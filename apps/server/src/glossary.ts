// 术语表文件：一行一条「原文=译文」，和插件设置页的格式相同。插件和命令行共用。
import { parseGlossary, type GlossaryEntry, type GlossaryError } from "@ai-translate/core";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

export class GlossaryFile {
  readonly #file: string;
  #text = "";
  #entries: GlossaryEntry[] = [];

  constructor(file: string) {
    this.#file = file;
    if (!existsSync(file)) return;
    // 主人手改出错的行跳过，其余照常生效（和设置页一致）
    this.#text = readFileSync(file, "utf8");
    this.#entries = parseGlossary(this.#text).entries;
  }

  get text(): string {
    return this.#text;
  }

  get entries(): readonly GlossaryEntry[] {
    return this.#entries;
  }

  /** 校验通过才保存；有错时不改文件，返回出错的行 */
  save(text: string): { ok: true; count: number } | { ok: false; errors: GlossaryError[] } {
    const { entries, errors } = parseGlossary(text);
    if (errors.length > 0) return { ok: false, errors };
    // 先写临时文件再改名，写到一半断电也不会留下半个文件
    const tmp = `${this.#file}.tmp`;
    writeFileSync(tmp, text, { mode: 0o600 });
    renameSync(tmp, this.#file);
    this.#text = text;
    this.#entries = entries;
    return { ok: true, count: entries.length };
  }
}

/** 合并术语：本次请求带的优先，同一原文（忽略大小写）只留一条 */
export function mergeGlossary(primary: readonly GlossaryEntry[], secondary: readonly GlossaryEntry[]): GlossaryEntry[] {
  const seen = new Set(primary.map((e) => e.from.trim().toLowerCase()));
  return [...primary, ...secondary.filter((e) => !seen.has(e.from.trim().toLowerCase()))];
}
