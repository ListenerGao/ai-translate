/** 通道：interactive 给插件（滑动翻译、划词），batch 给命令行的批量任务；interactive 永远排在 batch 前面 */
export type Lane = "interactive" | "batch";

const LANE_RANK: Record<Lane, number> = { interactive: 0, batch: 1 };

export interface Task<T> {
  /** 全局唯一 id（插件里是「标签页:段落」）；同 id 重复入队只执行一次 */
  id: string;
  /** 越小越先执行，只在同一通道内比较 */
  priority: number;
  /** 默认 interactive */
  lane?: Lane;
  run(signal: AbortSignal): Promise<T>;
}

interface Entry {
  id: string;
  lane: number;
  priority: number;
  seq: number;
  started: boolean;
  run(signal: AbortSignal): Promise<unknown>;
  resolve(value: unknown): void;
  reject(reason: unknown): void;
  promise: Promise<unknown>;
}

export interface SchedulerOptions {
  /** batch 通道最多同时运行几个任务，默认不限（等于并发上限）；aitd 留 1 路给 interactive，插件来了不用等 batch 让出 */
  batchLimit?: number;
}

/**
 * 带优先级的并发队列。并发上限等于模型服务的槽位数。
 * 先按通道（interactive 在前），同一通道内按优先级，再按先来后到；batch 同时运行的个数另有上限。
 * 没开始的任务可以撤销；已经开始的任务不打断，跑完照常返回（结果会写进缓存）。
 */
export class Scheduler {
  readonly concurrency: number;
  readonly batchLimit: number;
  #queue: Entry[] = [];
  #byId = new Map<string, Entry>();
  #running = 0;
  #runningBatch = 0;
  #seq = 0;

  constructor(concurrency: number, options: SchedulerOptions = {}) {
    if (!Number.isInteger(concurrency) || concurrency < 1) throw new RangeError("concurrency 至少为 1");
    const batchLimit = options.batchLimit ?? concurrency;
    if (!Number.isInteger(batchLimit) || batchLimit < 1 || batchLimit > concurrency) throw new RangeError("batchLimit 应在 1 到 concurrency 之间");
    this.concurrency = concurrency;
    this.batchLimit = batchLimit;
  }

  get pending(): number {
    return this.#queue.length;
  }

  get active(): number {
    return this.#running;
  }

  enqueue<T>(task: Task<T>): Promise<T> {
    const existing = this.#byId.get(task.id);
    if (existing !== undefined) {
      if (!existing.started) existing.priority = task.priority;
      return existing.promise as Promise<T>;
    }

    let resolve!: (value: unknown) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<unknown>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const entry: Entry = {
      id: task.id,
      lane: LANE_RANK[task.lane ?? "interactive"],
      priority: task.priority,
      seq: this.#seq++,
      started: false,
      run: (signal) => task.run(signal),
      resolve,
      reject,
      promise,
    };
    this.#queue.push(entry);
    this.#byId.set(task.id, entry);
    this.#pump();
    return promise as Promise<T>;
  }

  /** 撤销还没开始的任务；已开始或不存在返回 false */
  cancel(id: string): boolean {
    const entry = this.#byId.get(id);
    if (entry === undefined || entry.started) return false;
    this.#queue = this.#queue.filter((e) => e !== entry);
    this.#byId.delete(id);
    entry.reject(new DOMException("任务已撤销", "AbortError"));
    return true;
  }

  /** 撤销所有符合条件且还没开始的任务，返回撤销的个数 */
  cancelWhere(predicate: (id: string) => boolean): number {
    let count = 0;
    for (const entry of [...this.#queue]) {
      if (predicate(entry.id) && this.cancel(entry.id)) count++;
    }
    return count;
  }

  setPriority(id: string, priority: number): void {
    const entry = this.#byId.get(id);
    if (entry !== undefined && !entry.started) entry.priority = priority;
  }

  #pump(): void {
    while (this.#running < this.concurrency) {
      // batch 已经占满自己的上限时，只挑 interactive
      const batchFull = this.#runningBatch >= this.batchLimit;
      let best = -1;
      for (let i = 0; i < this.#queue.length; i++) {
        const e = this.#queue[i]!;
        if (batchFull && e.lane === LANE_RANK.batch) continue;
        if (best < 0 || before(e, this.#queue[best]!)) best = i;
      }
      if (best < 0) return;
      const [entry] = this.#queue.splice(best, 1);
      if (entry === undefined) return;
      const isBatch = entry.lane === LANE_RANK.batch;
      entry.started = true;
      this.#running++;
      if (isBatch) this.#runningBatch++;
      // 已开始的任务不打断：信号留给以后需要强制中止的场景
      entry
        .run(new AbortController().signal)
        .then(entry.resolve, entry.reject)
        .finally(() => {
          this.#running--;
          if (isBatch) this.#runningBatch--;
          this.#byId.delete(entry.id);
          this.#pump();
        });
    }
  }
}

function before(a: Entry, b: Entry): boolean {
  if (a.lane !== b.lane) return a.lane < b.lane;
  if (a.priority !== b.priority) return a.priority < b.priority;
  return a.seq < b.seq;
}
