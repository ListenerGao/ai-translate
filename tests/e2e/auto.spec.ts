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
    // 自动开启时右下角有提示，可以还原或让这个网站不再自动翻译
    await expect(page.locator("ait-notice .msg")).toHaveText("已自动翻译这个页面");
  });

  test("2 英文非文章页、中文文章页、夹着代码和英文段落的中文文档：不自动开启，模拟服务收不到请求", async ({ context, background, mock, site }) => {
    await settings(background, { autoTranslate: true });
    const page = await context.newPage();
    for (const name of ["link-list.html", "zh-article.html", "zh-doc-with-code.html"]) {
      await page.goto(`${site}/${name}`);
      await page.waitForTimeout(DETECT_WINDOW_MS);
      await expect(page.locator("ait-notice")).toHaveCount(0);
    }
    expect(mock.requests).toHaveLength(0);
    // 手动开启时只翻英文段落，等宽字体的代码行不翻
    expect(await toggle(background, page)).toBe(true);
    await settle(mock, page);
    expect(mock.requests.length).toBeGreaterThan(0);
    expect(mock.requests.some((r) => r.source.includes("budgetId"))).toBe(false);
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

  test("7 自动开启的提示点「这个网站不再自动翻译」：还原页面、记下规则，再打开也不翻", async ({ context, background, mock, site }) => {
    await settings(background, { autoTranslate: true });
    const page = await context.newPage();
    await page.goto(`${site}/long-article.html`);
    await settle(mock, page);
    expect(await translatedIds(page)).toContain("p1");
    await page.locator("ait-notice button", { hasText: "这个网站不再自动翻译" }).click();
    await expect(page.locator("ait-translation")).toHaveCount(0);
    await expect(page.locator("ait-notice .msg")).toContainText("以后不再自动翻译");
    await expect.poll(() => background.evaluate(() => chrome.storage.local.get("siteRules"))).toEqual({ siteRules: { [HOST]: "never" } });
    const tabId = await tabIdOf(background, page.url());
    await expect.poll(() => background.evaluate((id) => chrome.action.getBadgeText({ tabId: id }), tabId)).toBe("");

    mock.requests.length = 0;
    await page.reload();
    await page.waitForTimeout(DETECT_WINDOW_MS);
    expect(mock.requests).toHaveLength(0);
    await expect(page.locator("ait-notice")).toHaveCount(0);
  });

  test("8 自动开启的提示点「还原」：只还原这一页，不记规则", async ({ context, background, mock, site }) => {
    await settings(background, { autoTranslate: true });
    const page = await context.newPage();
    await page.goto(`${site}/long-article.html`);
    await settle(mock, page);
    await page.locator("ait-notice button", { hasText: "还原" }).click();
    await expect(page.locator("ait-translation")).toHaveCount(0);
    await expect(page.locator("ait-notice")).toHaveCount(0);
    expect(await background.evaluate(() => chrome.storage.local.get("siteRules"))).toEqual({});
    await expect.poll(() => background.evaluate(() => chrome.storage.local.get("siteHabits"))).toEqual({ siteHabits: { [HOST]: { off: 1 } } });
  });

  test("9 文档站文章页，收起的侧边目录里有几百个没显示的链接：照样自动开启", async ({ context, background, mock, site }) => {
    await settings(background, { autoTranslate: true });
    const page = await context.newPage();
    await page.goto(`${site}/doc-collapsed-nav.html`);
    await expect.poll(() => mock.requests.length).toBeGreaterThan(0);
    await settle(mock, page);
    expect(await translatedIds(page)).toContain("p1");
  });

  test("10 英文短文档够不上文章：不自动翻译，但问一句；点「翻译」就翻这一页，记一次手动开启", async ({ context, background, mock, site }) => {
    await settings(background, { autoTranslate: true });
    const page = await context.newPage();
    await page.goto(`${site}/short-doc.html`);
    await expect(page.locator("ait-notice .msg")).toHaveText("这个页面是英文，要翻译吗？");
    expect(mock.requests).toHaveLength(0);
    await page.locator("ait-notice button", { hasText: /^翻译$/ }).click();
    await settle(mock, page);
    expect(await translatedIds(page)).toContain("p1");
    await expect(page.locator("ait-notice")).toHaveCount(0);
    const tabId = await tabIdOf(background, page.url());
    await expect.poll(() => background.evaluate((id) => chrome.action.getBadgeText({ tabId: id }), tabId)).toBe("译");
    await expect.poll(() => background.evaluate(() => chrome.storage.local.get(["siteRules", "siteHabits"]))).toEqual({ siteHabits: { [HOST]: { on: 1, asked: 0 } } });
  });

  test("11 询问连续两次没理会（点 ×）：这个网站不再问", async ({ context, background, mock, site }) => {
    await settings(background, { autoTranslate: true });
    const page = await context.newPage();
    for (let i = 1; i <= 2; i++) {
      await page.goto(`${site}/short-doc.html`);
      await page.locator("ait-notice .close").click();
      await expect.poll(() => background.evaluate(() => chrome.storage.local.get("siteHabits"))).toEqual({ siteHabits: { [HOST]: { asked: i } } });
    }
    await page.goto(`${site}/short-doc.html`);
    await page.waitForTimeout(DETECT_WINDOW_MS);
    await expect(page.locator("ait-notice")).toHaveCount(0);
    expect(mock.requests).toHaveLength(0);
  });

  test("12 询问点「这个网站总是翻译」：记下规则并翻译，再打开直接翻", async ({ context, background, mock, site }) => {
    await settings(background, { autoTranslate: true });
    const page = await context.newPage();
    await page.goto(`${site}/short-doc.html`);
    await page.locator("ait-notice button", { hasText: "这个网站总是翻译" }).click();
    await settle(mock, page);
    expect(await translatedIds(page)).toContain("p1");
    await expect.poll(() => background.evaluate(() => chrome.storage.local.get("siteRules"))).toEqual({ siteRules: { [HOST]: "always" } });
    mock.requests.length = 0;
    await page.goto(`${site}/link-list.html`);
    await expect.poll(() => mock.requests.length).toBeGreaterThan(0);
  });

  test("13 同一网站手动开了两次：设成「总是翻译」并提示；同一页反复开关只记一次；可以撤回", async ({ context, background, mock, site }) => {
    await settings(background, { autoTranslate: true });
    const page = await context.newPage();
    await page.goto(`${site}/link-list.html`);
    expect(await toggle(background, page)).toBe(true);
    expect(await toggle(background, page)).toBe(false);
    expect(await toggle(background, page)).toBe(true);
    await expect.poll(() => background.evaluate(() => chrome.storage.local.get(["siteRules", "siteHabits"]))).toEqual({ siteHabits: { [HOST]: { on: 1, asked: 0 } } });
    await expect(page.locator("ait-notice")).toHaveCount(0);

    await page.goto(`${site}/zh-doc-with-code.html`);
    expect(await toggle(background, page)).toBe(true);
    await expect(page.locator("ait-notice .msg")).toContainText("以后会自动翻译");
    expect(await background.evaluate(() => chrome.storage.local.get(["siteRules", "siteHabits"]))).toEqual({ siteRules: { [HOST]: "always" }, siteHabits: {} });
    await page.locator("ait-notice button", { hasText: "撤回" }).click();
    await expect(page.locator("ait-notice")).toHaveCount(0);
    expect(await background.evaluate(() => chrome.storage.local.get("siteRules"))).toEqual({ siteRules: {} });
  });

  test("14 自动翻译被还原两次：设成「从不翻译」并提示，再打开不翻也不问", async ({ context, background, mock, site }) => {
    await settings(background, { autoTranslate: true });
    const page = await context.newPage();
    await page.goto(`${site}/long-article.html`);
    await settle(mock, page);
    await page.locator("ait-notice button", { hasText: "还原" }).click();
    await expect.poll(() => background.evaluate(() => chrome.storage.local.get("siteHabits"))).toEqual({ siteHabits: { [HOST]: { off: 1 } } });

    // 第二次用弹窗 / 快捷键的开关还原，也算
    await page.reload();
    await settle(mock, page);
    expect(await translatedIds(page)).toContain("p1");
    expect(await toggle(background, page)).toBe(false);
    await expect(page.locator("ait-notice .msg")).toContainText("以后不再自动翻译");
    expect(await background.evaluate(() => chrome.storage.local.get(["siteRules", "siteHabits"]))).toEqual({ siteRules: { [HOST]: "never" }, siteHabits: {} });

    mock.requests.length = 0;
    await page.reload();
    await page.waitForTimeout(DETECT_WINDOW_MS);
    expect(mock.requests).toHaveLength(0);
    await expect(page.locator("ait-notice")).toHaveCount(0);
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

  // 改原文语言、目标语言：只对这个标签页临时生效，不改设置；正在翻译的页面按新语言重翻
  await popup.click("#toggle");
  await expect(popup.locator("#toggle-label")).toHaveText("还原");
  await settle(mock, page);
  mock.requests.length = 0;
  await popup.selectOption("#target", "ja");
  await expect(popup.locator("#target-label")).toHaveText("日语 (日本語)");
  await expect(popup.locator("#target-sub")).toHaveText("仅本页临时");
  await expect(popup.locator("#toggle-label")).toHaveText("还原");
  await expect.poll(() => mock.requests.length).toBeGreaterThan(0);
  expect(mock.requests.every((r) => r.prompt.includes("翻译为日语"))).toBe(true);
  await popup.selectOption("#source", "fr");
  await expect(popup.locator("#source-label")).toHaveText("法语 (Français)");
  await expect(popup.locator("#source-sub")).toHaveText("仅本页临时");
  expect(await background.evaluate(() => chrome.storage.local.get(["source", "target"]))).toEqual({}); // 没写进设置
  // 重新打开弹窗：显示这个标签页临时用的语言
  await popup.reload();
  await expect(popup.locator("#source-label")).toHaveText("法语 (Français)");
  await expect(popup.locator("#target-label")).toHaveText("日语 (日本語)");
  // 刷新页面：回到默认（原文自动检测、目标用设置里的）
  await page.reload();
  await popup.reload();
  await expect(popup.locator("#source-sub")).toHaveText("自动检测");
  await expect(popup.locator("#target-label")).toHaveText("简体中文 (Simplified Chinese)");
  await expect(popup.locator("#target-sub")).toHaveText("目标语言");
});
