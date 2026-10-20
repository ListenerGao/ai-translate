// aitd：本机翻译服务。插件和命令行都连它；它管调度、缓存、术语表，再把段落交给模型服务。
// 接口和安全要求见 goals/20261019-1230-4-aitd-service.md「HTTP 接口」「安全」。
import {
  AITD_API,
  BUILTIN_GLOSSARY,
  Pipeline,
  Scheduler,
  SrtFormatError,
  TranslateError,
  documentSegments,
  isAbortError,
  languageName,
  mergeGlossary,
  parseDocument,
  renderDocument,
  type DocumentFormat,
  type GlossaryEntry,
  type Lane,
  type Segment,
  type TranslateErrorCode,
  type TranslateRequest,
  type Translator,
  type UnitOutcome,
} from "@ai-translate/core";
import { mkdirSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { SqliteCache, type SqliteCacheOptions } from "./cache.ts";
import { GlossaryFile } from "./glossary.ts";
import { HttpError, checkCaller, hasKey, readBody, sendError, sendJson } from "./http.ts";
import { Logger } from "./log.ts";
import type { ModelBackend } from "./model.ts";

const BODY_LIMIT = 1024 * 1024;
const MAX_SEGMENTS = 1000;

export interface AitdOptions {
  /** 监听端口；0 表示挑一个空闲端口（测试用） */
  port: number;
  /** 插件和命令行连 aitd 用的密钥 */
  apiKey: string;
  /** 数据目录：cache.db、glossary.txt、logs/ */
  home: string;
  model: ModelBackend;
  version: string;
  cache?: SqliteCacheOptions;
  /** 共用的日志；不传就在 home/logs 下新建 */
  log?: Logger;
}

export interface Aitd {
  url: string;
  port: number;
  close(): Promise<void>;
}

/** 两个翻译接口共有的字段 */
interface JobOptions {
  source: string;
  target: string;
  glossary: GlossaryEntry[];
  lane: Lane;
  priority: number;
}

interface TranslateBody extends JobOptions {
  segments: Segment[];
}

interface DocumentBody extends JobOptions {
  format: DocumentFormat;
  text: string;
  bilingual: boolean;
}

/** 一段的结果：翻成了带译文，没翻成带错误码和说明 */
type SegmentResult = { text: string; cached: boolean } | { error: { code: TranslateErrorCode; message: string } };

const ERROR_TEXT: Record<TranslateErrorCode, string> = {
  endpoint: "模型服务地址不对",
  "no-key": "缺少模型服务的密钥",
  unreachable: "连不上模型服务",
  unauthorized: "模型服务的密钥不对",
  timeout: "翻译超时",
  server: "模型服务出错",
  invalid: "译文不合格，保留原文",
};

export async function startAitd(options: AitdOptions): Promise<Aitd> {
  const { apiKey, home, model, version } = options;
  mkdirSync(join(home, "logs"), { recursive: true, mode: 0o700 });
  const log = options.log ?? new Logger(join(home, "logs", "aitd.log"));
  const cache = new SqliteCache(join(home, "cache.db"), options.cache);
  const glossary = new GlossaryFile(join(home, "glossary.txt"));
  // 全局一个队列，并发数等于模型服务的槽位数；插件（interactive）永远排在命令行（batch）前面，
  // 而且 batch 最多占到少 1 路，留 1 路给插件：命令行批量翻时，插件的请求来了马上开始，不用等 batch 让出（主人 2026-10-19 定）
  const scheduler = new Scheduler(model.profile.parallel, { batchLimit: Math.max(1, model.profile.parallel - 1) });
  const pipeline = new Pipeline({ cache, scheduler });
  // 真要调用模型时才去拿 Translator：缓存命中不会唤醒休眠中的模型（CP3）
  const translator: Translator = { translate: (req, signal) => viaModel(model, req, signal) };
  let requestSeq = 0;
  let port = options.port;

  const server = createServer((req, res) => {
    const started = performance.now();
    res.on("close", () => {
      log.info("request", { method: req.method ?? "", route: routeName(req), status: res.statusCode, ms: Math.round(performance.now() - started) });
    });
    handle(req, res).catch((err: unknown) => {
      if (err instanceof HttpError) return sendError(res, err);
      // 不记错误内容：JSON 解析之类的报错信息里可能带着原文
      log.info("error", { route: routeName(req), name: err instanceof Error ? err.name : "unknown" });
      if (!res.headersSent) sendError(res, new HttpError(500, "internal", "aitd 内部错误"));
      else res.destroy();
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const denied = checkCaller(req, port);
    if (denied !== null) return sendError(res, denied);
    const route = routeName(req);
    if (route === "/health") {
      if (req.method !== "GET") throw new HttpError(405, "method", "只支持 GET");
      return sendJson(res, 200, { status: "ok", version, api: AITD_API });
    }
    if (!hasKey(req, apiKey)) throw new HttpError(401, "unauthorized", "密钥不对：用 api-key 文件里的密钥");

    switch (`${req.method} ${route}`) {
      case "GET /api/status":
        return sendJson(res, 200, {
          version,
          api: AITD_API,
          model: await model.status(),
          queue: { pending: scheduler.pending, active: scheduler.active },
          cache: { entries: cache.size },
        });
      case "POST /api/translate":
        return translate(req, res);
      case "POST /api/translate-document":
        return translateDocument(req, res);
      case "POST /api/model/load": {
        // 桌面应用「重启翻译服务」后马上加载模型，不等开机自启的 60 秒延时（主人 2026-10-20 要求）；
        // 不等加载完就返回，加载进度看 /api/status
        void model.preload?.();
        log.info("model-load-requested");
        return sendJson(res, 202, { model: await model.status() });
      }
      case "GET /api/glossary":
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
        res.end(glossary.text);
        return;
      case "PUT /api/glossary": {
        const result = glossary.save(await readBody(req, BODY_LIMIT));
        if (!result.ok) throw new HttpError(400, "invalid-glossary", "术语表有错误，没有保存", { lines: result.errors });
        log.info("glossary-saved", { entries: result.count });
        return sendJson(res, 200, { entries: result.count });
      }
      default:
        if (route === "unknown") throw new HttpError(404, "not-found", "没有这个接口");
        throw new HttpError(405, "method", "不支持这个请求方法");
    }
  }

  /**
   * 把一组段落交给调度和缓存，每段结束（翻成或失败）回调一次；客户端断开就撤销还没开始的段落，
   * 已经开始的不打断：翻完照常写缓存，下次直接命中。
   */
  async function runJobs(res: ServerResponse, segments: readonly Segment[], options: JobOptions, onResult: (id: string, result: SegmentResult) => void) {
    const id = ++requestSeq;
    // 术语优先级：请求自带（命令行 --glossary）> 术语表文件 > 内置术语
    const terms = mergeGlossary(options.glossary, mergeGlossary(glossary.entries, BUILTIN_GLOSSARY));
    const taskIds = segments.map((s) => `${id}:${s.id}`);
    const controller = new AbortController();
    res.on("close", () => {
      if (res.writableFinished) return;
      controller.abort();
      for (const taskId of taskIds) scheduler.cancel(taskId);
    });
    let cached = 0;
    let failed = 0;
    await Promise.all(
      segments.map(async (segment, i) => {
        const job = {
          taskId: taskIds[i]!,
          segment,
          priority: options.priority,
          lane: options.lane,
          source: options.source,
          target: options.target,
          model: model.profile.id,
          glossary: terms,
        };
        try {
          const result = await pipeline.translate(job, translator, controller.signal);
          if (result.cached) cached++;
          onResult(segment.id, { text: result.text, cached: result.cached });
        } catch (err) {
          if (isAbortError(err) || controller.signal.aborted) return;
          failed++;
          const e = err instanceof TranslateError ? err : new TranslateError("server");
          onResult(segment.id, { error: { code: e.code, message: e.detail === "" ? ERROR_TEXT[e.code] : `${ERROR_TEXT[e.code]}：${e.detail}` } });
        }
      }),
    );
    return { request: id, cached, failed, cancelled: controller.signal.aborted };
  }

  function startNdjson(res: ServerResponse): (line: unknown) => void {
    res.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" });
    res.flushHeaders();
    return (line) => {
      if (!res.destroyed) res.write(`${JSON.stringify(line)}\n`);
    };
  }

  /** 逐段翻译，按完成顺序一段一行（NDJSON）返回；客户端断开就撤销还没开始的段落 */
  async function translate(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = parseTranslateBody(await readBody(req, BODY_LIMIT), model.profile.id);
    const started = performance.now();
    const write = startNdjson(res);
    const stats = await runJobs(res, body.segments, body, (id, r) => write("text" in r ? { id, text: r.text, cached: r.cached } : { id, error: r.error }));
    if (!res.destroyed) res.end();
    log.info("translate", { ...stats, lane: body.lane, segments: body.segments.length, ms: Math.round(performance.now() - started) });
  }

  /**
   * 翻一份 Markdown 或 SRT（Goal 6 CP1，桌面应用用）：用 core 拆段，逐段走调度和缓存，再用 core 重组，和 ait translate 逐字一致。
   * 每翻完一段写一行进度，最后一行是整份译文和没翻成的行号。
   */
  async function translateDocument(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = parseDocumentBody(await readBody(req, BODY_LIMIT), model.profile.id);
    let doc;
    try {
      doc = parseDocument(body.format, body.text);
    } catch (err) {
      if (err instanceof SrtFormatError) throw new HttpError(400, "format", `第 ${err.line} 行格式不对：${err.message}`, { line: err.line });
      throw err;
    }
    const started = performance.now();
    const segments = documentSegments(doc);
    const outcomes = new Map<string, UnitOutcome>();
    const write = startNdjson(res);
    const stats = await runJobs(res, segments, body, (id, r) => {
      outcomes.set(id, "text" in r ? { text: r.text } : { error: r.error.message });
      write({ type: "progress", done: outcomes.size, total: segments.length });
    });
    if (!stats.cancelled && !res.destroyed) {
      const { text, failed } = renderDocument(doc, outcomes, { bilingual: body.bilingual });
      write({ type: "done", text, failed });
      res.end();
    }
    log.info("translate-document", { ...stats, format: body.format, lane: body.lane, segments: segments.length, ms: Math.round(performance.now() - started) });
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, "127.0.0.1", () => resolve());
  });
  port = (server.address() as AddressInfo).port;
  log.info("started", { port, version });

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    close: async () => {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      cache.close();
      log.info("stopped");
    },
  };
}

/** 日志里只记已知的接口名，不记原样的地址（可能带查询参数） */
function routeName(req: IncomingMessage): string {
  const path = (req.url ?? "").split("?")[0];
  return path === "/health" ||
    path === "/api/status" ||
    path === "/api/translate" ||
    path === "/api/translate-document" ||
    path === "/api/glossary" ||
    path === "/api/model/load"
    ? path
    : "unknown";
}

async function* viaModel(model: ModelBackend, req: TranslateRequest, signal: AbortSignal) {
  const translator = await model.translator(signal);
  yield* translator.translate(req, signal);
}

const bad = (message: string) => new HttpError(400, "bad-request", message);

function parseJsonObject(raw: string): Record<string, unknown> {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw bad("请求体不是合法的 JSON");
  }
  if (!isRecord(data)) throw bad("请求体应为 JSON 对象");
  return data;
}

/** 两个翻译接口共有的字段：source、target、model、glossary、lane、priority */
function parseJobOptions(data: Record<string, unknown>, servedModel: string, defaultLane: Lane): JobOptions {
  const { source = "auto", target, model, glossary = [], lane = defaultLane, priority = 0 } = data;
  if (typeof source !== "string") throw bad("source 应为字符串");
  if (typeof target !== "string" || languageName(target) === undefined) throw bad("target 缺失或是不支持的语言");
  if (model !== servedModel) throw bad(`model 应为 ${servedModel}（aitd 当前加载的模型）`);
  if (!Array.isArray(glossary)) throw bad("glossary 应为数组");
  const terms: GlossaryEntry[] = glossary.map((g, i) => {
    if (!isRecord(g) || typeof g.from !== "string" || typeof g.to !== "string" || g.from.trim() === "" || g.to.trim() === "") {
      throw bad(`第 ${i + 1} 条术语缺少 from 或 to`);
    }
    return { from: g.from, to: g.to };
  });
  if (lane !== "interactive" && lane !== "batch") throw bad("lane 只能是 interactive 或 batch");
  if (typeof priority !== "number" || !Number.isFinite(priority)) throw bad("priority 应为数字");
  return { source, target, glossary: terms, lane, priority };
}

/** 校验 POST /api/translate 的请求体：段落协议的 TranslateRequest，另加 lane（默认 interactive）、priority */
export function parseTranslateBody(raw: string, servedModel: string): TranslateBody {
  const data = parseJsonObject(raw);
  const { segments } = data;
  if (!Array.isArray(segments) || segments.length === 0) throw bad("segments 应为非空数组");
  if (segments.length > MAX_SEGMENTS) throw bad(`一个请求最多 ${MAX_SEGMENTS} 段，请分批发送`);
  const ids = new Set<string>();
  const parsed: Segment[] = segments.map((s, i) => {
    if (!isRecord(s) || typeof s.id !== "string" || s.id === "" || typeof s.text !== "string" || s.text.trim() === "") {
      throw bad(`第 ${i + 1} 段缺少 id 或 text`);
    }
    if (ids.has(s.id)) throw bad(`段落 id 重复：第 ${i + 1} 段`);
    ids.add(s.id);
    if (s.markup !== undefined && typeof s.markup !== "string") throw bad(`第 ${i + 1} 段的 markup 应为字符串`);
    return { id: s.id, text: s.text, ...(typeof s.markup === "string" ? { markup: s.markup } : {}) };
  });
  return { segments: parsed, ...parseJobOptions(data, servedModel, "interactive") };
}

/** 校验 POST /api/translate-document 的请求体：format、text、bilingual，加上共有字段；lane 默认 batch */
export function parseDocumentBody(raw: string, servedModel: string): DocumentBody {
  const data = parseJsonObject(raw);
  const { format, text, bilingual = false } = data;
  if (format !== "markdown" && format !== "srt") throw bad("format 只能是 markdown 或 srt");
  if (typeof text !== "string") throw bad("text 应为字符串");
  if (typeof bilingual !== "boolean") throw bad("bilingual 应为 true 或 false");
  return { format, text, bilingual, ...parseJobOptions(data, servedModel, "batch") };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
