// 扩展后台（service worker）：接收网页端的段落，排队后交给本机翻译服务 aitd，按段返回译文。
// 缓存、术语表、模型都在 aitd；这里只按视口远近排队，同时最多发 4 段（等于模型的并行槽位）。
import { AitdError, AitdTranslator, DEFAULT_MODEL_ID, Scheduler, TranslateError, getModelProfile, isAbortError, type Segment } from "@ai-translate/core";
import { migrateGlossary } from "../shared/aitd.ts";
import { errorMessage } from "../shared/errors.ts";
import {
  PAGE_PORT,
  type BackgroundToPage,
  type PageToBackground,
  type QueueItem,
  type RuntimeMessage,
  type SelectionResult,
  type TabCommand,
  type TabStatus,
} from "../shared/messages.ts";
import { flipDisplayMode, loadSettings, type Settings } from "../shared/settings.ts";

let settingsMemo: Promise<Settings> | null = null;
chrome.storage.onChanged.addListener((_changes, area) => {
  if (area === "local") settingsMemo = null;
});
const getSettings = () => (settingsMemo ??= loadSettings());

// Chrome 对同一地址最多同时开 6 个连接：一次把几十段都发给 aitd 会在浏览器里排队、打乱视口优先级，所以只发轮到的
const scheduler = new Scheduler(getModelProfile(DEFAULT_MODEL_ID).parallel);

// 插件里旧的术语表搬到 aitd（aitd 没启动就下次再搬）。旧版默认地址 8791 的迁移已去掉：
// 8790 被占时桌面应用会把 aitd 换到 8791 等端口，主人填的 8791 不能再被改回 8790（2026-10-21）
void migrateGlossary();

interface Outcome {
  text: string;
  cached: boolean;
}

/** 出错时给人看的提示：aitd 给了原因就用它的 */
function describe(err: unknown): { code: TranslateError["code"]; message: string } {
  const e = err instanceof TranslateError ? err : new TranslateError("server", String(err));
  return { code: e.code, message: e instanceof AitdError ? e.display : errorMessage(e.code, e.detail) };
}

/** 调度队列里的任务 id：段落 id 只在标签页内唯一 */
const taskId = (tabId: number, segmentId: string) => `${tabId}:${segmentId}`;

/** 按入队时的设置翻译一段；target 不传就用设置里的目标语言 */
async function translateSegment(tabId: number, segment: Segment, priority: number, signal?: AbortSignal, target?: string): Promise<Outcome> {
  const s = await getSettings();
  // 读设置期间可能已被撤销：这时任务还没进队列，撤销消息找不到它
  signal?.throwIfAborted();
  const translator = new AitdTranslator(s, priority);
  const request = { segments: [segment], source: s.source, target: target ?? s.target, model: s.modelId };
  return scheduler.enqueue({
    id: taskId(tabId, segment.id),
    priority,
    run: async (runSignal) => {
      for await (const r of translator.translate(request, runSignal)) return { text: r.text, cached: r.cached };
      throw new TranslateError("server", "本机翻译服务没有返回译文");
    },
  });
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== PAGE_PORT) return;
  const tabId = port.sender?.tab?.id;
  if (tabId === undefined) return;

  let open = true;
  const post = (msg: BackgroundToPage) => {
    if (!open) return;
    try {
      port.postMessage(msg);
    } catch {
      open = false;
    }
  };

  // 每段一个撤销信号：撤销消息可能在查缓存期间到达，那时任务还没进队列
  const controllers = new Map<string, AbortController>();

  const handle = (item: QueueItem) => {
    const controller = new AbortController();
    controllers.set(item.id, controller);
    const segment = { id: item.id, text: item.text, ...(item.markup === undefined ? {} : { markup: item.markup }) };
    translateSegment(tabId, segment, item.priority, controller.signal)
      .then((r) => post({ type: "result", id: item.id, text: r.text, cached: r.cached }))
      .catch((err: unknown) => {
        if (isAbortError(err)) return;
        post({ type: "error", id: item.id, ...describe(err) });
      })
      .finally(() => {
        if (controllers.get(item.id) === controller) controllers.delete(item.id);
      });
  };

  const cancel = (id: string) => {
    controllers.get(id)?.abort();
    scheduler.cancel(taskId(tabId, id));
  };

  port.onMessage.addListener((msg: PageToBackground) => {
    switch (msg.type) {
      case "enqueue":
        msg.items.forEach(handle);
        break;
      case "cancel":
        msg.ids.forEach(cancel);
        break;
      case "priority":
        for (const u of msg.updates) scheduler.setPriority(taskId(tabId, u.id), u.priority);
        break;
    }
  });

  port.onDisconnect.addListener(() => {
    // 页面进入往返缓存（bfcache）时 Chrome 会关掉连接并带上 lastError；读一下，免得记成「未检查的错误」
    void chrome.runtime.lastError;
    open = false;
    for (const c of controllers.values()) c.abort();
    scheduler.cancelWhere((id) => id.startsWith(`${tabId}:`));
  });
});

/** 切换标签页的翻译状态，并更新图标角标。工具栏弹窗、快捷键、e2e 都走这里 */
async function toggleTab(tabId: number): Promise<TabStatus | undefined> {
  try {
    const status: TabStatus = await chrome.tabs.sendMessage(tabId, { type: "toggle" } satisfies TabCommand);
    await setBadge(tabId, status.active);
    return status;
  } catch {
    // 页面上没有 content script（chrome:// 页面、应用商店等），忽略
    return undefined;
  }
}

// 划词翻译插到队列最前（滑动翻译的优先级是离视口的距离，最小为 0）
const SELECTION_PRIORITY = -1;
let selectionSeq = 0;

chrome.runtime.onMessage.addListener((msg: RuntimeMessage, sender, sendResponse: (r: SelectionResult | TabStatus | null) => void) => {
  switch (msg?.type) {
    case "toggle-tab":
      void toggleTab(msg.tabId).then((status) => sendResponse(status ?? null));
      return true;
    case "open-options":
      void chrome.runtime.openOptionsPage();
      return false;
    case "page-state":
      if (sender.tab?.id !== undefined) void setBadge(sender.tab.id, msg.active);
      return false;
    case "translate-selection": {
      const tabId = sender.tab?.id ?? -1;
      translateSegment(tabId, { id: `sel-${++selectionSeq}`, text: msg.text }, SELECTION_PRIORITY, undefined, msg.target)
        .then((r) => sendResponse({ ok: true, text: r.text }))
        .catch((err: unknown) => {
          sendResponse({ ok: false, message: describe(err).message });
        });
      return true;
    }
    default:
      return false;
  }
});

async function setBadge(tabId: number, active: boolean): Promise<void> {
  await chrome.action.setBadgeText({ tabId, text: active ? "译" : "" }).catch(() => {});
}

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === "toggle-translate" && tab?.id !== undefined) void toggleTab(tab.id);
  if (command === "toggle-display-mode") void flipDisplayMode();
});

// 安装或更新后，给已经打开的网页补注入 content script，免得要刷新
chrome.runtime.onInstalled.addListener(async () => {
  // 第一阶段插件自己用 IndexedDB 缓存译文；缓存搬到 aitd 后删掉旧库
  indexedDB.deleteDatabase("ai-translate");
  await chrome.action.setBadgeBackgroundColor({ color: "#2753C8" });
  const tabs = await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] });
  for (const tab of tabs) {
    if (tab.id === undefined) continue;
    chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] }).catch(() => {});
  }
});

// e2e 无法点浏览器工具栏，测试通过这个入口调用同一个切换函数
(globalThis as unknown as { aitToggleTab: typeof toggleTab }).aitToggleTab = toggleTab;
