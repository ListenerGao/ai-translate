// Goal 3 CP1：划词翻译，用例编号对应施工清单
import type { Page } from "@playwright/test";
import { expect, settle, test, toggle } from "./fixtures.ts";

/** 选中元素里的文字（只选第一个文本节点，不含插件插入的译文），再触发 mouseup */
async function select(page: Page, selector: string): Promise<string> {
  return page.evaluate((sel) => {
    const el = document.querySelector<HTMLElement>(sel)!;
    let text = "";
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      el.focus();
      el.select();
      text = el.value;
    } else {
      if (el.isContentEditable) el.focus();
      const range = document.createRange();
      range.selectNodeContents(el.firstChild ?? el);
      const s = getSelection()!;
      s.removeAllRanges();
      s.addRange(range);
      text = s.toString();
    }
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    return text.trim();
  }, selector);
}

const icon = (page: Page) => page.locator("ait-selection .translate");
const speak = (page: Page) => page.locator("ait-selection .speak");
const card = (page: Page) => page.locator("ait-selection .card");

test.describe("划词翻译", () => {
  test("1、2 选中正文出现图标、不点不发请求；点图标先显示「翻译中」再显示译文", async ({ context, mock, site }) => {
    mock.setDelay(400);
    const page = await context.newPage();
    await page.goto(`${site}/selection.html`);
    const text = await select(page, "#p1");
    await expect(icon(page)).toBeVisible();
    await page.waitForTimeout(500);
    expect(mock.requests).toHaveLength(0);

    await icon(page).click();
    await expect(card(page).locator(".text")).toHaveText("翻译中…");
    await expect(card(page).locator(".text")).toHaveText(`【译】${text}`);
    await expect(icon(page)).toBeHidden();
    expect(mock.requests.map((r) => r.source)).toEqual([text]);
  });

  test("3 输入框、文本框、可编辑区域、中文、超过 2000 字符：不出现图标", async ({ context, mock, site }) => {
    const page = await context.newPage();
    await page.goto(`${site}/selection.html`);
    for (const selector of ["#input", "#textarea", "#editable", "#zh", "#long"]) {
      await select(page, selector);
      await page.waitForTimeout(250);
      await expect(icon(page), selector).toBeHidden();
    }
    expect(mock.requests).toHaveLength(0);
  });

  test("4 按 Esc、点别处、滚动页面：气泡关闭", async ({ context, mock, site }) => {
    const page = await context.newPage();
    await page.goto(`${site}/selection.html`);
    const open = async () => {
      await select(page, "#p1");
      await icon(page).click();
      await expect(card(page)).toBeVisible();
    };
    await open();
    await page.keyboard.press("Escape");
    await expect(card(page)).toBeHidden();
    await open();
    await page.mouse.click(5, 500);
    await expect(card(page)).toBeHidden();
    await open();
    await page.mouse.wheel(0, 400);
    await expect(card(page)).toBeHidden();
    await settle(mock, page);
  });

  test("5 滑动翻译正在排队时点划词：划词请求最先发出", async ({ context, background, mock, site }) => {
    mock.setDelay(600);
    const page = await context.newPage();
    await page.goto(`${site}/long-article.html`);
    await toggle(background, page);
    await expect.poll(() => mock.inflight()).toBe(4);
    // 第 6 段在视口内、正在排队；按滑动翻译的顺序，下一个应该是第 4 段
    await select(page, "#p6");
    await icon(page).click();
    const clickedAt = Date.now();
    await expect.poll(() => mock.requests.filter((r) => r.at > clickedAt).length).toBeGreaterThan(0);
    expect(mock.requests.find((r) => r.at > clickedAt)?.source).toMatch(/^Paragraph 6:/);
    await expect(card(page).locator(".text")).toHaveText(/^【译】Paragraph 6:/);
  });

  test("6 设置里关掉划词：不再出现图标", async ({ context, background, site }) => {
    const page = await context.newPage();
    await page.goto(`${site}/selection.html`);
    await background.evaluate(() => chrome.storage.local.set({ selectionEnabled: false }));
    await page.waitForTimeout(300);
    await select(page, "#p1");
    await page.waitForTimeout(300);
    await expect(icon(page)).toBeHidden();
  });

  test("8 选中后旁边还有朗读图标：不用先翻译，点了读原文、不发翻译请求，再点停止", async ({ context, mock, site }) => {
    const page = await context.newPage();
    await page.goto(`${site}/selection.html`);
    await select(page, "#p2");
    await expect(speak(page)).toBeVisible();
    await speak(page).click();
    // 用的是本机语音：按钮标题写明语音名
    await expect(speak(page)).toHaveAttribute("title", /^朗读原文（.+）$/);
    await expect(speak(page)).toHaveAttribute("aria-pressed", "true");
    await speak(page).click();
    await expect(speak(page)).toHaveAttribute("aria-pressed", "false");
    await expect(card(page)).toBeHidden();
    expect(mock.requests).toHaveLength(0);
  });

  test("9 朗读中点别处：朗读停止；按 Esc：图标收起", async ({ context, site }) => {
    const page = await context.newPage();
    await page.goto(`${site}/selection.html`);
    await select(page, "#p2");
    await speak(page).click();
    await expect(speak(page)).toHaveAttribute("aria-pressed", "true");
    // 在网页别处按下鼠标就停止朗读
    await page.click("#zh");
    await expect(speak(page)).toHaveAttribute("aria-pressed", "false");
    await page.keyboard.press("Escape");
    await expect(speak(page)).toBeHidden();
  });

  test("7 网页自己的样式改不了工具条和翻译卡片的外观", async ({ context, mock, site }) => {
    void mock;
    const page = await context.newPage();
    await page.goto(`${site}/selection.html`);
    await select(page, "#p1");
    // 两个图标在同一条蓝色工具条里，图标是白色
    const toolsStyle = await page.locator("ait-selection .tools").evaluate((el) => {
      const s = getComputedStyle(el);
      const icons = [...el.querySelectorAll(".icon")].map((b) => getComputedStyle(b).color);
      return { background: s.backgroundColor, display: s.display, icons };
    });
    expect(toolsStyle).toEqual({ background: "rgb(39, 83, 200)", display: "flex", icons: ["rgb(255, 255, 255)", "rgb(255, 255, 255)"] });
    await icon(page).click();
    await expect(card(page).locator(".text")).toHaveAttribute("data-state", "done");
    const cardStyle = await card(page).evaluate((el) => {
      const text = getComputedStyle(el.querySelector(".text")!);
      return { background: getComputedStyle(el).backgroundColor, color: text.color, fontSize: text.fontSize };
    });
    expect(cardStyle).toEqual({ background: "rgb(255, 255, 255)", color: "rgb(17, 24, 39)", fontSize: "15px" });
  });

  test("10 翻译卡片显示原文；改目标语言就用新语言重翻，下拉显示新语言", async ({ context, mock, site }) => {
    const page = await context.newPage();
    await page.goto(`${site}/selection.html`);
    const text = await select(page, "#p1");
    await icon(page).click();
    await expect(card(page).locator(".source-text")).toHaveText(text);
    await expect(card(page).locator(".text")).toHaveText(`【译】${text}`);
    await expect(card(page).locator(".lang-name")).toHaveText("简体中文");
    await card(page).locator("select.target").selectOption("ja");
    await expect(card(page).locator(".lang-name")).toHaveText("日语");
    await expect.poll(() => mock.requests.length).toBe(2);
    expect(mock.requests[1]!.prompt).toContain("翻译为日语");
    await expect(card(page).locator(".text")).toHaveText(`【译】${text}`);
  });

  test("11 固定后点别处、滚动页面都不关，新划的词原地换内容；按 Esc 或点关闭才关", async ({ context, mock, site }) => {
    const page = await context.newPage();
    await page.goto(`${site}/selection.html`);
    await select(page, "#p1");
    await icon(page).click();
    const pin = card(page).locator(".pin");
    await pin.click();
    await expect(pin).toHaveAttribute("aria-pressed", "true");
    await page.mouse.click(5, 500);
    await page.mouse.wheel(0, 200);
    await page.waitForTimeout(300);
    await expect(card(page)).toBeVisible();

    const before = await card(page).boundingBox();
    const second = await select(page, "#p2");
    await icon(page).click();
    await expect(card(page).locator(".source-text")).toHaveText(second);
    await expect(card(page).locator(".text")).toHaveText(`【译】${second}`);
    expect((await card(page).boundingBox())?.y).toBe(before?.y);

    await page.keyboard.press("Escape");
    await expect(card(page)).toBeHidden();
    // 这时 #p1 已经滚到屏幕上方：卡片仍要整个显示在屏幕内
    await select(page, "#p1");
    await icon(page).click();
    const box = (await card(page).boundingBox())!;
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(page.viewportSize()!.height);
    await expect(pin).toHaveAttribute("aria-pressed", "false");
    await pin.click();
    await card(page).locator(".close").click();
    await expect(card(page)).toBeHidden();
    await settle(mock, page);
  });

  test("12 原文超过两行才出现展开按钮；点了展开，再点收起", async ({ context, mock, site }) => {
    const page = await context.newPage();
    await page.goto(`${site}/selection.html`);
    await select(page, "#p1");
    await icon(page).click();
    await expect(card(page).locator(".source-text")).toBeVisible();
    await expect(card(page).locator(".expand")).toBeHidden();

    await select(page, "#p3");
    await icon(page).click();
    const expand = card(page).locator(".expand");
    await expect(expand).toBeVisible();
    const collapsed = (await card(page).locator(".source-text").boundingBox())!.height;
    await expand.click();
    await expect(expand).toHaveAttribute("aria-expanded", "true");
    expect((await card(page).locator(".source-text").boundingBox())!.height).toBeGreaterThan(collapsed);
    await expand.click();
    await expect(expand).toHaveAttribute("aria-expanded", "false");
    await settle(mock, page);
  });

  test("13 卡片里的喇叭读原文、不发翻译请求；复制把译文放进剪贴板", async ({ context, mock, site }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: site });
    const page = await context.newPage();
    await page.goto(`${site}/selection.html`);
    const text = await select(page, "#p2");
    await icon(page).click();
    await expect(card(page).locator(".text")).toHaveText(`【译】${text}`);

    const read = card(page).locator(".read");
    await read.click();
    await expect(read).toHaveAttribute("title", /^朗读原文（.+）$/);
    await expect(read).toHaveAttribute("aria-pressed", "true");
    await read.click();
    await expect(read).toHaveAttribute("aria-pressed", "false");
    expect(mock.requests).toHaveLength(1);

    await card(page).locator(".copy").click();
    await expect(card(page).locator(".copy")).toHaveAttribute("title", "已复制");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`【译】${text}`);
  });
});
