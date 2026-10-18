// Goal 1 CP5：滑动翻译 e2e，用例编号对应施工清单
import { API_KEY, expect, requestedSources, settle, test, toggle, translatedIds } from "./fixtures.ts";

const blocks = (page: import("@playwright/test").Page) =>
  page.$$eval("[data-ait-id]", (els) =>
    els.map((el) => ({
      id: el.id,
      text: (el.firstChild?.textContent ?? "").trim(),
      top: el.getBoundingClientRect().top,
    })),
  );

test("1 没开启翻译时滚动页面，不发任何请求", async ({ context, mock, site }) => {
  const page = await context.newPage();
  await page.goto(`${site}/long-article.html`);
  await page.mouse.wheel(0, 4000);
  await page.waitForTimeout(300);
  await page.mouse.wheel(0, -4000);
  await page.waitForTimeout(800);
  expect(mock.requests).toHaveLength(0);
  expect(await page.locator("ait-translation").count()).toBe(0);
});

test("2、5 开启后只翻视口和下方 1 屏；代码、导航、页脚、中文段落不翻", async ({ context, background, mock, site }) => {
  const page = await context.newPage();
  await page.goto(`${site}/long-article.html`);
  // 开启前量位置：译文插入后段落会被往下推，范围外还没开始的段落随后会被撤销
  const viewport = page.viewportSize()!.height;
  const before = await page.$$eval("#title, #article > p:not(#zh)", (els) =>
    els.map((el) => ({ text: (el.textContent ?? "").trim(), top: el.getBoundingClientRect().top })),
  );
  const inZone = new Set(before.filter((b) => b.top < viewport * 2).map((b) => b.text));
  const inViewport = before.filter((b) => b.top < viewport).map((b) => b.text);

  expect(await toggle(background, page)).toBe(true);
  await settle(mock, page);

  const requested = requestedSources(mock);
  expect(requested.filter((s) => !inZone.has(s))).toEqual([]);
  for (const text of inViewport) expect(requested).toContain(text);
  expect(inViewport.length).toBeGreaterThan(3);
  expect(inZone.size).toBeLessThan(30);

  const done = await translatedIds(page);
  expect(done).toContain("title");
  expect(done).toContain("p1");
  for (const id of ["nav", "code", "zh", "footer"]) {
    expect(await page.locator(`#${id} ait-translation`).count(), id).toBe(0);
  }
  for (const s of requestedSources(mock)) {
    expect(s).not.toMatch(/Home link|npm run build|这是一段|Copyright/);
  }
  expect(mock.maxConcurrent()).toBeLessThanOrEqual(4);
});

test("3 快速滚到底：滑过但没开始的段落被撤销", async ({ context, background, mock, site }) => {
  mock.setDelay(400);
  const page = await context.newPage();
  await page.goto(`${site}/long-article.html`);
  await toggle(background, page);
  await expect.poll(() => mock.requests.length).toBeGreaterThan(0);
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await settle(mock, page);

  const total = (await blocks(page)).length;
  expect(mock.requests.length).toBeLessThan(total * 0.5);
  expect(await translatedIds(page)).toContain("p60");
  // 顶部开头几段已经在翻的照常翻完，没开始的不会再请求
  expect(requestedSources(mock).filter((s) => s.startsWith("Paragraph 9:"))).toHaveLength(0);
});

test("4 回滑和重新开启都命中缓存，翻过的内容不再请求", async ({ context, background, mock, site }) => {
  const page = await context.newPage();
  await page.goto(`${site}/long-article.html`);
  await toggle(background, page);
  await settle(mock, page);
  await page.mouse.wheel(0, 2500);
  await settle(mock, page);
  await page.evaluate(() => window.scrollTo(0, 0));
  await settle(mock, page);

  // 翻过的内容只请求一次：回滑和关闭后重新开启都直接用缓存。
  // 重新开启时页面没有译文、变短了，范围里可能多出当初被推出范围、还没翻过的段落，它们第一次请求是正常的
  const duplicates = () => {
    const counts = new Map<string, number>();
    for (const s of requestedSources(mock)) counts.set(s, (counts.get(s) ?? 0) + 1);
    return [...counts].filter(([, n]) => n > 1).map(([s]) => s);
  };
  expect(duplicates()).toEqual([]);

  expect(await toggle(background, page)).toBe(false);
  expect(await toggle(background, page)).toBe(true);
  await settle(mock, page);
  expect(duplicates()).toEqual([]);
  expect(await translatedIds(page)).toContain("p1");
});

test("6 无限滚动追加的段落进入范围后被翻译", async ({ context, background, mock, site }) => {
  const page = await context.newPage();
  await page.goto(`${site}/infinite-scroll.html`);
  await toggle(background, page);
  await settle(mock, page);
  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(300);
  }
  await settle(mock, page);
  const done = await translatedIds(page);
  expect(done.some((id) => id.startsWith("more"))).toBe(true);
  expect(requestedSources(mock).some((s) => s.startsWith("Feed item more"))).toBe(true);
});

test("7 关闭并还原：页面 DOM 和开启前一致", async ({ context, background, mock, site }) => {
  const page = await context.newPage();
  await page.goto(`${site}/long-article.html`);
  const original = await page.evaluate(() => document.documentElement.outerHTML);
  await toggle(background, page);
  await settle(mock, page);
  expect((await translatedIds(page)).length).toBeGreaterThan(0);

  mock.setDelay(1000); // 关闭时还有在途请求，迟到的译文不能插回页面
  await page.mouse.wheel(0, 3000);
  await expect.poll(() => mock.inflight()).toBeGreaterThan(0);
  expect(await toggle(background, page)).toBe(false);
  await settle(mock, page);
  await page.evaluate(() => window.scrollTo(0, 0));

  expect(await page.evaluate(() => document.documentElement.outerHTML)).toBe(original);
});

test("8 密钥不对：页面提示「密钥不对」；改对后自动重新翻译", async ({ context, background, mock, site }) => {
  await background.evaluate(() => chrome.storage.local.set({ apiKey: "wrong-key" }));
  const page = await context.newPage();
  await page.goto(`${site}/long-article.html`);
  await toggle(background, page);
  await settle(mock, page);

  const banner = () => page.evaluate(() => document.querySelector("ait-banner")?.shadowRoot?.querySelector(".msg")?.textContent ?? "");
  expect(await banner()).toContain("密钥不对");
  expect(await translatedIds(page)).toHaveLength(0);

  await background.evaluate((key) => chrome.storage.local.set({ apiKey: key }), API_KEY);
  await expect.poll(async () => (await translatedIds(page)).length).toBeGreaterThan(5);
  expect(await banner()).toBe("");
});

test.describe("往返缓存", () => {
  test.use({ bfcache: true });

test("12 离开页面再后退（往返缓存恢复）后继续滚动，仍能翻译", async ({ context, background, mock, site }) => {
  const page = await context.newPage();
  await page.goto(`${site}/long-article.html`);
  await toggle(background, page);
  await settle(mock, page);
  await page.evaluate(() => ((window as unknown as { __marker: number }).__marker = 1));

  await page.goto(`${site}/structures.html`);
  // 从往返缓存恢复不会触发 load 事件，只等导航提交
  await page.goBack({ waitUntil: "commit" });
  await page.waitForTimeout(500);
  // 页面里的 JS 状态还在，说明是从往返缓存恢复的，而不是重新加载
  expect(await page.evaluate(() => (window as unknown as { __marker?: number }).__marker)).toBe(1);

  const before = mock.requests.length;
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await settle(mock, page);
  expect(mock.requests.length).toBeGreaterThan(before);
  expect(await translatedIds(page)).toContain("p60");
});
});

test("9 后台被回收后继续滚动，仍能翻译", async ({ context, background, extensionId, mock, site }) => {
  const page = await context.newPage();
  await page.goto(`${site}/long-article.html`);
  await toggle(background, page);
  await settle(mock, page);
  const origin = await background.evaluate(() => performance.timeOrigin);

  // Playwright 连着后台时它不会空闲休眠（实测等 40 秒也没被回收），这里用调试接口直接停掉，效果等同休眠回收
  const extPage = await context.newPage();
  await extPage.goto(`chrome-extension://${extensionId}/options.html`);
  const cdp = await context.newCDPSession(extPage);
  await cdp.send("ServiceWorker.enable");
  await cdp.send("ServiceWorker.stopAllWorkers");
  await extPage.close();
  await page.bringToFront();
  await page.waitForTimeout(500);

  const before = mock.requests.length;
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await settle(mock, page);

  expect(mock.requests.length).toBeGreaterThan(before);
  expect(await translatedIds(page)).toContain("p60");
  expect(await background.evaluate(() => performance.timeOrigin)).not.toBe(origin);
});
