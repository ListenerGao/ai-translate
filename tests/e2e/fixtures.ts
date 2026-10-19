import { test as base, chromium, type BrowserContext, type Page, type Worker } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startAitd, type Aitd } from "../../apps/server/src/app.ts";
import { ExternalModel } from "../../apps/server/src/model.ts";
import { startMockServer, type MockServer } from "../mock-server.ts";
import { startStaticServer } from "../static-server.ts";

const extensionPath = fileURLToPath(new URL("../../apps/extension/dist", import.meta.url));
const fixturesPath = fileURLToPath(new URL("../fixtures", import.meta.url));

/** 插件连 aitd 的密钥 */
export const API_KEY = "e2e-key";
/** aitd 连模拟模型服务的密钥：和插件的不同，插件拿着的密钥连不上模型服务 */
export const MODEL_KEY = "e2e-model-key";

/** 测试里的 aitd：可以停掉再在同一端口启动，测「服务没启动」 */
export interface AitdHandle {
  url: string;
  port: number;
  /** aitd 的数据目录（cache.db、glossary.txt） */
  home: string;
  stop(): Promise<void>;
  start(): Promise<void>;
}

interface Fixtures {
  /** Playwright 默认带 --disable-back-forward-cache；测往返缓存的用例用 test.use({ bfcache: true }) 打开 */
  bfcache: boolean;
  context: BrowserContext;
  background: Worker;
  extensionId: string;
  /** 模拟的 llama-server，每个用例一个 */
  llama: MockServer;
  /** 每个用例一个 aitd，背后接模拟模型服务；插件的服务地址和密钥指向它 */
  aitd: AitdHandle;
  /** 模拟模型服务（同 llama）；要它的用例自动带上 aitd */
  mock: MockServer;
  /** 测试页面所在的地址（插件已就绪） */
  site: string;
}

// 每个用例一个干净的持久化上下文，加载 dist 里的插件；插件连 aitd，aitd 再连模拟模型服务
export const test = base.extend<Fixtures>({
  bfcache: [false, { option: true }],
  context: async ({ bfcache }, use) => {
    const context = await chromium.launchPersistentContext("", {
      channel: "chromium",
      args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
      ...(bfcache ? { ignoreDefaultArgs: ["--disable-back-forward-cache"] } : {}),
    });
    await use(context);
    await context.close();
  },
  background: async ({ context }, use) => {
    let [worker] = context.serviceWorkers();
    worker ??= await context.waitForEvent("serviceworker");
    // 默认关掉自动翻译，免得其他用例的页面被自动开启干扰；测自动开启的用例自己打开
    await worker.evaluate(() => chrome.storage.local.set({ autoTranslate: false }));
    await use(worker);
  },
  extensionId: async ({ background }, use) => {
    await use(new URL(background.url()).host);
  },
  llama: async ({}, use) => {
    const llama = await startMockServer({ apiKey: MODEL_KEY });
    await use(llama);
    await llama.close();
  },
  aitd: async ({ background, llama }, use) => {
    const home = mkdtempSync(join(tmpdir(), "ait-e2e-"));
    const options = { apiKey: API_KEY, home, model: new ExternalModel({ endpoint: llama.url, apiKey: MODEL_KEY }), version: "e2e" };
    let server: Aitd | null = await startAitd({ ...options, port: 0 });
    const port = server.port;
    const handle: AitdHandle = {
      url: server.url,
      port,
      home,
      stop: async () => {
        await server?.close();
        server = null;
      },
      start: async () => {
        server ??= await startAitd({ ...options, port });
      },
    };
    await background.evaluate((s) => chrome.storage.local.set(s), { endpoint: server.url, apiKey: API_KEY });
    await use(handle);
    await handle.stop();
    rmSync(home, { recursive: true, force: true });
  },
  mock: async ({ llama, aitd }, use) => {
    void aitd;
    await use(llama);
  },
  // 依赖 background：等插件装好、关掉自动翻译后再开网页。
  // 否则安装时补注入的 content script 会在用例操作中途替换掉原来的实例。
  site: async ({ background }, use) => {
    void background;
    const server = await startStaticServer(fixturesPath);
    await use(server.url);
    await server.close();
  },
});

export const expect = test.expect;

/** 走和工具栏按钮同一个切换函数，返回切换后是否开启 */
export async function toggle(background: Worker, page: Page): Promise<boolean | undefined> {
  return background.evaluate(async (url) => {
    const tab = (await chrome.tabs.query({})).find((t) => t.url === url);
    const fn = (globalThis as unknown as { aitToggleTab(id: number): Promise<{ active: boolean } | undefined> }).aitToggleTab;
    return (await fn(tab!.id!))?.active;
  }, page.url());
}

/** 等模拟服务安静下来：没有在处理的请求，且一段时间内没有新请求 */
export async function settle(mock: MockServer, page: Page, quietMs = 800): Promise<void> {
  let last = -1;
  let stableSince = Date.now();
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const n = mock.requests.length;
    if (n !== last || mock.inflight() > 0) {
      last = n;
      stableSince = Date.now();
    } else if (Date.now() - stableSince >= quietMs) {
      return;
    }
    await page.waitForTimeout(100);
  }
  throw new Error("模拟服务一直没有安静下来");
}

/** 页面上已出译文的段落 id */
export function translatedIds(page: Page): Promise<string[]> {
  return page.$$eval('ait-translation[data-state="done"]', (els) => els.map((e) => e.parentElement?.id ?? ""));
}

/** 模拟服务收到的原文 */
export function requestedSources(mock: MockServer): string[] {
  return mock.requests.map((r) => r.source);
}
