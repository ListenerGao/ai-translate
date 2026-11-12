// 英文文章页自动开启翻译：页面加载完、单页应用切换地址后各检测一次。检测只在本地做，不发请求。
// 检测总有判断错的页面，靠三件事兜底：
// - 自动开启时在右下角给一个提示，可以还原这一页，或让这个网站以后不再自动翻译
// - 英文页面够不上文章、但有一定文字量时问一句要不要翻译；同一网站连续两次没理会就不再问
// - 记住使用习惯：同一网站手动开了两次就设成「总是翻译」，自动翻译后被还原两次就设成「从不翻译」，都可以撤回
import type { RuntimeMessage } from "../shared/messages.ts";
import { loadSettings, saveSettings, type SiteHabit, type SiteRule } from "../shared/settings.ts";
import { extensionAlive } from "./alive.ts";
import { ASK_MIN_LONG_CHARS, detectPage } from "./detect.ts";
import type { PageSession } from "./session.ts";
import { hideNotice, showNotice } from "./view.ts";

/** 单页应用切换地址：每秒看一次地址有没有变 */
const URL_POLL_MS = 1000;
/** 内容晚加载的页面：第一次没检测到文章，2 秒后再看一次 */
const RETRY_MS = 2000;
/** 同一网站手动开启、或还原自动翻译到这个次数，就学成网站规则 */
const LEARN_TIMES = 2;
/** 同一网站的询问连续这么多次没被理会，就不再问 */
const MAX_UNANSWERED_ASKS = 2;

export class AutoOpener {
  readonly #session: PageSession;
  #url = location.href;
  #poll = 0;
  #retry = 0;
  #disposed = false;
  /** 当前的翻译是按检测结果自动开的（不是按「总是翻译」规则，也不是手动开的）：还原它才算「不想要自动翻译」 */
  #autoStarted = false;
  /** 这个页面已经记过一次手动开启 / 还原，反复开关不重复记 */
  #countedOn = false;
  #countedOff = false;

  constructor(session: PageSession) {
    this.#session = session;
  }

  start(): void {
    void this.#check(true);
    this.#poll = window.setInterval(() => {
      if (location.href === this.#url) return;
      this.#url = location.href;
      this.#countedOn = false;
      this.#countedOff = false;
      clearTimeout(this.#retry);
      void this.#check(true);
    }, URL_POLL_MS);
  }

  dispose(): void {
    this.#disposed = true;
    clearInterval(this.#poll);
    clearTimeout(this.#retry);
  }

  /** 手动开启之后（弹窗、快捷键）：没有规则的网站记一次，够次数就设成「总是翻译」 */
  async manualOn(): Promise<void> {
    hideNotice();
    this.#autoStarted = false;
    if (this.#disposed || this.#countedOn || !extensionAlive()) return;
    const settings = await loadSettings();
    if (!settings.autoTranslate || settings.siteRules[location.hostname] !== undefined) return;
    this.#countedOn = true;
    const habit = settings.siteHabits[location.hostname] ?? {};
    const on = (habit.on ?? 0) + 1;
    if (on < LEARN_TIMES) {
      await this.#saveHabit({ ...habit, on, asked: 0 });
      return;
    }
    await this.#setRule("always");
    showNotice("这个网站你手动开了两次翻译，以后会自动翻译", [{ label: "撤回", run: () => void this.#setRule(undefined).then(hideNotice) }]);
  }

  /** 手动还原之后：还原的是自动开的翻译就记一次，够次数就设成「从不翻译」 */
  async manualOff(): Promise<void> {
    if (!this.#autoStarted) return;
    this.#autoStarted = false;
    if (this.#disposed || this.#countedOff || !extensionAlive()) return;
    const settings = await loadSettings();
    if (!settings.autoTranslate || settings.siteRules[location.hostname] !== undefined) return;
    this.#countedOff = true;
    const habit = settings.siteHabits[location.hostname] ?? {};
    const off = (habit.off ?? 0) + 1;
    if (off < LEARN_TIMES) {
      await this.#saveHabit({ ...habit, off });
      return;
    }
    await this.#setRule("never");
    showNotice("这个网站的自动翻译你还原了两次，以后不再自动翻译", [{ label: "撤回", run: () => void this.#setRule(undefined).then(hideNotice) }]);
  }

  /** 按网站规则和检测结果决定要不要开启：「从不翻译」不开，「总是翻译」直接开，否则英文文章才开，拿不准的问一句 */
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
        else if (page.english && page.longChars >= ASK_MIN_LONG_CHARS && (settings.siteHabits[location.hostname]?.asked ?? 0) < MAX_UNANSWERED_ASKS) this.#ask();
        return;
      }
    }
    if (this.#disposed || this.#session.active) return;
    await this.#open();
    this.#autoStarted = rule === undefined;
    // 自动开启时给一个几秒后消失的提示，一下就能还原或让这个网站以后不再自动翻译
    showNotice("已自动翻译这个页面", [
      { label: "这个网站不再自动翻译", run: () => void this.#never() },
      { label: "还原", run: () => void this.#restore().then(() => this.manualOff()) },
    ]);
  }

  /** 拿不准的英文页面：问一句。没理会（点 × 或等它消失）记一次 */
  #ask(): void {
    if (this.#disposed || this.#session.active) return;
    showNotice(
      "这个页面是英文，要翻译吗？",
      [
        { label: "翻译", run: () => void this.#open().then(() => this.manualOn()) },
        { label: "这个网站总是翻译", run: () => void this.#setRule("always").then(() => this.#open()) },
      ],
      () => void this.#unanswered(),
    );
  }

  async #unanswered(): Promise<void> {
    if (this.#disposed || !extensionAlive()) return;
    const habit = (await loadSettings()).siteHabits[location.hostname] ?? {};
    await this.#saveHabit({ ...habit, asked: (habit.asked ?? 0) + 1 });
  }

  /** 开启翻译（提示条收起），图标加上角标 */
  async #open(): Promise<void> {
    hideNotice();
    if (this.#disposed || this.#session.active) return;
    await this.#session.start();
    chrome.runtime.sendMessage({ type: "page-state", active: true } satisfies RuntimeMessage).catch(() => {});
  }

  /** 还原这一页（停止翻译时提示条一起收起），图标角标去掉 */
  async #restore(): Promise<void> {
    this.#session.stop();
    if (extensionAlive()) await chrome.runtime.sendMessage({ type: "page-state", active: false } satisfies RuntimeMessage).catch(() => {});
  }

  /** 这个网站设成「从不翻译」并还原这一页；工具栏弹窗的「当前网站」里可以改回 */
  async #never(): Promise<void> {
    this.#autoStarted = false;
    await this.#restore();
    if (!extensionAlive()) return;
    await this.#setRule("never");
    showNotice("这个网站以后不再自动翻译，可以在工具栏弹窗的「当前网站」里改回");
  }

  async #saveHabit(habit: SiteHabit): Promise<void> {
    const { siteHabits } = await loadSettings();
    await saveSettings({ siteHabits: { ...siteHabits, [location.hostname]: habit } });
  }

  /** 定下（或去掉）这个网站的规则；之前记的使用习惯作废，从头算 */
  async #setRule(rule: SiteRule | undefined): Promise<void> {
    if (!extensionAlive()) return;
    const settings = await loadSettings();
    const siteRules = { ...settings.siteRules };
    const siteHabits = { ...settings.siteHabits };
    if (rule === undefined) delete siteRules[location.hostname];
    else siteRules[location.hostname] = rule;
    delete siteHabits[location.hostname];
    await saveSettings({ siteRules, siteHabits });
  }
}
