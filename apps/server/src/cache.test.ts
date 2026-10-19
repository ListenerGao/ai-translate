import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { SqliteCache } from "./cache.ts";
import { GlossaryFile, mergeGlossary } from "./glossary.ts";
import { Logger } from "./log.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aitd-store-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("SqliteCache", () => {
  test("7 超过上限按最近使用淘汰：读过的条目留下，最久没用的删掉；重新打开后数据还在", async () => {
    let clock = 0;
    const file = join(dir, "cache.db");
    const cache = new SqliteCache(file, { maxEntries: 3, pruneEvery: 1, now: () => ++clock });
    await cache.set("a", "甲");
    await cache.set("b", "乙");
    await cache.set("c", "丙");
    assert.equal(await cache.get("a"), "甲"); // a 变成最近用过
    await cache.set("d", "丁"); // 超上限：删掉最久没用的 b
    assert.equal(cache.size, 3);
    assert.equal(await cache.get("b"), undefined);
    cache.close();

    const reopened = new SqliteCache(file, { maxEntries: 3 });
    assert.deepEqual(await Promise.all(["a", "b", "c", "d"].map((k) => reopened.get(k))), ["甲", undefined, "丙", "丁"]);
    reopened.close();
    assert.equal(statSync(file).mode & 0o777, 0o600);
  });

  test("打开时就超上限（比如改小了上限）：先淘汰到上限以内", async () => {
    const file = join(dir, "cache.db");
    const big = new SqliteCache(file, { maxEntries: 10 });
    for (let i = 0; i < 6; i++) await big.set(`k${i}`, `v${i}`);
    big.close();
    const small = new SqliteCache(file, { maxEntries: 2 });
    assert.equal(small.size, 2);
    small.close();
  });
});

describe("GlossaryFile", () => {
  test("文件不存在时为空；手改出错的行跳过，其余生效", async () => {
    assert.deepEqual(new GlossaryFile(join(dir, "none.txt")).entries, []);
    const file = join(dir, "glossary.txt");
    const g = new GlossaryFile(file);
    assert.deepEqual(g.save("token=词元"), { ok: true, count: 1 });
    assert.equal(existsSync(`${file}.tmp`), false);
    const { writeFileSync } = await import("node:fs");
    writeFileSync(file, "token=词元\nbroken line\nprompt=提示词");
    assert.deepEqual(new GlossaryFile(file).entries.map((e) => e.from), ["token", "prompt"]);
  });

  test("合并术语：请求带的优先，同一原文忽略大小写只留一条", () => {
    const merged = mergeGlossary([{ from: "Token", to: "令牌" }], [{ from: "token", to: "词元" }, { from: "prompt", to: "提示词" }]);
    assert.deepEqual(merged, [{ from: "Token", to: "令牌" }, { from: "prompt", to: "提示词" }]);
  });
});

describe("Logger", () => {
  test("超过上限轮转一次：旧内容挪到 .1，新文件从头写", () => {
    const file = join(dir, "aitd.log");
    const log = new Logger(file, { maxBytes: 300 });
    for (let i = 0; i < 6; i++) log.info("request", { status: 200, ms: i });
    assert.ok(existsSync(`${file}.1`));
    assert.ok(statSync(file).size <= 300);
    const lines = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(lines.at(-1).ms, 5);
  });
});
