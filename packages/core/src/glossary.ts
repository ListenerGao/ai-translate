import type { GlossaryEntry } from "./protocol.ts";

/**
 * 内置术语：模型常译错、换个语境意思也不变的少量技术术语（2026-10-19 译文质量评估后加）。
 * 和用户的术语表合并使用，用户写了同一个原文时以用户的为准。
 * 只放含义固定的词：一词多义的（如 resolve、disposable）放进来会把别的语境带错。
 */
export const BUILTIN_GLOSSARY: readonly GlossaryEntry[] = [
  { from: "mockup", to: "设计稿" },
  { from: "single source of truth", to: "单一事实来源" },
  { from: "sequence transduction", to: "序列转导" },
  { from: "under the hood", to: "底层" },
];

export interface GlossaryError {
  /** 从 1 开始的行号 */
  line: number;
  message: string;
}

export interface GlossaryParseResult {
  entries: GlossaryEntry[];
  errors: GlossaryError[];
}

/**
 * 解析设置页的术语表：一行一条 `原文=译文`，空行和 `#` 开头的行忽略。
 * 出错的行跳过并报告行号，其余照常生效；同一原文（忽略大小写）只保留第一条。
 */
export function parseGlossary(input: string): GlossaryParseResult {
  const entries: GlossaryEntry[] = [];
  const errors: GlossaryError[] = [];
  const seen = new Set<string>();

  input.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) return;

    const eq = line.indexOf("=");
    if (eq < 0) {
      errors.push({ line: i + 1, message: "缺少「=」，格式应为 原文=译文" });
      return;
    }
    const from = line.slice(0, eq).trim();
    const to = line.slice(eq + 1).trim();
    if (from === "" || to === "") {
      errors.push({ line: i + 1, message: "原文和译文都不能为空" });
      return;
    }
    const key = from.toLowerCase();
    if (seen.has(key)) {
      errors.push({ line: i + 1, message: `「${from}」重复，只保留第一条` });
      return;
    }
    seen.add(key);
    entries.push({ from, to });
  });

  return { entries, errors };
}

/** 找出这一段原文里出现的术语（忽略大小写）。英文术语按整词匹配，避免 "AI" 命中 "said"。 */
export function matchGlossary(text: string, entries: readonly GlossaryEntry[]): GlossaryEntry[] {
  return entries.filter((entry) => termPattern(entry.from).test(text));
}

function termPattern(term: string): RegExp {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const start = /^\w/.test(term) ? "\\b" : "";
  const end = /\w$/.test(term) ? "\\b" : "";
  return new RegExp(`${start}${escaped}${end}`, "i");
}

/** 合并术语：前面的优先，同一原文（忽略大小写）只留一条 */
export function mergeGlossary(primary: readonly GlossaryEntry[], secondary: readonly GlossaryEntry[]): GlossaryEntry[] {
  const seen = new Set(primary.map((e) => e.from.trim().toLowerCase()));
  return [...primary, ...secondary.filter((e) => !seen.has(e.from.trim().toLowerCase()))];
}
