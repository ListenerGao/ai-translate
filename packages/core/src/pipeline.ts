import { cacheKey } from "./cache-key.ts";
import type { CacheStore } from "./cache.ts";
import { matchGlossary } from "./glossary.ts";
import type { GlossaryEntry, Segment, Translator } from "./protocol.ts";
import type { Lane, Scheduler } from "./scheduler.ts";

export interface PipelineDeps {
  cache: CacheStore;
  scheduler: Scheduler;
}

/** 一段要翻译的文字和它的翻译参数 */
export interface PipelineJob {
  /** 调度队列里的任务 id：同一 id 重复入队只执行一次，撤销也按它 */
  taskId: string;
  segment: Segment;
  /** 越小越先执行 */
  priority: number;
  lane?: Lane;
  /** "auto" 或语言代码 */
  source: string;
  target: string;
  /** 模型配置 id，进缓存键 */
  model: string;
  /** 完整的术语表：只有本段命中的术语进 prompt 和缓存键 */
  glossary: readonly GlossaryEntry[];
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

  /**
   * translator：实际调用模型的实现（插件按当前设置创建，aitd 用自己管理的模型服务）。
   * signal：段落滑出范围时撤销；查完缓存、入队之前也会检查一次。
   */
  async translate(job: PipelineJob, translator: Translator, signal?: AbortSignal): Promise<SegmentOutcome> {
    const glossary = matchGlossary(job.segment.text, job.glossary);
    const key = await cacheKey({
      model: job.model,
      source: job.source,
      target: job.target,
      glossary,
      // 有格式时按带标记的原文缓存：同一段文字带不带格式，译文不同
      text: job.segment.markup ?? job.segment.text,
    });

    const hit = await this.#deps.cache.get(key);
    if (hit !== undefined) return { text: hit, cached: true };
    signal?.throwIfAborted();

    const text = await this.#deps.scheduler.enqueue({
      id: job.taskId,
      priority: job.priority,
      ...(job.lane === undefined ? {} : { lane: job.lane }),
      run: (signal) =>
        this.#once(key, async () => {
          // 排队期间同样的内容可能已经翻好（如划词翻了同一段），开始前再查一次缓存
          const ready = await this.#deps.cache.get(key);
          if (ready !== undefined) return ready;
          const request = { segments: [job.segment], source: job.source, target: job.target, model: job.model, glossary };
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
