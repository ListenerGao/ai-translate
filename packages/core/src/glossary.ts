import type { GlossaryEntry } from "./protocol.ts";

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
