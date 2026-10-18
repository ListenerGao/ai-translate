// 语言代码 → prompt 里用的中文语言名。
// 照抄 Index-Translate 官方 inference/llm/translate.py 的 LANG_NAMES（Apache-2.0），
// 训练时的 prompt 就用这些名字，改动会影响翻译效果。
export const LANG_NAMES: Readonly<Record<string, string>> = {
  en: "英语", zh: "中文", de: "德语", fr: "法语", es: "西班牙语",
  ja: "日语", ko: "韩语", pt: "葡萄牙语", ru: "俄语", ar: "阿拉伯语",
  it: "意大利语", nl: "荷兰语", pl: "波兰语", ro: "罗马尼亚语",
  sv: "瑞典语", tr: "土耳其语", hi: "印地语", vi: "越南语",
  th: "泰语", id: "印尼语", ms: "马来语", fil: "菲律宾语",
  ukr_cyrl: "乌克兰语", fas_arab: "波斯语", ces_latn: "捷克语",
  ell_grek: "希腊语", dan_latn: "丹麦语", hun_latn: "匈牙利语",
  fin_latn: "芬兰语", nob_latn: "书面挪威语", slk_latn: "斯洛伐克语",
  bul_cyrl: "保加利亚语",
};

export function languageName(code: string): string | undefined {
  return LANG_NAMES[code.toLowerCase()];
}

export function isAutoSource(source: string): boolean {
  const s = source.trim().toLowerCase();
  return s === "" || s === "auto";
}
