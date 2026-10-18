export interface ModelProfile {
  /** 设置里保存的 id */
  id: string;
  label: string;
  /** 请求体里的 model，对应 llama-server 的 --alias */
  serverModel: string;
  /** 并发上限，等于服务端槽位数（llama-server -np） */
  parallel: number;
  temperature: number;
  maxTokens: number;
  /** 单段超时 */
  timeoutMs: number;
}

// 新增模型只加一条配置；参数取官方默认：贪心解码、输出上限 1024
export const MODEL_PROFILES: Readonly<Record<string, ModelProfile>> = {
  "index-translate-2b": {
    id: "index-translate-2b",
    label: "Index-Translate-2B",
    serverModel: "index-translate-2b",
    parallel: 4,
    temperature: 0,
    maxTokens: 1024,
    timeoutMs: 30_000,
  },
};

export const DEFAULT_MODEL_ID = "index-translate-2b";

export function getModelProfile(id: string): ModelProfile {
  const profile = MODEL_PROFILES[id];
  if (profile === undefined) throw new Error(`未知的模型配置：${id}`);
  return profile;
}
