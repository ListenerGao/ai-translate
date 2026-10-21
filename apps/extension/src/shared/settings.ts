import { DEFAULT_ENDPOINT, DEFAULT_MODEL_ID } from "@ai-translate/core";

export type DisplayMode = "bilingual" | "translation-only";

/** 按网站设置：总是翻译 / 从不翻译；没有记录就是「自动」（按检测结果） */
export type SiteRule = "always" | "never";

export interface Settings {
  /** 模型服务地址，只允许本机 */
  endpoint: string;
  apiKey: string;
  /** "auto" 或语言代码 */
  source: string;
  target: string;
  displayMode: DisplayMode;
  /** 设置页的术语表原文，一行一条 原文=译文 */
  glossaryText: string;
  modelId: string;
  /** 划词翻译：选中文字后出现图标 */
  selectionEnabled: boolean;
  /** 英文文章页自动开启翻译 */
  autoTranslate: boolean;
  /** 域名 → 规则 */
  siteRules: Record<string, SiteRule>;
}

export const DEFAULT_SETTINGS: Settings = {
  endpoint: DEFAULT_ENDPOINT,
  apiKey: "",
  source: "auto",
  target: "zh",
  displayMode: "bilingual",
  glossaryText: "",
  modelId: DEFAULT_MODEL_ID,
  selectionEnabled: true,
  autoTranslate: true,
  siteRules: {},
};

export async function loadSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get({ ...DEFAULT_SETTINGS } as Record<string, unknown>);
  return { ...DEFAULT_SETTINGS, ...stored } as Settings;
}

/** 双语对照 ↔ 仅译文，返回切换后的方式。快捷键和弹窗都走这里；已打开的页面监听设置变化，立即跟着切换 */
export async function flipDisplayMode(): Promise<DisplayMode> {
  const { displayMode } = await loadSettings();
  const next: DisplayMode = displayMode === "bilingual" ? "translation-only" : "bilingual";
  await saveSettings({ displayMode: next });
  return next;
}

export async function saveSettings(patch: Partial<Settings>): Promise<void> {
  await chrome.storage.local.set(patch);
}
