// 译文回归检查的自动规则：只查机器能判断的硬伤（依据 docs/glossary-and-qa-checklist.html 的 P0 项），语义对不对留给人看。
import { BUILTIN_GLOSSARY, matchGlossary, parseMarkup, stripMarkers, validateTranslation, type GlossaryEntry } from "@ai-translate/core";

export interface Sample {
  id: string;
  kind: string;
  source: string;
  /** 带格式的段落：插件发给模型的带标记原文 */
  markup?: string;
  site?: string;
  from?: string;
}

export type CheckName = "残留英文" | "数字丢失" | "格式标记" | "术语" | "译文异常";

export interface Flag {
  check: CheckName;
  detail: string;
}

/** 允许原样留在译文里的小写英文词：代码里的名字、业内习惯不译的词。误报多了就往这里加 */
export const ALLOWED_ENGLISH: ReadonlySet<string> = new Set([
  "props", "token", "tokens", "drop", "int", "float", "str", "bool", "null", "true", "false", "npm", "git", "http", "https",
]);

/** 专名、书名里常见的小写虚词（如 Representations from Transformers），夹在大写开头的英文词组里不算残留 */
const FUNCTION_WORDS: ReadonlySet<string> = new Set(["the", "and", "for", "from", "with", "into", "over", "via", "per"]);

/**
 * 译文里没翻的英文单词：只看全小写、3 个字母起的词（如 scoping、mockup、intended）。
 * 带大写的（专名、缩写、驼峰的代码名）、带数字、下划线、:: 的（GPT-4、__init__、String::from）都不算；
 * 夹在含大写词的英文词组里的小写虚词也不算（译文里括注的英文全称）。
 */
export function residualEnglish(translation: string, allowed: ReadonlySet<string> = ALLOWED_ENGLISH): string[] {
  const words = new Set<string>();
  for (const [run] of stripMarkers(translation).matchAll(/[A-Za-z0-9_.:'-]+(?:[ \t]+[A-Za-z0-9_.:'-]+)*/g)) {
    const tokens = run.split(/[ \t]+/).map((t) => t.replace(/^[.'-]+|[.'-]+$/g, ""));
    const properName = tokens.length >= 2 && tokens.some((t) => /^[A-Z]/.test(t));
    for (const token of tokens) {
      if (!/^[a-z]{3,}$/.test(token) || allowed.has(token)) continue;
      if (properName && FUNCTION_WORDS.has(token)) continue;
      words.add(token);
    }
  }
  return [...words];
}

/** 原文里的数字在译文里都要找得到（千位逗号去掉再比，「40,000」和「40000」算同一个） */
export function missingNumbers(source: string, translation: string): string[] {
  const norm = (s: string) => s.replace(/(\d),(?=\d{3}\b)/g, "$1");
  const target = norm(stripMarkers(translation));
  const numbers = new Set(norm(source).match(/\d+(?:\.\d+)?/g) ?? []);
  return [...numbers].filter((n) => !target.includes(n));
}

/** 原文命中的术语，译文里要出现规定的译法 */
export function missingTerms(source: string, translation: string, glossary: readonly GlossaryEntry[] = BUILTIN_GLOSSARY): GlossaryEntry[] {
  const plain = stripMarkers(translation);
  return matchGlossary(source, glossary).filter((e) => !plain.includes(e.to.trim()));
}

/** 对一条样例的译文跑全部检查 */
export function checkTranslation(sample: Sample, translation: string, target = "zh"): Flag[] {
  const flags: Flag[] = [];
  const plain = stripMarkers(translation);
  const issue = validateTranslation(sample.source, plain, target);
  if (issue !== null) flags.push({ check: "译文异常", detail: issue });
  // 带格式的段落：标记保住时数字都在占位标记里，不用再比数字
  const markupKept = sample.markup !== undefined && parseMarkup(translation, sample.markup) !== null;
  if (sample.markup !== undefined && !markupKept) flags.push({ check: "格式标记", detail: "没保住，退回纯文本" });
  for (const word of residualEnglish(translation)) flags.push({ check: "残留英文", detail: word });
  if (!markupKept) for (const n of missingNumbers(sample.source, translation)) flags.push({ check: "数字丢失", detail: n });
  for (const term of missingTerms(sample.source, translation)) flags.push({ check: "术语", detail: `${term.from}→${term.to}` });
  return flags;
}

/** 比较用的键：同一条样例的同一个问题 */
export function flagKey(flag: Flag): string {
  return `${flag.check}:${flag.detail}`;
}
