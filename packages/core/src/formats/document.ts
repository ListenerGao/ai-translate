// Markdown、SRT 共用的「拆段 → 翻译 → 重组」。命令行在本地调用，aitd 的 /api/translate-document 在服务端调用，两边输出逐字一致。
import type { Segment } from "../protocol.ts";
import { parseMarkdown } from "./markdown.ts";
import { parseSrt } from "./srt.ts";

export type DocumentFormat = "markdown" | "srt";

export interface DocumentUnit {
  id: string;
  /** 在原文件里从第几行开始（1 起），报错时用 */
  line: number;
  text: string;
  markup?: string;
}

export interface ParsedDocument {
  readonly units: readonly DocumentUnit[];
  render(translations: ReadonlyMap<string, string>, options?: { bilingual?: boolean }): string;
}

/** 一段的翻译结果：有 text 就是翻成了，否则 error 是没翻成的原因 */
export interface UnitOutcome {
  text?: string;
  error?: string;
}

export interface FailedUnit {
  line: number;
  error: string;
}

/** 按格式拆段；SRT 格式不对时抛 SrtFormatError（带行号） */
export function parseDocument(format: DocumentFormat, source: string): ParsedDocument {
  return format === "srt" ? parseSrt(source) : parseMarkdown(source);
}

/** 每个要翻的单元一段；段内有格式时带上标记 */
export function documentSegments(doc: ParsedDocument): Segment[] {
  return doc.units.map((u) => ({ id: u.id, text: u.text, ...(u.markup === undefined ? {} : { markup: u.markup }) }));
}

/** 按各段结果重组；没翻成的段落保留原文，并列出行号和原因 */
export function renderDocument(
  doc: ParsedDocument,
  outcomes: ReadonlyMap<string, UnitOutcome>,
  options: { bilingual?: boolean } = {},
): { text: string; failed: FailedUnit[] } {
  const translations = new Map<string, string>();
  const failed: FailedUnit[] = [];
  for (const u of doc.units) {
    const r = outcomes.get(u.id);
    if (r?.text !== undefined) translations.set(u.id, r.text);
    else failed.push({ line: u.line, error: r?.error ?? "没有返回" });
  }
  return { text: doc.render(translations, options), failed };
}
