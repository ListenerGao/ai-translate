// aitd 日志：每行一条 JSON。只记事件、计数、耗时、状态码和错误码，不记原文、译文和密钥。
import { appendFileSync, existsSync, renameSync, statSync } from "node:fs";

/** 字段只允许数字、布尔和短代码，调用方不要把原文、译文、密钥放进来 */
export type LogFields = Record<string, number | boolean | string>;

export class Logger {
  readonly #file: string;
  readonly #maxBytes: number;
  readonly #echo: boolean;
  #bytes: number;

  /** echo：同时打到终端（前台运行时） */
  constructor(file: string, options: { maxBytes?: number; echo?: boolean } = {}) {
    this.#file = file;
    this.#maxBytes = options.maxBytes ?? 5 * 1024 * 1024;
    this.#echo = options.echo ?? false;
    this.#bytes = existsSync(file) ? statSync(file).size : 0;
  }

  info(event: string, fields: LogFields = {}): void {
    const line = `${JSON.stringify({ time: new Date().toISOString(), event, ...fields })}\n`;
    const size = Buffer.byteLength(line);
    // 写日志失败（磁盘满、目录被删）不能拖垮服务：这一行丢掉就是
    try {
      // 超过上限轮转一次：aitd.log → aitd.log.1（覆盖上一份）
      if (this.#bytes + size > this.#maxBytes && this.#bytes > 0) {
        renameSync(this.#file, `${this.#file}.1`);
        this.#bytes = 0;
      }
      appendFileSync(this.#file, line, { mode: 0o600 });
      this.#bytes += size;
    } catch {
      this.#bytes = 0;
    }
    if (this.#echo) process.stdout.write(line);
  }
}
