// 工具栏弹窗：当前页面的翻译开关、检测结果、按网站设置（自动 / 总是翻译 / 从不翻译）。
// 默认操作当前窗口的活动标签页；网址带 ?tab=<id> 时操作指定标签页（e2e 点不了浏览器工具栏，靠它测试）。
import type { PageDetection } from "../content/detect.ts";
import type { RuntimeMessage, TabCommand, TabStatus } from "../shared/messages.ts";
import { loadSettings, saveSettings, type SiteRule } from "../shared/settings.ts";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const stateEl = $<HTMLSpanElement>("state");
const toggleButton = $<HTMLButtonElement>("toggle");
const detectEl = $<HTMLParagraphElement>("detect");
const rulesEl = $<HTMLFieldSetElement>("rules");
const hostEl = $<HTMLParagraphElement>("host");

let tabId = -1;
let host = "";
let active = false;

async function targetTab(): Promise<chrome.tabs.Tab | undefined> {
  const id = Number(new URLSearchParams(location.search).get("tab"));
  if (Number.isInteger(id) && id > 0) return chrome.tabs.get(id);
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function renderState(): void {
  stateEl.textContent = active ? "正在翻译这个页面" : "这个页面未翻译";
  toggleButton.textContent = active ? "还原" : "翻译此页";
}

function describe(page: PageDetection, autoTranslate: boolean): string {
  if (!page.english) return "检测：不是英文页面，不会自动翻译";
  if (!page.article) return "检测：英文页面，但不像文章，不会自动翻译";
  return autoTranslate ? "检测：英文文章，会自动翻译" : "检测：英文文章（自动翻译已在设置里关闭）";
}

async function toggle(): Promise<void> {
  toggleButton.disabled = true;
  const status: TabStatus | null = await chrome.runtime.sendMessage({ type: "toggle-tab", tabId } satisfies RuntimeMessage);
  active = status?.active ?? active;
  renderState();
  toggleButton.disabled = false;
}

async function setRule(rule: SiteRule | "auto"): Promise<void> {
  const settings = await loadSettings();
  const siteRules = { ...settings.siteRules };
  if (rule === "auto") delete siteRules[host];
  else siteRules[host] = rule;
  await saveSettings({ siteRules });
  // 当前页面跟着规则走：选「总是翻译」就开启，选「从不翻译」就还原
  if ((rule === "always" && !active) || (rule === "never" && active)) await toggle();
}

async function init(): Promise<void> {
  const tab = await targetTab();
  if (tab?.id === undefined || tab.url === undefined) return unavailable();
  tabId = tab.id;
  host = new URL(tab.url).hostname;
  const status: TabStatus | null = await chrome.tabs.sendMessage(tabId, { type: "status" } satisfies TabCommand).catch(() => null);
  if (status === null) return unavailable();

  active = status.active;
  renderState();
  toggleButton.disabled = false;
  hostEl.textContent = host;
  const settings = await loadSettings();
  const rule = settings.siteRules[host] ?? "auto";
  $<HTMLInputElement>(`rule-${rule}`).checked = true;
  rulesEl.disabled = false;

  const page: PageDetection | null = await chrome.tabs.sendMessage(tabId, { type: "detect" } satisfies TabCommand).catch(() => null);
  if (page !== null) detectEl.textContent = describe(page, settings.autoTranslate);
}

function unavailable(): void {
  stateEl.textContent = "这个页面不能翻译";
  detectEl.textContent = "浏览器内置页面、应用商店等页面不允许插件运行；刚安装插件时，已打开的页面刷新后才能用。";
}

toggleButton.addEventListener("click", () => void toggle());
rulesEl.addEventListener("change", (event) => {
  const value = (event.target as HTMLInputElement).value as SiteRule | "auto";
  void setRule(value);
});
$<HTMLAnchorElement>("options").addEventListener("click", (event) => {
  event.preventDefault();
  void chrome.runtime.openOptionsPage();
});

void init();
