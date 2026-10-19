// 翻译出错的分类。插件、aitd、命令行共用；给人看的提示文字由各端自己写。

export type TranslateErrorCode =
  | "endpoint"
  | "no-key"
  | "unreachable"
  | "unauthorized"
  | "timeout"
  | "server"
  | "invalid";

export class TranslateError extends Error {
  readonly code: TranslateErrorCode;
  readonly detail: string;

  constructor(code: TranslateErrorCode, detail = "") {
    super(detail === "" ? code : `${code}: ${detail}`);
    this.name = "TranslateError";
    this.code = code;
    this.detail = detail;
  }
}

/** 撤销（AbortSignal、调度队列撤销）产生的错误 */
export function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}
