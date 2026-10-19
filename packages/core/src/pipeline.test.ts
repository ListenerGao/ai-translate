import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { MemoryCache } from "./cache.ts";
import { parseGlossary } from "./glossary.ts";
import { Pipeline, type PipelineJob } from "./pipeline.ts";
import type { Segment, TranslateRequest, TranslateResult, Translator } from "./protocol.ts";
import { Scheduler } from "./scheduler.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

/**
 * 入队之前要先算缓存键（异步哈希，在线程池里算），几段同时调用时入队先后不固定。
 * 测排队顺序的用例：先让第一段开始并占住唯一的槽位，等其余段落都排进队列再放行。
 */
async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("等待超时");
    await new Promise((r) => setTimeout(r, 1));
  }
}

class FakeTranslator implements Translator {
  calls: string[] = [];
  delayMs = 0;
  /** 设了就等它放行再返回：让第一段一直占着槽位，直到后面的段落都排进队列 */
  gate: Promise<void> | null = null;
  async *translate(req: TranslateRequest): AsyncIterable<TranslateResult> {
    for (const s of req.segments) {
      this.calls.push(s.text);
      if (this.gate !== null) await this.gate;
      await new Promise((r) => setTimeout(r, this.delayMs));
      yield { id: s.id, text: `译:${s.text}`, cached: false };
    }
  }
}

function setup(glossaryText = "", concurrency = 4) {
  const translator = new FakeTranslator();
  const scheduler = new Scheduler(concurrency);
  const raw = new Pipeline({ cache: new MemoryCache(), scheduler });
  let glossary = parseGlossary(glossaryText).entries;
  const segmentJob = (segment: Segment, priority = 0): PipelineJob => ({
    taskId: segment.id,
    segment,
    priority,
    source: "auto",
    target: "zh",
    model: "index-translate-2b",
    glossary,
  });
  const job = (id: string, text: string, priority = 0) => segmentJob({ id, text }, priority);
  // 测试里只有一个翻译实现，省掉每次传参
  const pipeline = { translate: (j: PipelineJob, signal?: AbortSignal) => raw.translate(j, translator, signal) };
  return { translator, scheduler, pipeline, job, segmentJob, setGlossary: (text: string) => (glossary = parseGlossary(text).entries) };
}

describe("Pipeline", () => {
  test("第一次翻译，第二次命中缓存不再调用模型", async () => {
    const { pipeline, translator, job } = setup();
    assert.deepEqual(await pipeline.translate(job("a", "Hello there")), { text: "译:Hello there", cached: false });
    assert.deepEqual(await pipeline.translate(job("b", "Hello there")), { text: "译:Hello there", cached: true });
    assert.equal(translator.calls.length, 1);
  });

  test("通道传给调度队列：batch 排在 interactive 后面", async () => {
    const { pipeline, translator, scheduler, segmentJob } = setup("", 1);
    const gate = deferred();
    translator.gate = gate.promise;
    const first = pipeline.translate(segmentJob({ id: "a", text: "Blocking paragraph text" }));
    await waitFor(() => scheduler.active === 1);
    const batch = pipeline.translate({ ...segmentJob({ id: "b", text: "Batch paragraph text" }, 0), lane: "batch" });
    const page = pipeline.translate(segmentJob({ id: "c", text: "Page paragraph text" }, 9));
    await waitFor(() => scheduler.pending === 2);
    gate.resolve();
    await Promise.all([first, batch, page]);
    assert.deepEqual(translator.calls, ["Blocking paragraph text", "Page paragraph text", "Batch paragraph text"]);
  });

  test("相同内容同时在翻时只翻一次", async () => {
    const { pipeline, translator, job } = setup();
    translator.delayMs = 20;
    const results = await Promise.all([pipeline.translate(job("a", "Same text")), pipeline.translate(job("b", "Same text"))]);
    assert.equal(translator.calls.length, 1);
    assert.deepEqual(results.map((r) => r.text), ["译:Same text", "译:Same text"]);
  });

  test("命中的术语变了，缓存不命中", async () => {
    const { pipeline, translator, job, setGlossary } = setup("token=词元");
    await pipeline.translate(job("a", "Each token is sent."));
    setGlossary("token=令牌");
    const r = await pipeline.translate(job("b", "Each token is sent."));
    assert.equal(r.cached, false);
    assert.equal(translator.calls.length, 2);
  });

  test("没命中的术语改了，缓存照样命中", async () => {
    const { pipeline, translator, job, setGlossary } = setup("pod=Pod");
    await pipeline.translate(job("a", "Each token is sent."));
    setGlossary("pod=容器组");
    assert.equal((await pipeline.translate(job("b", "Each token is sent."))).cached, true);
    assert.equal(translator.calls.length, 1);
  });

  test("排队期间同样内容已被翻好：开始时再查缓存，不重复调用模型", async () => {
    const { pipeline, translator, scheduler, job } = setup("", 1);
    const gate = deferred();
    translator.gate = gate.promise;
    const first = pipeline.translate(job("a", "Blocking paragraph text"));
    await waitFor(() => scheduler.active === 1);
    const queued = pipeline.translate(job("b", "Same text twice", 5));
    const jumped = pipeline.translate(job("c", "Same text twice", -1));
    await waitFor(() => scheduler.pending === 2);
    gate.resolve();
    await Promise.all([first, queued, jumped]);
    assert.deepEqual(translator.calls, ["Blocking paragraph text", "Same text twice"]);
  });

  test("同一段文字带格式和不带格式分开缓存", async () => {
    const { pipeline, translator, segmentJob } = setup();
    const text = "Read the setup guide first.";
    await pipeline.translate(segmentJob({ id: "a", text, markup: "Read <g1>the setup guide</g1> first." }));
    const plain = await pipeline.translate(segmentJob({ id: "b", text }));
    assert.equal(plain.cached, false);
    assert.equal(translator.calls.length, 2);
    const again = await pipeline.translate(segmentJob({ id: "c", text, markup: "Read <g1>the setup guide</g1> first." }));
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
    const { pipeline, translator, scheduler, job } = setup("", 1);
    const gate = deferred();
    translator.gate = gate.promise;
    const running = pipeline.translate(job("a", "First paragraph here"));
    await waitFor(() => scheduler.active === 1);
    const queued = pipeline.translate(job("b", "Second paragraph here", 5));
    await waitFor(() => scheduler.pending === 1);
    assert.equal(scheduler.cancel("b"), true);
    gate.resolve();
    await assert.rejects(queued, { name: "AbortError" });
    await running;
    assert.deepEqual(translator.calls, ["First paragraph here"]);
  });
});
