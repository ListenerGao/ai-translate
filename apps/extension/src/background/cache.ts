export interface CacheStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, text: string): Promise<void>;
}

/** 单测用；IndexedDB 打不开时也退回到它，只是关掉浏览器就丢 */
export class MemoryCache implements CacheStore {
  readonly #map = new Map<string, string>();

  async get(key: string): Promise<string | undefined> {
    return this.#map.get(key);
  }

  async set(key: string, text: string): Promise<void> {
    this.#map.set(key, text);
  }
}

interface Row {
  key: string;
  text: string;
  /** 最近使用时间，淘汰时先删最旧的 */
  at: number;
}

const STORE = "translations";
const TOUCH_AFTER_MS = 60 * 60 * 1000;
const PRUNE_EVERY = 200;

/** IndexedDB 译文缓存：上限 maxEntries 条，按最近使用淘汰；数据库打不开时退回内存缓存 */
export class IdbCache implements CacheStore {
  readonly #maxEntries: number;
  readonly #db: Promise<IDBDatabase>;
  readonly #fallback = new MemoryCache();
  #writes = 0;

  constructor(name = "ai-translate", maxEntries = 20_000) {
    this.#maxEntries = maxEntries;
    this.#db = new Promise((resolve, reject) => {
      const open = indexedDB.open(name, 1);
      open.onupgradeneeded = () => {
        const store = open.result.createObjectStore(STORE, { keyPath: "key" });
        store.createIndex("at", "at");
      };
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
  }

  async get(key: string): Promise<string | undefined> {
    const db = await this.#db.catch(() => null);
    if (db === null) return this.#fallback.get(key);
    const row = await request<Row | undefined>(db.transaction(STORE).objectStore(STORE).get(key));
    if (row === undefined) return undefined;
    // 读的时候顺手更新使用时间，但不必每次都写
    if (Date.now() - row.at > TOUCH_AFTER_MS) {
      void request(db.transaction(STORE, "readwrite").objectStore(STORE).put({ ...row, at: Date.now() }));
    }
    return row.text;
  }

  async set(key: string, text: string): Promise<void> {
    const db = await this.#db.catch(() => null);
    if (db === null) return this.#fallback.set(key, text);
    const row: Row = { key, text, at: Date.now() };
    await request(db.transaction(STORE, "readwrite").objectStore(STORE).put(row));
    if (++this.#writes % PRUNE_EVERY === 0) await this.prune();
  }

  /** 超过上限时删掉最久没用的条目 */
  async prune(): Promise<number> {
    const db = await this.#db.catch(() => null);
    if (db === null) return 0;
    const store = db.transaction(STORE, "readwrite").objectStore(STORE);
    const excess = (await request(store.count())) - this.#maxEntries;
    if (excess <= 0) return 0;
    let removed = 0;
    await new Promise<void>((resolve, reject) => {
      const cursor = store.index("at").openCursor();
      cursor.onsuccess = () => {
        const c = cursor.result;
        if (c === null || removed >= excess) return resolve();
        c.delete();
        removed++;
        c.continue();
      };
      cursor.onerror = () => reject(cursor.error);
    });
    return removed;
  }
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
