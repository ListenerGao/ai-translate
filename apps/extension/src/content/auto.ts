// 英文文章页自动开启翻译：页面加载完、单页应用切换地址后各检测一次。检测只在本地做，不发请求。
// 自动开启时在页面右下角给一个提示，可以还原这一页，或让这个网站以后不再自动翻译。
import type { RuntimeMessage } from "../shared/messages.ts";
import { loadSettings, saveSettings } from "../shared/settings.ts";
import { extensionAlive } from "./alive.ts";
import { detectPage } from "./detect.ts";
import type { PageSession } from "./session.ts";
import { showNotice } from "./view.ts";

/** 单页应用切换地址：每秒看一次地址有没有变 */
const URL_POLL_MS = 1000;
/** 内容晚加载的页面：第一次没检测到文章，2 秒后再看一次 */
const RETRY_MS = 2000;

export class AutoOpener {
  readonly #session: PageSession;
  #url = location.href;
  #poll = 0;
  #retry = 0;
  #disposed = false;

  constructor(session: PageSession) {
    this.#session = session;
  }

  start(): void {
    void this.#check(true);
    this.#poll = window.setInterval(() => {
      if (location.href === this.#url) return;
      this.#url = location.href;
      clearTimeout(this.#retry);
      void this.#check(true);
    }, URL_POLL_MS);
  }

  dispose(): void {
    this.#disposed = true;
    clearInterval(this.#poll);
    clearTimeout(this.#retry);
  }

  /** 按网站规则和检测结果决定要不要开启：「从不翻译」不开，「总是翻译」直接开，否则英文文章才开 */
  async #check(allowRetry: boolean): Promise<void> {
    if (this.#disposed || this.#session.active) return;
    if (!extensionAlive()) {
      this.dispose(); // 插件已重新加载或停用：停掉换地址检测，不再读设置
      return;
    }
    const settings = await loadSettings();
    if (!settings.autoTranslate) return;
    const rule = settings.siteRules[location.hostname];
    if (rule === "never") return;
    if (rule !== "always") {
      const page = await detectPage(settings.target);
      if (!(page.english && page.article)) {
        if (allowRetry) this.#retry = window.setTimeout(() => void this.#check(false), RETRY_MS);
        return;
      }
    }
    if (this.#disposed || this.#session.active) return;
    await this.#session.start();
    chrome.runtime.sendMessage({ type: "page-state", active: true } satisfies RuntimeMessage).catch(() => {});
    // 检测总有判断错的页面：自动开启时给一个几秒后消失的提示，一下就能还原或让这个网站以后不再自动翻译
    showNotice("已自动翻译这个页面", [
      { label: "这个网站不再自动翻译", run: () => void this.#never() },
      { label: "还原", run: () => this.#restore() },
    ]);
  }

  /** 还原这一页（停止翻译时提示条一起收起），图标角标去掉 */
  #restore(): void {
    this.#session.stop();
    if (extensionAlive()) chrome.runtime.sendMessage({ type: "page-state", active: false } satisfies RuntimeMessage).catch(() => {});
  }

  /** 这个网站设成「从不翻译」并还原这一页；工具栏弹窗的「当前网站」里可以改回 */
  async #never(): Promise<void> {
    this.#restore();
    if (!extensionAlive()) return;
    const { siteRules } = await loadSettings();
    await saveSettings({ siteRules: { ...siteRules, [location.hostname]: "never" } });
    showNotice("这个网站以后不再自动翻译，可以在工具栏弹窗的「当前网站」里改回");
  }
}
