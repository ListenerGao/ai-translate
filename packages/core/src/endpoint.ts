/** 插件、命令行连本机翻译服务 aitd 的默认地址（第一阶段插件直连 llama-server 时是 8791） */
export const DEFAULT_ENDPOINT = "http://127.0.0.1:8790";

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

export type EndpointCheck = { ok: true; base: string } | { ok: false; reason: string };

/**
 * 校验模型服务地址只指向本机（AGENTS 红线：翻译内容不出本机）。
 * 通过时返回 origin（协议 + 主机 + 端口），用来拼接 /v1/chat/completions。
 */
export function checkLocalEndpoint(input: string): EndpointCheck {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return { ok: false, reason: "地址格式不对，例如 http://127.0.0.1:8790" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: "只支持 http 或 https 地址" };
  }
  if (!LOCAL_HOSTS.has(url.hostname.toLowerCase())) {
    return { ok: false, reason: "只能连接本机服务（127.0.0.1 或 localhost），翻译内容不出本机" };
  }
  return { ok: true, base: url.origin };
}
