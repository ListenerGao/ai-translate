// 模型服务：aitd 通过它拿到能用的 Translator。
// 默认用 ManagedModel：aitd 自己按需启动 llama-server、空闲停止（也可以启动后预加载、不空闲停止）；ExternalModel 连一个已经在运行的 llama-server（调试用）。
import {
  LlamaServerTranslator,
  TranslateError,
  getModelProfile,
  type ModelProfile,
  type TranslateRequest,
  type TranslateResult,
  type Translator,
} from "@ai-translate/core";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { join } from "node:path";
import type { LogFields } from "./log.ts";

export type ModelState = "stopped" | "starting" | "ready" | "error";

export interface ModelStatus {
  state: ModelState;
  /** 模型配置 id */
  model: string;
  /** 量化版本，如 Q8_0 */
  quant?: string;
  /** 出错、意外退出时的原因 */
  detail?: string;
}

export interface ModelBackend {
  /** 这个服务加载的模型配置 */
  readonly profile: ModelProfile;
  /** 拿到能用的 Translator；模型还没就绪时等它就绪 */
  translator(signal: AbortSignal): Promise<Translator>;
  status(): Promise<ModelStatus>;
  /** aitd 退出时调用：停掉自己启动的模型进程 */
  close(): Promise<void>;
  /** 马上把模型加载好（开机自启的延时加载、桌面应用重启翻译服务后）；连外部模型服务时没有这一步 */
  preload?(): Promise<void>;
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

  async close(): Promise<void> {}
}

export interface ManagedModelOptions {
  /** llama-server 可执行文件；测试时换成假的 */
  command: string;
  modelFile: string;
  /** 量化版本，只用于状态显示 */
  quant: string;
  port: number;
  /** 一次性密钥和进程号文件所在的目录（$AIT_HOME/run） */
  runDir: string;
  modelId?: string;
  /** 最后一次请求结束后多久没有新请求就停掉，默认 30 分钟；0 表示不停（常驻） */
  idleMs?: number;
  /** 最多等多久就绪，默认 60 秒 */
  readyTimeoutMs?: number;
  /** 轮询就绪的间隔，默认 100 毫秒 */
  pollMs?: number;
  log?: (event: string, fields?: LogFields) => void;
}

/** 1 分钟内连续启动失败 3 次就停在 error，不再反复拉起 */
const FAILURE_WINDOW_MS = 60_000;
const MAX_FAILURES = 3;
const OUTPUT_LINES = 12;

/**
 * aitd 自己管理的 llama-server：第一次要翻译时启动，就绪前进来的请求一起等；
 * 意外退出后下一个请求重新拉起；空闲一段时间后停掉，释放内存；aitd 退出时一起停掉。
 * 每次启动生成一次性密钥，只有 aitd 知道；插件和命令行拿着的密钥连不上 llama-server。
 */
export class ManagedModel implements ModelBackend {
  readonly profile: ModelProfile;
  readonly #o: Required<Omit<ManagedModelOptions, "modelId" | "log">> & Pick<ManagedModelOptions, "log">;
  #state: ModelState = "stopped";
  #detail: string | undefined;
  #child: ChildProcess | null = null;
  #translator: LlamaServerTranslator | null = null;
  #starting: Promise<LlamaServerTranslator> | null = null;
  #stopping: Promise<void> | null = null;
  /** 正在换模型文件（Goal 8）：这期间来的请求等换好再翻 */
  #switching: Promise<void> | null = null;
  #failures: number[] = [];
  #output: string[] = [];
  #busy = 0;
  /** 等正在翻的段落都翻完（换模型前） */
  #drained: (() => void)[] = [];
  #idleTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: ManagedModelOptions) {
    this.profile = getModelProfile(options.modelId ?? "index-translate-2b");
    this.#o = { idleMs: 30 * 60_000, readyTimeoutMs: 60_000, pollMs: 100, ...options };
  }

  /** 当前模型进程的进程号（测试和诊断用） */
  get pid(): number | undefined {
    return this.#child?.pid;
  }

  get #keyFile(): string {
    return join(this.#o.runDir, "llama-server.key");
  }

  get #pidFile(): string {
    return join(this.#o.runDir, "llama-server.pid");
  }

  /** 当前的量化版本 */
  get quant(): string {
    return this.#o.quant;
  }

  async translator(): Promise<Translator> {
    const inner = await this.#ready();
    return { translate: (req, signal) => this.#track(inner, req, signal) };
  }

  /**
   * 换一个模型文件（Goal 8 切换量化版本）：等正在翻的段落翻完，停掉旧模型，换文件启动新模型，就绪后返回；
   * 切换期间进来的请求等新模型就绪后再翻。新模型启动失败（文件损坏等）时退回原来的文件、重新启动，再抛出原因
   */
  async switchTo(quant: string, modelFile: string): Promise<void> {
    while (this.#switching !== null) await this.#switching.catch(() => undefined);
    if (quant === this.#o.quant && modelFile === this.#o.modelFile) return;
    const run = this.#switch(quant, modelFile);
    this.#switching = run.catch(() => undefined).finally(() => (this.#switching = null));
    return run;
  }

  async #switch(quant: string, modelFile: string): Promise<void> {
    await this.#starting?.catch(() => undefined);
    await this.#drain();
    const from = { quant: this.#o.quant, modelFile: this.#o.modelFile };
    const started = performance.now();
    await this.#stop();
    Object.assign(this.#o, { quant, modelFile });
    this.#failures = [];
    try {
      await this.#ensureStarted();
      this.#o.log?.("model-switched", { from: from.quant, to: quant, ms: Math.round(performance.now() - started) });
    } catch (err) {
      this.#o.log?.("model-switch-failed", { from: from.quant, to: quant });
      Object.assign(this.#o, from);
      this.#failures = [];
      await this.#ensureStarted().catch(() => undefined);
      throw err;
    }
  }

  #drain(): Promise<void> {
    return this.#busy === 0 ? Promise.resolve() : new Promise((resolve) => this.#drained.push(resolve));
  }

  /** 等正在换模型、正在停的结束，再拿到就绪的模型（没在运行就启动） */
  async #ready(): Promise<LlamaServerTranslator> {
    for (;;) {
      if (this.#switching !== null) await this.#switching;
      else if (this.#stopping !== null) await this.#stopping;
      else break;
    }
    return this.#state === "ready" && this.#translator !== null ? this.#translator : this.#ensureStarted();
  }

  async status(): Promise<ModelStatus> {
    return {
      state: this.#state,
      model: this.profile.id,
      quant: this.#o.quant,
      ...(this.#detail === undefined ? {} : { detail: this.#detail }),
    };
  }

  async close(): Promise<void> {
    await this.#stop();
  }

  /** 提前把模型启动好（开机自启后延时调用），省掉第一次翻译的等待；已在运行或启动中时不重复启动，失败只记日志和状态 */
  async preload(): Promise<void> {
    if (this.#stopping !== null || this.#switching !== null || this.#state === "ready") return;
    this.#o.log?.("model-preload");
    await this.#ensureStarted().catch(() => undefined);
  }

  /** 进程意外退出时的兜底（同步）：aitd 自己要退出了，把模型进程一起带走 */
  killNow(): void {
    this.#child?.kill("SIGKILL");
  }

  #ensureStarted(): Promise<LlamaServerTranslator> {
    this.#starting ??= this.#start().finally(() => (this.#starting = null));
    return this.#starting;
  }

  async #start(): Promise<LlamaServerTranslator> {
    const now = Date.now();
    this.#failures = this.#failures.filter((t) => now - t < FAILURE_WINDOW_MS);
    if (this.#failures.length >= MAX_FAILURES) {
      throw new TranslateError("server", this.#detail ?? "模型服务启动失败");
    }
    this.#state = "starting";
    this.#detail = undefined;
    const started = performance.now();
    try {
      const translator = await this.#launch();
      this.#state = "ready";
      this.#translator = translator;
      this.#failures = [];
      this.#o.log?.("model-started", { quant: this.#o.quant, ms: Math.round(performance.now() - started) });
      this.#scheduleIdle();
      return translator;
    } catch (err) {
      this.#failures.push(Date.now());
      this.#detail = err instanceof TranslateError ? err.detail : "模型服务启动失败";
      this.#state = this.#failures.length >= MAX_FAILURES ? "error" : "stopped";
      this.#o.log?.("model-start-failed", { failures: this.#failures.length });
      throw new TranslateError("server", this.#detail);
    }
  }

  async #launch(): Promise<LlamaServerTranslator> {
    const fail = (detail: string) => new TranslateError("server", detail);
    const { modelFile, port, runDir } = this.#o;
    if (!existsSync(modelFile)) throw fail(`模型文件不存在：${modelFile}。在桌面应用的「设置 → 模型」里下载；从源码安装的，运行 scripts/download-model.sh`);
    await this.#killOrphan();
    if (await portInUse(port)) throw fail(`端口 ${port} 被占用（可能还开着 scripts/start-model.sh），先停掉它`);

    mkdirSync(runDir, { recursive: true, mode: 0o700 });
    chmodSync(runDir, 0o700);
    const key = randomBytes(32).toString("hex");
    rmSync(this.#keyFile, { force: true });
    writeFileSync(this.#keyFile, key, { mode: 0o600 });

    // 参数同 scripts/start-model.sh；--cache-ram 0 关掉提示缓存（Goal 4 CP0：默认开着内存越用越大，对翻译没帮助）
    const args = [
      "-m", modelFile, "--host", "127.0.0.1", "--port", String(port),
      "-c", "16384", "-np", String(this.profile.parallel), "-ngl", "99", "--cache-ram", "0",
      "--reasoning", "off", "--chat-template-kwargs", '{"enable_thinking":false}',
      "--api-key-file", this.#keyFile, "--alias", this.profile.serverModel,
    ];
    const child = spawn(this.#o.command, args, { stdio: ["ignore", "pipe", "pipe"] });
    this.#child = child;
    this.#output = [];
    let exited = false;
    let spawnError: Error | null = null;
    // 只在内存里留最后几行输出，启动失败时给出原因；不写文件（日志红线）
    const collect = (chunk: Buffer) => {
      const lines = chunk.toString("utf8").split("\n").map((l) => l.trim()).filter((l) => l !== "");
      this.#output = [...this.#output, ...lines].slice(-OUTPUT_LINES);
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    child.once("error", (err) => {
      // 命令不存在等：进程根本没起来，不会再有 exit 事件
      spawnError = err;
      exited = true;
      if (this.#child === child) this.#child = null;
    });
    child.once("exit", (code, signal) => {
      exited = true;
      this.#onExit(child, code, signal);
    });
    if (child.pid !== undefined) writeFileSync(this.#pidFile, String(child.pid), { mode: 0o600 });

    const deadline = Date.now() + this.#o.readyTimeoutMs;
    for (;;) {
      if (spawnError !== null) {
        throw fail((spawnError as NodeJS.ErrnoException).code === "ENOENT" ? `找不到 ${this.#o.command}：先运行 brew install llama.cpp` : "模型服务启动失败");
      }
      if (exited) throw fail(`模型服务启动失败：${this.#output.slice(-3).join(" / ") || "进程退出"}`);
      if (await healthy(port)) break;
      if (Date.now() > deadline) {
        child.kill("SIGKILL");
        throw fail(`模型服务 ${Math.round(this.#o.readyTimeoutMs / 1000)} 秒内没有就绪`);
      }
      await new Promise((r) => setTimeout(r, this.#o.pollMs));
    }
    return new LlamaServerTranslator({ endpoint: `http://127.0.0.1:${port}`, apiKey: key, profile: this.profile });
  }

  #onExit(child: ChildProcess, code: number | null, signal: NodeJS.Signals | null): void {
    if (child !== this.#child) return;
    this.#child = null;
    this.#translator = null;
    clearTimeout(this.#idleTimer);
    rmSync(this.#keyFile, { force: true });
    rmSync(this.#pidFile, { force: true });
    if (this.#state === "ready") {
      this.#state = "stopped";
      this.#detail = `模型服务意外退出（${signal ?? `退出码 ${code}`}），下次请求会重新启动`;
      this.#o.log?.("model-crashed", { code: code ?? -1 });
    }
  }

  async *#track(inner: Translator, req: TranslateRequest, signal: AbortSignal): AsyncIterable<TranslateResult> {
    // 拿到模型之后、开始翻之前换了模型：用换好的
    if (this.#switching !== null || inner !== this.#translator) inner = await this.#ready();
    this.#busy++;
    clearTimeout(this.#idleTimer);
    try {
      yield* inner.translate(req, signal);
    } catch (err) {
      // 模型进程是 aitd 自己管的：连不上就是它退出或卡死了
      if (err instanceof TranslateError && err.code === "unreachable") {
        throw new TranslateError("server", "模型服务意外退出，下次请求会重新启动");
      }
      throw err;
    } finally {
      this.#busy--;
      if (this.#busy === 0) {
        this.#scheduleIdle();
        for (const resolve of this.#drained.splice(0)) resolve();
      }
    }
  }

  #scheduleIdle(): void {
    clearTimeout(this.#idleTimer);
    if (this.#state !== "ready" || this.#busy > 0 || !(this.#o.idleMs > 0)) return;
    this.#idleTimer = setTimeout(() => {
      this.#o.log?.("model-idle-stop", { idleMinutes: Math.round(this.#o.idleMs / 60_000) });
      void this.#stop();
    }, this.#o.idleMs);
    this.#idleTimer.unref();
  }

  /** 停掉模型进程：先 SIGTERM，5 秒内没退出再 SIGKILL */
  async #stop(): Promise<void> {
    const child = this.#child;
    clearTimeout(this.#idleTimer);
    if (child === null) return;
    this.#state = "stopped";
    this.#translator = null;
    this.#stopping ??= new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000).unref();
    }).finally(() => (this.#stopping = null));
    await this.#stopping;
  }

  /**
   * 上次 aitd 被强杀时留下的模型进程：进程号文件还在、进程还活着、参数里有 aitd 专用的密钥文件路径，才认定是自己的，停掉它。
   * 别人开的 llama-server（如 scripts/start-model.sh）参数里没有这个路径，不会被误杀。
   */
  async #killOrphan(): Promise<void> {
    if (!existsSync(this.#pidFile)) return;
    const pid = Number(readFileSync(this.#pidFile, "utf8").trim());
    rmSync(this.#pidFile, { force: true });
    if (!Number.isInteger(pid) || pid <= 0 || pid === this.#child?.pid || !isAlive(pid)) return;
    let args = "";
    try {
      args = execFileSync("ps", ["-p", String(pid), "-o", "args="], { encoding: "utf8" });
    } catch {
      return;
    }
    if (!args.includes(this.#keyFile)) return;
    process.kill(pid, "SIGTERM");
    for (let i = 0; i < 50 && isAlive(pid); i++) await new Promise((r) => setTimeout(r, 100));
    if (isAlive(pid)) process.kill(pid, "SIGKILL");
    this.#o.log?.("model-orphan-killed");
  }
}

async function healthy(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) });
    return res.ok;
  } catch {
    return false;
  }
}

/** 本机这个端口能不能被占用：能监听就说明空着 */
function portInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createNetServer();
    probe.once("error", () => resolve(true));
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(false)));
  });
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
