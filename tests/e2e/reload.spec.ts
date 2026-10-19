// 插件重新加载（开发时点「重新加载」、商店自动更新）或停用后，网页里旧的 content script 还在跑，但已经不能再调 chrome.*。
// 旧脚本要自己停掉：不报「Extension context invalidated」，还原页面，不再出划词工具条。
// 注：Playwright 里重新加载后插件不会自己回来，这里测的是「旧脚本失效后」这一半；新脚本由后台的补注入负责。
import { expect, test, toggle } from "./fixtures.ts";

test("插件重新加载后：旧脚本不报错、还原页面、不再出划词工具条", async ({ context, background, mock, site }) => {
  const page = await context.newPage();
  await page.goto(`${site}/long-article.html`);
  // 网页里所有脚本（包括插件的 content script）抛出的未捕获错误
  const errors: string[] = [];
  const cdp = await context.newCDPSession(page);
  cdp.on("Runtime.exceptionThrown", (e) => errors.push(e.exceptionDetails.exception?.description ?? e.exceptionDetails.text));
  await cdp.send("Runtime.enable");

  await toggle(background, page);
  await expect(page.locator("ait-translation").first()).toBeVisible();
  await expect.poll(() => mock.inflight()).toBe(0);

  await background.evaluate(() => setTimeout(() => chrome.runtime.reload(), 50));
  // 旧脚本和后台的连接断开，发现插件已失效：还原页面
  await expect(page.locator("ait-translation")).toHaveCount(0);

  // 单页应用换地址：旧脚本的换地址检测原来会去读设置并报错
  await page.evaluate(() => history.pushState(null, "", "?next"));
  await page.waitForTimeout(1500);

  // 划词：旧脚本不再出工具条
  await page.evaluate(() => {
    const range = document.createRange();
    range.selectNodeContents(document.querySelector("#p2")!.firstChild!);
    getSelection()!.removeAllRanges();
    getSelection()!.addRange(range);
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  });
  await page.waitForTimeout(400);
  await expect(page.locator("ait-selection .tools:not([hidden])")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("新脚本的接管通知：插件还在时网页发了也没用；插件失效后收到就立刻停掉", async ({ context, background, mock, site }) => {
  const page = await context.newPage();
  await page.goto(`${site}/long-article.html`);
  await toggle(background, page);
  await expect(page.locator("ait-translation").first()).toBeVisible();
  await expect.poll(() => mock.inflight()).toBe(0);

  // 网页自己发通知：插件还在，不理会
  await page.evaluate(() => document.dispatchEvent(new Event("ait-retire")));
  await page.waitForTimeout(300);
  expect(await page.locator("ait-translation").count()).toBeGreaterThan(0);

  // 在插件脚本自己的 JS 环境里等它失效，失效后同一时刻发通知：译文应当立刻被还原，不用等每秒一次的检查
  const cdp = await context.newCDPSession(page);
  let world = 0;
  cdp.on("Runtime.executionContextCreated", (e) => {
    if (e.context.name === "AI Translate") world = e.context.id;
  });
  await cdp.send("Runtime.enable");
  expect(world).toBeGreaterThan(0);
  await background.evaluate(() => setTimeout(() => chrome.runtime.reload(), 50));
  const { result } = await cdp.send("Runtime.evaluate", {
    contextId: world,
    awaitPromise: true,
    returnByValue: true,
    expression: `new Promise((resolve) => {
      const tick = () => {
        if (chrome.runtime?.id !== undefined) return void setTimeout(tick, 0);
        const before = document.querySelectorAll("ait-translation").length;
        document.dispatchEvent(new Event("ait-retire"));
        resolve([before, document.querySelectorAll("ait-translation").length]);
      };
      tick();
    })`,
  });
  const [before, after] = result.value as [number, number];
  // 极少数情况下每秒一次的检查恰好先一步停掉了旧脚本（before 为 0），这时只能确认结果
  if (before === 0) test.info().annotations.push({ type: "note", description: "每秒检查先一步停掉了旧脚本" });
  expect(after).toBe(0);
});
