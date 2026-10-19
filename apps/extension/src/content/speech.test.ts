import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { pickVoice, type VoiceInfo } from "./speech.ts";

const v = (name: string, lang: string, localService = true, isDefault = false): VoiceInfo => ({ name, lang, localService, default: isDefault });

describe("pickVoice", () => {
  test("只用本机语音：联网语音再好也不选，只有联网语音时返回 null", () => {
    assert.equal(pickVoice([v("Google US English", "en-US", false)], "en"), null);
    assert.equal(pickVoice([v("Google US English", "en-US", false), v("Daniel", "en-GB")], "en")?.name, "Daniel");
  });

  test("语言对得上才选，地区后缀不影响", () => {
    const voices = [v("Tingting", "zh-CN"), v("Samantha", "en-US")];
    assert.equal(pickVoice(voices, "en")?.name, "Samantha");
    assert.equal(pickVoice(voices, "zh-TW")?.name, "Tingting");
    assert.equal(pickVoice(voices, "ja"), null);
  });

  test("中文系统里语音名是中文，也能认出常用语音", () => {
    assert.equal(pickVoice([v("Li-Mu", "zh-CN"), v("语舒", "zh-CN"), v("婷婷", "zh-CN")], "zh")?.name, "婷婷");
  });

  test("跳过搞怪音效语音，带性格的语音排在普通语音后面", () => {
    assert.equal(pickVoice([v("Bubbles", "en-US"), v("Bad News", "en-US")], "en"), null);
    assert.equal(pickVoice([v("Eddy (English (US))", "en-US"), v("Aaron", "en-US")], "en")?.name, "Aaron");
  });

  test("高品质优先：Premium > Enhanced > 常用自然语音 > 其他", () => {
    const voices = [v("Aaron", "en-US", true, true), v("Samantha", "en-US"), v("Allison (Enhanced)", "en-US"), v("Ava (Premium)", "en-US")];
    assert.equal(pickVoice(voices, "en")?.name, "Ava (Premium)");
    assert.equal(pickVoice(voices.slice(0, 3), "en")?.name, "Allison (Enhanced)");
    assert.equal(pickVoice(voices.slice(0, 2), "en")?.name, "Samantha");
  });
});
