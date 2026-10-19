// 划词翻译：选中文字后在选区末尾旁显示一条小工具条 -- 翻译图标点了才翻译、译文显示在翻译卡片里；朗读图标直接读选中的原文（不读译文）。
// 工具条和卡片挂在 Shadow DOM 里，:host 全部重置，网页样式影响不到它们，它们也不影响网页。
// 页面没开启滑动翻译时也能用：用一次性消息发给后台，插到翻译队列最前。
import { LANGUAGES } from "../shared/languages.ts";
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
const CARD_WIDTH = 420;
const GAP = 6;
// 「中→A」翻译图标，取自 Remix Icon 4.9.1 的 translate（https://remixicon.com，许可允许在软件里当界面图标用）
const TRANSLATE_ICON =
  "M5 15V17C5 18.0544 5.81588 18.9182 6.85074 18.9945L7 19H10V21H7C4.79086 21 3 19.2091 3 17V15H5ZM18 10L22.4 21H20.245L19.044 18H14.954L13.755 21H11.601L16 10H18ZM17 12.8852L15.753 16H18.245L17 12.8852ZM8 2V4H12V11H8V14H6V11H2V4H6V2H8ZM17 3C19.2091 3 21 4.79086 21 7V9H19V7C19 5.89543 18.1046 5 17 5H14V3H17ZM6 6H4V9H6V6ZM10 6H8V9H10V6Z";
// 卡片上的线条图标，画法参考 Lucide（ISC 许可）
const LINE_ICONS = {
  chevron: '<path d="m6 9 6 6 6-6"/>',
  close: '<path d="M18 6 6 18M6 6l12 12"/>',
  pin: '<path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/>',
  copy: '<rect x="8" y="8" width="14" height="14" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  speaker: '<path d="M11 5 6 9H3v6h3l5 4V5z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/>',
} as const;
const lineIcon = (name: keyof typeof LINE_ICONS, size = 18) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${LINE_ICONS[name]}</svg>`;

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

.card { --bg: #ffffff; --fg: #111827; --muted: #6b7280; --line: #e5e7eb; --hover: #f3f4f6; --accent: #2753c8; --error: #c2410c; --ok: #16a34a;
  position: fixed; box-sizing: border-box; width: ${CARD_WIDTH}px; max-width: calc(100vw - 16px); max-height: min(70vh, 520px);
  display: flex; flex-direction: column; overflow: hidden; border: 1px solid var(--line); border-radius: 12px;
  background: var(--bg); color: var(--fg); font: 15px/1.6 -apple-system, "PingFang SC", "Noto Sans SC", system-ui, sans-serif;
  text-align: left; box-shadow: 0 10px 32px rgba(0, 0, 0, 0.14); }
@media (prefers-color-scheme: dark) {
  .card { --bg: #1f2227; --fg: #e8eaee; --muted: #9aa1ae; --line: #33373e; --hover: #2a2e35; --accent: #8fb0ff; --error: #fdba74; --ok: #4ade80;
    box-shadow: 0 10px 32px rgba(0, 0, 0, 0.45); }
}
.head { display: flex; align-items: center; gap: 4px; padding: 8px 8px 8px 16px; border-bottom: 1px solid var(--line); }
.logo { display: grid; margin-right: 6px; color: var(--muted); }
.title { flex: 1; font-size: 16px; font-weight: 600; }
.lang { position: relative; display: flex; align-items: center; gap: 2px; height: 30px; padding: 0 6px 0 8px; border-radius: 8px;
  color: var(--muted); font-size: 14px; cursor: pointer; }
.lang:hover { background: var(--hover); color: var(--fg); }
.lang:focus-within { outline: 2px solid var(--accent); outline-offset: 1px; }
.lang select { position: absolute; inset: 0; width: 100%; height: 100%; opacity: 0; cursor: pointer; font: inherit; }
.btn { all: unset; display: grid; place-items: center; flex: none; width: 30px; height: 30px; border-radius: 8px; color: var(--muted); cursor: pointer; }
.btn:hover { background: var(--hover); color: var(--fg); }
.btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.btn[aria-pressed="true"] { color: var(--accent); }
.pin[aria-pressed="true"] svg { fill: currentColor; }
.body { overflow: auto; }
.source { margin: 0 8px 0 16px; padding: 10px 0 6px; border-bottom: 1px solid var(--line); }
.source-row { display: flex; align-items: flex-start; gap: 2px; }
.source-text { flex: 1; margin: 0; padding-top: 3px; color: var(--muted); white-space: pre-wrap; word-break: break-word;
  display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; }
.source-text[data-expanded="true"] { display: block; }
.expand svg { transition: transform 0.15s; }
.expand[aria-expanded="true"] svg { transform: rotate(180deg); }
.result { padding: 12px 16px 6px; }
.text { white-space: pre-wrap; word-break: break-word; }
.text[data-state="pending"] { color: var(--muted); }
.text[data-state="error"] { color: var(--error); }
.actions { display: flex; gap: 2px; margin: 4px 0 0 -7px; }
.foot { display: flex; align-items: center; padding: 10px 16px; border-top: 1px solid var(--line); }
.engine { display: inline-flex; align-items: center; gap: 8px; padding: 4px 12px; border: 1px solid var(--line); border-radius: 999px; font-size: 13px; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--ok); }
@media (prefers-reduced-motion: reduce) { .expand svg { transition: none; } }
`;

export class SelectionTranslator {
  #enabled = false;
  /** 设置里的目标语言 */
  #target = "zh";
  /** 卡片里临时选的目标语言，本页有效；null 表示跟随设置 */
  #cardTarget: string | null = null;
  #host: HTMLElement | null = null;
  #root: ShadowRoot | null = null;
  /** 当前选区的文字 */
  #text = "";
  /** 卡片里正在翻译的原文 */
  #cardText = "";
  #anchor: DOMRect | null = null;
  #pinned = false;
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
    if (target !== this.#target) this.#cardTarget = null; // 设置里改了目标语言：卡片跟着用新的
    this.#target = target;
    if (enabled === this.#enabled) return;
    this.#enabled = enabled;
    if (enabled) {
      document.addEventListener("mouseup", this.#onMouseUp, true);
      document.addEventListener("keyup", this.#onKeyUp, true);
      document.addEventListener("mousedown", this.#onMouseDown, true);
      document.addEventListener("keydown", this.#onKeyDown, true);
      window.addEventListener("scroll", this.#onScroll, true);
      return;
    }
    document.removeEventListener("mouseup", this.#onMouseUp, true);
    document.removeEventListener("keyup", this.#onKeyUp, true);
    document.removeEventListener("mousedown", this.#onMouseDown, true);
    document.removeEventListener("keydown", this.#onKeyDown, true);
    window.removeEventListener("scroll", this.#onScroll, true);
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

  /** 点网页别处：收起工具条、停止朗读；卡片没固定就关掉 */
  #onMouseDown = (event: MouseEvent): void => {
    if (this.#inside(event)) return;
    this.#hideTools();
    this.#stopSpeaking();
    if (!this.#pinned) this.#closeCard();
  };

  #onScroll = (): void => {
    this.#hideTools();
    if (!this.#pinned) this.#closeCard();
  };

  /** Esc：固定了也关 */
  #onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Escape") this.#hideAll();
  };

  #hideAll = (): void => {
    this.#hideTools();
    this.#closeCard();
  };

  #hideTools(): void {
    clearTimeout(this.#timer); // 还没执行的选区检查也取消，免得收起后又被它显示出来
    if (this.#root !== null) this.#root.querySelector<HTMLElement>(".tools")!.hidden = true;
  }

  #closeCard(): void {
    this.#seq++; // 还在路上的译文回来也不再显示
    this.#setPinned(false);
    this.#stopSpeaking();
    if (this.#root !== null) this.#root.querySelector<HTMLElement>(".card")!.hidden = true;
  }

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

  // ---------- 工具条和翻译卡片 ----------

  #ensureHost(): ShadowRoot {
    if (this.#root !== null && this.#host?.isConnected) return this.#root;
    const host = document.createElement(HOST_TAG);
    const root = host.attachShadow({ mode: "open" });
    const options = LANGUAGES.map((l) => `<option value="${l.code}">${l.name}</option>`).join("");
    root.innerHTML = `<style>${STYLE}</style>
      <div class="tools" hidden>
        <button class="icon translate" type="button" title="翻译选中的文字" aria-label="翻译选中的文字">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="${TRANSLATE_ICON}"/></svg>
        </button>
        <span class="sep" aria-hidden="true"></span>
        <button class="icon speak" type="button" data-speak title="朗读原文" aria-label="朗读原文" aria-pressed="false">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 5 6 9H3v6h3l5 4V5z" fill="currentColor"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/></svg>
        </button>
      </div>
      <div class="card" role="dialog" aria-label="划词翻译" hidden>
        <div class="head">
          <span class="logo"><svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="${TRANSLATE_ICON}"/></svg></span>
          <span class="title">翻译</span>
          <label class="lang" title="目标语言"><span class="lang-name"></span>${lineIcon("chevron", 16)}<select class="target" aria-label="目标语言">${options}</select></label>
          <button class="btn pin" type="button" aria-pressed="false" title="固定：点别处、滚动页面时不关闭" aria-label="固定">${lineIcon("pin")}</button>
          <button class="btn close" type="button" title="关闭" aria-label="关闭">${lineIcon("close")}</button>
        </div>
        <div class="body">
          <div class="source">
            <div class="source-row">
              <p class="source-text" data-expanded="false"></p>
              <button class="btn expand" type="button" aria-expanded="false" title="展开原文" aria-label="展开原文" hidden>${lineIcon("chevron")}</button>
            </div>
            <div class="actions"><button class="btn read" type="button" data-speak title="朗读原文" aria-label="朗读原文" aria-pressed="false">${lineIcon("speaker")}</button></div>
          </div>
          <div class="result">
            <div class="text" aria-live="polite"></div>
            <div class="actions"><button class="btn copy" type="button" title="复制译文" aria-label="复制译文">${lineIcon("copy")}</button></div>
          </div>
        </div>
        <div class="foot"><span class="engine"><span class="dot" aria-hidden="true"></span>Index-Translate-2B · 本机</span></div>
      </div>`;
    const $ = <T extends HTMLElement>(selector: string) => root.querySelector<T>(selector)!;
    $(".tools").addEventListener("mousedown", (e) => e.preventDefault()); // 点图标时保住页面上的选区
    $(".translate").addEventListener("click", () => this.#openCard());
    $(".speak").addEventListener("click", () => void this.#speak(this.#text));
    $(".read").addEventListener("click", () => void this.#speak(this.#cardText));
    $(".close").addEventListener("click", this.#hideAll);
    $(".pin").addEventListener("click", () => this.#setPinned(!this.#pinned));
    $(".expand").addEventListener("click", () => this.#toggleSource());
    $(".copy").addEventListener("click", () => void this.#copy());
    $<HTMLSelectElement>(".target").addEventListener("change", (e) => {
      this.#cardTarget = (e.target as HTMLSelectElement).value;
      this.#showTarget();
      void this.#request();
    });
    document.documentElement.append(host);
    this.#host = host;
    this.#root = root;
    return root;
  }

  /** 点工具条上的翻译图标：打开卡片翻译当前选区。卡片已固定时原地换内容，不挪位置 */
  #openCard(): void {
    if (this.#text === "" || this.#root === null) return;
    const card = this.#root.querySelector<HTMLElement>(".card")!;
    const stay = this.#pinned && !card.hidden;
    this.#cardText = this.#text;
    this.#root.querySelector<HTMLElement>(".tools")!.hidden = true;
    this.#stopSpeaking();
    const source = this.#root.querySelector<HTMLElement>(".source-text")!;
    source.textContent = this.#cardText;
    source.dataset.expanded = "false";
    const expand = this.#root.querySelector<HTMLElement>(".expand")!;
    expand.setAttribute("aria-expanded", "false");
    this.#showTarget();
    card.hidden = false;
    // 原文超过两行才出现「展开」
    expand.hidden = source.scrollHeight <= source.clientHeight + 1;
    void this.#request(stay);
  }

  /** 按卡片当前的目标语言翻译卡片里的原文 */
  async #request(stay = true): Promise<void> {
    if (this.#root === null || this.#cardText === "") return;
    const seq = ++this.#seq;
    const card = this.#root.querySelector<HTMLElement>(".card")!;
    const out = this.#root.querySelector<HTMLElement>(".text")!;
    out.dataset.state = "pending";
    out.textContent = "翻译中…";
    if (!stay) this.#placeCard(card);

    let result: SelectionResult;
    try {
      const message: RuntimeMessage = { type: "translate-selection", text: this.#cardText, target: this.#effectiveTarget() };
      result = await chrome.runtime.sendMessage(message);
    } catch {
      result = { ok: false, message: "插件已更新，请刷新页面后再试" };
    }
    if (seq !== this.#seq || card.hidden) return; // 已关闭，或者又翻了别的
    out.dataset.state = result.ok ? "done" : "error";
    out.textContent = result.ok ? result.text : result.message;
    if (!this.#pinned) this.#placeCard(card);
  }

  #effectiveTarget(): string {
    return this.#cardTarget ?? this.#target;
  }

  /** 语言下拉显示当前目标语言；不在列表里的语言（设置里手填的）临时加一项 */
  #showTarget(): void {
    if (this.#root === null) return;
    const code = this.#effectiveTarget();
    const select = this.#root.querySelector<HTMLSelectElement>(".target")!;
    if (![...select.options].some((o) => o.value === code)) select.add(new Option(code, code));
    select.value = code;
    this.#root.querySelector<HTMLElement>(".lang-name")!.textContent = LANGUAGES.find((l) => l.code === code)?.name ?? code;
  }

  #setPinned(pinned: boolean): void {
    this.#pinned = pinned;
    this.#root?.querySelector(".pin")?.setAttribute("aria-pressed", String(pinned));
  }

  #toggleSource(): void {
    const source = this.#root?.querySelector<HTMLElement>(".source-text");
    const expand = this.#root?.querySelector<HTMLElement>(".expand");
    if (!source || !expand) return;
    const expanded = source.dataset.expanded !== "true";
    source.dataset.expanded = String(expanded);
    expand.setAttribute("aria-expanded", String(expanded));
    expand.title = expand.ariaLabel = expanded ? "收起原文" : "展开原文";
  }

  /** 朗读原文（工具条和卡片里的喇叭都读原文，不读译文）；正在读时再点一次就停 */
  async #speak(text: string): Promise<void> {
    if (this.#speaker.speaking) {
      this.#stopSpeaking();
      return;
    }
    if (text === "") return;
    this.#setSpeaking(true);
    const voice = await this.#speaker.speak(text, await this.#speechLanguage(text), () => this.#setSpeaking(false));
    const buttons = this.#speakButtons();
    if (voice === null) {
      this.#setSpeaking(false);
      for (const b of buttons) b.title = "没有可用的本机语音";
      return;
    }
    for (const b of buttons) b.title = `朗读原文（${voice}）`;
  }

  #speakButtons(): HTMLElement[] {
    return [...(this.#root?.querySelectorAll<HTMLElement>("[data-speak]") ?? [])];
  }

  #setSpeaking(on: boolean): void {
    for (const b of this.#speakButtons()) b.setAttribute("aria-pressed", String(on));
  }

  #stopSpeaking(): void {
    this.#speaker.stop();
    this.#setSpeaking(false);
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

  /** 卡片放在选区下方；下方放不下就放上方；选区已经滚出屏幕（或全选时末尾在页面底部）也保证卡片整个在屏幕内 */
  #placeCard(card: HTMLElement): void {
    const anchor = this.#anchor;
    if (anchor === null) return;
    const { width, height } = card.getBoundingClientRect();
    const below = anchor.bottom + GAP;
    const top = below + height <= window.innerHeight - 8 ? below : anchor.top - height - GAP;
    card.style.left = `${clamp(anchor.left, 8, window.innerWidth - width - 8)}px`;
    card.style.top = `${clamp(top, 8, window.innerHeight - height - 8)}px`;
  }

  async #copy(): Promise<void> {
    const out = this.#root?.querySelector<HTMLElement>(".text");
    const button = this.#root?.querySelector<HTMLElement>(".copy");
    if (!out || !button || out.dataset.state !== "done") return;
    try {
      await navigator.clipboard.writeText(out.textContent ?? "");
      button.innerHTML = lineIcon("check");
      button.title = "已复制";
    } catch {
      button.title = "复制失败";
    }
    window.setTimeout(() => {
      button.innerHTML = lineIcon("copy");
      button.title = "复制译文";
    }, 1500);
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}
