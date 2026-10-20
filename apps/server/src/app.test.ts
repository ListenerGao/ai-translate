// Goal 4 CP2：aitd 的 HTTP 接口。用模拟 llama-server，编号对应施工清单 CP2 的预期 1~9。
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { request as httpRequest, type ClientRequest, type IncomingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { startMockServer, type MockServer } from "../../../tests/mock-server.ts";
import { startAitd, type Aitd } from "./app.ts";
import { ExternalModel } from "./model.ts";

const KEY = "client-key-0123456789abcdef";
const MODEL_KEY = "model-key-fedcba9876543210";
const AUTH = { authorization: `Bearer ${KEY}` };

let mock: MockServer;
let aitd: Aitd;
let home: string;

const boot = () =>
  startAitd({ port: 0, apiKey: KEY, home, model: new ExternalModel({ endpoint: mock.url, apiKey: MODEL_KEY }), version: "test" });

beforeEach(async () => {
  mock = await startMockServer({ apiKey: MODEL_KEY });
  home = mkdtempSync(join(tmpdir(), "aitd-test-"));
  aitd = await boot();
});

afterEach(async () => {
  await aitd.close();
  await mock.close();
  rmSync(home, { recursive: true, force: true });
});

interface RawResponse {
  status: number;
  headers: IncomingHttpHeaders;
  text: string;
}

/** 用 node:http 发请求，能自己定 Host、Origin */
function send(path: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}): { req: ClientRequest; done: Promise<RawResponse> } {
  let req!: ClientRequest;
  const done = new Promise<RawResponse>((resolve, reject) => {
    req = httpRequest(
      { host: "127.0.0.1", port: aitd.port, path, method: options.method ?? "GET", headers: { host: `127.0.0.1:${aitd.port}`, ...options.headers } },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (text += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text }));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
  return { req, done };
}

const call = (path: string, options: Parameters<typeof send>[1] = {}) => send(path, options).done;

interface Line {
  id: string;
  text?: string;
  cached?: boolean;
  error?: { code: string; message: string };
}

function translateBody(segments: { id: string; text: string }[], extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ segments, target: "zh", model: "index-translate-2b", ...extra });
}

async function translate(segments: { id: string; text: string }[], extra: Record<string, unknown> = {}) {
  const res = await call("/api/translate", { method: "POST", headers: { ...AUTH, "content-type": "application/json" }, body: translateBody(segments, extra) });
  const lines = res.text.split("\n").filter((l) => l !== "").map((l) => JSON.parse(l) as Line);
  return { status: res.status, headers: res.headers, lines };
}

async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("等待超时");
    await new Promise((r) => setTimeout(r, 5));
  }
}

const seg = (id: string, text: string) => ({ id, text });

describe("aitd", () => {
  test("1 鉴权：/health 不要密钥；其余接口不带密钥或密钥错误返回 401", async () => {
    const health = await call("/health");
    assert.equal(health.status, 200);
    assert.deepEqual(JSON.parse(health.text), { status: "ok", version: "test", api: 1 });

    assert.equal((await call("/api/status")).status, 401);
    assert.equal((await call("/api/status", { headers: { authorization: "Bearer wrong" } })).status, 401);
    assert.equal((await call("/api/status", { headers: { authorization: KEY } })).status, 401);
    const ok = await call("/api/status", { headers: AUTH });
    assert.equal(ok.status, 200);
    const status = JSON.parse(ok.text);
    assert.equal(status.model.state, "ready");
    assert.deepEqual(status.queue, { pending: 0, active: 0 });
    assert.deepEqual(status.cache, { entries: 0 });
  });

  test("2 来源：Host 不对、网页 Origin 拒绝；插件 Origin、没有 Origin 放行；响应不带 CORS 头", async () => {
    assert.equal((await call("/health", { headers: { host: `evil.example:${aitd.port}` } })).status, 403);
    assert.equal((await call("/api/status", { headers: { ...AUTH, host: `127.0.0.1:1` } })).status, 403);
    assert.equal((await call("/api/status", { headers: { ...AUTH, origin: "https://evil.example" } })).status, 403);
    assert.equal((await call("/api/status", { headers: { ...AUTH, origin: "http://127.0.0.1:3000" } })).status, 403);
    assert.equal((await call("/api/status", { headers: { ...AUTH, origin: "null" } })).status, 403);
    assert.equal((await call("/api/status", { headers: { ...AUTH, host: `localhost:${aitd.port}` } })).status, 200);
    const fromExtension = await call("/api/status", { headers: { ...AUTH, origin: "chrome-extension://abcdefghijklmnop" } });
    assert.equal(fromExtension.status, 200);
    for (const res of [fromExtension, await call("/health"), await call("/api/status")]) {
      assert.equal(Object.keys(res.headers).filter((h) => h.startsWith("access-control-")).length, 0);
    }
  });

  test("3 多段：按完成顺序逐段返回；再翻一次全部命中缓存，不再调用模型", async () => {
    mock.setResponder((req) => ({ delayMs: req.source.startsWith("Slow") ? 150 : 10 }));
    const first = await translate([seg("a", "Slow paragraph goes first."), seg("b", "Fast paragraph goes second.")]);
    assert.equal(first.status, 200);
    assert.match(String(first.headers["content-type"]), /application\/x-ndjson/);
    assert.deepEqual(first.lines, [
      { id: "b", text: "【译】Fast paragraph goes second.", cached: false },
      { id: "a", text: "【译】Slow paragraph goes first.", cached: false },
    ]);
    const again = await translate([seg("x", "Slow paragraph goes first."), seg("y", "Fast paragraph goes second.")]);
    assert.deepEqual(again.lines.map((l) => [l.id, l.cached]).sort(), [["x", true], ["y", true]]);
    assert.equal(mock.requests.length, 2);
  });

  test("4 客户端中途断开：没开始的段落不再发给模型；已开始的翻完并写缓存", async () => {
    mock.setDelay(200);
    const texts = Array.from({ length: 8 }, (_, i) => `Paragraph number ${i} about cancellation.`);
    const { req, done } = send("/api/translate", {
      method: "POST",
      headers: { ...AUTH, "content-type": "application/json" },
      body: translateBody(texts.map((t, i) => seg(`p${i}`, t))),
    });
    done.catch(() => {});
    await waitFor(() => mock.inflight() === 4);
    req.destroy();
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(mock.requests.length, 4);
    const started = mock.requests.map((r) => r.source);
    const again = await translate(started.map((t, i) => seg(`again${i}`, t)));
    assert.ok(again.lines.every((l) => l.cached === true));
    assert.equal(mock.requests.length, 4);
  });

  test("5 batch 排着 20 段：最多同时占 3 路，留 1 路给插件；interactive 请求来了马上开始，不用等 batch 让出", async () => {
    mock.setResponder((req) => ({ delayMs: req.source.startsWith("Batch paragraph") ? 300 : 10 }));
    const batch = translate(
      Array.from({ length: 20 }, (_, i) => seg(`b${i}`, `Batch paragraph number ${i}.`)),
      { lane: "batch" },
    );
    await waitFor(() => mock.inflight() === 3);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(mock.inflight(), 3, "第 4 路空着，留给插件");
    const started = performance.now();
    const page = await translate([seg("v1", "Visible paragraph on screen.")]);
    assert.equal(page.lines[0]?.text, "【译】Visible paragraph on screen.");
    assert.ok(performance.now() - started < 200, "不用等 300 毫秒的 batch 段落让出");
    assert.equal(mock.requests.findIndex((r) => r.source === "Visible paragraph on screen."), 3);
    await batch;
    assert.equal(mock.maxConcurrent(), 4);
  });

  test("6 相同内容的两个请求同时到：模型只收到一次", async () => {
    mock.setDelay(100);
    const [a, b] = await Promise.all([translate([seg("a", "Same text twice.")]), translate([seg("b", "Same text twice.")])]);
    assert.equal(a.lines[0]?.text, "【译】Same text twice.");
    assert.equal(b.lines[0]?.text, "【译】Same text twice.");
    assert.equal(mock.requests.length, 1);
  });

  test("7 重启 aitd 后缓存还在；缓存文件只给自己读写", async () => {
    await translate([seg("a", "Persistent paragraph text.")]);
    await aitd.close();
    aitd = await boot();
    const again = await translate([seg("a", "Persistent paragraph text.")]);
    assert.equal(again.lines[0]?.cached, true);
    assert.equal(mock.requests.length, 1);
    assert.equal(statSync(join(home, "cache.db")).mode & 0o777, 0o600);
  });

  test("8 术语表：有错返回行号且不保存；保存后翻译带上术语，请求自带的术语优先；文件权限 600", async () => {
    const put = (body: string) => call("/api/glossary", { method: "PUT", headers: { ...AUTH, "content-type": "text/plain" }, body });
    const invalid = await put("token=词元\nmissing equals sign");
    assert.equal(invalid.status, 400);
    assert.deepEqual(JSON.parse(invalid.text).error.lines.map((l: { line: number }) => l.line), [2]);
    assert.equal((await call("/api/glossary", { headers: AUTH })).text, "");

    const saved = await put("# 术语\ntoken=词元\nprompt=提示词");
    assert.equal(saved.status, 200);
    assert.deepEqual(JSON.parse(saved.text), { entries: 2 });
    assert.equal((await call("/api/glossary", { headers: AUTH })).text, "# 术语\ntoken=词元\nprompt=提示词");
    assert.equal(statSync(join(home, "glossary.txt")).mode & 0o777, 0o600);

    await translate([seg("a", "Each token is sent.")]);
    assert.match(mock.requests[0]!.prompt, /token→词元/);
    await translate([seg("b", "Every token counts.")], { glossary: [{ from: "Token", to: "令牌" }] });
    assert.match(mock.requests[1]!.prompt, /Token→令牌/);
    assert.doesNotMatch(mock.requests[1]!.prompt, /词元/);
  });

  test("内置术语：没写术语表也会带上；术语表文件、请求自带的同名术语依次优先", async () => {
    await translate([seg("a", "Start with the mockup.")]);
    assert.match(mock.requests[0]!.prompt, /mockup→设计稿/);
    await call("/api/glossary", { method: "PUT", headers: { ...AUTH, "content-type": "text/plain" }, body: "mockup=原型图" });
    await translate([seg("b", "Review the mockup again.")]);
    assert.match(mock.requests[1]!.prompt, /mockup→原型图/);
    await translate([seg("c", "Ship the mockup today.")], { glossary: [{ from: "Mockup", to: "线框图" }] });
    assert.match(mock.requests[2]!.prompt, /Mockup→线框图/);
    assert.doesNotMatch(mock.requests[2]!.prompt, /原型图|设计稿/);
  });

  test("9 日志里只有事件和数字：搜不到原文、译文和密钥", async () => {
    await translate([seg("a", "Zebras gallop across the secret savanna.")]);
    await call("/api/status", { headers: { authorization: "Bearer guessed-key" } });
    await call("/api/translate?text=hidden-query", { method: "POST", headers: { ...AUTH, "content-type": "application/json" }, body: "{not json zebra" });
    const log = readFileSync(join(home, "logs", "aitd.log"), "utf8");
    for (const secret of ["Zebras", "zebra", "【译】", "savanna", KEY, MODEL_KEY, "guessed-key", "hidden-query"]) {
      assert.ok(!log.includes(secret), `日志里出现了：${secret}`);
    }
    const events = log.trim().split("\n").map((l) => JSON.parse(l).event);
    assert.ok(events.includes("translate") && events.includes("request"));
    assert.equal(statSync(join(home, "logs", "aitd.log")).mode & 0o777, 0o600);
  });

  test("请求体校验：不是 JSON、模型不对、语言不支持、id 重复、段数过多、超过 1MB", async () => {
    const post = (body: string) => call("/api/translate", { method: "POST", headers: { ...AUTH, "content-type": "application/json" }, body });
    assert.equal((await post("{oops")).status, 400);
    assert.equal((await post(translateBody([seg("a", "Hi there.")], { model: "other-model" }))).status, 400);
    assert.equal((await post(translateBody([seg("a", "Hi there.")], { target: "xx" }))).status, 400);
    assert.equal((await post(translateBody([seg("a", "One."), seg("a", "Two.")]))).status, 400);
    assert.equal((await post(translateBody([seg("a", "Hi there.")], { lane: "urgent" }))).status, 400);
    assert.equal((await post(translateBody(Array.from({ length: 1001 }, (_, i) => seg(`s${i}`, "Text."))))).status, 400);
    assert.equal((await post(translateBody([seg("a", "x".repeat(1024 * 1024))]))).status, 413);
    assert.equal((await call("/api/nothing", { headers: AUTH })).status, 404);
    assert.equal((await call("/api/translate", { headers: AUTH })).status, 405);
    assert.equal(mock.requests.length, 0);
  });

  test("模型出错、连不上：对应的段落返回错误码，其余段落照常；状态接口报告连不上", async () => {
    mock.setResponder((req) => (req.source.startsWith("Broken") ? { status: 500 } : undefined));
    const mixed = await translate([seg("ok", "Healthy paragraph text."), seg("bad", "Broken paragraph text.")]);
    const byId = Object.fromEntries(mixed.lines.map((l) => [l.id, l]));
    assert.equal(byId.ok?.text, "【译】Healthy paragraph text.");
    assert.equal(byId.bad?.error?.code, "server");

    await mock.close();
    const down = await translate([seg("c", "Nobody is listening now.")]);
    assert.equal(down.lines[0]?.error?.code, "unreachable");
    const status = JSON.parse((await call("/api/status", { headers: AUTH })).text);
    assert.equal(status.model.state, "error");
    mock = await startMockServer({ apiKey: MODEL_KEY });
  });
});

// Goal 6 CP1：桌面应用用的文档翻译接口。编号对应施工清单 CP1 的单测预期 1~6。
describe("aitd /api/translate-document", () => {
  const fixture = (name: string) => readFileSync(new URL(`../../../tests/fixtures/cli/${name}`, import.meta.url), "utf8");

  interface DocLine {
    type: "progress" | "done";
    done?: number;
    total?: number;
    text?: string;
    failed?: { line: number; error: string }[];
  }

  const docBody = (format: string, text: string, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ format, text, target: "zh", model: "index-translate-2b", ...extra });

  async function translateDoc(format: string, text: string, extra: Record<string, unknown> = {}) {
    const res = await call("/api/translate-document", { method: "POST", headers: { ...AUTH, "content-type": "application/json" }, body: docBody(format, text, extra) });
    const lines = res.status === 200 ? res.text.split("\n").filter((l) => l !== "").map((l) => JSON.parse(l) as DocLine) : [];
    return { status: res.status, text: res.text, lines, last: lines.at(-1) };
  }

  test("1 Markdown、SRT 的译文和 ait translate 的 golden 逐字一致（单语、双语）；日志里搜不到原文和译文", async () => {
    for (const [format, source, mono, bilingual] of [
      ["markdown", "guide.md", "guide.zh.md", "guide.bilingual.md"],
      ["srt", "talk.srt", "talk.zh.srt", "talk.bilingual.srt"],
    ] as const) {
      const one = await translateDoc(format, fixture(source));
      assert.equal(one.status, 200);
      assert.equal(one.last?.type, "done");
      assert.equal(one.last?.text, fixture(mono), `${source} 单语`);
      assert.deepEqual(one.last?.failed, []);
      const two = await translateDoc(format, fixture(source), { bilingual: true });
      assert.equal(two.last?.text, fixture(bilingual), `${source} 双语`);
    }
    const log = readFileSync(join(home, "logs", "aitd.log"), "utf8");
    assert.ok(log.includes('"event":"translate-document"'));
    assert.ok(!log.includes("【译】") && !log.includes("Install"), "日志里不该有原文和译文");
  });

  test("2 SRT 格式错误：400，带行号；不发给模型", async () => {
    const res = await translateDoc("srt", "1\nHello there.\n");
    assert.equal(res.status, 400);
    const error = JSON.parse(res.text).error;
    assert.equal(error.code, "format");
    assert.equal(error.line, 2);
    assert.match(error.message, /第 2 行格式不对：.*时间轴/);
    assert.equal(mock.requests.length, 0);
  });

  test("3 进度：done 从 1 递增到段数；没有要翻的内容时直接返回原文，不发给模型", async () => {
    const source = fixture("dialog.srt");
    const res = await translateDoc("srt", source);
    const progress = res.lines.filter((l) => l.type === "progress");
    assert.equal(progress.length, 12);
    assert.deepEqual(progress.map((l) => l.done), Array.from({ length: 12 }, (_, i) => i + 1));
    assert.ok(progress.every((l) => l.total === 12));
    assert.equal(res.lines.length, 13);

    mock.reset();
    const code = "```js\nconst a = 1;\n```\n";
    const empty = await translateDoc("markdown", code);
    assert.deepEqual(empty.lines, [{ type: "done", text: code, failed: [] }]);
    assert.equal(mock.requests.length, 0);
  });

  test("4 有段落没翻成：failed 带行号和原因，这些段落保留原文", async () => {
    mock.setResponder((req) => (req.source.startsWith("Broken") ? { status: 500 } : undefined));
    const res = await translateDoc("markdown", "# Fine title\n\nBroken paragraph here.\n");
    assert.equal(res.last?.text, "# 【译】Fine title\n\nBroken paragraph here.\n");
    assert.equal(res.last?.failed?.length, 1);
    assert.equal(res.last?.failed?.[0]?.line, 3);
    assert.match(res.last?.failed?.[0]?.error ?? "", /模型服务出错/);
  });

  test("5 客户端断开：撤销还没开始的段落，不再返回整份译文", async () => {
    mock.setDelay(200);
    const text = Array.from({ length: 8 }, (_, i) => `Paragraph number ${i} in a long document.`).join("\n\n");
    const { req, done } = send("/api/translate-document", { method: "POST", headers: { ...AUTH, "content-type": "application/json" }, body: docBody("markdown", text) });
    done.catch(() => {});
    await waitFor(() => mock.inflight() === 3);
    req.destroy();
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(mock.requests.length, 3);
    await waitFor(() => readFileSync(join(home, "logs", "aitd.log"), "utf8").includes('"cancelled":true'));
  });

  test("6 默认走 batch 通道（最多占 3 路）；lane 设成 interactive 能用满 4 路", async () => {
    mock.setDelay(150);
    const text = (tag: string) => Array.from({ length: 6 }, (_, i) => `${tag} paragraph number ${i}.`).join("\n\n");
    await translateDoc("markdown", text("Batch"));
    assert.equal(mock.maxConcurrent(), 3);
    mock.reset();
    mock.setDelay(150);
    await translateDoc("markdown", text("Interactive"), { lane: "interactive" });
    assert.equal(mock.maxConcurrent(), 4);
  });

  test("鉴权、来源和请求体校验", async () => {
    const body = docBody("markdown", "Hello there.");
    assert.equal((await call("/api/translate-document", { method: "POST", headers: { "content-type": "application/json" }, body })).status, 401);
    assert.equal((await call("/api/translate-document", { method: "POST", headers: { ...AUTH, origin: "https://evil.example" }, body })).status, 403);
    assert.equal((await call("/api/translate-document", { headers: AUTH })).status, 405);
    assert.equal((await translateDoc("html", "<p>Hi</p>")).status, 400);
    assert.equal((await call("/api/translate-document", { method: "POST", headers: AUTH, body: JSON.stringify({ format: "markdown", text: 1, target: "zh", model: "index-translate-2b" }) })).status, 400);
    assert.equal((await translateDoc("markdown", "Hi there.", { bilingual: "yes" })).status, 400);
    assert.equal((await translateDoc("markdown", "Hi there.", { model: "other-model" })).status, 400);
    assert.equal((await translateDoc("markdown", "Hi there.", { lane: "urgent" })).status, 400);
    assert.equal((await translateDoc("markdown", "x".repeat(1024 * 1024))).status, 413);
    assert.equal(mock.requests.length, 0);
  });
});

// Goal 6 CP5：桌面应用「重启翻译服务」后马上加载模型
describe("aitd /api/model/load", () => {
  test("马上开始加载模型，不等加载完就返回 202 和当前状态；不带密钥 401；只支持 POST", async () => {
    let calls = 0;
    let state: "stopped" | "starting" = "stopped";
    const external = new ExternalModel({ endpoint: mock.url, apiKey: MODEL_KEY });
    const managed = {
      profile: external.profile,
      translator: (signal: AbortSignal) => external.translator(signal),
      status: async () => ({ state, model: "index-translate-2b", quant: "Q8_0" }),
      close: async () => {},
      preload: async () => {
        calls++;
        state = "starting";
        await new Promise((r) => setTimeout(r, 200));
      },
    };
    await aitd.close();
    aitd = await startAitd({ port: 0, apiKey: KEY, home, model: managed, version: "test" });
    const started = performance.now();
    const res = await call("/api/model/load", { method: "POST", headers: AUTH });
    assert.equal(res.status, 202);
    assert.ok(performance.now() - started < 150, "不等加载完");
    assert.equal(JSON.parse(res.text).model.state, "starting");
    assert.equal(calls, 1);
    assert.equal((await call("/api/model/load", { method: "POST" })).status, 401);
    assert.equal((await call("/api/model/load", { headers: AUTH })).status, 405);
    assert.equal(calls, 1);
    assert.ok(readFileSync(join(home, "logs", "aitd.log"), "utf8").includes('"event":"model-load-requested"'));
  });

  test("连外部模型服务时没有加载这一步：照样返回 202 和状态", async () => {
    const res = await call("/api/model/load", { method: "POST", headers: AUTH });
    assert.equal(res.status, 202);
    assert.equal(JSON.parse(res.text).model.state, "ready");
  });
});
