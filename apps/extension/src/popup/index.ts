// 工具栏弹窗：原文 / 目标语言、模型和本机服务状态、按网站设置、显示方式切换、翻译开关。
// 默认操作当前窗口的活动标签页；网址带 ?tab=<id> 时操作指定标签页（e2e 点不了浏览器工具栏，靠它测试）。
import { checkLocalEndpoint } from "@ai-translate/core";
import type { PageDetection } from "../content/detect.ts";
import { LANGUAGES, languageLabel } from "../shared/languages.ts";
import type { RuntimeMessage, TabCommand, TabStatus } from "../shared/messages.ts";
import { flipDisplayMode, loadSettings, saveSettings, type DisplayMode, type Settings, type SiteRule } from "../shared/settings.ts";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const source = $<HTMLSelectElement>("source");
const target = $<HTMLSelectElement>("target");
const siteRule = $<HTMLSelectElement>("site-rule");
const modeButton = $<HTMLButtonElement>("mode");
const toggleButton = $<HTMLButtonElement>("toggle");

let tabId = -1;
let host = "";
let active = false;
let detected: PageDetection | null = null;
let settings: Settings;

// ---------- 快捷键显示 ----------

const KEY_SYMBOLS: Record<string, string> = { Alt: "⌥", Option: "⌥", Shift: "⇧", Command: "⌘", Ctrl: "⌃", MacCtrl: "⌃" };

/** chrome.commands 给的快捷键可能是「⌥⇧M」也可能是「Alt+Shift+M」，统一拆成一个个键帽 */
function keycaps(shortcut: string): string[] {
  if (shortcut === "") return [];
  return shortcut.includes("+") ? shortcut.split("+").map((k) => KEY_SYMBOLS[k] ?? k) : [...shortcut];
}

async function renderShortcuts(): Promise<void> {
  const commands = await chrome.commands.getAll();
  const fill = (id: string, name: string) => {
    const caps = keycaps(commands.find((c) => c.name === name)?.shortcut ?? "");
    $(id).replaceChildren(...caps.map((k) => Object.assign(document.createElement("kbd"), { textContent: k })));
  };
  fill("toggle-keys", "toggle-translate");
  fill("mode-keys", "toggle-display-mode");
}

// ---------- 渲染 ----------

function renderLanguages(): void {
  if (settings.source === "auto") {
    $("source-label").textContent = detected?.language ? languageLabel(detected.language) : "自动检测";
    $("source-sub").textContent = "自动检测";
  } else {
    $("source-label").textContent = languageLabel(settings.source);
    $("source-sub").textContent = "原文语言";
  }
  $("target-label").textContent = languageLabel(settings.target);
  source.value = settings.source;
  target.value = settings.target;
}

function renderMode(mode: DisplayMode): void {
  const bilingual = mode === "bilingual";
  modeButton.setAttribute("aria-pressed", String(!bilingual));
  modeButton.setAttribute("aria-label", bilingual ? "当前为双语对照，点击切换为仅译文" : "当前为仅译文，点击切换为双语对照");
  $("mode-tip-text").innerHTML = bilingual ? "当前为双语对照<br>点击切换为仅译文" : "当前为仅译文<br>点击切换为双语对照";
}

function renderToggle(): void {
  $("toggle-label").textContent = active ? "还原" : "翻译";
}

function renderDetection(): void {
  const hint = $("detect");
  if (detected === null) return;
  if (!detected.english) hint.textContent = "这个页面不是英文，不会自动翻译";
  else if (!detected.article) hint.textContent = "英文页面，但不像文章，不会自动翻译";
  else hint.textContent = settings.autoTranslate ? "英文文章，打开时会自动翻译" : "英文文章（自动翻译已在设置里关闭）";
}

/** 本机模型服务状态：/health 不需要密钥 */
async function renderStatus(): Promise<void> {
  const dot = $("dot");
  const status = $("status");
  const endpoint = checkLocalEndpoint(settings.endpoint);
  let state: "ok" | "bad" | "warn" = "bad";
  let text = "服务地址不对";
  if (endpoint.ok) {
    const alive = await fetch(`${endpoint.base}/health`, { signal: AbortSignal.timeout(1500) }).then((r) => r.ok, () => false);
    if (!alive) text = "本机服务未启动";
    else if (settings.apiKey.trim() === "") [state, text] = ["warn", "还没填密钥"];
    else [state, text] = ["ok", "本机已连接"];
  }
  dot.dataset.state = state;
  status.textContent = text;
}

// ---------- 操作 ----------

async function toggle(): Promise<void> {
  toggleButton.disabled = true;
  const status: TabStatus | null = await chrome.runtime.sendMessage({ type: "toggle-tab", tabId } satisfies RuntimeMessage);
  active = status?.active ?? active;
  renderToggle();
  toggleButton.disabled = false;
}

/** 语言改了：正在翻译的页面重新翻一遍 */
async function changeLanguage(patch: Partial<Settings>): Promise<void> {
  await saveSettings(patch);
  settings = { ...settings, ...patch };
  renderLanguages();
  if (active) {
    await toggle();
    await toggle();
  }
}

async function setRule(rule: SiteRule | "auto"): Promise<void> {
  const siteRules = { ...(await loadSettings()).siteRules };
  if (rule === "auto") delete siteRules[host];
  else siteRules[host] = rule;
  await saveSettings({ siteRules });
  // 当前页面跟着规则走：选「总是翻译」就开启，选「从不翻译」就还原
  if ((rule === "always" && !active) || (rule === "never" && active)) await toggle();
}

// ---------- 初始化 ----------

async function targetTab(): Promise<chrome.tabs.Tab | undefined> {
  const id = Number(new URLSearchParams(location.search).get("tab"));
  if (Number.isInteger(id) && id > 0) return chrome.tabs.get(id);
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function init(): Promise<void> {
  source.replaceChildren(new Option("自动检测", "auto"), ...LANGUAGES.map((l) => new Option(`${l.name} (${l.native})`, l.code)));
  target.replaceChildren(...LANGUAGES.map((l) => new Option(`${l.name} (${l.native})`, l.code)));
  settings = await loadSettings();
  renderLanguages();
  renderMode(settings.displayMode);
  void renderStatus();
  void renderShortcuts();

  const tab = await targetTab();
  const status: TabStatus | null =
    tab?.id === undefined ? null : await chrome.tabs.sendMessage(tab.id, { type: "status" } satisfies TabCommand).catch(() => null);
  if (tab?.id === undefined || tab.url === undefined || status === null) {
    $("detect").textContent = "这个页面不能翻译：浏览器内置页面、应用商店等不允许插件运行；刚安装插件时，已打开的页面刷新后才能用";
    return;
  }
  tabId = tab.id;
  host = new URL(tab.url).hostname;
  active = status.active;
  renderToggle();
  toggleButton.disabled = false;
  siteRule.value = settings.siteRules[host] ?? "auto";
  siteRule.disabled = false;
  siteRule.title = host;

  detected = await chrome.tabs.sendMessage(tabId, { type: "detect" } satisfies TabCommand).catch(() => null);
  renderLanguages();
  renderDetection();
}

toggleButton.addEventListener("click", () => void toggle());
modeButton.addEventListener("click", () => void flipDisplayMode().then(renderMode));
source.addEventListener("change", () => void changeLanguage({ source: source.value }));
target.addEventListener("change", () => void changeLanguage({ target: target.value }));
siteRule.addEventListener("change", () => void setRule(siteRule.value as SiteRule | "auto"));
$("options").addEventListener("click", () => void chrome.runtime.openOptionsPage());

void init();
