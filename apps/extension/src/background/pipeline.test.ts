import type { TranslateRequest, TranslateResult, Translator } from "@ai-translate/core";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DEFAULT_SETTINGS, type Settings } from "../shared/settings.ts";
import { MemoryCache } from "./cache.ts";
import { Pipeline } from "./pipeline.ts";
import { Scheduler } from "./scheduler.ts";

class FakeTranslator implements Translator {
  calls: string[] = [];
  delayMs = 0;
  async *translate(req: TranslateRequest): AsyncIterable<TranslateResult> {
    for (const s of req.segments) {
      this.calls.push(s.text);
      await new Promise((r) => setTimeout(r, this.delayMs));
      yield { id: s.id, text: `译:${s.text}`, cached: false };
    }
  }
}

function setup(settings: Partial<Settings> = {}, concurrency = 4) {
  const translator = new FakeTranslator();
  const scheduler = new Scheduler(concurrency);
  let current: Settings = { ...DEFAULT_SETTINGS, apiKey: "k", ...settings };
  const pipeline = new Pipeline({
    cache: new MemoryCache(),
    scheduler,
    getSettings: async () => current,
    createTranslator: () => translator,
  });
  const job = (id: string, text: string, priority = 0) => ({ tabId: 1, segment: { id, text }, priority });
  return { translator, scheduler, pipeline, job, update: (s: Partial<Settings>) => (current = { ...current, ...s }) };
}

describe("Pipeline", () => {
  test("第一次翻译，第二次命中缓存不再调用模型", async () => {
    const { pipeline, translator, job } = setup();
    assert.deepEqual(await pipeline.translate(job("a", "Hello there")), { text: "译:Hello there", cached: false });
    assert.deepEqual(await pipeline.translate(job("b", "Hello there")), { text: "译:Hello there", cached: true });
    assert.equal(translator.calls.length, 1);
  });

  test("相同内容同时在翻时只翻一次", async () => {
    const { pipeline, translator, job } = setup();
    translator.delayMs = 20;
    const results = await Promise.all([pipeline.translate(job("a", "Same text")), pipeline.translate(job("b", "Same text"))]);
    assert.equal(translator.calls.length, 1);
    assert.deepEqual(results.map((r) => r.text), ["译:Same text", "译:Same text"]);
  });

  test("命中的术语变了，缓存不命中", async () => {
    const { pipeline, translator, job, update } = setup({ glossaryText: "token=词元" });
    await pipeline.translate(job("a", "Each token is sent."));
    update({ glossaryText: "token=令牌" });
    const r = await pipeline.translate(job("b", "Each token is sent."));
    assert.equal(r.cached, false);
    assert.equal(translator.calls.length, 2);
  });

  test("没命中的术语改了，缓存照样命中", async () => {
    const { pipeline, translator, job, update } = setup({ glossaryText: "pod=Pod" });
    await pipeline.translate(job("a", "Each token is sent."));
    update({ glossaryText: "pod=容器组" });
    assert.equal((await pipeline.translate(job("b", "Each token is sent."))).cached, true);
    assert.equal(translator.calls.length, 1);
  });

  test("排队期间同样内容已被翻好：开始时再查缓存，不重复调用模型", async () => {
    const { pipeline, translator, job } = setup({}, 1);
    translator.delayMs = 30;
    const first = pipeline.translate(job("a", "Blocking paragraph text"));
    const queued = pipeline.translate(job("b", "Same text twice", 5));
    const jumped = pipeline.translate(job("c", "Same text twice", -1));
    await Promise.all([first, queued, jumped]);
    assert.deepEqual(translator.calls, ["Blocking paragraph text", "Same text twice"]);
  });

  test("同一段文字带格式和不带格式分开缓存", async () => {
    const { pipeline, translator } = setup();
    const text = "Read the setup guide first.";
    await pipeline.translate({ tabId: 1, segment: { id: "a", text, markup: "Read <g1>the setup guide</g1> first." }, priority: 0 });
    const plain = await pipeline.translate({ tabId: 1, segment: { id: "b", text }, priority: 0 });
    assert.equal(plain.cached, false);
    assert.equal(translator.calls.length, 2);
    const again = await pipeline.translate({ tabId: 1, segment: { id: "c", text, markup: "Read <g1>the setup guide</g1> first." }, priority: 0 });
    assert.equal(again.cached, true);
  });

  test("查缓存期间就被撤销：不进队列，不调用模型", async () => {
    const { pipeline, translator, scheduler, job } = setup();
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(pipeline.translate(job("a", "Cancelled early text"), controller.signal), { name: "AbortError" });
    assert.equal(translator.calls.length, 0);
    assert.equal(scheduler.pending + scheduler.active, 0);
  });

  test("缓存命中时即使已撤销也照常返回（译文白拿）", async () => {
    const { pipeline, job } = setup();
    await pipeline.translate(job("a", "Cached paragraph text"));
    const controller = new AbortController();
    controller.abort();
    assert.equal((await pipeline.translate(job("b", "Cached paragraph text"), controller.signal)).cached, true);
  });

  test("排队中的段落被撤销：AbortError，不调用模型", async () => {
    const { pipeline, translator, scheduler, job } = setup({}, 1);
    translator.delayMs = 30;
    const running = pipeline.translate(job("a", "First paragraph here"));
    const queued = pipeline.translate(job("b", "Second paragraph here", 5));
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(scheduler.cancel(Pipeline.taskId(1, "b")), true);
    await assert.rejects(queued, { name: "AbortError" });
    await running;
    assert.deepEqual(translator.calls, ["First paragraph here"]);
  });
});
