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

test("弹窗：语言、模型状态、翻译开关、显示方式立即生效、按网站设置", async ({ context, background, extensionId, mock, site }) => {
  const page = await context.newPage();
  await page.goto(`${site}/long-article.html`);
  const tabId = await tabIdOf(background, page.url());
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html?tab=${tabId}`);

  await expect(popup.locator("#toggle-label")).toHaveText("翻译");
  await expect(popup.locator("#source-label")).toHaveText("英语 (English)");
  await expect(popup.locator("#source-sub")).toHaveText("自动检测");
  await expect(popup.locator("#target-label")).toHaveText("简体中文 (Simplified Chinese)");
  await expect(popup.locator("#status")).toHaveText("运行中");
  await expect(popup.locator("#detect")).toContainText("英文文章");
  await expect(popup.locator("#site-rule")).toHaveValue("auto");

  // 翻译开关
  await popup.click("#toggle");
  await expect(popup.locator("#toggle-label")).toHaveText("还原");
  await settle(mock, page);
  expect(await translatedIds(page)).toContain("p1");

  // 显示方式：切到仅译文，已出的译文立即生效；再切回双语对照
  await popup.click("#mode");
  await expect(popup.locator("#mode-tip-text")).toContainText("当前为仅译文");
  expect(await background.evaluate(() => chrome.storage.local.get("displayMode"))).toEqual({ displayMode: "translation-only" });
  await expect(page.locator("#p1")).toHaveClass(/ait-only/);
  await popup.click("#mode");
  await expect(popup.locator("#mode-tip-text")).toContainText("当前为双语对照");
  await expect(page.locator("#p1")).not.toHaveClass(/ait-only/);

  // 选「从不翻译」：记下规则，当前页面跟着还原；改回「自动」规则删掉
  await popup.selectOption("#site-rule", "never");
  await expect(popup.locator("#toggle-label")).toHaveText("翻译");
  expect(await background.evaluate(() => chrome.storage.local.get("siteRules"))).toEqual({ siteRules: { [HOST]: "never" } });
  await expect(page.locator("ait-translation")).toHaveCount(0);
  await popup.selectOption("#site-rule", "auto");
  await expect.poll(() => background.evaluate(() => chrome.storage.local.get("siteRules"))).toEqual({ siteRules: {} });

  // 改目标语言
  await popup.selectOption("#target", "ja");
  await expect(popup.locator("#target-label")).toHaveText("日语 (日本語)");
  expect(await background.evaluate(() => chrome.storage.local.get("target"))).toEqual({ target: "ja" });
});
