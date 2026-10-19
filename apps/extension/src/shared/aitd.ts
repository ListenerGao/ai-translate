// 插件连本机翻译服务 aitd：翻译、状态、术语表。地址只能是本机（AGENTS 红线），除 /health 外都要带密钥。
import {
  TranslateError,
  checkLocalEndpoint,
  parseGlossary,
  type TranslateErrorCode,
  type TranslateRequest,
  type TranslateResult,
  type Translator,
} from "@ai-translate/core";
import { loadSettings, saveSettings } from "./settings.ts";

/** 插件认识的 aitd 接口版本；aitd 的 /health 返回别的版本时提示更新 */
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

const ERROR_CODES = new Set<TranslateErrorCode>(["endpoint", "no-key", "unreachable", "unauthorized", "timeout", "server", "invalid"]);

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
async function call(config: AitdConfig, path: string, init: RequestInit, options: { timeoutMs: number; signal?: AbortSignal; allow?: number[] }): Promise<Response> {
  const base = root(config);
  const timeout = AbortSignal.timeout(options.timeoutMs);
  const signal = options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout]);
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, { ...init, headers: { ...(init.headers as Record<string, string>), Authorization: `Bearer ${config.apiKey.trim()}` }, signal });
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

interface TranslateLine {
  id: string;
  text?: string;
  cached?: boolean;
  error?: { code: string; message: string };
}

/**
 * 连 aitd 的 Translator：插件请求走 interactive 通道，排在命令行的批量任务前面。
 * 正常超时由 aitd 判定（开始翻译后 30 秒）；这里只设 120 秒兜底，排队和等模型启动的时间都在里面。
 */
export class AitdTranslator implements Translator {
  readonly #config: AitdConfig;
  readonly #priority: number;

  constructor(config: AitdConfig, priority: number) {
    this.#config = config;
    this.#priority = priority;
  }

  async *translate(req: TranslateRequest, signal: AbortSignal): AsyncIterable<TranslateResult> {
    const body = JSON.stringify({ ...req, lane: "interactive", priority: this.#priority });
    const res = await call(this.#config, "/api/translate", { method: "POST", headers: { "Content-Type": "application/json" }, body }, { timeoutMs: 120_000, signal });
    try {
      for await (const raw of readLines(res)) {
        const line = raw as TranslateLine;
        if (line.error !== undefined) {
          const code = ERROR_CODES.has(line.error.code as TranslateErrorCode) ? (line.error.code as TranslateErrorCode) : "server";
          throw new AitdError(code, line.error.message);
        }
        yield { id: line.id, text: line.text ?? "", cached: line.cached ?? false };
      }
    } catch (err) {
      if (err instanceof TranslateError || signal.aborted) throw signal.aborted ? (signal.reason ?? err) : err;
      throw new TranslateError("unreachable"); // 读到一半连接断了
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
  return (await (await call(config, "/api/status", {}, { timeoutMs: 3000 })).json()) as AitdStatus;
}

export async function getGlossary(config: AitdConfig): Promise<string> {
  return (await call(config, "/api/glossary", {}, { timeoutMs: 3000 })).text();
}

export type GlossarySaveResult = { ok: true; entries: number } | { ok: false; lines: { line: number; message: string }[] };

export async function putGlossary(config: AitdConfig, text: string): Promise<GlossarySaveResult> {
  const res = await call(config, "/api/glossary", { method: "PUT", headers: { "Content-Type": "text/plain; charset=utf-8" }, body: text }, { timeoutMs: 3000, allow: [400] });
  const body = (await res.json()) as { entries?: number; error?: { lines?: { line: number; message: string }[] } };
  return res.ok ? { ok: true, entries: body.entries ?? 0 } : { ok: false, lines: body.error?.lines ?? [] };
}

/**
 * 第一阶段的术语表存在插件里；改连 aitd 后术语表放在 aitd。
 * 插件里还有、aitd 的又是空的，就搬过去并清掉插件里的；aitd 没启动就下次再试。
 */
export async function migrateGlossary(): Promise<void> {
  const settings = await loadSettings();
  if (settings.glossaryText.trim() === "") return;
  try {
    if ((await getGlossary(settings)).trim() !== "") return;
    let result = await putGlossary(settings, settings.glossaryText);
    // 插件里的术语表有写错的行（翻译时本来就跳过了）：只搬写对的那些
    if (!result.ok) result = await putGlossary(settings, parseGlossary(settings.glossaryText).entries.map((e) => `${e.from}=${e.to}`).join("\n"));
    if (result.ok) await saveSettings({ glossaryText: "" });
  } catch {
    // aitd 没启动或密钥不对：下次再搬
  }
}
