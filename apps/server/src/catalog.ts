// 模型文件管理（Goal 8）：本机 models/ 里有哪些量化版本、当前用哪个，切换和删除。下载由桌面应用做，aitd 不访问外网。
// 只读写 models/ 里名字是 Index-Translate-2B.<量化版本>.gguf 的文件；量化版本名只允许字母、数字和下划线（防路径穿越）。
// 选择存在 settings.json，重启后保留；设了环境变量 AIT_QUANT 时以它为准，不能切换。
import { TranslateError } from "@ai-translate/core";
import { existsSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HttpError } from "./http.ts";
import type { LogFields } from "./log.ts";

export const DEFAULT_QUANT = "Q8_0";
const QUANT = /^[A-Za-z0-9_]{1,32}$/;
const FILE = /^Index-Translate-2B\.([A-Za-z0-9_]{1,32})\.gguf$/;

export function modelFile(modelsDir: string, quant: string): string {
  return join(modelsDir, `Index-Translate-2B.${quant}.gguf`);
}

export interface LocalModel {
  quant: string;
  /** 字节数 */
  size: number;
}

/** 本机已下载的版本：只认完整的 .gguf，不认下载中的 .part 和看图用的 mmproj 文件 */
export function listModels(modelsDir: string): LocalModel[] {
  if (!existsSync(modelsDir)) return [];
  return readdirSync(modelsDir)
    .flatMap((name) => {
      const quant = FILE.exec(name)?.[1];
      const stat = quant === undefined ? undefined : statSync(join(modelsDir, name), { throwIfNoEntry: false });
      return quant !== undefined && stat?.isFile() === true ? [{ quant, size: stat.size }] : [];
    })
    .sort((a, b) => a.size - b.size);
}

/**
 * 启动时用哪个版本：环境变量 AIT_QUANT（固定，不能切换）> settings.json > Q8_0。
 * 给了 modelsDir 时，选中的版本没有文件就改用本机已有的（Q8_0 > Q4_K_M > 其余里最大的），
 * 免得只下了别的版本还报「模型文件不存在」（Goal 9 发布包新手引导下的是 Q4_K_M）；被 AIT_QUANT 固定时不回退
 */
export function chooseQuant(envQuant: string | undefined, settingsFile: string, modelsDir?: string): { quant: string; pinned: boolean } {
  if (envQuant !== undefined && envQuant !== "") return { quant: envQuant, pinned: true };
  const saved = readSettings(settingsFile).quant;
  const quant = typeof saved === "string" && QUANT.test(saved) ? saved : DEFAULT_QUANT;
  if (modelsDir === undefined || existsSync(modelFile(modelsDir, quant))) return { quant, pinned: false };
  const local = listModels(modelsDir);
  const fallback = ["Q8_0", "Q4_K_M"].find((q) => local.some((m) => m.quant === q)) ?? [...local].sort((a, b) => b.size - a.size)[0]?.quant;
  return { quant: fallback ?? quant, pinned: false };
}

function readSettings(file: string): Record<string, unknown> {
  try {
    const data: unknown = JSON.parse(readFileSync(file, "utf8"));
    return typeof data === "object" && data !== null && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** 先写临时文件再改名，写到一半断电也不会留下坏的 settings.json；只有自己能读写 */
function writeSettings(file: string, patch: Record<string, unknown>): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ ...readSettings(file), ...patch }, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}

/** 能换模型文件的模型服务（ManagedModel） */
export interface SwitchableModel {
  readonly quant: string;
  switchTo(quant: string, modelFile: string): Promise<void>;
}

export interface ModelCatalogOptions {
  modelsDir: string;
  settingsFile: string;
  model: SwitchableModel;
  /** 版本由 AIT_QUANT 固定 */
  pinned: boolean;
  log?: (event: string, fields?: LogFields) => void;
}

export class ModelCatalog {
  readonly #o: ModelCatalogOptions;
  /** 正在切换到的版本：切换期间不能删它 */
  #target: string | null = null;

  constructor(options: ModelCatalogOptions) {
    this.#o = options;
  }

  list(): { current: string; pinned: boolean; models: LocalModel[] } {
    return { current: this.#o.model.quant, pinned: this.#o.pinned, models: listModels(this.#o.modelsDir) };
  }

  /** 换成 quant：等正在翻的段落翻完再换，新模型就绪后返回；启动失败时已退回原来的版本，抛出原因 */
  async use(quant: unknown): Promise<void> {
    const name = checkName(quant);
    const { model, modelsDir, pinned } = this.#o;
    if (pinned) throw new HttpError(409, "pinned", `量化版本由环境变量 AIT_QUANT 固定为 ${model.quant}，不能切换`);
    const file = modelFile(modelsDir, name);
    if (!existsSync(file)) throw new HttpError(404, "not-found", `本机没有 ${name} 的模型文件`);
    if (name === model.quant) return;
    const from = model.quant;
    this.#target = name;
    try {
      await model.switchTo(name, file);
    } catch (err) {
      const detail = err instanceof TranslateError ? err.detail : "模型服务启动失败";
      throw new HttpError(500, "switch-failed", `换成 ${name} 失败，已退回 ${from}：${detail}`);
    } finally {
      this.#target = null;
    }
    writeSettings(this.#o.settingsFile, { quant: name });
  }

  /** 删掉一个版本的文件；正在用、正在切换到的不能删 */
  remove(quant: unknown): void {
    const name = checkName(quant);
    if (name === this.#o.model.quant || name === this.#target) throw new HttpError(409, "in-use", `${name} 正在使用，不能删除`);
    const file = modelFile(this.#o.modelsDir, name);
    if (!existsSync(file)) throw new HttpError(404, "not-found", `本机没有 ${name} 的模型文件`);
    rmSync(file);
    this.#o.log?.("model-deleted", { quant: name });
  }
}

function checkName(quant: unknown): string {
  if (typeof quant !== "string" || !QUANT.test(quant)) throw new HttpError(400, "bad-request", "量化版本名只能是字母、数字和下划线，如 Q8_0");
  return quant;
}
