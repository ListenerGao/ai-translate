// Goal 2 CP3：段内格式保留，用例编号对应施工清单
import { expect, settle, test, toggle } from "./fixtures.ts";

test.describe("段内格式", () => {
  test("1~3 链接能点、加粗和嵌套保留、行内代码原样且不发给模型", async ({ context, background, mock, site }) => {
    const page = await context.newPage();
    await page.goto(`${site}/inline-format.html`);
    await toggle(background, page);
    await settle(mock, page);

    // 1 链接：href 和原文一致；复制品去掉 id，页面上不出现重复 id
    const link = page.locator('#links ait-translation a[href="https://example.com/guide"]');
    await expect(link).toHaveText("setup guide");
    expect(await page.locator("#guide-link").count()).toBe(1);
    // 2 加粗、嵌套
    await expect(page.locator("#links ait-translation strong")).toHaveText("security notes");
    await expect(page.locator('#nested ait-translation em a[href="https://example.com/nested"]')).toHaveText("nested link");
    // 3 行内代码、图片、换行原样出现；代码文字没有发给模型
    await expect(page.locator("#code ait-translation code")).toHaveText("initialDelaySeconds");
    await expect(page.locator("#image ait-translation img[alt='ok']")).toHaveCount(1);
    await expect(page.locator("#breaks ait-translation br")).toHaveCount(1);

    const sources = mock.requests.map((r) => r.source);
    expect(sources).toContain("Read the <g1>setup guide</g1> and the <g2>security notes</g2> before you start.");
    expect(sources).toContain("Set the <x1/> field to give the container enough time to boot.");
    expect(sources.some((s) => s.includes("initialDelaySeconds"))).toBe(false);
    // 空锚点不当标记；没有格式的段落按纯文本发
    expect(sources).toContain("A paragraph that starts with an empty anchor element.");
    const plain = mock.requests.find((r) => r.source === "A plain paragraph without any formatting at all.")!;
    expect(plain.prompt).not.toMatch(/标记/);
  });

  test("4 模型弄丢标记：该段退回纯文本显示，其他段不受影响", async ({ context, background, mock, site }) => {
    mock.setResponder((req) =>
      req.prompt.includes("保留所有的标记") && req.source.includes("a broken page") ? { content: "这段故意链接到一个坏页面。" } : undefined,
    );
    const page = await context.newPage();
    await page.goto(`${site}/inline-format.html`);
    await toggle(background, page);
    await settle(mock, page);

    await expect(page.locator("#broken ait-translation")).toHaveText("【译】This paragraph links to a broken page on purpose.");
    await expect(page.locator("#broken ait-translation a")).toHaveCount(0);
    expect(mock.requests.filter((r) => r.source.includes("a broken page"))).toHaveLength(2);
    await expect(page.locator('#links ait-translation a[href="https://example.com/guide"]')).toHaveCount(1);
  });

  test("5 还原后插件插入的节点全部移除，原段落的链接和格式没被改动", async ({ context, background, mock, site }) => {
    const page = await context.newPage();
    await page.goto(`${site}/inline-format.html`);
    const original = await page.evaluate(() => document.documentElement.outerHTML);
    await toggle(background, page);
    await settle(mock, page);
    expect(await page.locator("ait-translation a").count()).toBeGreaterThan(0);
    expect(await toggle(background, page)).toBe(false);
    expect(await page.evaluate(() => document.documentElement.outerHTML)).toBe(original);
  });
});
