// Goal 5 CP2：Markdown 分段与重组。golden 文件由「【译】+ 发给模型的原文」这个假翻译生成，逐字比较。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { parseMarkdown, type MarkdownDoc } from "./markdown.ts";

const fixture = (name: string) => readFileSync(new URL(`../../../../tests/fixtures/cli/${name}`, import.meta.url), "utf8");

/** 假翻译：【译】+ 发给模型的原文（带标记的原样带回，相当于模型保住了标记） */
function fake(doc: MarkdownDoc): Map<string, string> {
  return new Map(doc.units.map((u) => [u.id, `【译】${u.markup ?? u.text}`]));
}

/** 只有一段时，按给定译文重组 */
function translateOne(source: string, output: string): string {
  const doc = parseMarkdown(source);
  assert.equal(doc.units.length, 1, `应只有一段：${JSON.stringify(doc.units)}`);
  return doc.render(new Map([[doc.units[0]!.id, output]]));
}

describe("Markdown golden", () => {
  const source = fixture("guide.md");

  test("1 标题、段落、列表、引用、表格单元格逐个翻译，结构不变", () => {
    const doc = parseMarkdown(source);
    assert.equal(doc.render(fake(doc)), fixture("guide.zh.md"));
  });

  test("2 代码块、front matter、HTML 块、链接和脚注定义、徽章行、定义列表不发给模型", () => {
    const sent = parseMarkdown(source).units.map((u) => u.markup ?? u.text);
    for (const kept of ["Getting Started Guide", "Comments inside code", "Tilde fences", "Indented code", "logo.png", "This comment", "Settings", "footnote text", "Definition lists", "Home", "Build"]) {
      assert.ok(!sent.some((s) => s.includes(kept)), `不该发给模型：${kept}`);
    }
    assert.ok(!sent.some((s) => s.includes("snake_case") && s.includes("<g3>")), "snake_case_names 不该当成斜体");
  });

  test("4 --bilingual：每段原文后接译文", () => {
    const doc = parseMarkdown(source);
    assert.equal(doc.render(fake(doc), { bilingual: true }), fixture("guide.bilingual.md"));
  });

  test("没有译文的段落逐字保留：整份文件原样还原", () => {
    assert.equal(parseMarkdown(source).render(new Map()), source);
  });

  test("CRLF 换行和 BOM 原样保留", () => {
    const crlf = `﻿${source.replaceAll("\n", "\r\n")}`;
    const doc = parseMarkdown(crlf);
    assert.equal(doc.render(fake(doc)), `﻿${fixture("guide.zh.md").replaceAll("\n", "\r\n")}`);
    assert.equal(doc.render(new Map()), crlf);
  });

  test("5 空文件、只有代码块的文件：没有要翻的段落，原样输出", () => {
    for (const text of ["", "\n", "```js\nconst a = 1;\n```\n", "    indented();\n", "---\ntitle: x\n---\n", "| 1 | 2 |\n|---|---|\n| 3 | 4 |\n"]) {
      const doc = parseMarkdown(text);
      assert.deepEqual(doc.units, [], JSON.stringify(text));
      assert.equal(doc.render(new Map()), text);
    }
  });
});

describe("Markdown 行内格式", () => {
  test("3 链接、加粗、斜体、行内代码按原来的符号写回", () => {
    const src = "Run `npm test` and read the [guide](https://example.com/a_b \"Guide\") **first**.\n";
    const doc = parseMarkdown(src);
    assert.equal(doc.units[0]!.markup, "Run <x1/> and read the <g2>guide</g2> <g3>first</g3>.");
    const out = doc.render(new Map([[doc.units[0]!.id, "先读<g2>指南</g2>里的<g3>第一节</g3>，再运行 <x1/>。"]]));
    assert.equal(out, "先读[指南](https://example.com/a_b \"Guide\")里的**第一节**，再运行 `npm test`。\n");
  });

  test("3 标记没保住（缺了、多了、嵌套错）：按纯文本写回，文字不丢", () => {
    const src = "Read the [guide](g.md) **first**.";
    assert.equal(translateOne(src, "先读指南的第一节。"), "先读指南的第一节。");
    assert.equal(translateOne(src, "先读<g1>指南</g1>的第一节。"), "先读指南的第一节。");
    assert.equal(translateOne(src, "先读<g1>指南<g2>的</g1>第一节</g2>。"), "先读指南的第一节。");
  });

  test("中文标点紧贴强调符号：挪到符号外面，_ 改成 *，免得渲染失效", () => {
    assert.equal(translateOne("**Note:** this is it.", "<g1>注意：</g1>这就是它。"), "**注意**：这就是它。");
    assert.equal(translateOne("Use _this_ one.", "用<g1>这个</g1>就行。"), "用*这个*就行。");
    assert.equal(translateOne("Say **\"hi\"** now.", "现在说<g1>“你好”</g1>。"), "现在说“**你好**”。");
    // 两侧有空格或标点时保持原样
    assert.equal(translateOne("**Note:** this is it.", "<g1>Note:</g1> this is it."), "**Note:** this is it.");
    assert.equal(translateOne("Use _this_ one.", "Use <g1>this</g1> one."), "Use _this_ one.");
  });

  test("嵌套强调、转义、脚注引用、图片、自动链接、行内 HTML", () => {
    const doc = parseMarkdown("*All **good** here*, 2 \\* 3, see[^n] ![img](a.png) <https://x.dev> <kbd>K</kbd>.");
    assert.equal(doc.units[0]!.markup, "<g1>All <g2>good</g2> here</g1>, 2 <x3/> 3, see<x4/> <x5/> <x6/> <x7/>K<x8/>.");
    const out = doc.render(new Map([[doc.units[0]!.id, "<g1>这里<g2>都好</g2></g1>，2 <x3/> 3，见<x4/> <x5/> <x6/> <x7/>K<x8/>。"]]));
    assert.equal(out, "*这里**都好***，2 \\* 3，见[^n] ![img](a.png) <https://x.dev> <kbd>K</kbd>。");
  });

  test("snake_case、单独的 * 和 _ 不当成强调", () => {
    for (const src of ["Set max_retry_count to 3.", "Compute 2 * 3 * 4 now.", "A lone _ here."]) {
      const doc = parseMarkdown(src);
      assert.equal(doc.units[0]!.markup, undefined, src);
      assert.equal(doc.units[0]!.text, src);
    }
  });

  test("标记超过上限：只发纯文本", () => {
    const src = Array.from({ length: 12 }, (_, i) => `**w${i}**`).join(" ") + " words";
    const doc = parseMarkdown(src);
    assert.equal(doc.units[0]!.markup, undefined);
    assert.equal(doc.units[0]!.text, Array.from({ length: 12 }, (_, i) => `w${i}`).join(" ") + " words");
  });
});

describe("Markdown 块", () => {
  test("列表里缩进的围栏代码不翻；列表后顶格的缩进代码块不翻", () => {
    const src = "- Step one:\n\n    ```sh\n    make it\n    ```\n\n- Step two\n\n```\nx\n```\n\n    code here\n";
    const doc = parseMarkdown(src);
    assert.deepEqual(
      doc.units.map((u) => u.text),
      ["Step one:", "Step two"],
    );
  });

  test("pre 块里的空行不结束 HTML 块；行内 HTML 开头的段落照常翻", () => {
    const src = "<pre>\nkeep this\n\nand this\n</pre>\n\n<kbd>Esc</kbd> closes the dialog.\n";
    const doc = parseMarkdown(src);
    assert.deepEqual(
      doc.units.map((u) => u.text),
      ["Esc closes the dialog."],
    );
  });

  test("表格：译文里的 | 转义；数字单元格不翻；没有竖线的 --- 不是表格", () => {
    assert.equal(translateOne("| Name |\n|---|\n| 42 |\n", "名字 | 称呼"), "| 名字 \\| 称呼 |\n|---|\n| 42 |\n");
    const setext = parseMarkdown("Title here\n---\n");
    assert.equal(setext.render(new Map([[setext.units[0]!.id, "标题"]])), "标题\n---\n");
  });

  test("没翻成的段落保留原文，翻好的照常替换", () => {
    const src = "# Title\n\nFirst line\nsecond line.\n\n- item one\n  continues\n";
    const doc = parseMarkdown(src);
    const [title, para, item] = doc.units;
    assert.equal(doc.render(new Map([[title!.id, "标题"]])), "# 标题\n\nFirst line\nsecond line.\n\n- item one\n  continues\n");
    assert.equal(doc.render(new Map([[para!.id, "段落"], [item!.id, "条目"]])), "# Title\n\n段落\n\n- 条目\n");
  });

  test("每段记下在原文件里的起始行号（引用、表格里的也算原文件的行号）", () => {
    const doc = parseMarkdown("# Title\n\nPara one\ncontinues.\n\n> Quote\n>\n> > Deep quote\n\n| Head |\n|---|\n| Cell |\n");
    assert.deepEqual(
      doc.units.map((u) => [u.text, u.line]),
      [["Title", 1], ["Para one continues.", 3], ["Quote", 6], ["Deep quote", 8], ["Head", 10], ["Cell", 12]],
    );
  });

  test("引用：原样的行保留原来的 > 写法，嵌套引用照常翻", () => {
    const src = ">Plain quote\n> > Nested quote\n";
    const doc = parseMarkdown(src);
    assert.deepEqual(
      doc.units.map((u) => u.text),
      ["Plain quote", "Nested quote"],
    );
    assert.equal(doc.render(new Map([[doc.units[1]!.id, "嵌套"]])), ">Plain quote\n> > 嵌套\n");
  });
});
