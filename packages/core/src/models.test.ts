import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DEFAULT_MODEL_ID, getModelProfile } from "./models.ts";

describe("models", () => {
  test("默认模型是 Index-Translate-2B，参数取官方默认", () => {
    const p = getModelProfile(DEFAULT_MODEL_ID);
    assert.equal(p.serverModel, "index-translate-2b");
    assert.equal(p.temperature, 0);
    assert.equal(p.maxTokens, 1024);
    assert.equal(p.parallel, 4);
  });

  test("未知模型报错", () => {
    assert.throws(() => getModelProfile("nope"), /未知的模型配置/);
  });
});
