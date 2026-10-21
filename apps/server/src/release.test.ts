// Goal 9 CP1：发布包里的 aitd。打成单文件（apps/server/build.mjs）后用 Node 直接跑，像桌面应用那样：
// 标准输入给一个管道、设 AIT_EXIT_WITH_PARENT=1；管道关掉（App 退出或崩溃）后 aitd 跟着退出，模型进程一起停。用假的 llama-server。
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const FAKE = fileURLToPath(new URL("../../../tests/fake-llama-server.sh", import.meta.url));
const BUILD = fileURLToPath(new URL("../build.mjs", import.meta.url));
// 干净的 PATH：没有 Homebrew；只放当前 Node 的目录（假的 llama-server 是 Node 脚本）
const PATH = `${dirname(process.execPath)}:/usr/bin:/bin`;
const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };

let dir: string;
let bundle: string;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "aitd-release-"));
  bundle = join(dir, "aitd.mjs");
  execFileSync(process.execPath, [BUILD, bundle], { stdio: "ignore" });
});

after(() => rmSync(dir, { recursive: true, force: true }));

async function freePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("等待超时");
    await sleep(20);
  }
}

test("单文件 aitd：报构建时写进去的版本号，能翻译；标准输入的管道关掉后跟着退出，模型进程一起停", async () => {
  const home = join(dir, "home");
  mkdirSync(join(home, "models"), { recursive: true });
  // 只下了 Q4_K_M：默认的 Q8_0 没有文件，回退用 Q4_K_M
  writeFileSync(join(home, "models", "Index-Translate-2B.Q4_K_M.gguf"), "Q4_K_M");
  const [aitdPort, llamaPort] = [await freePort(), await freePort()];
  const aitd = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", bundle], {
    cwd: dir,
    env: { HOME: process.env.HOME ?? "", PATH, AIT_HOME: home, AIT_PORT: String(aitdPort), AIT_LLAMA_SERVER: FAKE, AIT_LLAMA_PORT: String(llamaPort), AIT_EXIT_WITH_PARENT: "1" },
    stdio: ["pipe", "ignore", "ignore"],
  });
  const exited = new Promise<number | null>((resolve) => aitd.once("exit", (code) => resolve(code)));
  try {
    let health: { version?: string } | null = null;
    for (let i = 0; i < 200 && health === null; i++) {
      health = await fetch(`http://127.0.0.1:${aitdPort}/health`)
        .then((r) => r.json() as Promise<{ version?: string }>)
        .catch(async () => (await sleep(25), null));
    }
    assert.equal(health?.version, version);

    const key = readFileSync(join(home, "api-key"), "utf8").trim();
    const res = await fetch(`http://127.0.0.1:${aitdPort}/api/translate`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ segments: [{ id: "a", text: "From the bundle." }], target: "zh", model: "index-translate-2b" }),
    });
    assert.match(await res.text(), /【译 Q4_K_M】From the bundle\./);
    const llamaPid = Number(readFileSync(join(home, "run", "llama-server.pid"), "utf8"));
    assert.ok(isAlive(llamaPid));

    // App 退出或崩溃：给 aitd 的管道关掉
    aitd.stdin?.end();
    assert.equal(await exited, 0);
    await waitFor(() => !isAlive(llamaPid), 3000);
    assert.equal(existsSync(join(home, "run", "llama-server.key")), false);
  } finally {
    if (aitd.exitCode === null) aitd.kill("SIGKILL");
  }
});

test("没设 AIT_EXIT_WITH_PARENT（开机自启、npm run aitd）：标准输入关掉也照常运行", async () => {
  const home = join(dir, "home2");
  mkdirSync(join(home, "models"), { recursive: true });
  const port = await freePort();
  const aitd = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", bundle], {
    cwd: dir,
    env: { HOME: process.env.HOME ?? "", PATH, AIT_HOME: home, AIT_PORT: String(port), AIT_LLAMA_SERVER: FAKE, AIT_LLAMA_PORT: String(await freePort()) },
    stdio: ["pipe", "ignore", "ignore"],
  });
  try {
    await waitFor(() => existsSync(join(home, "api-key")));
    aitd.stdin?.end();
    await sleep(500);
    assert.equal(aitd.exitCode, null);
    assert.equal((await fetch(`http://127.0.0.1:${port}/health`)).status, 200);
  } finally {
    aitd.kill("SIGTERM");
  }
});
