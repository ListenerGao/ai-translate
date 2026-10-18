import { PROMPT_VERSION } from "./prompt.ts";
import type { GlossaryEntry } from "./protocol.ts";

export interface CacheKeyInput {
  model: string;
  source: string;
  target: string;
  /** 本段命中的术语 */
  glossary: readonly GlossaryEntry[];
  text: string;
  /** 默认取当前 PROMPT_VERSION；只在测试里覆盖 */
  promptVersion?: number;
}

/** 译文缓存键：prompt 版本、模型、语言、命中的术语、原文任一变化，键就变 */
export async function cacheKey(input: CacheKeyInput): Promise<string> {
  const terms = [...input.glossary]
    .map((e) => [e.from.trim(), e.to.trim()])
    .sort(([a = ""], [b = ""]) => a.localeCompare(b));
  const material = JSON.stringify([
    input.promptVersion ?? PROMPT_VERSION,
    input.model,
    input.source.trim().toLowerCase(),
    input.target.trim().toLowerCase(),
    terms,
    input.text.trim(),
  ]);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(material));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
