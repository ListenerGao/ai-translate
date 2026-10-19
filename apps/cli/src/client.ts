// 命令行连 aitd：读密钥、发 batch 请求（排在浏览器后面）、把出错转成给人看的提示和退出码。
import {
  AitdError,
  DEFAULT_ENDPOINT,
  DEFAULT_MODEL_ID,
  TranslateError,
  translateLines,
  type AitdConfig,
  type GlossaryEntry,
  type Segment,
} from "@ai-translate/core";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** 退出码：0 成功；1 参数或文件错误；2 aitd 没启动或密钥不对；3 有段落没翻成 */
export const EXIT = { ok: 0, usage: 1, service: 2, partial: 3 } as const;

export class CliError extends Error {
  readonly exitCode: number;

  constructor(exitCode: number, message: string) {
    super(message);
    this.exitCode = exitCode;
  }
}

/** 一次请求最多发多少段：aitd 一个请求最多收 1000 段、请求体不超过 1MB */
const BATCH = 200;
/** 一批的兜底超时：200 段按每段 1~2 秒、4 路并行，再加模型冷启动 */
const BATCH_TIMEOUT_MS = 10 * 60_000;

export interface Connection extends AitdConfig {
  keyFile: string;
}

/** 密钥只从 api-key 文件读，不支持环境变量和命令行参数，免得进 shell 历史 */
export function connect(env: NodeJS.ProcessEnv = process.env): Connection {
  const home = env.AIT_HOME ?? join(homedir(), "Library", "Application Support", "ai-translate");
  const keyFile = join(home, "api-key");
  if (!existsSync(keyFile)) throw new CliError(EXIT.service, `找不到密钥文件 ${keyFile} ：先启动一次 aitd（npm run aitd）生成`);
  const apiKey = readFileSync(keyFile, "utf8").trim();
  return { endpoint: env.AIT_URL ?? DEFAULT_ENDPOINT, apiKey, keyFile };
}

/** 连 aitd 出的错转成给人看的提示 */
export function serviceError(err: unknown, conn: Connection): CliError {
  if (err instanceof AitdError) return new CliError(EXIT.service, err.display);
  if (!(err instanceof TranslateError)) return new CliError(EXIT.service, `本机翻译服务出错：${String(err)}`);
  switch (err.code) {
    case "unreachable":
      return new CliError(EXIT.service, `连不上本机翻译服务 aitd（${conn.endpoint}）：在项目目录运行 npm run aitd，或用 scripts/aitd-service.sh install 设为开机自启`);
    case "unauthorized":
      return new CliError(EXIT.service, `密钥不对：${conn.keyFile} 和 aitd 用的不是同一个`);
    case "endpoint":
      return new CliError(EXIT.service, `服务地址不对：${err.detail}`);
    case "no-key":
      return new CliError(EXIT.service, `密钥文件是空的：${conn.keyFile}`);
    case "timeout":
      return new CliError(EXIT.service, "等本机翻译服务太久了：看看 aitd 和模型是不是卡住了（ait status）");
    default:
      return new CliError(EXIT.service, `本机翻译服务出错：${err.detail || err.code}`);
  }
}

export interface Outcome {
  text?: string;
  /** 这一段没翻成的原因 */
  error?: string;
}

export interface BatchOptions {
  source: string;
  target: string;
  glossary: readonly GlossaryEntry[];
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
}

/** 分批发给 aitd（batch 通道），返回每段的结果；某段出错不影响其他段 */
export async function translateAll(conn: Connection, segments: readonly Segment[], options: BatchOptions): Promise<Map<string, Outcome>> {
  const results = new Map<string, Outcome>();
  for (let start = 0; start < segments.length; start += BATCH) {
    const request = {
      segments: segments.slice(start, start + BATCH),
      source: options.source,
      target: options.target,
      model: DEFAULT_MODEL_ID,
      glossary: [...options.glossary],
    };
    try {
      const lines = translateLines(conn, request, {
        lane: "batch",
        priority: 0,
        timeoutMs: BATCH_TIMEOUT_MS,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      for await (const line of lines) {
        results.set(line.id, line.error === undefined ? { text: line.text ?? "" } : { error: line.error.message });
        options.onProgress?.(results.size, segments.length);
      }
    } catch (err) {
      if (options.signal?.aborted) throw err;
      throw serviceError(err, conn);
    }
  }
  return results;
}
