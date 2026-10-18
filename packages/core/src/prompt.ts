import { isAutoSource, languageName } from "./languages.ts";
import type { GlossaryEntry } from "./protocol.ts";

/** 改模板就升版本：版本号进缓存键，旧缓存自然失效 */
export const PROMPT_VERSION = 1;

export interface PromptOptions {
  /** "auto" 或语言代码 */
  source: string;
  target: string;
  /** 本段命中的术语；为空时用无约束格式 */
  glossary?: readonly GlossaryEntry[];
  /** 原文里的格式标记（按出现顺序）；有标记时要求模型原样保留 */
  markers?: readonly string[];
}

/**
 * 按 Index-Translate 官方 instTrans 格式组装 prompt，
 * 逐字对齐官方 inference/llm/translate.py 的 build_prompt（genre 取默认的「文本」）。
 */
export function buildPrompt(text: string, options: PromptOptions): string {
  const targetName = languageName(options.target);
  if (targetName === undefined) {
    throw new Error(`不支持的目标语言：${options.target}`);
  }
  const sourceName = isAutoSource(options.source)
    ? ""
    : (languageName(options.source) ?? options.source);
  const body = text.trim();

  // 约束顺序照官方 translate.py：先硬性要求，再术语对照
  const constraints: string[] = [];
  const markers = options.markers ?? [];
  if (markers.length > 0) {
    // 措辞参考官方「保留占位符」样例，举例列出本段实际的前 3 个标记
    constraints.push(`【硬性要求】保留所有的标记（如 ${markers.slice(0, 3).join("、")}）原样不变，标记内的文字照常翻译`);
  }
  const glossary = options.glossary ?? [];
  if (glossary.length > 0) {
    const terms = glossary.map((e) => `${e.from.trim()}→${e.to.trim()}`);
    constraints.push(`【硬性要求】专名/术语对照: ${terms.join("、")}`);
  }

  if (constraints.length > 0) {
    const header = `请将以下${sourceName}文本翻译成${targetName}，并且严格遵循所有约束要求。`;
    const requirements = constraints.map((c, i) => `${i + 1}. ${c}`).join("\n");
    return `${header}\n\n【源文】\n${body}\n\n【约束要求】\n${requirements}\n\n只输出译文，不要有任何额外说明。`;
  }

  return `请将以下${sourceName}文本翻译为${targetName}，直接输出翻译结果，不要进行任何解释。\n\n${body}`;
}
