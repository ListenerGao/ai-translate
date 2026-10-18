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

  test("并发上限必须是正整数", () => {
    assert.throws(() => new Scheduler(0), RangeError);
  });
});
