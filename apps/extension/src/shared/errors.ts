import type { TranslateErrorCode } from "@ai-translate/core";

/** 显示在段落下方的一行提示 */
export function errorMessage(code: TranslateErrorCode, detail = ""): string {
  switch (code) {
    case "endpoint":
      return `服务地址不可用：${detail}`;
    case "no-key":
      return "还没填密钥：打开插件设置页，填入 api-key 文件里的密钥";
    case "unreachable":
      return "连不上本地模型服务：先运行 scripts/start-model.sh";
    case "unauthorized":
      return "密钥不对：到插件设置页重新填写";
    case "timeout":
      return "翻译超时：滚动离开再回来会重试";
    case "server":
      return `模型服务出错（${detail}）`;
    case "invalid":
      return "这一段没翻好，保留原文";
  }
}
