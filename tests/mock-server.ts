// 模拟 llama-server 的 /v1/chat/completions：延迟可调，记录收到的请求，单测和 e2e 共用。
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

export interface MockRequest {
  prompt: string;
  /** 从 prompt 里取出的原文 */
  source: string;
  body: Record<string, unknown>;
  auth: string | undefined;
  at: number;
}

export interface MockReply {
  status?: number;
  content?: string;
  delayMs?: number;
}

export type Responder = (req: MockRequest, index: number) => MockReply | undefined;

export interface MockServer {
  url: string;
  requests: MockRequest[];
  /** 同时在处理的请求数峰值 */
  maxConcurrent(): number;
  /** 当前正在处理的请求数 */
  inflight(): number;
  setDelay(ms: number): void;
  setResponder(fn: Responder | null): void;
  reset(): void;
  close(): Promise<void>;
}

/** 从 instTrans prompt 里取出原文 */
export function extractSource(prompt: string): string {
  const constrained = /【源文】\n([\s\S]*?)\n\n【约束要求】/.exec(prompt);
  if (constrained?.[1] !== undefined) return constrained[1];
  const i = prompt.indexOf("\n\n");
  return i >= 0 ? prompt.slice(i + 2) : prompt;
}

/** 默认的假译文：带汉字，能通过译文校验，又能看出原文 */
export function fakeTranslation(source: string): string {
  return `【译】${source}`;
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export async function startMockServer(options: { apiKey?: string; delayMs?: number } = {}): Promise<MockServer> {
  let delay = options.delayMs ?? 0;
  let responder: Responder | null = null;
  let active = 0;
  let peak = 0;
  const requests: MockRequest[] = [];

  const server = createServer(async (req, res) => {
    const send = (status: number, payload: unknown) => {
      if (res.destroyed || res.writableEnded) return;
      res.writeHead(status, { "Content-Type": "application/json", ...CORS });
      res.end(JSON.stringify(payload));
    };
    if (req.method === "OPTIONS") {
      res.writeHead(204, CORS).end();
      return;
    }
    if (req.method === "GET" && req.url === "/health") {
      send(200, { status: "ok" });
      return;
    }
    if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
      send(404, { error: "not found" });
      return;
    }

    const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
    const messages = body.messages as { content?: string }[] | undefined;
    const prompt = messages?.[0]?.content ?? "";
    const entry: MockRequest = { prompt, source: extractSource(prompt), body, auth: req.headers.authorization, at: Date.now() };
    const index = requests.push(entry) - 1;
    active++;
    peak = Math.max(peak, active);
    try {
      const reply = responder?.(entry, index) ?? {};
      await new Promise((r) => setTimeout(r, reply.delayMs ?? delay));
      if (options.apiKey !== undefined && entry.auth !== `Bearer ${options.apiKey}`) {
        send(401, { error: { code: 401, message: "Invalid API Key" } });
      } else if ((reply.status ?? 200) !== 200) {
        send(reply.status ?? 500, { error: { message: "mock error" } });
      } else {
        const content = reply.content ?? fakeTranslation(entry.source);
        send(200, { choices: [{ index: 0, message: { role: "assistant", content } }] });
      }
    } finally {
      active--;
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    maxConcurrent: () => peak,
    inflight: () => active,
    setDelay: (ms) => {
      delay = ms;
    },
    setResponder: (fn) => {
      responder = fn;
    },
    reset: () => {
      requests.length = 0;
      peak = 0;
      responder = null;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}
