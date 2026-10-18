import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { matchGlossary, parseGlossary } from "./glossary.ts";

describe("parseGlossary", () => {
  test("一行一条，忽略空行和 # 注释，去掉前后空格", () => {
    const { entries, errors } = parseGlossary("  liveness probe = 存活探针 \n\n# 注释\nPod=Pod\n");
    assert.deepEqual(entries, [
      { from: "liveness probe", to: "存活探针" },
      { from: "Pod", to: "Pod" },
    ]);
    assert.deepEqual(errors, []);
  });

  test("译文里可以有等号：只按第一个等号切分", () => {
    assert.deepEqual(parseGlossary("a=b=c").entries, [{ from: "a", to: "b=c" }]);
  });

  test("缺等号、两边为空的行报错并跳过，其余照常生效", () => {
    const { entries, errors } = parseGlossary("no equals\n=译文\n原文=\nok=好");
    assert.deepEqual(entries, [{ from: "ok", to: "好" }]);
    assert.deepEqual(errors.map((e) => e.line), [1, 2, 3]);
  });

  test("同一原文（忽略大小写）只保留第一条", () => {
    const { entries, errors } = parseGlossary("API=接口\napi=应用程序接口");
    assert.deepEqual(entries, [{ from: "API", to: "接口" }]);
    assert.equal(errors.length, 1);
    assert.equal(errors[0]?.line, 2);
  });

  test("兼容 Windows 换行", () => {
    assert.equal(parseGlossary("a=1\r\nb=2").entries.length, 2);
  });
});

describe("matchGlossary", () => {
  const entries = [
    { from: "AI", to: "人工智能" },
    { from: "liveness probe", to: "存活探针" },
    { from: "C++", to: "C++" },
    { from: "大模型", to: "LLM" },
  ];

  test("英文术语整词匹配，忽略大小写", () => {
    assert.deepEqual(matchGlossary("The ai is here", entries).map((e) => e.from), ["AI"]);
    assert.deepEqual(matchGlossary("She said hello", entries), []);
    assert.deepEqual(matchGlossary("When the Liveness Probe fails", entries).map((e) => e.from), ["liveness probe"]);
  });

  test("含正则特殊字符的术语按字面匹配", () => {
    assert.deepEqual(matchGlossary("Written in C++ and Rust", entries).map((e) => e.from), ["C++"]);
  });

  test("中文术语按子串匹配", () => {
    assert.deepEqual(matchGlossary("本地大模型很快", entries).map((e) => e.from), ["大模型"]);
  });
});
