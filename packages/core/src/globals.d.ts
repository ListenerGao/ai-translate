// core 只允许使用浏览器、Node、Bun 都有的 Web 标准对象。这里按需声明最小类型，
// 不引入完整的 DOM 或 Node 类型：用到某个环境专有的 API 时，类型检查会直接报错。

declare global {
  interface AbortSignal {
    readonly aborted: boolean;
    readonly reason: unknown;
    throwIfAborted(): void;
    addEventListener(type: "abort", listener: () => void, options?: { once?: boolean }): void;
    removeEventListener(type: "abort", listener: () => void): void;
  }
  var AbortSignal: {
    prototype: AbortSignal;
    timeout(ms: number): AbortSignal;
    any(signals: AbortSignal[]): AbortSignal;
  };

  class AbortController {
    readonly signal: AbortSignal;
    abort(reason?: unknown): void;
  }

  class DOMException extends Error {
    constructor(message?: string, name?: string);
  }

  interface RequestInit {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  }

  interface Response {
    readonly ok: boolean;
    readonly status: number;
    readonly body: { getReader(): { read(): Promise<{ value?: Uint8Array; done: boolean }> } } | null;
    json(): Promise<unknown>;
    text(): Promise<string>;
  }

  class TextDecoder {
    decode(input?: Uint8Array, options?: { stream?: boolean }): string;
  }

  function fetch(input: string, init?: RequestInit): Promise<Response>;

  class TextEncoder {
    encode(input?: string): Uint8Array;
  }

  class URL {
    constructor(url: string, base?: string);
    readonly protocol: string;
    readonly hostname: string;
    readonly origin: string;
  }

  var crypto: {
    subtle: {
      digest(algorithm: "SHA-256", data: Uint8Array): Promise<ArrayBuffer>;
    };
  };
}

export {};
