import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { cacheKey, type CacheKeyInput } from "./cache-key.ts";

const base: CacheKeyInput = {
  model: "index-translate-2b",
  source: "auto",
  target: "zh",
  glossary: [{ from: "liveness probe", to: "存活探针" }],
  text: "When the liveness probe fails.",
};

describe("cacheKey", () => {
  test("同输入结果稳定，是 64 位十六进制", async () => {
    const a = await cacheKey(base);
    assert.match(a, /^[0-9a-f]{64}$/);
    assert.equal(a, await cacheKey({ ...base }));
  });

  test("原文首尾空白、语言代码大小写、术语顺序不影响结果", async () => {
    const a = await cacheKey({ ...base, glossary: [{ from: "b", to: "2" }, { from: "a", to: "1" }] });
    const b = await cacheKey({
      ...base,
      text: `  ${base.text}\n`,
      target: "ZH",
      glossary: [{ from: "a", to: "1" }, { from: "b", to: "2" }],
    });
    assert.equal(a, b);
  });

  test("任一要素变化，键就变", async () => {
    const original = await cacheKey(base);
    const variants: Partial<CacheKeyInput>[] = [
      { model: "index-translate-9b" },
      { source: "en" },
      { target: "ja" },
      { glossary: [] },
      { glossary: [{ from: "liveness probe", to: "存活检测" }] },
      { text: "When the readiness probe fails." },
      { promptVersion: 999 },
    ];
    for (const v of variants) {
      assert.notEqual(await cacheKey({ ...base, ...v }), original, JSON.stringify(v));
    }
  });
});
