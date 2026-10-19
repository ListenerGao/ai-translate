import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { checkTranslation, missingNumbers, missingTerms, residualEnglish } from "./checks.ts";

describe("residualEnglish", () => {
  test("报出没翻的普通英文词（评估里的真实例子）", () => {
    assert.deepEqual(residualEnglish("对于通过 drop 函数释放内存的 scoping、所有权和内存之间的关系"), ["scoping"]);
    assert.deepEqual(residualEnglish("这些因素包括翻译的 intended 用途"), ["intended"]);
    assert.deepEqual(residualEnglish("从 mockup 开始"), ["mockup"]);
  });

  test("专名、缩写、代码名、允许清单里的词不报", () => {
    const ok = "调用 String::from 和 __init__() 时，GPT-4 与 Hugging Face 的 PaaS 用 useState 和 props 传递 token，e.g. 不算";
    assert.deepEqual(residualEnglish(ok), []);
  });

  test("括注的英文全称里的小写虚词不算；没翻的普通词照样报", () => {
    assert.deepEqual(residualEnglish("BERT（Bidirectional Encoder Representations from Transformers）"), []);
    assert.deepEqual(residualEnglish("关于 the intended use 的说明"), ["the", "intended", "use"]);
  });

  test("格式标记本身不算英文", () => {
    assert.deepEqual(residualEnglish("先读<g1>设置指南</g1>，再调用 <x2/>"), []);
  });
});

describe("missingNumbers", () => {
  test("原文的数字在译文里都要有，千位逗号不影响", () => {
    assert.deepEqual(missingNumbers("one or more $40,000+ GPUs in 2023", "2023 年一块或多块 40000 美元以上的 GPU"), []);
    assert.deepEqual(missingNumbers("cheaper by 27x than in 2023", "比 2023 年便宜了很多"), ["27"]);
    assert.deepEqual(missingNumbers("(e.g. 5.0, 1.6)", "（例如 5.0、1.6）"), []);
  });
});

describe("missingTerms", () => {
  test("命中的内置术语必须按规定译", () => {
    assert.deepEqual(missingTerms("Start with the mockup", "从设计稿开始"), []);
    assert.deepEqual(missingTerms("Start with the mockup", "从模型开始").map((e) => e.to), ["设计稿"]);
  });
});

describe("checkTranslation", () => {
  test("带格式的段落：标记保住就不比数字；没保住就报格式，再比数字", () => {
    const sample = {
      id: "m01",
      kind: "带格式段落",
      source: "The integer numbers (e.g. 2, 4, 20) have type int.",
      markup: "The integer numbers (e.g. <x1/>, <x2/>, <x3/>) have type <g4><x5/></g4>.",
    };
    assert.deepEqual(checkTranslation(sample, "整数（例如 <x1/>、<x2/>、<x3/>）的类型是 <g4><x5/></g4>。"), []);
    const lost = checkTranslation(sample, "整数（例如 2、4）的类型是整型。").map((f) => `${f.check}:${f.detail}`);
    assert.deepEqual(lost, ["格式标记:没保住，退回纯文本", "数字丢失:20"]);
  });

  test("原样照抄算译文异常", () => {
    const flags = checkTranslation({ id: "x", kind: "段落", source: "The quick brown fox jumps over the lazy dog." }, "The quick brown fox jumps over the lazy dog.");
    assert.ok(flags.some((f) => f.check === "译文异常"));
  });
});
