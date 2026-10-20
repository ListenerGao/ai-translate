// Goal 4 CP3：aitd 管理模型进程。用假的 llama-server（tests/fake-llama-server.sh），编号对应施工清单 CP3 的预期 1~6。
import { TranslateError, type TranslateRequest } from "@ai-translate/core";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer as createNetServer, connect, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { ManagedModel, type ManagedModelOptions } from "./model.ts";

const FAKE = fileURLToPath(new URL("../../../tests/fake-llama-server.sh", import.meta.url));
const MAIN = fileURLToPath(new URL("./main.ts", import.meta.url));
const FAKE_ENV = ["FAKE_LLAMA_START_MS", "FAKE_LLAMA_FAIL", "FAKE_LLAMA_DELAY_MS", "FAKE_LLAMA_STARTS"];

let dir: string;
let starts: string;
let models: ManagedModel[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aitd-model-"));
  writeFileSync(join(dir, "model.gguf"), "");
  starts = join(dir, "starts.txt");
  process.env.FAKE_LLAMA_STARTS = starts;
});

afterEach(async () => {
  for (const m of models) await m.close();
  models = [];
  for (const name of FAKE_ENV) delete process.env[name];
  rmSync(dir, { recursive: true, force: true });
});

async function freePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function make(options: Partial<ManagedModelOptions> = {}): Promise<ManagedModel> {
  const model = new ManagedModel({
    command: FAKE,
    modelFile: join(dir, "model.gguf"),
    quant: "Q8_0",
    port: await freePort(),
    runDir: join(dir, "run"),
    readyTimeoutMs: 5000,
    pollMs: 20,
    ...options,
  });
  models.push(model);
  return model;
}

const request = (text: string): TranslateRequest => ({ segments: [{ id: "s", text }], source: "auto", target: "zh", model: "index-translate-2b" });

async function translateOnce(model: ManagedModel, text: string): Promise<string> {
  const translator = await model.translator();
  for await (const r of translator.translate(request(text), new AbortController().signal)) return r.text;
  throw new Error("没有结果");
}

const startCount = () => (existsSync(starts) ? readFileSync(starts, "utf8").trim().split("\n").length : 0);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("等待超时");
    await sleep(20);
  }
}

const serverError = (pattern: RegExp) => (err: unknown) => err instanceof TranslateError && err.code === "server" && pattern.test(err.detail);

describe("ManagedModel", () => {
  test("1 第一个请求触发启动；启动期间进来的请求等它就绪后一起完成；一次性密钥只有 aitd 知道", async () => {
    process.env.FAKE_LLAMA_START_MS = "300";
    const model = await make();
    assert.equal((await model.status()).state, "stopped");
    assert.equal(startCount(), 0);

    const pending = ["First waiting paragraph.", "Second waiting paragraph.", "Third waiting paragraph."].map((t) => translateOnce(model, t));
    await sleep(80);
    assert.equal((await model.status()).state, "starting");
    assert.deepEqual(await Promise.all(pending), ["【译】First waiting paragraph.", "【译】Second waiting paragraph.", "【译】Third waiting paragraph."]);
    assert.deepEqual(await model.status(), { state: "ready", model: "index-translate-2b", quant: "Q8_0" });
    assert.equal(startCount(), 1);

    const keyFile = join(dir, "run", "llama-server.key");
    assert.equal(statSync(keyFile).mode & 0o777, 0o600);
    assert.equal(statSync(join(dir, "run")).mode & 0o777, 0o700);
  });

  test("1b 别的密钥连不上 aitd 启动的模型服务", async () => {
    const port = await freePort();
    const model = await make({ port });
    await translateOnce(model, "Warm up the model.");
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer client-key-from-extension" },
      body: JSON.stringify({ messages: [{ role: "user", content: "x" }] }),
    });
    assert.equal(res.status, 401);
  });

  test("2 运行中杀掉模型进程：正在翻的段落报错，下一个请求重新拉起", async () => {
    process.env.FAKE_LLAMA_DELAY_MS = "600";
    const model = await make();
    await translateOnce(model, "Warm up the model.");
    const first = model.pid!;
    const inflight = translateOnce(model, "Paragraph that is being translated.");
    await sleep(150);
    process.kill(first, "SIGKILL");
    await assert.rejects(inflight, serverError(/意外退出/));
    // 正在翻的请求先断（连接被重置），进程退出事件几毫秒后才到，状态随后变为 stopped
    await waitFor(async () => (await model.status()).state === "stopped");
    assert.match((await model.status()).detail ?? "", /意外退出/);

    assert.equal(await translateOnce(model, "Paragraph after the crash."), "【译】Paragraph after the crash.");
    assert.notEqual(model.pid, first);
    assert.equal(startCount(), 2);
  });

  test("3 1 分钟内连续启动失败 3 次：停在 error 并给出原因，之后不再反复拉起", async () => {
    process.env.FAKE_LLAMA_FAIL = "error: failed to load model weights";
    const model = await make();
    for (let i = 0; i < 3; i++) await assert.rejects(translateOnce(model, "Will not start."), serverError(/failed to load model weights/));
    const status = await model.status();
    assert.equal(status.state, "error");
    assert.match(status.detail ?? "", /failed to load model weights/);

    const t0 = performance.now();
    await assert.rejects(translateOnce(model, "Still broken."), serverError(/failed to load model weights/));
    assert.ok(performance.now() - t0 < 100, "第 4 次应直接报错，不再启动");
    assert.equal(startCount(), 3);
  });

  test("4 空闲超时后模型进程退出；再来请求重新启动", async () => {
    const model = await make({ idleMs: 300 });
    await translateOnce(model, "Before going idle.");
    const first = model.pid!;
    await waitFor(() => !isAlive(first));
    assert.equal((await model.status()).state, "stopped");
    assert.equal(existsSync(join(dir, "run", "llama-server.key")), false);

    assert.equal(await translateOnce(model, "After waking up."), "【译】After waking up.");
    assert.equal(startCount(), 2);
  });

  test("4b 空闲时间设为 0：模型常驻，空闲也不停", async () => {
    const model = await make({ idleMs: 0 });
    await translateOnce(model, "Stay resident.");
    const pid = model.pid!;
    await sleep(300);
    assert.ok(isAlive(pid));
    assert.equal((await model.status()).state, "ready");
  });

  test("4c 预加载：不等请求就启动；运行中、启动中再调不重复启动；启动失败不抛错，原因留在状态里", async () => {
    process.env.FAKE_LLAMA_START_MS = "200";
    const model = await make();
    const preloading = model.preload();
    await sleep(50);
    assert.equal((await model.status()).state, "starting");
    assert.equal(await translateOnce(model, "Arrives while preloading."), "【译】Arrives while preloading.");
    await preloading;
    await model.preload();
    assert.equal((await model.status()).state, "ready");
    assert.equal(startCount(), 1);

    const broken = await make({ modelFile: join(dir, "missing.gguf") });
    await broken.preload();
    assert.match((await broken.status()).detail ?? "", /模型文件不存在/);
  });

  test("4d aitd 设了 AIT_PRELOAD_SECONDS：启动后不发请求，模型也按时加载", async () => {
    const home = join(dir, "home");
    mkdirSync(join(home, "models"), { recursive: true });
    writeFileSync(join(home, "models", "Index-Translate-2B.Q8_0.gguf"), "");
    const [aitdPort, llamaPort] = [await freePort(), await freePort()];
    const aitd = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", MAIN], {
      env: { ...process.env, AIT_HOME: home, AIT_PORT: String(aitdPort), AIT_LLAMA_SERVER: FAKE, AIT_LLAMA_PORT: String(llamaPort), AIT_PRELOAD_SECONDS: "0.5" },
      stdio: "ignore",
    });
    const exited = new Promise<number | null>((resolve) => aitd.once("exit", (code) => resolve(code)));
    const pidFile = join(home, "run", "llama-server.pid");
    try {
      await waitFor(() => existsSync(join(home, "api-key")));
      assert.equal(existsSync(pidFile), false, "还没到时间，不该启动");
      await waitFor(() => existsSync(pidFile));
      const llamaPid = Number(readFileSync(pidFile, "utf8"));
      await waitFor(() => startCount() === 1);
      assert.ok(isAlive(llamaPid));

      aitd.kill("SIGTERM");
      assert.equal(await exited, 0);
      await waitFor(() => !isAlive(llamaPid), 3000);
    } finally {
      if (aitd.exitCode === null) aitd.kill("SIGKILL");
    }
  });

  test("5 aitd 收到 SIGTERM：模型进程一起退出，不留残留", async () => {
    const home = join(dir, "home");
    mkdirSync(join(home, "models"), { recursive: true });
    writeFileSync(join(home, "models", "Index-Translate-2B.Q8_0.gguf"), "");
    const [aitdPort, llamaPort] = [await freePort(), await freePort()];
    const aitd = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", MAIN], {
      env: { ...process.env, AIT_HOME: home, AIT_PORT: String(aitdPort), AIT_LLAMA_SERVER: FAKE, AIT_LLAMA_PORT: String(llamaPort) },
      stdio: "ignore",
    });
    const exited = new Promise<number | null>((resolve) => aitd.once("exit", (code) => resolve(code)));
    try {
      await waitFor(() => existsSync(join(home, "api-key")));
      const key = readFileSync(join(home, "api-key"), "utf8").trim();
      let res: Response | null = null;
      for (let i = 0; i < 100 && res === null; i++) {
        res = await fetch(`http://127.0.0.1:${aitdPort}/api/translate`, {
          method: "POST",
          headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
          body: JSON.stringify({ segments: [{ id: "a", text: "Through the real aitd." }], target: "zh", model: "index-translate-2b" }),
        }).catch(async () => (await sleep(50), null));
      }
      assert.match(await res!.text(), /【译】Through the real aitd\./);
      const llamaPid = Number(readFileSync(join(home, "run", "llama-server.pid"), "utf8"));
      assert.ok(isAlive(llamaPid));

      aitd.kill("SIGTERM");
      assert.equal(await exited, 0);
      await waitFor(() => !isAlive(llamaPid), 3000);
      assert.equal(existsSync(join(home, "run", "llama-server.key")), false);
    } finally {
      if (aitd.exitCode === null) aitd.kill("SIGKILL");
    }
  });

  test("6 端口已被占用：报「端口被占用」，不启动、不动占用端口的进程", async () => {
    const other: Server = createNetServer((socket) => socket.end("still here"));
    await new Promise<void>((resolve) => other.listen(0, "127.0.0.1", resolve));
    const port = (other.address() as { port: number }).port;
    try {
      const model = await make({ port });
      await assert.rejects(translateOnce(model, "Port is taken."), serverError(new RegExp(`端口 ${port} 被占用`)));
      assert.equal(startCount(), 0);
      const reply = await new Promise<string>((resolve) => {
        const socket = connect(port, "127.0.0.1");
        socket.setEncoding("utf8");
        socket.on("data", (d: string) => resolve(d));
      });
      assert.equal(reply, "still here");
    } finally {
      await new Promise<void>((resolve) => other.close(() => resolve()));
    }
  });

  test("上次 aitd 被强杀留下的模型进程：下次启动前停掉它；进程号文件指向别人的进程时不碰", async () => {
    const port = await freePort();
    const crashed = await make({ port });
    await translateOnce(crashed, "Left behind by a crashed aitd.");
    const orphan = crashed.pid!;
    // 新的 aitd（同一个数据目录、同一个端口）接手
    const next = await make({ port });
    assert.equal(await translateOnce(next, "New aitd takes over."), "【译】New aitd takes over.");
    assert.equal(isAlive(orphan), false);
    await next.close();

    const stranger = spawn("sleep", ["30"]);
    try {
      writeFileSync(join(dir, "run", "llama-server.pid"), String(stranger.pid));
      const third = await make({ port });
      await translateOnce(third, "Do not touch strangers.");
      assert.equal(isAlive(stranger.pid!), true);
    } finally {
      stranger.kill("SIGKILL");
    }
  });

  test("模型文件不存在、命令不存在：给出明确原因", async () => {
    const noFile = await make({ modelFile: join(dir, "missing.gguf") });
    await assert.rejects(translateOnce(noFile, "No model file."), serverError(/模型文件不存在.*download-model\.sh/));
    const noCommand = await make({ command: join(dir, "no-such-llama-server") });
    await assert.rejects(translateOnce(noCommand, "No command."), serverError(/找不到 .*brew install llama\.cpp/));
    assert.equal(startCount(), 0);
  });
});
