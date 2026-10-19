import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { Scheduler } from "./scheduler.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("Scheduler", () => {
  test("按优先级出队，同优先级先到先得", async () => {
    const s = new Scheduler(1);
    const gate = deferred();
    const order: string[] = [];
    const add = (id: string, priority: number) =>
      s.enqueue({ id, priority, run: async () => void order.push(id) });

    const blocker = s.enqueue({ id: "blocker", priority: 0, run: () => gate.promise });
    const rest = [add("p5", 5), add("p1-a", 1), add("p3", 3), add("p1-b", 1)];
    gate.resolve();
    await Promise.all([blocker, ...rest]);
    assert.deepEqual(order, ["p1-a", "p1-b", "p3", "p5"]);
  });

  test("interactive 通道排在 batch 前面，不管优先级数值；没写通道按 interactive", async () => {
    const s = new Scheduler(1);
    const gate = deferred();
    const order: string[] = [];
    const add = (id: string, priority: number, lane?: "interactive" | "batch") =>
      s.enqueue({ id, priority, ...(lane === undefined ? {} : { lane }), run: async () => void order.push(id) });

    const blocker = s.enqueue({ id: "blocker", priority: 0, run: () => gate.promise });
    const rest = [add("batch-0", 0, "batch"), add("batch-1", 1, "batch"), add("page-9", 9, "interactive"), add("default-5", 5)];
    gate.resolve();
    await Promise.all([blocker, ...rest]);
    assert.deepEqual(order, ["default-5", "page-9", "batch-0", "batch-1"]);
  });

  test("同时运行的任务数不超过上限", async () => {
    const s = new Scheduler(2);
    let running = 0;
    let peak = 0;
    const tasks = Array.from({ length: 6 }, (_, i) =>
      s.enqueue({
        id: `t${i}`,
        priority: i,
        run: async () => {
          running++;
          peak = Math.max(peak, running);
          await new Promise((r) => setTimeout(r, 10));
          running--;
          return i;
        },
      }),
    );
    assert.deepEqual(await Promise.all(tasks), [0, 1, 2, 3, 4, 5]);
    assert.equal(peak, 2);
  });

  test("没开始的任务能撤销：拒绝为 AbortError，run 不会被调用", async () => {
    const s = new Scheduler(1);
    const gate = deferred();
    let called = false;
    const blocker = s.enqueue({ id: "a", priority: 0, run: () => gate.promise });
    const queued = s.enqueue({ id: "b", priority: 0, run: async () => void (called = true) });

    assert.equal(s.cancel("b"), true);
    await assert.rejects(queued, { name: "AbortError" });
    gate.resolve();
    await blocker;
    await tick();
    assert.equal(called, false);
    assert.equal(s.pending, 0);
  });

  test("已开始的任务撤销不了，完成后照常返回", async () => {
    const s = new Scheduler(1);
    const gate = deferred();
    const running = s.enqueue({ id: "a", priority: 0, run: async () => (await gate.promise, "done") });
    await tick();
    assert.equal(s.cancel("a"), false);
    gate.resolve();
    assert.equal(await running, "done");
  });

  test("同 id 重复入队只执行一次，并用新的优先级", async () => {
    const s = new Scheduler(1);
    const gate = deferred();
    const order: string[] = [];
    const blocker = s.enqueue({ id: "blocker", priority: 0, run: () => gate.promise });
    const x1 = s.enqueue({ id: "x", priority: 9, run: async () => (order.push("x"), "x") });
    const y = s.enqueue({ id: "y", priority: 5, run: async () => (order.push("y"), "y") });
    const x2 = s.enqueue({ id: "x", priority: 1, run: async () => (order.push("x-again"), "x-again") });
    gate.resolve();
    await Promise.all([blocker, x1, y, x2]);
    assert.equal(await x2, "x");
    assert.deepEqual(order, ["x", "y"]);
  });

  test("setPriority 改变出队顺序；cancelWhere 按条件撤销", async () => {
    const s = new Scheduler(1);
    const gate = deferred();
    const order: string[] = [];
    const add = (id: string, priority: number) => s.enqueue({ id, priority, run: async () => void order.push(id) });
    const blocker = s.enqueue({ id: "blocker", priority: 0, run: () => gate.promise });
    const a = add("1:a", 1);
    const b = add("1:b", 2);
    const c = add("2:c", 3);
    s.setPriority("2:c", 0);
    assert.equal(s.cancelWhere((id) => id === "1:b"), 1);
    gate.resolve();
    await Promise.all([blocker, a, c]);
    await assert.rejects(b, { name: "AbortError" });
    assert.deepEqual(order, ["2:c", "1:a"]);
  });

  test("并发上限必须是正整数；batchLimit 在 1 到并发上限之间", () => {
    assert.throws(() => new Scheduler(0), RangeError);
    assert.throws(() => new Scheduler(4, { batchLimit: 0 }), RangeError);
    assert.throws(() => new Scheduler(4, { batchLimit: 5 }), RangeError);
    assert.equal(new Scheduler(4).batchLimit, 4);
  });
});

describe("Scheduler batchLimit", () => {
  /** 往队列里放 n 个卡在 gate 上的任务，记录同时运行的峰值 */
  function blocked(s: Scheduler, prefix: string, n: number, lane: "interactive" | "batch") {
    const gate = deferred();
    const stats = { running: 0, peak: 0 };
    const tasks = Array.from({ length: n }, (_, i) =>
      s.enqueue({
        id: `${prefix}${i}`,
        priority: i,
        lane,
        run: async () => {
          stats.peak = Math.max(stats.peak, ++stats.running);
          await gate.promise;
          stats.running--;
        },
      }),
    );
    return { gate, stats, all: Promise.all(tasks) };
  }

  test("batch 同时最多跑 batchLimit 个；空着的槽位留给 interactive，来了马上开始", async () => {
    const s = new Scheduler(4, { batchLimit: 3 });
    const batch = blocked(s, "b", 10, "batch");
    await tick();
    assert.equal(s.active, 3);
    assert.equal(s.pending, 7);
    // batch 全都卡着，interactive 照样能跑完
    assert.equal(await s.enqueue({ id: "page", priority: 0, lane: "interactive", run: async () => "done" }), "done");
    batch.gate.resolve();
    await batch.all;
    assert.equal(batch.stats.peak, 3);
  });

  test("interactive 能用满全部槽位，batch 等它们让出", async () => {
    const s = new Scheduler(4, { batchLimit: 3 });
    const page = blocked(s, "p", 4, "interactive");
    const batch = blocked(s, "b", 2, "batch");
    batch.gate.resolve();
    await tick();
    assert.equal(s.active, 4);
    assert.equal(batch.stats.peak, 0);
    page.gate.resolve();
    await Promise.all([page.all, batch.all]);
    assert.equal(page.stats.peak, 4);
  });

  test("不设 batchLimit（插件端）：batch 也能用满全部槽位，行为不变", async () => {
    const s = new Scheduler(4);
    const batch = blocked(s, "b", 6, "batch");
    await tick();
    assert.equal(s.active, 4);
    batch.gate.resolve();
    await batch.all;
    assert.equal(batch.stats.peak, 4);
  });
});
