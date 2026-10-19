// Goal 5 CP1：命令行骨架。真的起一个 aitd（背后是模拟模型服务），再把 ait 当独立进程跑，看输出和退出码。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { BUILTIN_GLOSSARY, buildPrompt, matchGlossary } from "@ai-translate/core";
import { startAitd, type Aitd } from "../../server/src/app.ts";
import { ExternalModel } from "../../server/src/model.ts";
import { startMockServer, type MockServer } from "../../../tests/mock-server.ts";

const MAIN = fileURLToPath(new URL("./main.ts", import.meta.url));
const KEY = "cli-test-key";
const MODEL_KEY = "cli-model-key";

let mock: MockServer;
let aitd: Aitd;
let home: string;
let aitdHome: string;

before(async () => {
  mock = await startMockServer({ apiKey: MODEL_KEY });
  aitdHome = mkdtempSync(join(tmpdir(), "ait-cli-aitd-"));
  aitd = await startAitd({ port: 0, apiKey: KEY, home: aitdHome, model: new ExternalModel({ endpoint: mock.url, apiKey: MODEL_KEY }), version: "test" });
  home = mkdtempSync(join(tmpdir(), "ait-cli-home-"));
  writeFileSync(join(home, "api-key"), KEY, { mode: 0o600 });
});

after(async () => {
  await aitd.close();
  await mock.close();
  rmSync(aitdHome, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

beforeEach(() => {
  mock.reset();
});

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

function ait(args: string[], options: { input?: string; env?: Record<string, string>; cwd?: string } = {}): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", MAIN, ...args], {
      env: { ...process.env, AIT_HOME: home, AIT_URL: aitd.url, ...options.env },
      cwd: options.cwd ?? process.cwd(),
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
    child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(options.input ?? "");
  });
}

describe("ait", () => {
  test("1 ait \"文字\" 输出译文；从标准输入读结果相同；空行分段", async () => {
    assert.deepEqual(await ait(["Hello there."]), { code: 0, stdout: "【译】Hello there.\n", stderr: "" });
    assert.equal((await ait([], { input: "Hello there.\n" })).stdout, "【译】Hello there.\n");
    const multi = await ait([], { input: "First paragraph.\n\nSecond paragraph\ncontinues here.\n" });
    assert.equal(multi.stdout, "【译】First paragraph.\n\n【译】Second paragraph\ncontinues here.\n");
  });

  test("2 aitd 没启动：退出码 2，提示怎么启动", async () => {
    const free = await new Promise<number>((resolve) => {
      const s: Server = createServer();
      s.listen(0, "127.0.0.1", () => {
        const { port } = s.address() as AddressInfo;
        s.close(() => resolve(port));
      });
    });
    const run = await ait(["Hello."], { env: { AIT_URL: `http://127.0.0.1:${free}` } });
    assert.equal(run.code, 2);
    assert.match(run.stderr, /连不上本机翻译服务 aitd.*npm run aitd/);
    const st = await ait(["status"], { env: { AIT_URL: `http://127.0.0.1:${free}` } });
    assert.equal(st.code, 2);
  });

  test("3 密钥文件不存在、密钥不对：退出码 2，提示原因", async () => {
    const empty = mkdtempSync(join(tmpdir(), "ait-cli-nokey-"));
    try {
      const missing = await ait(["Hello."], { env: { AIT_HOME: empty } });
      assert.equal(missing.code, 2);
      assert.match(missing.stderr, /找不到密钥文件/);
      writeFileSync(join(empty, "api-key"), "wrong-key");
      const wrong = await ait(["Hello."], { env: { AIT_HOME: empty } });
      assert.equal(wrong.code, 2);
      assert.match(wrong.stderr, /密钥不对/);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  test("4 --to、--from 原样传给 aitd；不支持的语言直接报错", async () => {
    assert.equal((await ait(["--to", "ja", "--from", "en", "Good morning."])).code, 0);
    assert.match(mock.requests.at(-1)!.prompt, /英语文本翻译为日语/);
    const bad = await ait(["--to", "xx", "Hi."]);
    assert.equal(bad.code, 1);
    assert.match(bad.stderr, /不支持的目标语言/);
  });

  test("5 请求走 batch 通道（排在浏览器后面）", async () => {
    const bodies: Record<string, unknown>[] = [];
    const capture = createServer((req, res) => {
      if (req.url === "/health") return void res.end(JSON.stringify({ status: "ok", api: 1 }));
      let raw = "";
      req.on("data", (c: Buffer) => (raw += c));
      req.on("end", () => {
        const body = JSON.parse(raw) as { segments: { id: string }[] };
        bodies.push(body as unknown as Record<string, unknown>);
        res.writeHead(200, { "Content-Type": "application/x-ndjson" });
        res.end(body.segments.map((s) => JSON.stringify({ id: s.id, text: "译", cached: false })).join("\n") + "\n");
      });
    });
    await new Promise<void>((resolve) => capture.listen(0, "127.0.0.1", resolve));
    try {
      const run = await ait(["Hi there."], { env: { AIT_URL: `http://127.0.0.1:${(capture.address() as AddressInfo).port}` } });
      assert.equal(run.code, 0);
      assert.equal(bodies[0]?.lane, "batch");
    } finally {
      await new Promise<void>((resolve) => capture.close(() => resolve()));
    }
  });

  test("status：显示 aitd、模型、队列、缓存", async () => {
    const run = await ait(["status"]);
    assert.equal(run.code, 0);
    assert.match(run.stdout, /^aitd test 正常/);
    assert.match(run.stdout, /模型：Index-Translate-2B，运行中/);
    assert.match(run.stdout, /缓存：\d+ 条/);
  });

  test("--glossary：术语带给模型；文件有写错的行就不翻，退出码 1", async () => {
    const file = join(home, "terms.txt");
    writeFileSync(file, "kubelet=节点代理");
    assert.equal((await ait(["--glossary", file, "The kubelet restarted."])).code, 0);
    assert.match(mock.requests.at(-1)!.prompt, /kubelet→节点代理/);
    writeFileSync(file, "kubelet=节点代理\nno equals here");
    const bad = await ait(["--glossary", file, "The kubelet restarted again."]);
    assert.equal(bad.code, 1);
    assert.match(bad.stderr, /第 2 行/);
  });

  test("有段落没翻成：保留原文，stderr 说明，退出码 3", async () => {
    mock.setResponder((req) => (req.source.startsWith("Broken") ? { status: 500 } : undefined));
    const run = await ait([], { input: "Healthy paragraph.\n\nBroken paragraph.\n" });
    assert.equal(run.code, 3);
    assert.equal(run.stdout, "【译】Healthy paragraph.\n\nBroken paragraph.\n");
    assert.match(run.stderr, /第 2 段没翻成，保留原文/);
  });

  test("参数错误、没有文字：退出码 1；--help、--version 正常", async () => {
    assert.equal((await ait(["--nope"])).code, 1);
    assert.equal((await ait([], { input: "   \n" })).code, 1);
    assert.match((await ait(["--help"])).stdout, /用法/);
    assert.match((await ait(["--version"])).stdout, /^ait \d+\.\d+\.\d+/);
  });
});

describe("ait translate：Markdown", () => {
  const fixture = (name: string) => fileURLToPath(new URL(`../../../tests/fixtures/cli/${name}`, import.meta.url));
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ait-cli-md-"));
    copyFileSync(fixture("guide.md"), join(dir, "guide.md"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("1~3 默认写到原文件旁边（guide.zh.md），结构和格式与 golden 逐字一致", async () => {
    const run = await ait(["translate", join(dir, "guide.md")]);
    assert.equal(run.code, 0, run.stderr);
    assert.equal(run.stdout, "");
    assert.match(run.stderr, /已写入 .*guide\.zh\.md/);
    assert.equal(readFileSync(join(dir, "guide.zh.md"), "utf8"), readFileSync(fixture("guide.zh.md"), "utf8"));
    assert.ok(mock.requests.length > 0);
  });

  test("4 --bilingual 输出双语；-o - 打到终端；-o 写到指定位置", async () => {
    const bi = await ait(["translate", join(dir, "guide.md"), "--bilingual", "-o", "-"]);
    assert.equal(bi.code, 0, bi.stderr);
    assert.equal(bi.stdout, readFileSync(fixture("guide.bilingual.md"), "utf8"));
    assert.ok(!existsSync(join(dir, "guide.zh.md")));
    const out = join(dir, "out.md");
    assert.equal((await ait(["translate", join(dir, "guide.md"), "-o", out])).code, 0);
    assert.equal(readFileSync(out, "utf8"), readFileSync(fixture("guide.zh.md"), "utf8"));
  });

  test("5 空文件、只有代码块的文件：原样输出，不发请求，也不需要 aitd", async () => {
    for (const [name, text] of [["empty.md", ""], ["code.md", "```sh\nnpm test\n```\n"]] as const) {
      writeFileSync(join(dir, name), text);
      const run = await ait(["translate", join(dir, name), "-o", "-"], { env: { AIT_URL: "http://127.0.0.1:9" } });
      assert.equal(run.code, 0, run.stderr);
      assert.equal(run.stdout, text);
      assert.match(run.stderr, /没有要翻译的文字/);
    }
    assert.equal(mock.requests.length, 0);
  });

  test("6 输出文件已存在：不覆盖，退出码 1，不发请求；加 --force 覆盖", async () => {
    writeFileSync(join(dir, "guide.zh.md"), "keep me\n");
    const run = await ait(["translate", join(dir, "guide.md")]);
    assert.equal(run.code, 1);
    assert.match(run.stderr, /已存在：加 --force 覆盖/);
    assert.equal(readFileSync(join(dir, "guide.zh.md"), "utf8"), "keep me\n");
    assert.equal(mock.requests.length, 0);
    assert.equal((await ait(["translate", join(dir, "guide.md"), "--force"])).code, 0);
    assert.equal(readFileSync(join(dir, "guide.zh.md"), "utf8"), readFileSync(fixture("guide.zh.md"), "utf8"));
  });

  test("有段落没翻成：保留原文，stderr 给出行号，退出码 3", async () => {
    writeFileSync(join(dir, "part.md"), "# Fine title\n\nBroken paragraph here.\n");
    mock.setResponder((req) => (req.source.startsWith("Broken") ? { status: 500 } : undefined));
    const run = await ait(["translate", join(dir, "part.md"), "-o", "-"]);
    assert.equal(run.code, 3);
    assert.equal(run.stdout, "# 【译】Fine title\n\nBroken paragraph here.\n");
    assert.match(run.stderr, /第 3 行没翻成，保留原文/);
  });

  test("文件错误：不支持的类型、找不到文件、不是 UTF-8、输出到原文件，退出码 1", async () => {
    writeFileSync(join(dir, "notes.txt"), "Hello");
    assert.match((await ait(["translate", join(dir, "notes.txt")])).stderr, /不支持的文件类型/);
    assert.match((await ait(["translate", join(dir, "missing.md")])).stderr, /找不到文件/);
    writeFileSync(join(dir, "gbk.md"), Buffer.from([0x23, 0x20, 0xc4, 0xe3, 0xba, 0xc3, 0x0a]));
    const gbk = await ait(["translate", join(dir, "gbk.md")]);
    assert.equal(gbk.code, 1);
    assert.match(gbk.stderr, /不是 UTF-8 编码/);
    assert.equal((await ait(["translate", join(dir, "guide.md"), "-o", join(dir, "guide.md"), "--force"])).code, 1);
    assert.equal((await ait(["translate"])).code, 1);
    assert.equal(mock.requests.length, 0);
  });
});

describe("ait translate：SRT", () => {
  const fixture = (name: string) => fileURLToPath(new URL(`../../../tests/fixtures/cli/${name}`, import.meta.url));
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ait-cli-srt-"));
    copyFileSync(fixture("talk.srt"), join(dir, "talk.srt"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("1 默认写到 talk.zh.srt，序号、时间轴不变，多行合成一行；用和网页相同的纯文本 prompt", async () => {
    const run = await ait(["translate", join(dir, "talk.srt")]);
    assert.equal(run.code, 0, run.stderr);
    assert.match(run.stderr, /已写入 .*talk\.zh\.srt/);
    assert.equal(readFileSync(join(dir, "talk.zh.srt"), "utf8"), readFileSync(fixture("talk.zh.srt"), "utf8"));
    assert.equal(mock.requests.length, 18);
    // 和网页同一个 prompt：不加文体、不带前后文，命中术语时照常带上
    for (const r of mock.requests) {
      assert.equal(r.prompt, buildPrompt(r.source, { source: "auto", target: "zh", glossary: matchGlossary(r.source, BUILTIN_GLOSSARY) }));
    }
    assert.ok(mock.requests.some((r) => r.prompt.includes("under the hood→底层")));
  });

  test("2 --bilingual：原文行在上、译文一行在下", async () => {
    const run = await ait(["translate", join(dir, "talk.srt"), "--bilingual", "-o", "-"]);
    assert.equal(run.code, 0, run.stderr);
    assert.equal(run.stdout, readFileSync(fixture("talk.bilingual.srt"), "utf8"));
  });

  test("3 带 BOM、CRLF 换行：输出保留 BOM 和 CRLF", async () => {
    const crlf = (text: string) => `﻿${text.replaceAll("\n", "\r\n")}`;
    writeFileSync(join(dir, "win.srt"), crlf(readFileSync(fixture("talk.srt"), "utf8")));
    const run = await ait(["translate", join(dir, "win.srt"), "-o", "-"]);
    assert.equal(run.code, 0, run.stderr);
    assert.equal(run.stdout, crlf(readFileSync(fixture("talk.zh.srt"), "utf8")));
  });

  test("4 格式错误：报文件和行号，退出码 1，不发请求，不写输出文件", async () => {
    writeFileSync(join(dir, "bad.srt"), "1\n00:00:01,000 --> 00:00:02,000\nFine.\n\n2\nMissing timing.\n");
    const run = await ait(["translate", join(dir, "bad.srt")]);
    assert.equal(run.code, 1);
    assert.match(run.stderr, /bad\.srt 第 6 行格式不对：这里应该是时间轴/);
    assert.equal(mock.requests.length, 0);
    assert.ok(!existsSync(join(dir, "bad.zh.srt")));
  });

  test("5 非 UTF-8 文件：报错并提示转码，退出码 1", async () => {
    // GBK 编码的「你好」
    writeFileSync(join(dir, "gbk.srt"), Buffer.concat([Buffer.from("1\n00:00:01,000 --> 00:00:02,000\n"), Buffer.from([0xc4, 0xe3, 0xba, 0xc3]), Buffer.from("\n")]));
    const run = await ait(["translate", join(dir, "gbk.srt")]);
    assert.equal(run.code, 1);
    assert.match(run.stderr, /不是 UTF-8 编码：先转成 UTF-8 再翻（如 iconv/);
    assert.equal(mock.requests.length, 0);
  });
});
