import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { isShortText, wordCount } from "./text-rules.ts";

describe("text-rules", () => {
  test("单词数：撇号、连字符、小数点连在一起算一个词，符号不算词", () => {
    assert.equal(wordCount("Hub"), 1);
    assert.equal(wordCount("self-hosted"), 1);
    assert.equal(wordCount("don't"), 1);
    assert.equal(wordCount("Version 2.0"), 2);
    assert.equal(wordCount("Team & Enterprise"), 2);
    assert.equal(wordCount("Hub Python Library"), 3);
    assert.equal(wordCount("—"), 0);
  });

  test("中日韩等不靠空格分词的文字不套用规则", () => {
    assert.equal(wordCount("これは日本語の文です"), null);
    assert.equal(wordCount("한국어 문장입니다"), null);
    assert.equal(isShortText("これは日本語の文です"), false);
  });

  test("1~4 个单词是短文本，5 个起不是，没有单词的不算", () => {
    assert.equal(isShortText("Hub"), true);
    assert.equal(isShortText("Basic plan"), true);
    assert.equal(isShortText("one two three four"), true);
    assert.equal(isShortText("one two three four five"), false);
    assert.equal(isShortText("—"), false);
  });
});
