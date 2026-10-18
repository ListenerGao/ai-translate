// 英文文章检测：决定要不要自动开启翻译。只在本地做，不发请求。
import type { InlineNode } from "@ai-translate/core";
import { BlockFinder, type FoundBlock } from "./blocks.ts";

// 阈值经 Goal 3 CP0 用 20 个真实网页校准（10 个文章页、10 个首页 / 列表 / 目录 / 搜索结果页）
export const LONG_BLOCK_CHARS = 80;
export const MIN_LONG_BLOCKS = 5;
export const MIN_LONG_CHARS = 1500;
/** 段落里链接文字超过一半就不算正文（搜索结果、链接列表） */
export const MAX_LINK_SHARE = 0.5;
/** 全页链接文字占比超过这个就不是文章（首页、目录页）；文章页实测最高 0.34 */
export const MAX_PAGE_LINK_DENSITY = 0.5;
/** 正文集中度低于这个就不是文章（新闻首页的摘要分散在各张卡片里，实测 0.03）；文章页实测最低 0.29 */
export const MIN_CONCENTRATION = 0.2;
const SAMPLE_CHARS = 2000;
const MIN_SAMPLE_FOR_DETECTION = 200;

export interface PageDetection {
  /** 判定的语言：内容检测结果，样本太少时用 <html lang> */
  language: string;
  english: boolean;
  /** 页面声明 og:type=article */
  ogArticle: boolean;
  /** 长段落（够长、链接文字不到一半）的段数和总字数 */
  longBlocks: number;
  longChars: number;
  /** 最长的一段的字数 */
  maxBlockChars: number;
  /** 正文集中度：得分最高的容器占全部长段落字数的比例（每段给父元素记全分、祖父元素记半分） */
  concentration: number;
  /** 全页链接文字占比 */
  linkDensity: number;
  article: boolean;
}

/** 段落里链接文字占多少 */
function linkShare(block: FoundBlock): number {
  let link = 0;
  const rec = (nodes: readonly InlineNode[], inLink: boolean) => {
    for (const n of nodes) {
      if (n.type === "text" || n.type === "atom") {
        if (inLink) link += n.text.replace(/\s+/g, "").length;
      } else rec(n.children, inLink || block.refs.get(n.id)?.tagName === "A");
    }
  };
  rec(block.nodes, false);
  const total = block.text.replace(/\s+/g, "").length;
  return total === 0 ? 0 : link / total;
}

export async function detectPage(target: string): Promise<PageDetection> {
  const blocks = new BlockFinder().find(document.body, target);
  const long = blocks.filter((b) => b.text.length >= LONG_BLOCK_CHARS && linkShare(b) < MAX_LINK_SHARE);
  const longChars = long.reduce((n, b) => n + b.text.length, 0);
  const maxBlockChars = long.reduce((n, b) => Math.max(n, b.text.length), 0);
  const scores = new Map<Element, number>();
  for (const b of long) {
    const parent = b.el.parentElement;
    if (parent !== null) scores.set(parent, (scores.get(parent) ?? 0) + b.text.length);
    const grand = parent?.parentElement;
    if (grand != null) scores.set(grand, (scores.get(grand) ?? 0) + b.text.length / 2);
  }
  const concentration = longChars === 0 ? 0 : Math.max(0, ...scores.values()) / longChars;
  const squash = (s: string) => s.replace(/\s+/g, "").length;
  const linkText = [...document.body.querySelectorAll("a")].reduce((n, a) => n + squash(a.innerText ?? ""), 0);
  const bodyText = squash(document.body.innerText ?? "");
  const linkDensity = bodyText === 0 ? 0 : linkText / bodyText;
  const ogArticle = document.querySelector('meta[property="og:type"]')?.getAttribute("content")?.trim().toLowerCase() === "article";

  const sample = (long.length > 0 ? long : blocks).map((b) => b.text).join(" ").slice(0, SAMPLE_CHARS);
  const htmlLang = document.documentElement.lang.trim().toLowerCase();
  let language = htmlLang.split("-")[0] ?? "";
  if (sample.length >= MIN_SAMPLE_FOR_DETECTION) {
    const result = await chrome.i18n.detectLanguage(sample);
    const top = [...result.languages].sort((a, b) => b.percentage - a.percentage)[0];
    if (top !== undefined && top.percentage >= 50) language = top.language.split("-")[0] ?? language;
  }

  const english = language === "en";
  // 链接占比高的不是文章；声明了 og:type=article 的算文章；否则要有足够、集中的正文（单段超长的也算，如整篇用 <br> 分段的随笔）
  const enoughText = longChars >= MIN_LONG_CHARS && (long.length >= MIN_LONG_BLOCKS || maxBlockChars >= MIN_LONG_CHARS);
  const article = linkDensity <= MAX_PAGE_LINK_DENSITY && (ogArticle || (enoughText && concentration >= MIN_CONCENTRATION));
  return { language, english, ogArticle, longBlocks: long.length, longChars, maxBlockChars, concentration: Math.round(concentration * 100) / 100, linkDensity: Math.round(linkDensity * 100) / 100, article };
}
