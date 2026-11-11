import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { isIdentifier, isMonospace, isShortText, wordCount } from "./text-rules.ts";

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

  test("标识符：文件名、版本号、提交编号、驼峰字段名、网址不翻；普通单词和句子照常翻", () => {
    for (const t of ["README.md", ".gitignore", "run_proxy_windows.bat", "v0.2.3", "93ac637", "2B", "35BA3B", "pageSize", "budgetId", "user@example.com", "https://example.com/docs"]) {
      assert.equal(isIdentifier(t), true, t);
    }
    for (const t of ["Hub", "Overview", "LICENSE", "docs", "Sign-in", "etc.", "Yes/No", "Version 2.0", "Last commit message", "第3章", "已发布v2"]) {
      assert.equal(isIdentifier(t), false, t);
    }
  });

  test("等宽字体：只看字体列表的第一个", () => {
    for (const f of ['ui-monospace, SFMono-Regular, Menlo', '"JetBrains Mono", monospace', "Monaco, Menlo", '"Courier New"', "monospace", "Consolas"]) {
      assert.equal(isMonospace(f), true, f);
    }
    for (const f of ["Georgia, serif", '-apple-system, "PingFang SC", monospace', "Helvetica Neue", ""]) {
      assert.equal(isMonospace(f), false, f);
    }
  });
});
