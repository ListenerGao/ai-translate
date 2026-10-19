// 连本机翻译服务 aitd 的客户端：插件、命令行、以后的桌面应用共用。只用 fetch 等 Web 标准接口。
// 地址只能是本机（AGENTS 红线），除 /health 外都要带密钥。
import { checkLocalEndpoint } from "./endpoint.ts";
import { TranslateError, type TranslateErrorCode } from "./errors.ts";
import type { Lane } from "./scheduler.ts";
import type { TranslateRequest, TranslateResult, Translator } from "./protocol.ts";

/** aitd 的接口版本：服务端在 /health 里报这个数，客户端发现不一样就提示更新。接口出现不兼容改动时才加 1 */
export const AITD_API = 1;

/** aitd 返回的错误：提示文字直接用 aitd 给的（如模型启动失败的原因） */
export class AitdError extends TranslateError {
  readonly display: string;

  constructor(code: TranslateErrorCode, display: string) {
    super(code, display);
    this.name = "AitdError";
    this.display = display;
  }
}

export interface AitdConfig {
  endpoint: string;
  apiKey: string;
}

export interface AitdStatus {
  version: string;
  api: number;
  model: { state: "stopped" | "starting" | "ready" | "error"; model: string; quant?: string; detail?: string };
  queue: { pending: number; active: number };
  cache: { entries: number };
}

/** POST /api/translate 返回的一行：译文，或这一段的错误 */
export interface TranslateLine {
  id: string;
  text?: string;
  cached?: boolean;
  error?: { code: string; message: string };
}

const ERROR_CODES = new Set<TranslateErrorCode>(["endpoint", "no-key", "unreachable", "unauthorized", "timeout", "server", "invalid"]);

/** aitd 给的错误转成 AitdError；不认识的错误码按 server 算 */
export function lineError(error: { code: string; message: string }): AitdError {
  const code = ERROR_CODES.has(error.code as TranslateErrorCode) ? (error.code as TranslateErrorCode) : "server";
  return new AitdError(code, error.message);
}

/** 地址只能是本机、必须有密钥，返回 aitd 的根地址 */
function root(config: AitdConfig): string {
  const endpoint = checkLocalEndpoint(config.endpoint);
  if (!endpoint.ok) throw new TranslateError("endpoint", endpoint.reason);
  if (config.apiKey.trim() === "") throw new TranslateError("no-key");
  return endpoint.base;
}

/**
 * 发请求并统一出错：连不上 → unreachable，401 → unauthorized，超时 → timeout，调用方撤销 → 原样抛出撤销原因。
 * allow 里的状态码交给调用方自己处理（如术语表有错的 400）。
 */
export async function aitdCall(
  config: AitdConfig,
  path: string,
  init: RequestInit,
  options: { timeoutMs: number; signal?: AbortSignal; allow?: number[] },
): Promise<Response> {
  const base = root(config);
  const timeout = AbortSignal.timeout(options.timeoutMs);
  const signal = options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout]);
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, { ...init, headers: { ...init.headers, Authorization: `Bearer ${config.apiKey.trim()}` }, signal });
  } catch (err) {
    if (options.signal?.aborted) throw options.signal.reason ?? err;
    if (timeout.aborted) throw new TranslateError("timeout");
    throw new TranslateError("unreachable");
  }
  if (res.status === 401) throw new TranslateError("unauthorized");
  if (!res.ok && !(options.allow ?? []).includes(res.status)) {
    const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
    throw new AitdError("server", body?.error?.message ?? `本机翻译服务出错（HTTP ${res.status}）`);
  }
  return res;
}

/** 逐行读 NDJSON */
async function* readLines(res: Response): AsyncIterable<unknown> {
  if (res.body === null) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    for (let i = buffer.indexOf("\n"); i >= 0; i = buffer.indexOf("\n")) {
      const line = buffer.slice(0, i).trim();
      buffer = buffer.slice(i + 1);
      if (line !== "") yield JSON.parse(line);
    }
  }
  if (buffer.trim() !== "") yield JSON.parse(buffer);
}

export interface TranslateOptions {
  /** interactive 给插件，batch 给命令行的批量任务 */
  lane: Lane;
  /** 越小越先，只在同一通道内比较 */
  priority: number;
  /** 兜底超时：正常超时由 aitd 判定，这里要把排队和等模型启动的时间都算进去 */
  timeoutMs: number;
  signal?: AbortSignal;
}

/** 发一批段落给 aitd，按完成顺序逐行返回；某段出错不影响其他段落 */
export async function* translateLines(config: AitdConfig, req: TranslateRequest, options: TranslateOptions): AsyncIterable<TranslateLine> {
  const body = JSON.stringify({ ...req, lane: options.lane, priority: options.priority });
  const res = await aitdCall(config, "/api/translate", { method: "POST", headers: { "Content-Type": "application/json" }, body }, options);
  try {
    for await (const line of readLines(res)) yield line as TranslateLine;
  } catch (err) {
    if (options.signal?.aborted) throw options.signal.reason ?? err;
    if (err instanceof TranslateError) throw err;
    throw new TranslateError("unreachable"); // 读到一半连接断了
  }
}

/**
 * 插件用的 Translator：一段一个请求，走 interactive 通道，出错就抛出。
 * 插件端只设 120 秒兜底超时，排队和等模型启动的时间都在里面。
 */
export class AitdTranslator implements Translator {
  readonly #config: AitdConfig;
  readonly #priority: number;

  constructor(config: AitdConfig, priority: number) {
    this.#config = config;
    this.#priority = priority;
  }

  async *translate(req: TranslateRequest, signal: AbortSignal): AsyncIterable<TranslateResult> {
    for await (const line of translateLines(this.#config, req, { lane: "interactive", priority: this.#priority, timeoutMs: 120_000, signal })) {
      if (line.error !== undefined) throw lineError(line.error);
      yield { id: line.id, text: line.text ?? "", cached: line.cached ?? false };
    }
  }
}

/** aitd 在不在：/health 不需要密钥；返回接口版本，连不上返回 null */
export async function aitdHealth(endpoint: string): Promise<number | null> {
  const checked = checkLocalEndpoint(endpoint);
  if (!checked.ok) return null;
  try {
    const res = await fetch(`${checked.base}/health`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return null;
    return ((await res.json()) as { api?: number }).api ?? null;
  } catch {
    return null;
  }
}

export async function aitdStatus(config: AitdConfig): Promise<AitdStatus> {
  return (await (await aitdCall(config, "/api/status", {}, { timeoutMs: 3000 })).json()) as AitdStatus;
}

export async function getGlossary(config: AitdConfig): Promise<string> {
  return (await aitdCall(config, "/api/glossary", {}, { timeoutMs: 3000 })).text();
}

export type GlossarySaveResult = { ok: true; entries: number } | { ok: false; lines: { line: number; message: string }[] };

export async function putGlossary(config: AitdConfig, text: string): Promise<GlossarySaveResult> {
  const res = await aitdCall(config, "/api/glossary", { method: "PUT", headers: { "Content-Type": "text/plain; charset=utf-8" }, body: text }, { timeoutMs: 3000, allow: [400] });
  const body = (await res.json()) as { entries?: number; error?: { lines?: { line: number; message: string }[] } };
  return res.ok ? { ok: true, entries: body.entries ?? 0 } : { ok: false, lines: body.error?.lines ?? [] };
}
