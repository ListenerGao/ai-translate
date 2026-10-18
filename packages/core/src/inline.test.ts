import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  MAX_MARKERS,
  canUseMarkup,
  markersOf,
  normalizeMarkupSpacing,
  parseMarkup,
  plainText,
  stripMarkers,
  toTagged,
  type InlineNode,
} from "./inline.ts";

// Read <a>the <b>setup</b> guide</a> before running <code>npm ci</code>.
const tree: InlineNode[] = [
  { type: "text", text: "Read " },
  { type: "tag", id: 1, children: [{ type: "text", text: "the " }, { type: "tag", id: 2, children: [{ type: "text", text: "setup" }] }, { type: "text", text: " guide" }] },
  { type: "text", text: " before running " },
  { type: "atom", id: 3, text: "npm ci" },
  { type: "text", text: ".\n" },
];
const SOURCE = "Read <g1>the <g2>setup</g2> guide</g1> before running <x3/>.";

describe("段内结构 ↔ 带标记文本", () => {
  test("写成标记文本、取纯文字", () => {
    assert.equal(toTagged(tree), SOURCE);
    assert.equal(plainText(tree), "Read the setup guide before running npm ci.");
    assert.deepEqual(markersOf(SOURCE), ["<g1>", "<g2>", "</g2>", "</g1>", "<x3/>"]);
    assert.equal(stripMarkers("运行 <x3/> 前先读<g1>安装指南</g1>。"), "运行 前先读安装指南。");
  });

  test("能不能用带标记的翻译", () => {
    assert.equal(canUseMarkup(tree), true);
    assert.equal(canUseMarkup([{ type: "text", text: "plain only" }]), false);
    // 原文本身就有长得像标记的文字（如讲 HTML 的教程），不用
    assert.equal(canUseMarkup([{ type: "text", text: "Write <g1> here " }, { type: "tag", id: 1, children: [] }]), false);
    const many: InlineNode[] = Array.from({ length: MAX_MARKERS / 2 + 1 }, (_, i) => ({ type: "tag", id: i + 1, children: [{ type: "text", text: "x" }] }));
    assert.equal(canUseMarkup(many), false);
  });
});

describe("parseMarkup", () => {
  test("标记完整：解析成结构，语序变化也接受", () => {
    const out = "运行 <x3/> 之前，先阅读<g1><g2>安装</g2>指南</g1>。";
    assert.deepEqual(parseMarkup(out, SOURCE), [
      { type: "text", text: "运行 " },
      { type: "atom", id: 3 },
      { type: "text", text: " 之前，先阅读" },
      { type: "tag", id: 1, children: [{ type: "tag", id: 2, children: [{ type: "text", text: "安装" }] }, { type: "text", text: "指南" }] },
      { type: "text", text: "。" },
    ]);
  });

  test("嵌套关系可以变，只要合法", () => {
    assert.notEqual(parseMarkup("<g2>安装</g2><g1>指南</g1><x3/>", SOURCE), null);
  });

  test("不合格返回 null：缺标记、多标记、重复、嵌套交叉、没闭合、多余闭合", () => {
    const bad = [
      "<g1>指南</g1>运行 <x3/>", // 缺 g2
      "<g1><g2>安装</g2>指南</g1><x3/><g4>多</g4>", // 多出 g4
      "<g1><g2>安装</g2>指南</g1><x3/><x3/>", // atom 重复
      "<g1><g2>安装</g1>指南</g2><x3/>", // 交叉
      "<g1><g2>安装</g2>指南<x3/>", // g1 没闭合
      "</g1><g1><g2>安装</g2>指南</g1><x3/>", // 先闭合
    ];
    for (const out of bad) assert.equal(parseMarkup(out, SOURCE), null, out);
  });
});

describe("normalizeMarkupSpacing", () => {
  test("标记两侧都是中文时去掉多余空格", () => {
    assert.equal(normalizeMarkupSpacing("<g1>机器翻译</g1> 是指", "zh"), "<g1>机器翻译</g1>是指");
    assert.equal(normalizeMarkupSpacing("新版本 <g1> 速度显著更快</g1>，", "zh"), "新版本<g1>速度显著更快</g1>，");
  });

  test("中文和英文之间的空格保留", () => {
    assert.equal(normalizeMarkupSpacing("尤其是在 <g2>Apple Silicon</g2> 设备上", "zh"), "尤其是在 <g2>Apple Silicon</g2> 设备上");
  });

  test("原样保留的元素两侧空格保留", () => {
    assert.equal(normalizeMarkupSpacing("以井号字符 <x1/> 开头", "zh"), "以井号字符 <x1/> 开头");
  });

  test("目标不是中文时不处理", () => {
    assert.equal(normalizeMarkupSpacing("<g1>x</g1> y", "fr"), "<g1>x</g1> y");
  });
});
