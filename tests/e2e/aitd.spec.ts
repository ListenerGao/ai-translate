// Goal 4 CP4：插件改连 aitd，编号对应施工清单 CP4 的 e2e 用例 2~5（用例 1 是原有用例原样通过）
import type { Page, Worker } from "@playwright/test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startAitd } from "../../apps/server/src/app.ts";
import { ManagedModel } from "../../apps/server/src/model.ts";
import { API_KEY, expect, test, toggle, translatedIds } from "./fixtures.ts";

const FAKE_LLAMA = fileURLToPath(new URL("../fake-llama-server.sh", import.meta.url));

const banner = (page: Page) => page.evaluate(() => document.querySelector("ait-banner")?.shadowRoot?.querySelector(".msg")?.textContent ?? "");
const tabIdOf = (background: Worker, url: string) =>
  background.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url === u)!.id!, url);

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

test("2 aitd 没启动：整页提示「本机翻译服务没启动」；启动 aitd 后自动接着翻，提示消失", async ({ context, background, aitd, mock, site }) => {
  await aitd.stop();
  const page = await context.newPage();
  await page.goto(`${site}/long-article.html`);
  await toggle(background, page);
  await expect.poll(() => banner(page)).toContain("本机翻译服务没启动");
  expect(await banner(page)).toContain("scripts/aitd-service.sh install");
  expect(mock.requests).toHaveLength(0);

  await aitd.start();
  await expect.poll(async () => (await translatedIds(page)).length, { timeout: 15_000 }).toBeGreaterThan(0);
  expect(await banner(page)).toBe("");
});

test("3 模型已休眠：弹窗显示「已休眠」；开启翻译后模型自动启动、出译文，弹窗显示「运行中」", async ({ context, background, extensionId, site }) => {
  // 单独起一个自己管模型的 aitd，模型用假的 llama-server，一开始是停着的
  const home = mkdtempSync(join(tmpdir(), "ait-e2e-managed-"));
  mkdirSync(join(home, "models"));
  writeFileSync(join(home, "models", "model.gguf"), "");
  const model = new ManagedModel({ command: FAKE_LLAMA, modelFile: join(home, "models", "model.gguf"), quant: "Q8_0", port: await freePort(), runDir: join(home, "run"), pollMs: 20 });
  const server = await startAitd({ port: 0, apiKey: API_KEY, home, model, version: "e2e" });
  try {
    await background.evaluate((s) => chrome.storage.local.set(s), { endpoint: server.url, apiKey: API_KEY });
    const page = await context.newPage();
    await page.goto(`${site}/long-article.html`);
    const popupUrl = `chrome-extension://${extensionId}/popup.html?tab=${await tabIdOf(background, page.url())}`;
    const popup = await context.newPage();
    await popup.goto(popupUrl);
    await expect(popup.locator("#status")).toHaveText("已休眠");
    await expect(popup.locator("#model-name")).toHaveText("Index-Translate-2B · Q8_0");

    await popup.click("#toggle");
    await expect.poll(async () => (await translatedIds(page)).length, { timeout: 15_000 }).toBeGreaterThan(0);
    await popup.goto(popupUrl);
    await expect(popup.locator("#status")).toHaveText("运行中");
  } finally {
    await server.close();
    await model.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("4 设置页的术语表读写 aitd；插件里的旧术语表第一次连上时搬过去（写错的行不搬）", async ({ context, background, extensionId, aitd, mock }) => {
  void mock;
  await background.evaluate(() => chrome.storage.local.set({ glossaryText: "kubelet=节点代理\nno equals here" }));
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options.html`);
  await expect(page.locator("#glossary")).toHaveValue("kubelet=节点代理");
  expect(readFileSync(join(aitd.home, "glossary.txt"), "utf8")).toBe("kubelet=节点代理");
  expect(await background.evaluate(() => chrome.storage.local.get("glossaryText"))).toEqual({ glossaryText: "" });

  await page.fill("#glossary", "kubelet=节点代理\nmockup=原型图");
  await page.click("button[type=submit]");
  await expect(page.locator("#status")).toHaveText("已保存");
  expect(readFileSync(join(aitd.home, "glossary.txt"), "utf8")).toBe("kubelet=节点代理\nmockup=原型图");
  await page.reload();
  await expect(page.locator("#glossary")).toHaveValue("kubelet=节点代理\nmockup=原型图");
});

test("5 命令行批量翻译 50 段的同时滑动翻译：视口内的段落照样先出译文", async ({ context, background, aitd, mock, site }) => {
  mock.setDelay(150);
  // 用 HTTP 直接发 batch 请求，模拟命令行
  const segments = Array.from({ length: 50 }, (_, i) => ({ id: `c${i}`, text: `Command line paragraph number ${i} for the batch.` }));
  const batch = fetch(`${aitd.url}/api/translate`, {
    method: "POST",
    headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ segments, target: "zh", model: "index-translate-2b", lane: "batch" }),
  }).then((r) => r.text());
  // batch 最多占 3 路，第 4 路留给插件
  await expect.poll(() => mock.inflight()).toBe(3);

  const page = await context.newPage();
  await page.goto(`${site}/long-article.html`);
  await toggle(background, page);
  // 屏幕内和下方一屏的段落都出了译文
  await page.waitForFunction(() => document.querySelectorAll('ait-translation[data-state="done"]').length > 0 && !document.querySelector('ait-translation[data-state="pending"]'), null, { timeout: 15_000 });
  const batchDone = mock.requests.filter((r) => r.source.startsWith("Command line")).length;
  // 要是排在命令行后面，得等 50 段全翻完；插件优先时，页面翻完那一刻命令行还剩一大半
  expect(batchDone).toBeLessThan(35);
  expect((await batch).split("\n").filter((l) => l !== "")).toHaveLength(50);
});
