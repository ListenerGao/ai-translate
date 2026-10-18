// 划词翻译：选中文字后在选区末尾旁显示一个小图标，点了才翻译，译文显示在气泡里。
// 图标和气泡挂在 Shadow DOM 里，:host 全部重置，网页样式影响不到它们，它们也不影响网页。
// 页面没开启滑动翻译时也能用：用一次性消息发给后台，插到翻译队列最前。
import type { RuntimeMessage, SelectionResult } from "../shared/messages.ts";
import { loadSettings } from "../shared/settings.ts";
import { isAlreadyTarget } from "./blocks.ts";

export const MAX_SELECTION_CHARS = 2000;
const HOST_TAG = "ait-selection";
const ICON_SIZE = 24;
const BUBBLE_WIDTH = 360;
const GAP = 6;

const STYLE = `
:host { all: initial !important; position: fixed !important; top: 0 !important; left: 0 !important; z-index: 2147483647 !important; }
[hidden] { display: none !important; }
.icon { position: fixed; box-sizing: border-box; width: ${ICON_SIZE}px; height: ${ICON_SIZE}px; margin: 0; padding: 0; border: 0; border-radius: 6px;
  background: #2753c8; color: #fff; font: 600 13px/${ICON_SIZE}px -apple-system, "PingFang SC", "Noto Sans SC", system-ui, sans-serif;
  text-align: center; cursor: pointer; box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25); }
.icon:focus-visible { outline: 2px solid #9cb6ff; outline-offset: 2px; }
.bubble { position: fixed; box-sizing: border-box; width: max-content; max-width: ${BUBBLE_WIDTH}px; max-height: 260px; overflow: auto;
  padding: 10px 12px; border-radius: 10px; background: #1f2533; color: #f3f5f9;
  font: 14px/1.6 -apple-system, "PingFang SC", "Noto Sans SC", system-ui, sans-serif; text-align: left;
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.3); }
.text { white-space: pre-wrap; word-break: break-word; }
.text[data-state="pending"] { opacity: 0.6; }
.text[data-state="error"] { color: #f0b35a; }
.actions { display: flex; gap: 14px; justify-content: flex-end; margin-top: 6px; font-size: 12px; }
.actions button { all: unset; cursor: pointer; color: #9cb6ff; }
.actions button:focus-visible { outline: 2px solid #9cb6ff; border-radius: 3px; }
`;

export class SelectionTranslator {
  #enabled = false;
  #target = "zh";
  #host: HTMLElement | null = null;
  #root: ShadowRoot | null = null;
  #text = "";
  #anchor: DOMRect | null = null;
  #seq = 0;
  #timer = 0;

  async init(): Promise<void> {
    const s = await loadSettings();
    this.#apply(s.selectionEnabled, s.target);
    chrome.storage.onChanged.addListener(this.#onSettings);
  }

  dispose(): void {
    chrome.storage.onChanged.removeListener(this.#onSettings);
    this.#apply(false, this.#target);
  }

  #apply(enabled: boolean, target: string): void {
    this.#target = target;
    if (enabled === this.#enabled) return;
    this.#enabled = enabled;
    if (enabled) {
      document.addEventListener("mouseup", this.#onMouseUp, true);
      document.addEventListener("keyup", this.#onKeyUp, true);
      document.addEventListener("mousedown", this.#onMouseDown, true);
      document.addEventListener("keydown", this.#onKeyDown, true);
      window.addEventListener("scroll", this.#hideAll, true);
      return;
    }
    document.removeEventListener("mouseup", this.#onMouseUp, true);
    document.removeEventListener("keyup", this.#onKeyUp, true);
    document.removeEventListener("mousedown", this.#onMouseDown, true);
    document.removeEventListener("keydown", this.#onKeyDown, true);
    window.removeEventListener("scroll", this.#hideAll, true);
    this.#hideAll();
    this.#host?.remove();
    this.#host = this.#root = null;
  }

  #onSettings = (changes: Record<string, unknown>, area: string): void => {
    if (area !== "local" || !("selectionEnabled" in changes || "target" in changes)) return;
    void loadSettings().then((s) => this.#apply(s.selectionEnabled, s.target));
  };

  // ---------- 事件 ----------

  #inside(event: Event): boolean {
    return this.#host !== null && event.composedPath().includes(this.#host);
  }

  #onMouseUp = (event: MouseEvent): void => {
    if (!this.#inside(event)) this.#schedule();
  };

  #onKeyUp = (event: KeyboardEvent): void => {
    if (event.shiftKey || event.key === "Shift" || (event.key === "a" && (event.metaKey || event.ctrlKey))) this.#schedule();
  };

  #onMouseDown = (event: MouseEvent): void => {
    if (!this.#inside(event)) this.#hideAll();
  };

  #onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Escape") this.#hideAll();
  };

  #hideAll = (): void => {
    this.#seq++; // 还在路上的译文回来也不再显示
    if (this.#root === null) return;
    this.#root.querySelector<HTMLElement>(".icon")!.hidden = true;
    this.#root.querySelector<HTMLElement>(".bubble")!.hidden = true;
  };

  #schedule(): void {
    clearTimeout(this.#timer);
    this.#timer = window.setTimeout(() => this.#check(), 120);
  }

  // ---------- 选区 ----------

  #check(): void {
    const sel = document.getSelection();
    const text = (sel?.toString() ?? "").replace(/\s+/g, " ").trim();
    const range = sel !== null && sel.rangeCount > 0 && !sel.isCollapsed ? sel.getRangeAt(sel.rangeCount - 1) : null;
    const rects = range?.getClientRects();
    const last = rects?.[rects.length - 1];
    if (sel === null || last === undefined || !this.#translatable(sel, text)) {
      if (this.#root !== null) this.#root.querySelector<HTMLElement>(".icon")!.hidden = true;
      return;
    }
    this.#text = text;
    this.#anchor = last;
    const root = this.#ensureHost();
    const icon = root.querySelector<HTMLElement>(".icon")!;
    icon.style.left = `${clamp(last.right + GAP, 4, window.innerWidth - ICON_SIZE - 4)}px`;
    icon.style.top = `${clamp(last.bottom + GAP, 4, window.innerHeight - ICON_SIZE - 4)}px`;
    icon.hidden = false;
  }

  /** 输入框、可编辑区域、插件自己的界面、已是目标语言、太长的选区不出图标 */
  #translatable(sel: Selection, text: string): boolean {
    if (!/\p{L}/u.test(text) || text.length > MAX_SELECTION_CHARS) return false;
    if (isAlreadyTarget(text, this.#target)) return false;
    const active = document.activeElement;
    if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement || (active as HTMLElement | null)?.isContentEditable) return false;
    const node = sel.anchorNode;
    const el = node instanceof Element ? node : (node?.parentElement ?? null);
    return el?.closest("input, textarea, [contenteditable]:not([contenteditable='false']), ait-banner") == null;
  }

  // ---------- 图标和气泡 ----------

  #ensureHost(): ShadowRoot {
    if (this.#root !== null && this.#host?.isConnected) return this.#root;
    const host = document.createElement(HOST_TAG);
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `<style>${STYLE}</style>
      <button class="icon" type="button" title="翻译选中的文字" aria-label="翻译选中的文字" hidden>译</button>
      <div class="bubble" role="dialog" aria-label="划词翻译" hidden>
        <div class="text"></div>
        <div class="actions"><button class="copy" type="button">复制</button><button class="close" type="button">关闭</button></div>
      </div>`;
    const icon = root.querySelector<HTMLElement>(".icon")!;
    icon.addEventListener("mousedown", (e) => e.preventDefault()); // 点图标时保住页面上的选区
    icon.addEventListener("click", () => void this.#translate());
    root.querySelector(".copy")!.addEventListener("click", () => void this.#copy());
    root.querySelector(".close")!.addEventListener("click", this.#hideAll);
    document.documentElement.append(host);
    this.#host = host;
    this.#root = root;
    return root;
  }

  async #translate(): Promise<void> {
    const text = this.#text;
    if (text === "" || this.#root === null) return;
    const seq = ++this.#seq;
    const icon = this.#root.querySelector<HTMLElement>(".icon")!;
    const bubble = this.#root.querySelector<HTMLElement>(".bubble")!;
    const out = this.#root.querySelector<HTMLElement>(".text")!;
    icon.hidden = true;
    out.dataset.state = "pending";
    out.textContent = "翻译中…";
    bubble.hidden = false;
    this.#placeBubble(bubble);

    let result: SelectionResult;
    try {
      result = await chrome.runtime.sendMessage({ type: "translate-selection", text } satisfies RuntimeMessage);
    } catch {
      result = { ok: false, message: "插件已更新，请刷新页面后再试" };
    }
    if (seq !== this.#seq || bubble.hidden) return; // 已关闭，或者又划了新的词
    out.dataset.state = result.ok ? "done" : "error";
    out.textContent = result.ok ? result.text : result.message;
    this.#placeBubble(bubble);
  }

  /** 气泡放在选区下方；下方放不下就放上方 */
  #placeBubble(bubble: HTMLElement): void {
    const anchor = this.#anchor;
    if (anchor === null) return;
    const { width, height } = bubble.getBoundingClientRect();
    const left = clamp(anchor.left, 8, window.innerWidth - width - 8);
    const below = anchor.bottom + GAP;
    const top = below + height <= window.innerHeight - 8 ? below : Math.max(8, anchor.top - height - GAP);
    bubble.style.left = `${left}px`;
    bubble.style.top = `${top}px`;
  }

  async #copy(): Promise<void> {
    const out = this.#root?.querySelector<HTMLElement>(".text");
    const button = this.#root?.querySelector<HTMLElement>(".copy");
    if (!out || !button) return;
    try {
      await navigator.clipboard.writeText(out.textContent ?? "");
      button.textContent = "已复制";
    } catch {
      button.textContent = "复制失败";
    }
    window.setTimeout(() => (button.textContent = "复制"), 1500);
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}
