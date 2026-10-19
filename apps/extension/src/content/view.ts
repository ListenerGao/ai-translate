// 译文显示：样式、段落下的译文节点、页面右上角的提示条。
import { parseMarkup, stripMarkers, type ParsedNode } from "@ai-translate/core";
import type { DisplayMode } from "../shared/settings.ts";
import { boxKind, insertionPoint } from "./blocks.ts";

const STYLE_ID = "ait-style";
const TAG = "ait-translation";

const CSS = `
${TAG} { display: block !important; margin: 0.35em 0 0 !important; padding: 0 !important; font: inherit; line-height: inherit; text-align: inherit; white-space: normal; }
${TAG}[data-layout="inline"] { display: inline !important; margin: 0 0 0 0.5em !important; }
${TAG}[data-state="pending"] { opacity: 0.45 !important; font-size: 0.85em !important; }
${TAG}[data-state="error"] { opacity: 0.75 !important; font-size: 0.85em !important; font-style: italic !important; }
.ait-only { font-size: 0 !important; }
.ait-only > :not(${TAG}) { display: none !important; }
.ait-only > ${TAG} { font-size: var(--ait-font-size) !important; margin-top: 0 !important; }
.ait-only > ${TAG}[data-layout="inline"] { margin-left: 0 !important; }
`;

export function ensureStyle(): void {
  if (document.getElementById(STYLE_ID) !== null) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = CSS;
  (document.head ?? document.documentElement).append(style);
}

export function removeStyle(): void {
  document.getElementById(STYLE_ID)?.remove();
}

export interface BlockView {
  el: HTMLElement;
  node: HTMLElement | null;
  /** 开启前元素有没有 style、class 属性，还原时据此决定是否删掉空属性 */
  hadStyleAttr: boolean;
  hadClassAttr: boolean;
  /** 短文本：先试着把译文放在同一行右边，放不下再改到原文下方 */
  inline: boolean;
  /** 段内有格式时发出去的带标记原文；没有格式为 null */
  markup: string | null;
  /** 标记编号 → 页面上的原元素 */
  refs: Map<number, Element>;
}

export function htmlLang(target: string): string {
  return target.toLowerCase() === "zh" ? "zh-CN" : target;
}

// 译文颜色：和原文区分开，又不用蓝色（网页链接多是蓝色，容易被当成链接）。
// 看段落背后的背景是深是浅，分别用浅青色和深青色。
// 不看文字颜色：浅色页面上的浅灰色副标题会被误判成深色页面。
const COLOR_ON_LIGHT_PAGE = "#0f766e";
const COLOR_ON_DARK_PAGE = "#5eead4";
type Rgba = readonly [number, number, number, number];
let colorProbe: CanvasRenderingContext2D | null = null;

/** 任意 CSS 颜色换算成 RGBA（0~255）。用 canvas 统一换算，oklch 等新写法也能识别 */
function toRgba(color: string): Rgba {
  colorProbe ??= document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  if (colorProbe === null) return [0, 0, 0, 0];
  colorProbe.clearRect(0, 0, 1, 1);
  colorProbe.fillStyle = "rgba(0, 0, 0, 0)";
  colorProbe.fillStyle = color;
  colorProbe.fillRect(0, 0, 1, 1);
  const [r = 0, g = 0, b = 0, a = 0] = colorProbe.getImageData(0, 0, 1, 1).data;
  return [r, g, b, a];
}

function luminance(c: Rgba): number {
  return (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255;
}

/**
 * 段落所在区域是不是深色：往上找第一个不透明的背景色。
 * 一直找不到时是浏览器默认底色：页面声明了深色配色方案（color-scheme）才是深色，否则是白底。
 */
function isDarkArea(el: Element): boolean {
  for (let e: Element | null = el; e !== null; e = e.parentElement) {
    const bg = toRgba(getComputedStyle(e).backgroundColor);
    if (bg[3] >= 128) return luminance(bg) < 0.5;
  }
  const scheme = getComputedStyle(document.documentElement).colorScheme;
  if (!scheme.includes("dark")) return false;
  return !scheme.includes("light") || matchMedia("(prefers-color-scheme: dark)").matches;
}

export function translationColor(el: Element): string {
  return isDarkArea(el) ? COLOR_ON_DARK_PAGE : COLOR_ON_LIGHT_PAGE;
}

// 译文位置：短文本先试着放在同一行右边，实际排版放不下（原文本身折行，或译文折到下一行）就改到原文下方

interface Lines {
  count: number;
  lastTop: number;
  lastBottom: number;
}

/** 段落自己的文字（不含译文和嵌套的块）占几行，以及最后一行的上下边界 */
function ownTextLines(el: Element, exclude: Node | null): Lines {
  const rects: DOMRect[] = [];
  const range = document.createRange();
  for (const node of el.childNodes) {
    if (node === exclude) continue;
    if (node.nodeType === Node.TEXT_NODE) {
      if ((node.textContent ?? "").trim() === "") continue;
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const child = node as Element;
      if (child.tagName === "AIT-TRANSLATION" || boxKind(child) !== "inline") continue;
    } else {
      continue;
    }
    range.selectNodeContents(node);
    for (const r of range.getClientRects()) if (r.width > 0 && r.height > 0) rects.push(r);
  }
  rects.sort((a, b) => a.top - b.top);
  const lines: Lines = { count: 0, lastTop: 0, lastBottom: -Infinity };
  for (const r of rects) {
    if (r.top >= lines.lastBottom - 1) {
      lines.count++;
      lines.lastTop = r.top;
      lines.lastBottom = r.bottom;
    } else {
      lines.lastBottom = Math.max(lines.lastBottom, r.bottom);
    }
  }
  return lines;
}

/** 原文只占一行，译文也完整落在这一行里，才适合放在右边 */
function fitsInline(view: BlockView, node: HTMLElement): boolean {
  const own = ownTextLines(view.el, node);
  const rects = node.getClientRects();
  if (own.count !== 1 || rects.length !== 1) return false;
  const t = rects[0]!;
  return t.top < own.lastBottom && t.bottom > own.lastTop;
}

function ensureNode(view: BlockView, target: string): HTMLElement {
  if (view.node === null || !view.el.contains(view.node)) {
    const node = document.createElement(TAG);
    node.setAttribute("lang", htmlLang(target));
    node.dataset.layout = view.inline && ownTextLines(view.el, null).count === 1 ? "inline" : "block";
    node.style.setProperty("color", translationColor(view.el), "important");
    // 紧跟段落自己的文字：嵌套的子列表留在后面，开头的锚点图标等留在前面
    view.el.insertBefore(node, insertionPoint(view.el));
    view.node = node;
  }
  return view.node;
}

/** 文字填好后按实际排版定位置：放不下就改到原文下方 */
function settleLayout(view: BlockView, node: HTMLElement, mode: DisplayMode): void {
  if (node.dataset.layout !== "inline") return;
  if (mode === "translation-only" || !fitsInline(view, node)) node.dataset.layout = "block";
}

export function showPending(view: BlockView, target: string): void {
  const node = ensureNode(view, target);
  node.dataset.state = "pending";
  node.textContent = "翻译中…";
}

export function showResult(view: BlockView, text: string, target: string, mode: DisplayMode): void {
  const node = ensureNode(view, target);
  node.dataset.state = "done";
  // 带标记的译文还原成带链接、加粗的元素；退回了纯文本翻译的段落没有标记，按文字显示
  const parsed = view.markup === null ? null : parseMarkup(text, view.markup);
  if (parsed !== null) node.replaceChildren(renderMarkup(parsed, view.refs));
  else node.textContent = view.markup === null ? text : stripMarkers(text);
  // 有格式的段落标出结果：kept 保住了格式，plain 退回了纯文本（排查和统计用）
  if (view.markup !== null) node.dataset.markup = parsed !== null ? "kept" : "plain";
  applyDisplayMode(view, mode);
}

/**
 * 对已出的译文应用显示方式，切换时立即生效：
 * 仅译文 -- 隐藏原文、译文放原文位置；双语对照 -- 撤回隐藏，短文本重新判断能不能放在同一行右边
 */
export function applyDisplayMode(view: BlockView, mode: DisplayMode): void {
  const node = view.node;
  if (node === null || node.dataset.state !== "done") return;
  if (mode === "translation-only") {
    if (!view.el.classList.contains("ait-only")) {
      view.el.style.setProperty("--ait-font-size", getComputedStyle(view.el).fontSize);
      view.el.classList.add("ait-only");
    }
    node.dataset.layout = "block";
    return;
  }
  view.el.classList.remove("ait-only");
  view.el.style.removeProperty("--ait-font-size");
  if (!view.hadClassAttr && view.el.getAttribute("class") === "") view.el.removeAttribute("class");
  if (!view.hadStyleAttr && view.el.getAttribute("style") === "") view.el.removeAttribute("style");
  node.dataset.layout = view.inline && ownTextLines(view.el, node).count === 1 ? "inline" : "block";
  settleLayout(view, node, mode);
}

/**
 * 按译文的结构复制页面上的原元素：链接、加粗等只复制外壳（保留 href 等属性）再填入译文，
 * 行内代码、图片、换行整个复制；复制品去掉 id，免得页面上出现重复 id。
 */
function renderMarkup(nodes: readonly ParsedNode[], refs: Map<number, Element>): DocumentFragment {
  const fragment = document.createDocumentFragment();
  for (const n of nodes) {
    if (n.type === "text") {
      fragment.append(n.text);
      continue;
    }
    const source = refs.get(n.id);
    if (source === undefined) continue;
    const copy = source.cloneNode(n.type === "atom") as Element;
    copy.removeAttribute("id");
    for (const inner of copy.querySelectorAll("[id]")) inner.removeAttribute("id");
    if (n.type === "tag") copy.append(renderMarkup(n.children, refs));
    fragment.append(copy);
  }
  return fragment;
}

export function showError(view: BlockView, message: string, target: string): void {
  const node = ensureNode(view, target);
  node.dataset.state = "error";
  node.textContent = message;
  settleLayout(view, node, "bilingual");
}

/** 撤回插件对这一块做的所有改动 */
export function clearView(view: BlockView): void {
  view.node?.remove();
  view.node = null;
  if (view.el.classList.contains("ait-only")) {
    view.el.classList.remove("ait-only");
  }
  if (!view.hadClassAttr && view.el.getAttribute("class") === "") view.el.removeAttribute("class");
  view.el.style.removeProperty("--ait-font-size");
  if (!view.hadStyleAttr && view.el.getAttribute("style") === "") view.el.removeAttribute("style");
}

/** 只清掉「翻译中」占位，保留已有译文 */
export function clearPending(view: BlockView): void {
  if (view.node?.dataset.state === "pending") {
    view.node.remove();
    view.node = null;
  }
}

// ---------- 页面右上角的提示条（Shadow DOM，网页样式影响不到） ----------

const BANNER_TAG = "ait-banner";

export function showBanner(message: string, onOpenSettings: () => void): void {
  let host = document.querySelector(BANNER_TAG);
  if (host === null) {
    host = document.createElement(BANNER_TAG);
    host.attachShadow({ mode: "open" });
    document.documentElement.append(host);
  }
  const root = host.shadowRoot!;
  root.innerHTML = `
    <style>
      .bar { position: fixed; top: 16px; right: 16px; z-index: 2147483647; max-width: 360px;
        display: flex; gap: 10px; align-items: flex-start; padding: 12px 14px; border-radius: 10px;
        background: #1f2533; color: #f3f5f9; font: 13px/1.5 -apple-system, "PingFang SC", system-ui, sans-serif;
        box-shadow: 0 6px 24px rgba(0,0,0,.25); }
      .msg { flex: 1; }
      button { all: unset; cursor: pointer; color: #9cb6ff; white-space: nowrap; }
      button:focus-visible { outline: 2px solid #9cb6ff; border-radius: 3px; }
    </style>
    <div class="bar" role="alert">
      <div class="msg"></div>
      <button class="open" type="button">打开设置</button>
      <button class="close" type="button" aria-label="关闭">×</button>
    </div>`;
  root.querySelector(".msg")!.textContent = message;
  root.querySelector(".open")!.addEventListener("click", onOpenSettings);
  root.querySelector(".close")!.addEventListener("click", hideBanner);
}

export function hideBanner(): void {
  document.querySelector(BANNER_TAG)?.remove();
}

