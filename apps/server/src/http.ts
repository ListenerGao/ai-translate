// HTTP 小工具：来源检查、密钥比较、读请求体、返回 JSON。
import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly extra: Record<string, unknown>;

  constructor(status: number, code: string, message: string, extra: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

/**
 * 只接受本机程序的请求：
 * - Host 必须是 127.0.0.1 或 localhost 加本服务端口，防 DNS 重绑定（恶意域名解析到 127.0.0.1）
 * - 带 Origin 的只接受浏览器插件（chrome-extension://），网页发起的一律拒绝；命令行不带 Origin
 * 不返回任何 CORS 头，网页即使发出请求也读不到结果。
 */
export function checkCaller(req: IncomingMessage, port: number): HttpError | null {
  const host = req.headers.host;
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
    return new HttpError(403, "forbidden", "只接受发往 127.0.0.1 或 localhost 的请求");
  }
  const origin = req.headers.origin;
  if (origin !== undefined && !origin.startsWith("chrome-extension://")) {
    return new HttpError(403, "forbidden", "不接受网页发起的请求");
  }
  return null;
}

/** 比较 Bearer 密钥。先各自取哈希再比：长度固定，比较耗时和密钥内容无关 */
export function hasKey(req: IncomingMessage, key: string): boolean {
  const header = req.headers.authorization ?? "";
  const given = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
  const digest = (s: string) => createHash("sha256").update(s).digest();
  return given !== "" && timingSafeEqual(digest(given), digest(key));
}

/** 读请求体，超过 limit 字节报 413 */
export async function readBody(req: IncomingMessage, limit: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, "too-large", `请求体超过 ${Math.round(limit / 1024)}KB`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  if (res.headersSent) return;
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(payload));
}

export function sendError(res: ServerResponse, err: HttpError): void {
  sendJson(res, err.status, { error: { code: err.code, message: err.message, ...err.extra } });
}
