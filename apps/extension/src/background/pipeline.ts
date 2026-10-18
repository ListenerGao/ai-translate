import {
  cacheKey,
  getModelProfile,
  matchGlossary,
  parseGlossary,
  type Segment,
  type Translator,
} from "@ai-translate/core";
import type { Settings } from "../shared/settings.ts";
import type { CacheStore } from "./cache.ts";
import type { Scheduler } from "./scheduler.ts";

export interface PipelineDeps {
  cache: CacheStore;
  scheduler: Scheduler;
  getSettings(): Promise<Settings>;
  createTranslator(settings: Settings): Translator;
}

export interface SegmentJob {
  tabId: number;
  segment: Segment;
  priority: number;
}

export interface SegmentOutcome {
  text: string;
  cached: boolean;
}

/** 一段文字的完整路径：查缓存 → 排队 → 翻译 → 写缓存。相同内容同时在翻时只翻一次 */
export class Pipeline {
  readonly #deps: PipelineDeps;
  readonly #inflight = new Map<string, Promise<string>>();

  constructor(deps: PipelineDeps) {
    this.#deps = deps;
  }

  /** 任务在 Scheduler 里的 id */
  static taskId(tabId: number, segmentId: string): string {
    return `${tabId}:${segmentId}`;
  }

  /** signal：段落滑出范围时撤销；查完缓存、入队之前也会检查一次 */
  async translate(job: SegmentJob, signal?: AbortSignal): Promise<SegmentOutcome> {
    const settings = await this.#deps.getSettings();
    const profile = getModelProfile(settings.modelId);
    const glossary = matchGlossary(job.segment.text, parseGlossary(settings.glossaryText).entries);
    const key = await cacheKey({
      model: profile.id,
      source: settings.source,
      target: settings.target,
      glossary,
      // 有格式时按带标记的原文缓存：同一段文字带不带格式，译文不同
      text: job.segment.markup ?? job.segment.text,
    });

    const hit = await this.#deps.cache.get(key);
    if (hit !== undefined) return { text: hit, cached: true };
    signal?.throwIfAborted();

    const text = await this.#deps.scheduler.enqueue({
      id: Pipeline.taskId(job.tabId, job.segment.id),
      priority: job.priority,
      run: (signal) =>
        this.#once(key, async () => {
          // 排队期间同样的内容可能已经翻好（如划词翻了同一段），开始前再查一次缓存
          const ready = await this.#deps.cache.get(key);
          if (ready !== undefined) return ready;
          const translator = this.#deps.createTranslator(settings);
          const request = { segments: [job.segment], source: settings.source, target: settings.target, model: profile.id, glossary };
          for await (const result of translator.translate(request, signal)) {
            await this.#deps.cache.set(key, result.text);
            return result.text;
          }
          throw new Error("Translator 没有返回结果");
        }),
    });
    return { text, cached: false };
  }

  #once(key: string, work: () => Promise<string>): Promise<string> {
    const existing = this.#inflight.get(key);
    if (existing !== undefined) return existing;
    const promise = work().finally(() => this.#inflight.delete(key));
    this.#inflight.set(key, promise);
    return promise;
  }
}
