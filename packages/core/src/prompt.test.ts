import assert from "node:assert/strict";
import { describe, test } from "node:test";
import fixture from "./fixtures/official-prompts.json" with { type: "json" };
import { buildPrompt } from "./prompt.ts";

describe("buildPrompt", () => {
  // fixture 由官方 inference/llm/translate.py 的 trans_prompt 生成，逐字比对
  for (const c of fixture.cases) {
    test(`与官方格式逐字一致：${c.name}`, () => {
      const actual = buildPrompt(c.text, { source: c.source, target: c.target, glossary: c.glossary });
      assert.equal(actual, c.expected);
    });
  }

  test("术语为空数组时用无约束格式", () => {
    const withEmpty = buildPrompt("Hello.", { source: "auto", target: "zh", glossary: [] });
    const without = buildPrompt("Hello.", { source: "auto", target: "zh" });
    assert.equal(withEmpty, without);
    assert.ok(!withEmpty.includes("约束要求"));
  });

  test("源语言大小写不敏感，空串当作自动识别", () => {
    assert.ok(buildPrompt("Hi.", { source: "EN", target: "zh" }).startsWith("请将以下英语文本翻译为中文"));
    assert.ok(buildPrompt("Hi.", { source: "", target: "zh" }).startsWith("请将以下文本翻译为中文"));
  });

  test("有格式标记：先列标记要求，再列术语对照，举例最多 3 个标记", () => {
    const prompt = buildPrompt("Read <g1>the guide</g1> and <g2>the notes</g2>, then run <x3/>.", {
      source: "auto",
      target: "zh",
      glossary: [{ from: "guide", to: "指南" }],
      markers: ["<g1>", "</g1>", "<g2>", "</g2>", "<x3/>"],
    });
    assert.equal(
      prompt,
      "请将以下文本翻译成中文，并且严格遵循所有约束要求。\n\n【源文】\nRead <g1>the guide</g1> and <g2>the notes</g2>, then run <x3/>.\n\n【约束要求】\n" +
        "1. 【硬性要求】保留所有的标记（如 <g1>、</g1>、<g2>）原样不变，标记内的文字照常翻译\n" +
        "2. 【硬性要求】专名/术语对照: guide→指南\n\n只输出译文，不要有任何额外说明。",
    );
  });

  test("未知目标语言直接报错", () => {
    assert.throws(() => buildPrompt("Hi.", { source: "auto", target: "xx" }), /不支持的目标语言/);
  });
});
