// 译文缓存：SQLite（Node 自带的 node:sqlite），插件和命令行共用。上限条数，按最近使用淘汰。
import type { CacheStore } from "@ai-translate/core";
import { closeSync, chmodSync, existsSync, openSync } from "node:fs";
import { DatabaseSync, type StatementSync } from "node:sqlite";

export interface SqliteCacheOptions {
  /** 默认 10 万条（约 50MB，Goal 4 CP0 实测） */
  maxEntries?: number;
  /** 每写多少次检查一次是否超上限 */
  pruneEvery?: number;
  /** 测试时注入，控制「最近使用」的先后 */
  now?: () => number;
}

export class SqliteCache implements CacheStore {
  readonly #db: DatabaseSync;
  readonly #maxEntries: number;
  readonly #pruneEvery: number;
  readonly #now: () => number;
  readonly #get: StatementSync;
  readonly #touch: StatementSync;
  readonly #put: StatementSync;
  #writes = 0;
  #closed = false;

  constructor(file: string, options: SqliteCacheOptions = {}) {
    this.#maxEntries = options.maxEntries ?? 100_000;
    this.#pruneEvery = options.pruneEvery ?? 200;
    this.#now = options.now ?? Date.now;
    // 译文是主人读过的内容，文件只给自己读写；SQLite 的 -wal、-shm 文件沿用数据库文件的权限
    if (!existsSync(file)) closeSync(openSync(file, "a", 0o600));
    chmodSync(file, 0o600);
    this.#db = new DatabaseSync(file);
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS translations (key TEXT PRIMARY KEY, text TEXT NOT NULL, at INTEGER NOT NULL) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS translations_at ON translations (at);
    `);
    this.#get = this.#db.prepare("SELECT text FROM translations WHERE key = ?");
    this.#touch = this.#db.prepare("UPDATE translations SET at = ? WHERE key = ?");
    this.#put = this.#db.prepare("INSERT OR REPLACE INTO translations (key, text, at) VALUES (?, ?, ?)");
    this.prune();
  }

  // aitd 退出时，已经开始的翻译还会陆续完成：关闭后读写都当作没有缓存，不报错
  async get(key: string): Promise<string | undefined> {
    if (this.#closed) return undefined;
    const row = this.#get.get(key) as { text: string } | undefined;
    if (row === undefined) return undefined;
    this.#touch.run(this.#now(), key);
    return row.text;
  }

  async set(key: string, text: string): Promise<void> {
    if (this.#closed) return;
    this.#put.run(key, text, this.#now());
    if (++this.#writes % this.#pruneEvery === 0) this.prune();
  }

  get size(): number {
    return (this.#db.prepare("SELECT COUNT(*) AS n FROM translations").get() as { n: number }).n;
  }

  /** 超过上限时删掉最久没用的条目，返回删掉的条数 */
  prune(): number {
    const result = this.#db
      .prepare("DELETE FROM translations WHERE key IN (SELECT key FROM translations ORDER BY at DESC LIMIT -1 OFFSET ?)")
      .run(this.#maxEntries);
    return Number(result.changes);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#db.close();
  }
}
