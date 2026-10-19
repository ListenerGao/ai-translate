// 弹窗和设置页里可选的语言。code 对应 core 的 LANG_NAMES，prompt 里用的是那边的中文名。

export interface LanguageOption {
  code: string;
  name: string;
  /** 括号里的本语言写法，帮助辨认 */
  native: string;
}

export const LANGUAGES: readonly LanguageOption[] = [
  { code: "zh", name: "简体中文", native: "Simplified Chinese" },
  { code: "en", name: "英语", native: "English" },
  { code: "ja", name: "日语", native: "日本語" },
  { code: "ko", name: "韩语", native: "한국어" },
  { code: "fr", name: "法语", native: "Français" },
  { code: "de", name: "德语", native: "Deutsch" },
  { code: "es", name: "西班牙语", native: "Español" },
];

/** 「英语 (English)」这样的显示名；不在列表里的语言原样显示代码 */
export function languageLabel(code: string): string {
  const lang = LANGUAGES.find((l) => l.code === code.toLowerCase().split("-")[0]);
  return lang === undefined ? code : `${lang.name} (${lang.native})`;
}
