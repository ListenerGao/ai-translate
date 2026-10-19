import { checkLocalEndpoint } from "./endpoint.ts";
import { TranslateError } from "./errors.ts";
import { matchGlossary } from "./glossary.ts";
import { markersOf, normalizeMarkupSpacing, parseMarkup, stripMarkers } from "./inline.ts";
import type { ModelProfile } from "./models.ts";
import { buildPrompt } from "./prompt.ts";
import type { TranslateRequest, TranslateResult, Translator } from "./protocol.ts";
import { validateTranslation } from "./validate.ts";

export interface LlamaServerConfig {
  endpoint: string;
  apiKey: string;
  profile: ModelProfile;
  /** 测试时注入 */
  fetch?: typeof fetch;
}

/**
 * 直连本机 llama-server 的 OpenAI 兼容接口的 Translator，一段一个请求。第一阶段插件直接用它，第二阶段由 aitd 使用。
 * 段内有格式（segment.markup）时先按带标记的原文翻译；标记没保住或译文不合格，退回纯文本翻译。
 */
export class LlamaServerTranslator implements Translator {
  readonly #config: LlamaServerConfig;

  constructor(config: LlamaServerConfig) {
    this.#config = config;
  }

  async *translate(req: TranslateRequest, signal: AbortSignal): AsyncIterable<TranslateResult> {
    for (const segment of req.segments) {
      const text =
        segment.markup === undefined
          ? await this.#translateText(segment.text, req, signal)
          : await this.#translateMarkup(segment.text, segment.markup, req, signal);
      yield { id: segment.id, text, cached: false };
    }
  }

  /** 服务地址只能是本机、必须有密钥，通过后返回服务地址 */
  #base(): string {
    const endpoint = checkLocalEndpoint(this.#config.endpoint);
    if (!endpoint.ok) throw new TranslateError("endpoint", endpoint.reason);
    if (this.#config.apiKey.trim() === "") throw new TranslateError("no-key");
    return endpoint.base;
  }

  async #translateMarkup(text: string, markup: string, req: TranslateRequest, signal: AbortSignal): Promise<string> {
    const base = this.#base();
    const glossary = matchGlossary(text, req.glossary ?? []);
    const prompt = buildPrompt(markup, { source: req.source, target: req.target, glossary, markers: markersOf(markup) });
    const output = normalizeMarkupSpacing((await this.#complete(base, prompt, signal)).trim(), req.target);
    const issue = validateTranslation(text, stripMarkers(output), req.target);
    if (parseMarkup(output, markup) !== null && (issue === null || issue === "same-as-source")) return output;
    // 标记没保住或译文不合格：退回纯文本翻译。贪心解码下同一 prompt 重试结果基本一样，所以不重试
    return this.#translateText(text, req, signal);
  }

  async #translateText(text: string, req: TranslateRequest, signal: AbortSignal): Promise<string> {
    const base = this.#base();
    const glossary = matchGlossary(text, req.glossary ?? []);
    const prompt = buildPrompt(text, { source: req.source, target: req.target, glossary });

    // 校验不通过重试 1 次（贪心解码下重试结果通常相同，但服务偶发异常时有用）。
    // 两次都原样照抄原文时照常返回：品牌名、产品名本来就不用翻，由网页端决定不显示
    let issue = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      const output = (await this.#complete(base, prompt, signal)).trim();
      const found = validateTranslation(text, output, req.target);
      if (found === null || (found === "same-as-source" && attempt === 1)) return output;
      issue = found;
    }
    throw new TranslateError("invalid", issue);
  }

  async #complete(base: string, prompt: string, signal: AbortSignal): Promise<string> {
    const { apiKey, profile } = this.#config;
    const doFetch = this.#config.fetch ?? fetch;
    const timeout = AbortSignal.timeout(profile.timeoutMs);
    const combined = AbortSignal.any([signal, timeout]);

    // 调用方撤销时原样抛出撤销原因；超时转成 timeout；其余用 fallback
    const fail = (err: unknown, fallback: TranslateError): never => {
      if (signal.aborted) throw signal.reason ?? err;
      if (timeout.aborted) throw new TranslateError("timeout");
      throw fallback;
    };

    let res: Response;
    try {
      res = await doFetch(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey.trim()}` },
        body: JSON.stringify({
          model: profile.serverModel,
          messages: [{ role: "user", content: prompt }],
          temperature: profile.temperature,
          max_tokens: profile.maxTokens,
          chat_template_kwargs: { enable_thinking: false },
        }),
        signal: combined,
      });
    } catch (err) {
      return fail(err, new TranslateError("unreachable"));
    }

    if (res.status === 401 || res.status === 403) throw new TranslateError("unauthorized");
    if (!res.ok) throw new TranslateError("server", `HTTP ${res.status}`);

    let data: unknown;
    try {
      data = await res.json();
    } catch (err) {
      return fail(err, new TranslateError("server", "返回的不是 JSON"));
    }
    const content = (data as { choices?: { message?: { content?: unknown } }[] }).choices?.[0]?.message?.content;
    if (typeof content !== "string") throw new TranslateError("server", "返回格式不对");
    return content;
  }
}
