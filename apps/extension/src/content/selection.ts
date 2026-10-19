// 划词翻译：选中文字后在选区末尾旁显示一条小工具条 -- 翻译图标点了才翻译、译文显示在气泡里；朗读图标直接读选中的原文（不读译文）。
// 图标和气泡挂在 Shadow DOM 里，:host 全部重置，网页样式影响不到它们，它们也不影响网页。
// 页面没开启滑动翻译时也能用：用一次性消息发给后台，插到翻译队列最前。
import type { RuntimeMessage, SelectionResult } from "../shared/messages.ts";
import { DEFAULT_SETTINGS, loadSettings } from "../shared/settings.ts";
import { extensionAlive } from "./alive.ts";
import { isAlreadyTarget } from "./blocks.ts";
import { Speaker } from "./speech.ts";

export const MAX_SELECTION_CHARS = 2000;
const HOST_TAG = "ait-selection";
// 工具条上每个按钮的大小：图标 14~16px，左右各留约 7px
const TOOL_WIDTH = 30;
const TOOL_HEIGHT = 26;
const TOOLS_WIDTH = TOOL_WIDTH * 2 + 1; // 两个按钮加中间 1px 分隔线
const BUBBLE_WIDTH = 360;
const GAP = 6;
// 「中→A」翻译图标，取自 Remix Icon 4.9.1 的 translate（https://remixicon.com，许可允许在软件里当界面图标用）
const TRANSLATE_ICON =
  "M5 15V17C5 18.0544 5.81588 18.9182 6.85074 18.9945L7 19H10V21H7C4.79086 21 3 19.2091 3 17V15H5ZM18 10L22.4 21H20.245L19.044 18H14.954L13.755 21H11.601L16 10H18ZM17 12.8852L15.753 16H18.245L17 12.8852ZM8 2V4H12V11H8V14H6V11H2V4H6V2H8ZM17 3C19.2091 3 21 4.79086 21 7V9H19V7C19 5.89543 18.1046 5 17 5H14V3H17ZM6 6H4V9H6V6ZM10 6H8V9H10V6Z";

const STYLE = `
:host { all: initial !important; position: fixed !important; top: 0 !important; left: 0 !important; z-index: 2147483647 !important; }
[hidden] { display: none !important; }
.tools { position: fixed; display: flex; align-items: center; border-radius: 6px; overflow: hidden;
  background: #2753c8; box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25); }
.sep { width: 1px; height: 14px; background: rgba(255, 255, 255, 0.35); }
.icon { display: grid; place-items: center; box-sizing: border-box; width: ${TOOL_WIDTH}px; height: ${TOOL_HEIGHT}px; margin: 0; padding: 0; border: 0;
  background: transparent; color: #fff; cursor: pointer; }
.icon:hover { background: rgba(255, 255, 255, 0.16); }
.icon:focus-visible { outline: 2px solid #9cb6ff; outline-offset: -2px; }
.speak[aria-pressed="true"] { background: rgba(255, 255, 255, 0.28); }
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
  readonly #speaker = new Speaker();

  async init(): Promise<void> {
    // 先按默认设置同步挂上监听，页面刚加载完就划词也能接住；读完设置再按实际设置调整
    this.#apply(DEFAULT_SETTINGS.selectionEnabled, DEFAULT_SETTINGS.target);
    chrome.storage.onChanged.addListener(this.#onSettings);
    const s = await loadSettings();
    this.#apply(s.selectionEnabled, s.target);
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
    clearTimeout(this.#timer); // 还没执行的选区检查也取消，免得收起后又被它显示出来
    if (this.#root === null) return;
    this.#root.querySelector<HTMLElement>(".tools")!.hidden = true;
    this.#root.querySelector<HTMLElement>(".bubble")!.hidden = true;
    this.#stopSpeaking();
  };

  #schedule(): void {
    clearTimeout(this.#timer);
    this.#timer = window.setTimeout(() => this.#check(), 120);
  }

  // ---------- 选区 ----------

  #check(): void {
    if (!extensionAlive()) {
      this.dispose(); // 插件已重新加载或停用：不再出工具条，交给新注入的脚本
      return;
    }
    const sel = document.getSelection();
    const text = (sel?.toString() ?? "").replace(/\s+/g, " ").trim();
    const range = sel !== null && sel.rangeCount > 0 && !sel.isCollapsed ? sel.getRangeAt(sel.rangeCount - 1) : null;
    const rects = range?.getClientRects();
    const last = rects?.[rects.length - 1];
    if (sel === null || last === undefined || !this.#translatable(sel, text)) {
      if (this.#root !== null) this.#root.querySelector<HTMLElement>(".tools")!.hidden = true;
      return;
    }
    this.#text = text;
    this.#anchor = last;
    const root = this.#ensureHost();
    const tools = root.querySelector<HTMLElement>(".tools")!;
    tools.style.left = `${clamp(last.right + GAP, 4, window.innerWidth - TOOLS_WIDTH - 4)}px`;
    tools.style.top = `${clamp(last.bottom + GAP, 4, window.innerHeight - TOOL_HEIGHT - 4)}px`;
    tools.hidden = false;
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
      <div class="tools" hidden>
        <button class="icon translate" type="button" title="翻译选中的文字" aria-label="翻译选中的文字">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="${TRANSLATE_ICON}"/></svg>
        </button>
        <span class="sep" aria-hidden="true"></span>
        <button class="icon speak" type="button" title="朗读原文" aria-label="朗读原文" aria-pressed="false">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 5 6 9H3v6h3l5 4V5z" fill="currentColor"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/></svg>
        </button>
      </div>
      <div class="bubble" role="dialog" aria-label="划词翻译" hidden>
        <div class="text"></div>
        <div class="actions"><button class="copy" type="button">复制</button><button class="close" type="button">关闭</button></div>
      </div>`;
    const tools = root.querySelector<HTMLElement>(".tools")!;
    tools.addEventListener("mousedown", (e) => e.preventDefault()); // 点图标时保住页面上的选区
    root.querySelector(".translate")!.addEventListener("click", () => void this.#translate());
    root.querySelector(".speak")!.addEventListener("click", () => void this.#speak());
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
    const tools = this.#root.querySelector<HTMLElement>(".tools")!;
    const bubble = this.#root.querySelector<HTMLElement>(".bubble")!;
    const out = this.#root.querySelector<HTMLElement>(".text")!;
    tools.hidden = true;
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

  /** 朗读选中的原文；正在读时再点一次就停 */
  async #speak(): Promise<void> {
    const button = this.#root?.querySelector<HTMLElement>(".speak");
    if (!button) return;
    if (this.#speaker.speaking) {
      this.#stopSpeaking();
      return;
    }
    const text = this.#text;
    if (text === "") return;
    button.setAttribute("aria-pressed", "true");
    const voice = await this.#speaker.speak(text, await this.#speechLanguage(text), () => button.setAttribute("aria-pressed", "false"));
    if (voice === null) {
      button.setAttribute("aria-pressed", "false");
      button.title = "没有可用的本机语音";
      return;
    }
    button.title = `朗读原文（${voice}）`;
  }

  #stopSpeaking(): void {
    this.#speaker.stop();
    this.#root?.querySelector(".speak")?.setAttribute("aria-pressed", "false");
  }

  /** 朗读用的语言：检测结果可靠就用它；单个词常常测不准，退回网页声明的语言，再退回英语 */
  async #speechLanguage(text: string): Promise<string> {
    // 工具条出来后插件被重新加载，检测会失败；朗读本身不靠插件，照样按网页语言读
    const result = await chrome.i18n.detectLanguage(text).catch(() => null);
    const top = result === null ? undefined : [...result.languages].sort((a, b) => b.percentage - a.percentage)[0];
    if (result?.isReliable && top !== undefined && top.percentage >= 50) return top.language;
    const page = document.documentElement.lang.toLowerCase().split("-")[0] ?? "";
    return page !== "" && page !== this.#target.toLowerCase().split("-")[0] ? page : "en";
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
