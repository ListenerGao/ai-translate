import { getModelProfile, type TranslateRequest } from "@ai-translate/core";
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { startMockServer, type MockServer } from "../../../../tests/mock-server.ts";
import { TranslateError, isAbortError } from "../shared/errors.ts";
import { LlamaServerTranslator } from "./translator.ts";

const KEY = "test-key";
const SOURCE = "The server sends each token as a separate event.";

function request(text = SOURCE, glossary: TranslateRequest["glossary"] = []): TranslateRequest {
  return { segments: [{ id: "s1", text }], source: "auto", target: "zh", model: "index-translate-2b", glossary };
}

async function first(it: AsyncIterable<{ text: string }>): Promise<string> {
  for await (const r of it) return r.text;
  throw new Error("no result");
}

describe("LlamaServerTranslator", () => {
  let mock: MockServer;
  const make = (overrides: { endpoint?: string; apiKey?: string; timeoutMs?: number } = {}) =>
    new LlamaServerTranslator({
      endpoint: overrides.endpoint ?? mock.url,
      apiKey: overrides.apiKey ?? KEY,
      profile: { ...getModelProfile("index-translate-2b"), timeoutMs: overrides.timeoutMs ?? 2_000 },
    });
  const signal = () => new AbortController().signal;
  const rejectsWith = (p: Promise<unknown>, code: string) =>
    assert.rejects(p, (err) => err instanceof TranslateError && err.code === code);

  before(async () => {
    mock = await startMockServer({ apiKey: KEY });
  });
  after(() => mock.close());
  beforeEach(() => {
    mock.reset();
    mock.setDelay(0);
  });

  test("正常返回译文；请求参数符合约定", async () => {
    assert.equal(await first(make().translate(request(), signal())), `【译】${SOURCE}`);
    const req = mock.requests[0]!;
    assert.equal(req.auth, `Bearer ${KEY}`);
    assert.equal(req.body.model, "index-translate-2b");
    assert.equal(req.body.temperature, 0);
    assert.equal(req.body.max_tokens, 1024);
    assert.deepEqual(req.body.chat_template_kwargs, { enable_thinking: false });
    assert.equal(req.prompt, `请将以下文本翻译为中文，直接输出翻译结果，不要进行任何解释。\n\n${SOURCE}`);
  });

  test("只把本段命中的术语放进 prompt", async () => {
    const glossary = [{ from: "token", to: "词元" }, { from: "pod", to: "Pod" }];
    await first(make().translate(request(SOURCE, glossary), signal()));
    assert.match(mock.requests[0]!.prompt, /专名\/术语对照: token→词元\n/);
    assert.doesNotMatch(mock.requests[0]!.prompt, /pod→Pod/);
  });

  test("密钥不对：unauthorized", async () => {
    await rejectsWith(first(make({ apiKey: "wrong" }).translate(request(), signal())), "unauthorized");
  });

  test("服务出错：server", async () => {
    mock.setResponder(() => ({ status: 500 }));
    await rejectsWith(first(make().translate(request(), signal())), "server");
  });

  test("超时：timeout", async () => {
    mock.setDelay(500);
    await rejectsWith(first(make({ timeoutMs: 100 }).translate(request(), signal())), "timeout");
  });

  test("连不上服务：unreachable", async () => {
    await rejectsWith(first(make({ endpoint: "http://127.0.0.1:9" }).translate(request(), signal())), "unreachable");
  });

  test("返回思考内容：重试 1 次，第二次正常就通过", async () => {
    mock.setResponder((_req, i) => (i === 0 ? { content: "<think>想想</think>" } : undefined));
    assert.equal(await first(make().translate(request(), signal())), `【译】${SOURCE}`);
    assert.equal(mock.requests.length, 2);
  });

  test("两次都不合格：invalid，只请求 2 次", async () => {
    mock.setResponder(() => ({ content: "Le serveur envoie chaque jeton." }));
    await rejectsWith(first(make().translate(request(), signal())), "invalid");
    assert.equal(mock.requests.length, 2);
  });

  test("两次都原样照抄原文（品牌名、产品名）：照常返回，不算错", async () => {
    const brand = "Hugging Face Hub";
    mock.setResponder(() => ({ content: brand }));
    assert.equal(await first(make().translate(request(brand), signal())), brand);
    assert.equal(mock.requests.length, 2);
  });

  test("服务地址不是本机：endpoint，不发请求", async () => {
    await rejectsWith(first(make({ endpoint: "https://example.com" }).translate(request(), signal())), "endpoint");
    assert.equal(mock.requests.length, 0);
  });

  test("没填密钥：no-key，不发请求", async () => {
    await rejectsWith(first(make({ apiKey: " " }).translate(request(), signal())), "no-key");
    assert.equal(mock.requests.length, 0);
  });

  describe("带格式的段落", () => {
    const TEXT = "Read the setup guide before running npm ci.";
    const MARKUP = "Read <g1>the setup guide</g1> before running <x2/>.";
    const withMarkup = (glossary: TranslateRequest["glossary"] = []): TranslateRequest => ({
      segments: [{ id: "m1", text: TEXT, markup: MARKUP }],
      source: "auto",
      target: "zh",
      model: "index-translate-2b",
      glossary,
    });

    test("标记保住：返回带标记的译文，只请求 1 次，prompt 要求保留标记", async () => {
      mock.setResponder(() => ({ content: "运行 <x2/> 之前，先阅读<g1>安装指南</g1>。" }));
      assert.equal(await first(make().translate(withMarkup(), signal())), "运行 <x2/> 之前，先阅读<g1>安装指南</g1>。");
      assert.equal(mock.requests.length, 1);
      assert.match(mock.requests[0]!.prompt, /【硬性要求】保留所有的标记（如 <g1>、<\/g1>、<x2\/>）原样不变/);
      assert.equal(mock.requests[0]!.source, MARKUP);
    });

    test("标记没保住：退回纯文本翻译，第二次请求不带标记", async () => {
      mock.setResponder((req) => (req.prompt.includes("保留所有的标记") ? { content: "运行之前先阅读安装指南。" } : undefined));
      assert.equal(await first(make().translate(withMarkup(), signal())), `【译】${TEXT}`);
      assert.equal(mock.requests.length, 2);
      assert.equal(mock.requests[1]!.source, TEXT);
      assert.doesNotMatch(mock.requests[1]!.prompt, /标记/);
    });

    test("去掉标记两侧多余的空格", async () => {
      mock.setResponder(() => ({ content: "运行 <x2/> 之前，先阅读 <g1> 安装指南</g1> 。" }));
      assert.equal(await first(make().translate(withMarkup(), signal())), "运行 <x2/> 之前，先阅读<g1>安装指南</g1>。");
    });

    test("术语表按纯文字匹配，和标记要求一起放进 prompt", async () => {
      await first(make().translate(withMarkup([{ from: "setup guide", to: "安装指南" }]), signal()));
      assert.match(mock.requests[0]!.prompt, /1\. 【硬性要求】保留所有的标记[^\n]*\n2\. 【硬性要求】专名\/术语对照: setup guide→安装指南/);
    });
  });

  test("调用方撤销：抛出 AbortError", async () => {
    mock.setDelay(500);
    const controller = new AbortController();
    const pending = first(make().translate(request(), controller.signal));
    setTimeout(() => controller.abort(), 50);
    await assert.rejects(pending, (err) => isAbortError(err));
  });
});
