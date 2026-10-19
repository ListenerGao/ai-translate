// 一个标签页的翻译会话：开启后观察视口，把进入范围的段落交给后台，按段插入译文；关闭时完整还原页面。
import { canUseMarkup, stripMarkers, toTagged, type TranslateErrorCode } from "@ai-translate/core";
import { PAGE_PORT, type BackgroundToPage, type PageToBackground, type QueueItem } from "../shared/messages.ts";
import { loadSettings, type Settings } from "../shared/settings.ts";
import { BlockFinder, viewportDistance } from "./blocks.ts";
import { isShortText } from "./text-rules.ts";
import {
  applyDisplayMode,
  clearPending,
  clearView,
  ensureStyle,
  hideBanner,
  removeStyle,
  showBanner,
  showError,
  showPending,
  showResult,
  type BlockView,
} from "./view.ts";

type Status = "idle" | "queued" | "done" | "failed";

interface Block extends BlockView {
  id: string;
  text: string;
  status: Status;
}

const ID_ATTR = "data-ait-id";

function sameText(a: string, b: string): boolean {
  const normalize = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  return normalize(a) === normalize(b);
}
// 这几类错误和段落无关，整页只提示一次，段落保持未翻译，改好设置后自动重试
const PAGE_LEVEL_ERRORS = new Set<TranslateErrorCode>(["endpoint", "no-key", "unreachable", "unauthorized"]);

export class PageSession {
  #active = false;
  #disposed = false;
  #settings: Settings | null = null;
  #blocks = new Map<string, Block>();
  #byElement = new WeakMap<Element, Block>();
  #visible = new Set<string>();
  #nextId = 1;
  #port: chrome.runtime.Port | null = null;
  #intersection: IntersectionObserver | null = null;
  #mutation: MutationObserver | null = null;
  #scanTimer = 0;
  #priorityTimer = 0;

  get active(): boolean {
    return this.#active;
  }

  async start(): Promise<void> {
    if (this.#active || this.#disposed) return;
    this.#active = true;
    this.#settings = await loadSettings();
    ensureStyle();

    this.#intersection = new IntersectionObserver((entries) => this.#onIntersect(entries), {
      rootMargin: "0px 0px 100% 0px", // 屏幕内 + 下方 1 屏
    });
    this.#mutation = new MutationObserver((mutations) => this.#onMutation(mutations));
    this.#mutation.observe(document.body, { childList: true, subtree: true });
    window.addEventListener("scroll", this.#onScroll, { passive: true });
    window.addEventListener("pagehide", this.#onPageHide);
    window.addEventListener("pageshow", this.#onPageShow);
    chrome.storage.onChanged.addListener(this.#onSettingsChanged);
    this.#scan();
  }

  stop(): void {
    if (!this.#active) return;
    this.#active = false;
    this.#intersection?.disconnect();
    this.#mutation?.disconnect();
    this.#intersection = this.#mutation = null;
    window.removeEventListener("scroll", this.#onScroll);
    window.removeEventListener("pagehide", this.#onPageHide);
    window.removeEventListener("pageshow", this.#onPageShow);
    chrome.storage.onChanged.removeListener(this.#onSettingsChanged);
    clearTimeout(this.#scanTimer);
    clearTimeout(this.#priorityTimer);

    const queued = [...this.#blocks.values()].filter((b) => b.status === "queued").map((b) => b.id);
    if (queued.length > 0) this.#send({ type: "cancel", ids: queued }, false);
    for (const block of this.#blocks.values()) {
      clearView(block);
      block.el.removeAttribute(ID_ATTR);
    }
    this.#blocks.clear();
    this.#byElement = new WeakMap();
    this.#visible.clear();
    removeStyle();
    hideBanner();
    this.#port?.disconnect();
    this.#port = null;
  }

  /** 新注入的 content script 接管时，停掉旧实例 */
  dispose(): void {
    this.stop();
    this.#disposed = true;
  }

  // ---------- 段落发现 ----------

  #scan(): void {
    if (!this.#active || this.#settings === null) return;
    for (const { el, text, nodes, refs } of new BlockFinder().find(document.body, this.#settings.target)) {
      if (this.#byElement.has(el)) continue;
      const block: Block = {
        id: String(this.#nextId++),
        el,
        text,
        status: "idle",
        node: null,
        hadStyleAttr: el.hasAttribute("style"),
        hadClassAttr: el.hasAttribute("class"),
        inline: isShortText(text),
        markup: canUseMarkup(nodes) ? toTagged(nodes) : null,
        refs,
      };
      el.setAttribute(ID_ATTR, block.id);
      this.#blocks.set(block.id, block);
      this.#byElement.set(el, block);
      this.#intersection?.observe(el);
    }
  }

  #onMutation(mutations: MutationRecord[]): void {
    const relevant = mutations.some((m) =>
      [...m.addedNodes].some((n) => n.nodeType === Node.ELEMENT_NODE && !(n as Element).closest("ait-translation")),
    );
    if (!relevant) return;
    clearTimeout(this.#scanTimer);
    this.#scanTimer = window.setTimeout(() => this.#scan(), 200);
  }

  // ---------- 视口观察与排队 ----------

  #onIntersect(entries: IntersectionObserverEntry[]): void {
    const enqueue: QueueItem[] = [];
    const cancel: string[] = [];
    for (const entry of entries) {
      const block = this.#byElement.get(entry.target);
      if (block === undefined) continue;
      if (entry.isIntersecting) {
        this.#visible.add(block.id);
        if (block.status === "idle") enqueue.push(this.#markQueued(block));
      } else {
        this.#visible.delete(block.id);
        if (block.status === "queued") {
          // 滑出范围还没翻完：撤销。已经在翻的后台会照常翻完写缓存，回来时直接命中
          block.status = "idle";
          clearPending(block);
          cancel.push(block.id);
        }
      }
    }
    if (cancel.length > 0) this.#send({ type: "cancel", ids: cancel });
    if (enqueue.length > 0) this.#send({ type: "enqueue", items: enqueue });
  }

  #markQueued(block: Block): QueueItem {
    block.status = "queued";
    showPending(block, this.#settings!.target);
    const item: QueueItem = { id: block.id, text: block.text, priority: viewportDistance(block.el) };
    if (block.markup !== null) item.markup = block.markup;
    return item;
  }

  /** 端口断开（后台休眠）或设置改好后，把范围内还没翻的段落重新排队 */
  #requeueVisible(): void {
    if (!this.#active) return;
    const items: QueueItem[] = [];
    for (const id of this.#visible) {
      const block = this.#blocks.get(id);
      if (block?.status === "idle") items.push(this.#markQueued(block));
    }
    if (items.length > 0) this.#send({ type: "enqueue", items });
  }

  #onScroll = (): void => {
    clearTimeout(this.#priorityTimer);
    this.#priorityTimer = window.setTimeout(() => {
      const updates = [...this.#blocks.values()]
        .filter((b) => b.status === "queued")
        .map((b) => ({ id: b.id, priority: viewportDistance(b.el) }));
      if (updates.length > 0) this.#send({ type: "priority", updates }, false);
    }, 150);
  };

  // 往返缓存（bfcache）：离开页面时页面被冻结保存，Chrome 会关掉连接且不会恢复。
  // 离开前主动断开、把排队中的段落退回未翻译；后退回来时重新连接并排队（Chrome 官方建议的做法）
  #onPageHide = (event: PageTransitionEvent): void => {
    if (!event.persisted) return;
    const port = this.#port;
    this.#dropPort();
    port?.disconnect();
  };

  #onPageShow = (event: PageTransitionEvent): void => {
    if (!event.persisted) return;
    this.#dropPort();
    this.#requeueVisible();
  };

  #onSettingsChanged = (_changes: unknown, area: string): void => {
    if (area !== "local" || !this.#active) return;
    void loadSettings().then((s) => {
      const modeChanged = s.displayMode !== this.#settings?.displayMode;
      this.#settings = s;
      if (modeChanged) for (const block of this.#blocks.values()) applyDisplayMode(block, s.displayMode);
      hideBanner();
      this.#requeueVisible();
    });
  };

  // ---------- 和后台通信 ----------

  #send(msg: PageToBackground, connectIfNeeded = true): void {
    // 连接可能已被关掉而本页没收到通知（如往返缓存），发送失败就重连再发一次
    for (let attempt = 0; attempt < 2; attempt++) {
      if (this.#port === null) {
        if (!connectIfNeeded) return;
        try {
          this.#connect();
        } catch {
          // 插件被重新加载后旧页面的上下文失效，静默停止
          this.stop();
          return;
        }
      }
      try {
        this.#port?.postMessage(msg);
        return;
      } catch {
        this.#port = null;
      }
    }
  }

  #connect(): void {
    const port = chrome.runtime.connect({ name: PAGE_PORT });
    port.onMessage.addListener((msg: BackgroundToPage) => this.#onMessage(msg));
    port.onDisconnect.addListener(() => {
      void chrome.runtime.lastError;
      if (this.#port !== port) return;
      // 后台休眠时排队中的任务丢了：退回未翻译，稍后重新排队
      this.#dropPort();
      if (this.#active) window.setTimeout(() => this.#requeueVisible(), 100);
    });
    this.#port = port;
  }

  /** 连接作废：排队中的段落退回未翻译，等重新排队 */
  #dropPort(): void {
    this.#port = null;
    for (const block of this.#blocks.values()) {
      if (block.status === "queued") {
        block.status = "idle";
        clearPending(block);
      }
    }
  }

  #onMessage(msg: BackgroundToPage): void {
    const block = this.#blocks.get(msg.id);
    if (!this.#active || block === undefined || this.#settings === null) return;
    if (msg.type === "result") {
      block.status = "done";
      // 译文和原文一样（品牌名、产品名）就不显示，免得出现「Hugging Face Hugging Face」
      if (sameText(stripMarkers(msg.text), block.text)) clearPending(block);
      else showResult(block, msg.text, this.#settings.target, this.#settings.displayMode);
      return;
    }
    if (PAGE_LEVEL_ERRORS.has(msg.code)) {
      block.status = "idle";
      clearPending(block);
      showBanner(msg.message, () => {
        chrome.runtime.sendMessage({ type: "open-options" }).catch(() => {});
      });
      return;
    }
    // 超时、服务出错：段落下提示，滑出再回来会重试；译文不合格：不再重试
    block.status = msg.code === "invalid" ? "failed" : "idle";
    showError(block, msg.message, this.#settings.target);
  }
}
