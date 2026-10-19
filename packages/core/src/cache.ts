// 译文缓存接口：插件用 IndexedDB，aitd 用 SQLite，单测用内存。

export interface CacheStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, text: string): Promise<void>;
}

/** 单测用；持久化存储打不开时也退回到它，只是进程退出就丢 */
export class MemoryCache implements CacheStore {
  readonly #map = new Map<string, string>();

  async get(key: string): Promise<string | undefined> {
    return this.#map.get(key);
  }

  async set(key: string, text: string): Promise<void> {
    this.#map.set(key, text);
  }
}
