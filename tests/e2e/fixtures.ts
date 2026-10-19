import { test as base, chromium, type BrowserContext, type Page, type Worker } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { startMockServer, type MockServer } from "../mock-server.ts";
import { startStaticServer } from "../static-server.ts";

const extensionPath = fileURLToPath(new URL("../../apps/extension/dist", import.meta.url));
const fixturesPath = fileURLToPath(new URL("../fixtures", import.meta.url));

export const API_KEY = "e2e-key";

interface Fixtures {
  /** Playwright 默认带 --disable-back-forward-cache；测往返缓存的用例用 test.use({ bfcache: true }) 打开 */
  bfcache: boolean;
  context: BrowserContext;
  background: Worker;
  extensionId: string;
  /** 模拟模型服务，每个用例一个 */
  mock: MockServer;
  /** 测试页面所在的地址（插件已就绪） */
  site: string;
}

// 每个用例一个干净的持久化上下文，加载 dist 里的插件，并把服务地址和密钥指向模拟服务
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
  mock: async ({ background }, use) => {
    const mock = await startMockServer({ apiKey: API_KEY });
    await background.evaluate((s) => chrome.storage.local.set(s), { endpoint: mock.url, apiKey: API_KEY });
    await use(mock);
    await mock.close();
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
