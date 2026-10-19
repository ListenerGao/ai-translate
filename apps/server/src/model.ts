// 模型服务：aitd 通过它拿到能用的 Translator。
// CP2 先连一个已经在运行的 llama-server（scripts/start-model.sh 启动的）；CP3 换成 aitd 自己按需启动、空闲停止。
import { LlamaServerTranslator, getModelProfile, type ModelProfile, type Translator } from "@ai-translate/core";

export type ModelState = "stopped" | "starting" | "ready" | "error";

export interface ModelStatus {
  state: ModelState;
  /** 模型配置 id */
  model: string;
  /** 出错时的原因 */
  detail?: string;
}

export interface ModelBackend {
  /** 这个服务加载的模型配置 */
  readonly profile: ModelProfile;
  /** 拿到能用的 Translator；模型还没就绪时等它就绪 */
  translator(signal: AbortSignal): Promise<Translator>;
  status(): Promise<ModelStatus>;
}

/** 连一个已经在运行的 llama-server */
export class ExternalModel implements ModelBackend {
  readonly profile: ModelProfile;
  readonly #endpoint: string;
  readonly #translator: LlamaServerTranslator;

  constructor(options: { endpoint: string; apiKey: string; modelId?: string }) {
    this.profile = getModelProfile(options.modelId ?? "index-translate-2b");
    this.#endpoint = options.endpoint;
    // 服务地址只能是本机，由 LlamaServerTranslator 每次发送前校验
    this.#translator = new LlamaServerTranslator({ endpoint: options.endpoint, apiKey: options.apiKey, profile: this.profile });
  }

  async translator(): Promise<Translator> {
    return this.#translator;
  }

  async status(): Promise<ModelStatus> {
    const model = this.profile.id;
    try {
      const res = await fetch(`${this.#endpoint}/health`, { signal: AbortSignal.timeout(1000) });
      return res.ok ? { state: "ready", model } : { state: "error", model, detail: `模型服务返回 HTTP ${res.status}` };
    } catch {
      return { state: "error", model, detail: "连不上模型服务" };
    }
  }
}
