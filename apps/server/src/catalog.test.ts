// Goal 8 CP1：aitd 的模型接口（列表、切换、删除）。用假的 llama-server（tests/fake-llama-server.sh）：
// 测试里的模型文件是小文本，假服务的译文带上文件内容（如「【译 Q4_K_M】原文」），能看出是哪个文件在翻；内容是 broken 时启动失败。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { startAitd, type Aitd } from "./app.ts";
import { ModelCatalog, chooseQuant, listModels, modelFile } from "./catalog.ts";
import { ExternalModel, ManagedModel } from "./model.ts";

const FAKE = fileURLToPath(new URL("../../../tests/fake-llama-server.sh", import.meta.url));
const MAIN = fileURLToPath(new URL("./main.ts", import.meta.url));
const KEY = "client-key-0123456789abcdef";
const AUTH = { authorization: `Bearer ${KEY}` };

let home: string;
let modelsDir: string;
let settingsFile: string;
let model: ManagedModel | undefined;
let aitd: Aitd | undefined;

async function freePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** 模型目录：三个完整版本（BAD 是坏文件），外加不该列出的下载中文件、看图用的 mmproj、别的文件 */
function writeModels(dir: string): void {
  mkdirSync(dir, { recursive: true });
  for (const [quant, text] of [["Q8_0", "Q8_0 model file"], ["Q4_K_M", "Q4_K_M"], ["BAD", "broken file"]]) {
    writeFileSync(modelFile(dir, quant ?? ""), text ?? "");
  }
  writeFileSync(join(dir, "Index-Translate-2B.Q2_K.gguf.part"), "half");
  writeFileSync(join(dir, "Index-Translate-2B.mmproj-Q8_0.gguf"), "vision");
  writeFileSync(join(dir, "notes.txt"), "x");
}

async function boot(options: { pinned?: boolean } = {}): Promise<ManagedModel> {
  const managed = new ManagedModel({
    command: FAKE,
    modelFile: modelFile(modelsDir, "Q8_0"),
    quant: "Q8_0",
    port: await freePort(),
    runDir: join(home, "run"),
    readyTimeoutMs: 5000,
    pollMs: 20,
  });
  model = managed;
  const catalog = new ModelCatalog({ modelsDir, settingsFile, model: managed, pinned: options.pinned ?? false });
  aitd = await startAitd({ port: 0, apiKey: KEY, home, model: managed, catalog, version: "test" });
  return managed;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "aitd-catalog-"));
  modelsDir = join(home, "models");
  settingsFile = join(home, "settings.json");
  writeModels(modelsDir);
});

afterEach(async () => {
  await aitd?.close();
  await model?.close();
  aitd = undefined;
  model = undefined;
  delete process.env.FAKE_LLAMA_DELAY_MS;
  rmSync(home, { recursive: true, force: true });
});

async function call(path: string, options: { method?: string; body?: unknown; auth?: boolean } = {}): Promise<{ status: number; data: Record<string, unknown> }> {
  const res = await fetch(`${aitd?.url}${path}`, {
    method: options.method ?? "GET",
    headers: { ...(options.auth === false ? {} : AUTH), "Content-Type": "application/json" },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  return { status: res.status, data: (await res.json()) as Record<string, unknown> };
}

async function translate(text: string): Promise<string> {
  const res = await fetch(`${aitd?.url}/api/translate`, {
    method: "POST",
    headers: { ...AUTH, "Content-Type": "application/json" },
    body: JSON.stringify({ segments: [{ id: "1", text }], target: "zh", model: "index-translate-2b" }),
  });
  const line = JSON.parse((await res.text()).trim().split("\n")[0] ?? "{}") as { text?: string };
  return line.text ?? "";
}

const quants = (data: Record<string, unknown>) => (data.models as { quant: string }[]).map((m) => m.quant).sort();
const statusQuant = async () => ((await call("/api/status")).data.model as { quant: string; state: string });

describe("Goal 8 CP1 aitd 模型接口", () => {
  test("1 列表只列完整的 .gguf（不列 .part、mmproj、别的文件），带大小、当前版本、是否被固定", async () => {
    await boot();
    const { status, data } = await call("/api/models");
    assert.equal(status, 200);
    assert.deepEqual(quants(data), ["BAD", "Q4_K_M", "Q8_0"]);
    assert.equal(data.current, "Q8_0");
    assert.equal(data.pinned, false);
    const q4 = (data.models as { quant: string; size: number }[]).find((m) => m.quant === "Q4_K_M");
    assert.equal(q4?.size, "Q4_K_M".length);
  });

  test("2 切换：新模型就绪后返回，/api/status 显示新版本，settings.json 写入，之后的翻译用新模型", async () => {
    await boot();
    assert.equal(await translate("Hello"), "【译 Q8_0 model file】Hello");
    const { status, data } = await call("/api/models/current", { method: "PUT", body: { quant: "Q4_K_M" } });
    assert.equal(status, 200);
    assert.equal(data.current, "Q4_K_M");
    assert.deepEqual(data.model, { state: "ready", model: "index-translate-2b", quant: "Q4_K_M" });
    assert.deepEqual(await statusQuant(), { state: "ready", model: "index-translate-2b", quant: "Q4_K_M" });
    assert.deepEqual(JSON.parse(readFileSync(settingsFile, "utf8")), { quant: "Q4_K_M" });
    assert.equal(await translate("World"), "【译 Q4_K_M】World");
    // 换回当前版本：什么都不做
    assert.equal((await call("/api/models/current", { method: "PUT", body: { quant: "Q4_K_M" } })).status, 200);
  });

  test("3 正在翻的段落用旧模型翻完才切；切换期间进来的请求等新模型就绪后用新模型翻完", async () => {
    process.env.FAKE_LLAMA_DELAY_MS = "400";
    await (await boot()).preload();
    const order: string[] = [];
    const before = translate("Before").then((t) => (order.push("before"), t));
    await new Promise((r) => setTimeout(r, 100));
    const switched = call("/api/models/current", { method: "PUT", body: { quant: "Q4_K_M" } }).then((r) => (order.push("switched"), r));
    await new Promise((r) => setTimeout(r, 50));
    const during = translate("During").then((t) => (order.push("during"), t));
    assert.equal(await before, "【译 Q8_0 model file】Before");
    assert.equal((await switched).status, 200);
    assert.equal(await during, "【译 Q4_K_M】During");
    assert.deepEqual(order, ["before", "switched", "during"]);
  });

  test("4 新模型启动失败（文件损坏）：退回原来的版本，返回 500 说明原因，settings.json 不变，还能照常翻", async () => {
    await (await boot()).preload();
    const { status, data } = await call("/api/models/current", { method: "PUT", body: { quant: "BAD" } });
    assert.equal(status, 500);
    assert.equal((data.error as { code: string }).code, "switch-failed");
    assert.match((data.error as { message: string }).message, /换成 BAD 失败，已退回 Q8_0/);
    assert.deepEqual(await statusQuant(), { state: "ready", model: "index-translate-2b", quant: "Q8_0" });
    assert.equal(existsSync(settingsFile), false);
    assert.equal(await translate("Still works"), "【译 Q8_0 model file】Still works");
  });

  test("5 AIT_QUANT 固定时不能切换（409）；列表标明被固定", async () => {
    await boot({ pinned: true });
    assert.equal((await call("/api/models")).data.pinned, true);
    const { status, data } = await call("/api/models/current", { method: "PUT", body: { quant: "Q4_K_M" } });
    assert.equal(status, 409);
    assert.equal((data.error as { code: string }).code, "pinned");
    assert.equal((await statusQuant()).quant, "Q8_0");
  });

  test("6 删除：当前版本 409；别的版本删掉文件、列表跟着变；没有的 404；非法版本名 400（防路径穿越）", async () => {
    await boot();
    assert.equal((await call("/api/models/Q8_0", { method: "DELETE" })).status, 409);
    const removed = await call("/api/models/Q4_K_M", { method: "DELETE" });
    assert.equal(removed.status, 200);
    assert.deepEqual(quants(removed.data), ["BAD", "Q8_0"]);
    assert.equal(existsSync(modelFile(modelsDir, "Q4_K_M")), false);
    assert.equal((await call("/api/models/Q5_K_M", { method: "DELETE" })).status, 404);
    assert.equal((await call("/api/models/..%2Fapi-key", { method: "DELETE" })).status, 400);
    assert.equal((await call("/api/models/Q8_0.gguf", { method: "DELETE" })).status, 400);
    assert.equal(existsSync(join(modelsDir, "Index-Translate-2B.Q2_K.gguf.part")), true, "下载中的文件不受影响");
  });

  test("7 切换的参数不对：非法版本名 400，本机没有的版本 404，缺 quant 400", async () => {
    await boot();
    assert.equal((await call("/api/models/current", { method: "PUT", body: { quant: "../Q8_0" } })).status, 400);
    assert.equal((await call("/api/models/current", { method: "PUT", body: { quant: "Q5_K_M" } })).status, 404);
    assert.equal((await call("/api/models/current", { method: "PUT", body: {} })).status, 400);
  });

  test("8 不带密钥：三个接口都 401", async () => {
    await boot();
    assert.equal((await call("/api/models", { auth: false })).status, 401);
    assert.equal((await call("/api/models/current", { method: "PUT", body: { quant: "Q4_K_M" }, auth: false })).status, 401);
    assert.equal((await call("/api/models/Q4_K_M", { method: "DELETE", auth: false })).status, 401);
    assert.equal(existsSync(modelFile(modelsDir, "Q4_K_M")), true);
  });

  test("9 连外部模型服务（AIT_MODEL_URL）时不管理模型文件：409", async () => {
    aitd = await startAitd({ port: 0, apiKey: KEY, home, model: new ExternalModel({ endpoint: "http://127.0.0.1:9", apiKey: "x" }), version: "test" });
    const { status, data } = await call("/api/models");
    assert.equal(status, 409);
    assert.equal((data.error as { code: string }).code, "external-model");
  });
});

describe("Goal 8 CP1 启动时用哪个版本", () => {
  test("10 AIT_QUANT（固定）> settings.json > Q8_0；settings.json 坏了或版本名不合法时用 Q8_0", () => {
    assert.deepEqual(chooseQuant(undefined, settingsFile), { quant: "Q8_0", pinned: false });
    writeFileSync(settingsFile, JSON.stringify({ quant: "Q4_K_M" }));
    assert.deepEqual(chooseQuant(undefined, settingsFile), { quant: "Q4_K_M", pinned: false });
    assert.deepEqual(chooseQuant("Q6_K", settingsFile), { quant: "Q6_K", pinned: true });
    writeFileSync(settingsFile, "{ not json");
    assert.deepEqual(chooseQuant(undefined, settingsFile), { quant: "Q8_0", pinned: false });
    writeFileSync(settingsFile, JSON.stringify({ quant: "../x" }));
    assert.deepEqual(chooseQuant(undefined, settingsFile), { quant: "Q8_0", pinned: false });
    assert.deepEqual(listModels(join(home, "missing")), []);
  });

  test("11 重启 aitd 后仍用切换后的版本：真的启动 aitd（main.ts），读 settings.json", async () => {
    writeFileSync(settingsFile, JSON.stringify({ quant: "Q4_K_M" }));
    const [aitdPort, llamaPort] = [await freePort(), await freePort()];
    const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", MAIN], {
      env: { ...process.env, AIT_HOME: home, AIT_PORT: String(aitdPort), AIT_LLAMA_SERVER: FAKE, AIT_LLAMA_PORT: String(llamaPort), AIT_QUANT: "" },
      stdio: "ignore",
    });
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    try {
      const deadline = Date.now() + 10_000;
      let data: Record<string, unknown> | undefined;
      while (data === undefined && Date.now() < deadline) {
        try {
          const key = readFileSync(join(home, "api-key"), "utf8").trim();
          const res = await fetch(`http://127.0.0.1:${aitdPort}/api/models`, { headers: { authorization: `Bearer ${key}` } });
          if (res.ok) data = (await res.json()) as Record<string, unknown>;
        } catch {
          await new Promise((r) => setTimeout(r, 100));
        }
      }
      assert.equal(data?.current, "Q4_K_M");
      assert.equal(data?.pinned, false);
    } finally {
      child.kill("SIGTERM");
      await exited;
    }
  });
});
