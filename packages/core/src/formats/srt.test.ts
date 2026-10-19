// Goal 5 CP3：SRT 字幕解析与重组。golden 文件由「【译】+ 发给模型的原文」这个假翻译生成，逐字比较。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { SrtFormatError, parseSrt, type SrtDoc } from "./srt.ts";

const fixture = (name: string) => readFileSync(new URL(`../../../../tests/fixtures/cli/${name}`, import.meta.url), "utf8");

function fake(doc: SrtDoc): Map<string, string> {
  return new Map(doc.units.map((u) => [u.id, `【译】${u.markup ?? u.text}`]));
}

/** 只有一条字幕时，按给定译文重组 */
function translateOne(source: string, output: string, bilingual = false): string {
  const doc = parseSrt(source);
  assert.equal(doc.units.length, 1, JSON.stringify(doc.units));
  return doc.render(new Map([[doc.units[0]!.id, output]]), { bilingual });
}

const cue = (text: string) => `1\n00:00:01,000 --> 00:00:02,000\n${text}\n`;

/** 时间轴、序号（不含字幕文字）按顺序列出，用来比较结构 */
function skeleton(text: string): string[] {
  return text.split(/\r?\n/).filter((l) => /^\d+$/.test(l) || l.includes("-->"));
}

function formatError(source: string): SrtFormatError {
  try {
    parseSrt(source);
  } catch (err) {
    assert.ok(err instanceof SrtFormatError);
    return err;
  }
  assert.fail("应该报格式错误");
}

describe("SRT golden", () => {
  test("1 序号、时间轴原样保留；多行文字合成一行翻", () => {
    const source = fixture("talk.srt");
    const doc = parseSrt(source);
    assert.equal(doc.units.length, 18);
    assert.equal(doc.units[3]!.text, "You needed a data center, or at least");
    assert.equal(doc.units[3]!.line, 15);
    const out = doc.render(fake(doc));
    assert.equal(out, fixture("talk.zh.srt"));
    assert.deepEqual(skeleton(out), skeleton(source));
  });

  test("2 --bilingual：原文行在上、译文一行在下", () => {
    const doc = parseSrt(fixture("talk.srt"));
    assert.equal(doc.render(fake(doc), { bilingual: true }), fixture("talk.bilingual.srt"));
  });

  test("3 带 BOM、CRLF 换行：读写正常，换行风格不变", () => {
    const source = `﻿${fixture("dialog.srt").replaceAll("\n", "\r\n")}`;
    const doc = parseSrt(source);
    assert.equal(doc.units.length, 12);
    assert.ok(!doc.units.some((u) => u.text.includes("\r") || u.text.includes("﻿")));
    assert.equal(doc.render(new Map()), source);
    const out = doc.render(fake(doc));
    assert.ok(out.startsWith("﻿1\r\n"));
    assert.ok(!/[^\r]\n/.test(out), "不该混进 LF");
    assert.deepEqual(skeleton(out), skeleton(source));
  });

  test("译文能被重新解析，结构和原文一致；没有译文的字幕保留原文", () => {
    const source = fixture("dialog.srt");
    const doc = parseSrt(source);
    const half = new Map([...fake(doc)].filter((_, k) => k % 2 === 0));
    const out = doc.render(half);
    const again = parseSrt(out);
    assert.equal(again.units.length, doc.units.length);
    assert.deepEqual(skeleton(out), skeleton(source));
    assert.equal(again.units[1]!.text, doc.units[1]!.text);
    assert.equal(again.units[0]!.text, `【译】${doc.units[0]!.text}`);
  });

  test("空文件、没有文字的字幕（♪、数字）：没有要翻的，原样输出", () => {
    for (const text of ["", "\n", cue("♪ ♪"), cue("1984"), "1\n00:00:01,000 --> 00:00:02,000\n\n"]) {
      const doc = parseSrt(text);
      assert.deepEqual(doc.units, [], JSON.stringify(text));
      assert.equal(doc.render(new Map()), text);
    }
  });
});

describe("SRT 格式错误：报行号，不猜", () => {
  test("4 缺时间轴、序号不是数字、条目之间缺空行、时间轴写错", () => {
    let err = formatError("1\nHello there.\n");
    assert.equal(err.line, 2);
    assert.match(err.message, /时间轴/);

    err = formatError(`${cue("Fine.")}\nabc\n00:00:03,000 --> 00:00:04,000\nNext.\n`);
    assert.equal(err.line, 5);
    assert.match(err.message, /序号/);

    err = formatError("1\n00:00:01,000 --> 00:00:02,000\nFirst line.\n2\n00:00:03,000 --> 00:00:04,000\nSecond.\n");
    assert.equal(err.line, 5);
    assert.match(err.message, /缺了空行/);

    err = formatError("1\n00:00:01 --> 00:00:02\nNo millis.\n");
    assert.equal(err.line, 2);
  });

  test("时间轴的毫秒用点、后面带坐标也认", () => {
    assert.equal(parseSrt("1\n00:00:01.000 --> 00:00:02.500 X1:10 X2:20\nHi there.\n").units.length, 1);
  });
});

describe("SRT 字幕里的格式", () => {
  test("整条包在 <i> 里：剥掉翻，译文再包回去；开头的 {\\an8} 留在开头", () => {
    const doc = parseSrt(cue("{\\an8}<i>Where are you going?</i>"));
    assert.equal(doc.units[0]!.text, "Where are you going?");
    assert.equal(doc.units[0]!.markup, undefined);
    assert.equal(doc.render(new Map([[doc.units[0]!.id, "你去哪儿？"]])), cue("{\\an8}<i>你去哪儿？</i>"));
    assert.equal(
      doc.render(new Map([[doc.units[0]!.id, "你去哪儿？"]]), { bilingual: true }),
      "1\n00:00:01,000 --> 00:00:02,000\n{\\an8}<i>Where are you going?</i>\n<i>你去哪儿？</i>\n",
    );
  });

  test("两行各自包 <i> 算整条斜体；句中加粗按标记翻，标记没保住退回纯文本", () => {
    const src = cue("<i>I told you</i>\n<i>it was <b>never</b> mine.</i>");
    const doc = parseSrt(src);
    assert.equal(doc.units[0]!.markup, "I told you it was <g1>never</g1> mine.");
    assert.equal(translateOne(src, "我跟你说过，它<g1>从来</g1>不是我的。"), cue("<i>我跟你说过，它<b>从来</b>不是我的。</i>"));
    assert.equal(translateOne(src, "我跟你说过，它从来不是我的。"), cue("<i>我跟你说过，它从来不是我的。</i>"));
  });

  test("不同标签各包一段：按标记翻", () => {
    const src = cue("<i>Hello,</i> <b>world</b>.");
    assert.equal(parseSrt(src).units[0]!.markup, "<g1>Hello,</g1> <g2>world</g2>.");
    assert.equal(translateOne(src, "<g1>你好，</g1><g2>世界</g2>。"), cue("<i>你好，</i><b>世界</b>。"));
  });

  test("标签不成对：原样保留、不当格式，文字照常翻", () => {
    const doc = parseSrt(cue("<i>Broken tag here."));
    assert.equal(doc.units[0]!.text, "Broken tag here.");
    assert.equal(doc.render(new Map([[doc.units[0]!.id, "<x1/>标签坏了。"]])), cue("<i>标签坏了。"));
  });

  test("中文字幕多行合成一行时不加空格", () => {
    assert.equal(parseSrt(cue("我们今天\n聊聊模型")).units[0]!.text, "我们今天聊聊模型");
    assert.equal(parseSrt(cue("We talk\nabout models")).units[0]!.text, "We talk about models");
  });

  test("译文里的换行合成一个空格，保证一条译文只占一行", () => {
    assert.equal(translateOne(cue("Hello\nthere."), "你好\n啊。"), cue("你好 啊。"));
  });
});
