// 段落提取：按页面实际排版找出要翻译的文字块，不看标签名。
// 一段文字所在的最近一个「自成一块」的元素就是它的段落：普通块、列表项、表格单元格都算；
// 行内元素（a、strong、span 等）的文字算进外层段落；flex / grid 容器本身不算段落（多是按钮、工具栏这类界面），
// 但浏览器会把它的子元素当成块，子元素里的文字照样能被找到。

import { plainText, type InlineNode } from "@ai-translate/core";

// 落在这些元素里面的文字不翻：代码、导航、菜单、表单、可编辑区域、隐藏给读屏软件的区域、插件自己插入的节点等
const EXCLUDED_ANCESTORS = [
  "pre",
  "code",
  "script",
  "style",
  "noscript",
  "nav",
  "aside",
  "footer",
  "form",
  "textarea",
  "select",
  "button",
  "[contenteditable]:not([contenteditable='false'])",
  "svg",
  "math",
  "[role='navigation']",
  "[role='menu']",
  "[role='menubar']",
  "[role='toolbar']",
  "[role='tablist']",
  "[aria-hidden='true']",
  "ait-translation",
  "ait-banner",
  "[data-ait-skip]",
].join(", ");

export type BoxKind = "inline" | "block" | "container" | "hidden";

/** 按计算后的 display 给元素分类 */
export function boxKind(el: Element): BoxKind {
  const display = getComputedStyle(el).display;
  if (display === "none") return "hidden";
  if (display === "contents" || display.startsWith("inline") || display.startsWith("ruby")) return "inline";
  if (display === "table-cell" || display === "table-caption") return "block";
  if (display === "flex" || display === "grid" || display.startsWith("table")) return "container";
  return "block";
}

// 段内格式：这些元素在译文里保留（Goal 2），包住的文字照常翻译
const MARKUP_TAGS = new Set(["A", "STRONG", "B", "EM", "I", "U", "S", "DEL", "MARK", "SUB", "SUP"]);
// 这些元素原样保留、不翻译
const MARKUP_ATOMS = new Set(["CODE", "KBD", "SAMP", "IMG"]);

export interface FoundBlock {
  el: HTMLElement;
  /** 段落自己的纯文字 */
  text: string;
  /** 段内结构：链接、加粗等是标记，行内代码等原样保留 */
  nodes: InlineNode[];
  /** 结构里的编号 → 页面上的原元素，渲染译文时照着复制 */
  refs: Map<number, Element>;
}

/** 一次扫描用一个实例，缓存每个元素的分类 */
export class BlockFinder {
  readonly #kinds = new Map<Element, BoxKind>();

  kind(el: Element): BoxKind {
    let k = this.#kinds.get(el);
    if (k === undefined) {
      k = boxKind(el);
      this.#kinds.set(el, k);
    }
    return k;
  }

  /** 文字所在的段落：往上越过行内元素，停在第一个块上；碰到 flex / grid 容器或隐藏元素则不算 */
  blockOf(node: Text): HTMLElement | null {
    let el = node.parentElement;
    while (el !== null && this.kind(el) === "inline") el = el.parentElement;
    if (el === null || el === document.body || el === document.documentElement) return null;
    return this.kind(el) === "block" ? el : null;
  }

  /**
   * 段落自己的内容转成段内结构：链接、加粗等成为标记，行内代码、图片、换行原样保留，
   * 其他行内元素只取文字；嵌套的块和隐藏元素跳过。纯文字由结构算出，两者始终一致。
   */
  inline(el: Element): { nodes: InlineNode[]; refs: Map<number, Element> } {
    const refs = new Map<number, Element>();
    let next = 1;
    const atom = (child: Element, text: string): InlineNode => {
      const id = next++;
      refs.set(id, child);
      return { type: "atom", id, text };
    };
    const rec = (parent: Element): InlineNode[] => {
      const out: InlineNode[] = [];
      for (const node of parent.childNodes) {
        if (node.nodeType === Node.TEXT_NODE) {
          out.push({ type: "text", text: node.textContent ?? "" });
          continue;
        }
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        const child = node as Element;
        const tag = child.tagName.toUpperCase();
        if (tag === "BR") out.push(atom(child, " "));
        else if (this.kind(child) !== "inline") continue;
        else if (MARKUP_ATOMS.has(tag)) out.push(atom(child, child.textContent ?? ""));
        else if (MARKUP_TAGS.has(tag)) {
          const id = next++;
          const children = rec(child);
          // 空元素（如只做锚点的 <a id>）不当标记，免得要求模型保留一个空壳
          if (plainText(children) === "" && !children.some((c) => c.type === "atom")) {
            out.push(...children);
            continue;
          }
          refs.set(id, child);
          out.push({ type: "tag", id, children });
        } else out.push(...rec(child));
      }
      return out;
    };
    return { nodes: rec(el), refs };
  }

  /** 找出 root 里所有要翻的段落 */
  find(root: Element, target: string): FoundBlock[] {
    const found: FoundBlock[] = [];
    const seen = new Set<Element>();
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      if (!/\p{L}/u.test((node as Text).data)) continue;
      const el = this.blockOf(node as Text);
      if (el === null || seen.has(el)) continue;
      seen.add(el);
      const block = this.#candidate(el, target);
      if (block !== null) found.push(block);
    }
    return found;
  }

  #candidate(el: HTMLElement, target: string): FoundBlock | null {
    if (el.closest(EXCLUDED_ANCESTORS) !== null) return null;
    if (el.getClientRects().length === 0) return null;
    const { nodes, refs } = this.inline(el);
    const text = plainText(nodes);
    if (text.length < 2 || !/\p{L}/u.test(text)) return null;
    if (isAlreadyTarget(text, target)) return null;
    return { el, text, nodes, refs };
  }
}

/**
 * 译文插入位置：紧跟段落自己最后一段文字（文本或行内元素）之后，返回插在谁前面，null 表示追加到末尾。
 * 这样嵌套的子列表留在译文后面，开头的块级元素（如标题前的锚点图标）留在译文前面。
 */
export function insertionPoint(el: Element): ChildNode | null {
  let last: ChildNode | null = null;
  for (const node of el.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) {
      if ((node.textContent ?? "").trim() !== "") last = node;
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const child = node as Element;
      if (child.tagName === "AIT-TRANSLATION") continue;
      if (boxKind(child) === "inline" && (child.textContent ?? "").trim() !== "") last = node;
    }
  }
  return last === null ? null : last.nextSibling;
}

/**
 * 已经是目标语言就不翻。目前只对中日韩目标按文字比例判断，够快、不用异步；
 * 其他目标语言一律翻译。
 */
export function isAlreadyTarget(text: string, target: string): boolean {
  const letters = text.match(/\p{L}/gu)?.length ?? 0;
  if (letters === 0) return false;
  const t = target.toLowerCase();
  const count = (re: RegExp) => text.match(re)?.length ?? 0;
  if (t.startsWith("zh")) return count(/\p{Script=Han}/gu) / letters > 0.5;
  if (t === "ja") return count(/[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/gu) / letters > 0.5;
  if (t === "ko") return count(/\p{Script=Hangul}/gu) / letters > 0.5;
  return false;
}

/** 块到视口的距离（像素），在视口内为 0 */
export function viewportDistance(el: Element): number {
  const r = el.getBoundingClientRect();
  if (r.bottom < 0) return Math.round(-r.bottom);
  if (r.top > window.innerHeight) return Math.round(r.top - window.innerHeight);
  return 0;
}
