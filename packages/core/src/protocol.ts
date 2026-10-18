// 段落协议：插件和后端之间按段落交换数据。第二阶段 aitd 的 /api/translate 沿用这套格式。

export interface Segment {
  /** 段落 id，插件里对应一个 DOM 节点 */
  id: string;
  text: string;
  /** 上一段原文，可选；第一版不发送，接口先留着 */
  context?: string;
  /** 段内有链接、加粗等格式时的带标记原文（见 inline.ts）；译文保不住标记时退回按 text 纯文本翻译 */
  markup?: string;
}

export interface GlossaryEntry {
  from: string;
  to: string;
}

export interface TranslateRequest {
  segments: Segment[];
  /** "auto" 或语言代码 */
  source: string;
  target: string;
  /** 对应一组模型配置的 id */
  model: string;
  glossary?: GlossaryEntry[];
}

export interface TranslateResult {
  id: string;
  text: string;
  cached: boolean;
}

export interface Translator {
  /** 逐段返回结果；signal 用来撤销已经滑过的段落 */
  translate(req: TranslateRequest, signal: AbortSignal): AsyncIterable<TranslateResult>;
}
