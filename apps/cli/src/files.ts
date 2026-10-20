// 翻译文件：按扩展名认格式、只读 UTF-8、决定输出位置、不覆盖已有文件（除非 --force）。
import type { DocumentFormat } from "@ai-translate/core";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { CliError, EXIT } from "./client.ts";

export function detectFormat(file: string): DocumentFormat {
  const ext = extname(file).toLowerCase();
  if (ext === ".md" || ext === ".markdown") return "markdown";
  if (ext === ".srt") return "srt";
  throw new CliError(EXIT.usage, `不支持的文件类型：${file}（只支持 .md、.markdown、.srt）`);
}

/** 读原文件：只认 UTF-8；BOM 留在内容里，写回时原样保留 */
export function readSource(file: string): string {
  if (!existsSync(file)) throw new CliError(EXIT.usage, `找不到文件：${file}`);
  if (!statSync(file).isFile()) throw new CliError(EXIT.usage, `不是文件：${file}`);
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(readFileSync(file));
  } catch {
    throw new CliError(EXIT.usage, `${file} 不是 UTF-8 编码：先转成 UTF-8 再翻（如 iconv -f GBK -t UTF-8 原文件 > 新文件）`);
  }
}

/**
 * 输出位置：-o - 打到终端（返回 null）；-o 路径；默认写到原文件旁边，按目标语言命名（README.md → README.zh.md）。
 * 翻译前就检查：输出文件已存在且没加 --force 时直接报错，不白翻。
 */
export function outputTarget(file: string, to: string, options: { output?: string; force: boolean }): string | null {
  if (options.output === "-") return null;
  const ext = extname(file);
  const target = options.output ?? join(dirname(file), `${basename(file, ext)}.${to}${ext}`);
  if (resolve(target) === resolve(file)) throw new CliError(EXIT.usage, `输出文件不能是原文件本身：${target}`);
  if (existsSync(target) && !options.force) throw new CliError(EXIT.usage, `${target} 已存在：加 --force 覆盖，或用 -o 指定别的位置`);
  return target;
}

export function writeOutput(target: string, content: string): void {
  try {
    writeFileSync(target, content);
  } catch (err) {
    throw new CliError(EXIT.usage, `写不进 ${target}：${err instanceof Error ? err.message : String(err)}`);
  }
}
