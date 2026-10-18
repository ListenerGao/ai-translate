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

const icon = (page: Page) => page.locator("ait-selection .icon");
const bubble = (page: Page) => page.locator("ait-selection .bubble");

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
    await expect(bubble(page).locator(".text")).toHaveText("翻译中…");
    await expect(bubble(page).locator(".text")).toHaveText(`【译】${text}`);
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
      await expect(bubble(page)).toBeVisible();
    };
    await open();
    await page.keyboard.press("Escape");
    await expect(bubble(page)).toBeHidden();
    await open();
    await page.mouse.click(5, 500);
    await expect(bubble(page)).toBeHidden();
    await open();
    await page.mouse.wheel(0, 400);
    await expect(bubble(page)).toBeHidden();
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
    await expect(bubble(page).locator(".text")).toHaveText(/^【译】Paragraph 6:/);
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

  test("7 网页自己的样式改不了图标和气泡的外观", async ({ context, site }) => {
    const page = await context.newPage();
    await page.goto(`${site}/selection.html`);
    await select(page, "#p1");
    const iconStyle = await icon(page).evaluate((el) => {
      const s = getComputedStyle(el);
      return { color: s.color, background: s.backgroundColor, fontSize: s.fontSize };
    });
    expect(iconStyle).toEqual({ color: "rgb(255, 255, 255)", background: "rgb(39, 83, 200)", fontSize: "13px" });
    await icon(page).click();
    const bubbleStyle = await bubble(page).evaluate((el) => {
      const s = getComputedStyle(el);
      return { color: s.color, fontSize: s.fontSize };
    });
    expect(bubbleStyle).toEqual({ color: "rgb(243, 245, 249)", fontSize: "14px" });
  });
});
