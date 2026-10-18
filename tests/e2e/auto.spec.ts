// Goal 3 CP2：英文文章页自动开启、按网站规则、工具栏弹窗，用例编号对应施工清单
import type { Worker } from "@playwright/test";
import { expect, settle, test, toggle, translatedIds } from "./fixtures.ts";

const HOST = "127.0.0.1";
/** 自动开启的检测有一次 2 秒后的重试，等够这么久才能断言「没开启」 */
const DETECT_WINDOW_MS = 3000;

const settings = (background: Worker, values: Record<string, unknown>) =>
  background.evaluate((v) => chrome.storage.local.set(v), values);

const tabIdOf = (background: Worker, url: string) =>
  background.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url === u)!.id!, url);

test.describe("英文文章页自动开启", () => {
  test("1 英文文章页：打开后自动开始翻译，图标出现角标", async ({ context, background, mock, site }) => {
    await settings(background, { autoTranslate: true });
    const page = await context.newPage();
    await page.goto(`${site}/long-article.html`);
    await expect.poll(() => mock.requests.length).toBeGreaterThan(0);
    await settle(mock, page);
    expect(await translatedIds(page)).toContain("p1");
    const tabId = await tabIdOf(background, page.url());
    expect(await background.evaluate((id) => chrome.action.getBadgeText({ tabId: id }), tabId)).toBe("译");
  });

  test("2 英文非文章页、中文文章页：不自动开启，模拟服务收不到请求", async ({ context, background, mock, site }) => {
    await settings(background, { autoTranslate: true });
    const page = await context.newPage();
    await page.goto(`${site}/link-list.html`);
    await page.waitForTimeout(DETECT_WINDOW_MS);
    await page.goto(`${site}/zh-article.html`);
    await page.waitForTimeout(DETECT_WINDOW_MS);
    expect(mock.requests).toHaveLength(0);
  });

  test("3 设成「从不翻译」的网站：文章页也不开；手动仍能开", async ({ context, background, mock, site }) => {
    await settings(background, { autoTranslate: true, siteRules: { [HOST]: "never" } });
    const page = await context.newPage();
    await page.goto(`${site}/long-article.html`);
    await page.waitForTimeout(DETECT_WINDOW_MS);
    expect(mock.requests).toHaveLength(0);
    expect(await toggle(background, page)).toBe(true);
    await expect.poll(() => mock.requests.length).toBeGreaterThan(0);
  });

  test("4 设成「总是翻译」的网站：非文章页也开", async ({ context, background, mock, site }) => {
    await settings(background, { autoTranslate: true, siteRules: { [HOST]: "always" } });
    const page = await context.newPage();
    await page.goto(`${site}/link-list.html`);
    await expect.poll(() => mock.requests.length).toBeGreaterThan(0);
    await settle(mock, page);
    expect(await translatedIds(page)).toContain("item-1");
  });

  test("5 单页应用切到新的英文文章：重新检测并开启", async ({ context, background, mock, site }) => {
    await settings(background, { autoTranslate: true });
    const page = await context.newPage();
    await page.goto(`${site}/spa.html`);
    await page.waitForTimeout(DETECT_WINDOW_MS);
    expect(mock.requests).toHaveLength(0);
    await page.evaluate(() => (window as unknown as { goArticle(): void }).goArticle());
    await expect.poll(() => mock.requests.length, { timeout: 10_000 }).toBeGreaterThan(0);
    await settle(mock, page);
    expect(await translatedIds(page)).toContain("spa-p1");
  });

  test("6 设置里关掉自动翻译：都不自动开启（「总是翻译」的网站也不开）", async ({ context, background, mock, site }) => {
    await settings(background, { autoTranslate: false, siteRules: { [HOST]: "always" } });
    const page = await context.newPage();
    await page.goto(`${site}/long-article.html`);
    await page.waitForTimeout(DETECT_WINDOW_MS);
    expect(mock.requests).toHaveLength(0);
  });
});

test("弹窗：显示状态和检测结果，切换翻译，按网站设置跟着生效", async ({ context, background, extensionId, mock, site }) => {
  const page = await context.newPage();
  await page.goto(`${site}/long-article.html`);
  const tabId = await tabIdOf(background, page.url());
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html?tab=${tabId}`);

  await expect(popup.locator("#state")).toHaveText("这个页面未翻译");
  await expect(popup.locator("#detect")).toContainText("英文文章");
  await expect(popup.locator("#host")).toHaveText(HOST);
  await expect(popup.locator("#rule-auto")).toBeChecked();

  await popup.click("#toggle");
  await expect(popup.locator("#state")).toHaveText("正在翻译这个页面");
  await settle(mock, page);
  expect(await translatedIds(page)).toContain("p1");

  // 选「从不翻译」：记下规则，当前页面跟着还原
  await popup.check("#rule-never");
  await expect(popup.locator("#state")).toHaveText("这个页面未翻译");
  expect(await background.evaluate(() => chrome.storage.local.get("siteRules"))).toEqual({ siteRules: { [HOST]: "never" } });
  await expect(page.locator("ait-translation")).toHaveCount(0);

  // 改回「自动」：规则删掉
  await popup.check("#rule-auto");
  await expect.poll(() => background.evaluate(() => chrome.storage.local.get("siteRules"))).toEqual({ siteRules: {} });
});
