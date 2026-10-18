import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { validateTranslation } from "./validate.ts";

const SRC = "The server will send each token as a separate event.";

describe("validateTranslation", () => {
  test("正常译文通过", () => {
    assert.equal(validateTranslation(SRC, "服务器会把每个 token 作为单独的事件发送。", "zh"), null);
  });

  test("空输出", () => {
    assert.equal(validateTranslation(SRC, "  \n", "zh"), "empty");
  });

  test("混进思考内容", () => {
    assert.equal(validateTranslation(SRC, "<think>先想想</think>服务器……", "zh"), "think");
    assert.equal(validateTranslation(SRC, "服务器……</think>", "zh"), "think");
  });

  test("原样照抄原文（忽略大小写和空白）", () => {
    assert.equal(validateTranslation(SRC, `  ${SRC.toUpperCase()} `, "zh"), "same-as-source");
  });

  test("短文本原样输出不算错：专有名词、API 名", () => {
    assert.equal(validateTranslation("GitHub Actions", "GitHub Actions", "zh"), null);
    assert.equal(validateTranslation("useEffect", "useEffect", "zh"), null);
  });

  test("输出远长于原文", () => {
    assert.equal(validateTranslation(SRC, "重复".repeat(200), "zh"), "too-long");
  });

  test("目标是中文但输出没有一个汉字", () => {
    assert.equal(validateTranslation(SRC, "Le serveur enverra chaque jeton.", "zh"), "wrong-language");
    assert.equal(validateTranslation(SRC, "Le serveur enverra chaque jeton.", "zh-CN"), "wrong-language");
  });

  test("非中文目标不做语言检查", () => {
    assert.equal(validateTranslation(SRC, "Le serveur enverra chaque jeton.", "fr"), null);
  });
});
