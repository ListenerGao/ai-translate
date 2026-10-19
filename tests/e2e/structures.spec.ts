// 段落识别：按排版而不是标签名找段落（CP6 试用中 Hugging Face 文档页的 div 标题、表格漏翻后补充）
import { expect, requestedSources, settle, test, toggle, translatedIds } from "./fixtures.ts";

test("10 div 标题、表格单元格、列表、行内混排都会翻；界面元素和隐藏内容不翻", async ({ context, background, mock, site }) => {
  const page = await context.newPage();
  await page.goto(`${site}/structures.html`);
  await toggle(background, page);
  await settle(mock, page);

  const done = await translatedIds(page);
  for (const id of ["div-heading", "intro", "th1", "th2", "td1", "td2", "flex-span", "li-nested", "li-child", "inline-mix", "short-title", "single-word"]) {
    expect(done, id).toContain(id);
  }
  // flex 容器里的零散文字、导航、隐藏内容不翻
  for (const id of ["flex-bare", "role-nav", "hidden-aria", "display-none"]) {
    expect(done, id).not.toContain(id);
  }

  const sources = requestedSources(mock);
  // 段内有链接、加粗时按带标记的原文发送（Goal 2）
  expect(sources).toContain("Read the <g1>setup guide</g1> and the <g2>security notes</g2> first.");
  expect(sources).toContain("Parent item text");
  expect(sources.some((s) => /Bare flex text|Role navigation|Decorative|Hidden block/.test(s))).toBe(false);

  // 嵌套列表：译文紧跟父项自己的文字，在子列表前面
  const next = await page.$eval("#li-nested > ait-translation", (el) => el.nextElementSibling?.tagName);
  expect(next).toBe("UL");
});

test("13 1~4 个单词放得下就跟在同一行右边，放不下或 5 个单词起放在原文下方", async ({ context, background, mock, site }) => {
  const page = await context.newPage();
  await page.goto(`${site}/structures.html`);
  const heightBefore = await page.$eval("#short-title", (el) => el.getBoundingClientRect().height);
  await toggle(background, page);
  await settle(mock, page);

  // 原文文字的行框和译文的行框是否在同一行
  const placement = (selector: string) =>
    page.$eval(selector, (el) => {
      const range = document.createRange();
      range.selectNodeContents(el.firstChild!);
      const src = range.getClientRects()[0]!;
      const tr = el.querySelector("ait-translation")!;
      const t = tr.getClientRects()[0]!;
      return { layout: tr.getAttribute("data-layout"), sameLine: t.top < src.bottom && t.bottom > src.top, below: t.top >= src.bottom - 1, right: t.left >= src.right };
    });

  const short = await placement("#short-title");
  expect(short).toMatchObject({ layout: "inline", sameLine: true, right: true });
  // 标题没有被撑高
  expect(await page.$eval("#short-title", (el) => el.getBoundingClientRect().height)).toBe(heightBefore);

  expect(await placement("#th1")).toMatchObject({ layout: "inline", sameLine: true });
  expect(await placement("#single-word")).toMatchObject({ layout: "inline", sameLine: true, right: true });
  expect(await placement("#intro")).toMatchObject({ layout: "block", below: true });

  // 5 个单词起直接放原文下方
  expect(await placement("#narrow-short")).toMatchObject({ layout: "block", below: true });
  // 短文本但放不下：原文一行、译文接在后面会折行 -> 改放原文下方
  expect(await placement("#tight")).toMatchObject({ layout: "block", below: true });
});

test("14 标题开头有锚点图标时译文仍在原文后面；译文和原文一样时不显示", async ({ context, background, mock, site }) => {
  mock.setResponder((req) => (req.source === "Hugging Face Hub" ? { content: "Hugging Face Hub" } : undefined));
  const page = await context.newPage();
  await page.goto(`${site}/structures.html`);
  await toggle(background, page);
  await settle(mock, page);

  const anchored = await page.$eval("#anchored", (h2) => {
    const tr = h2.querySelector("ait-translation")!;
    const span = h2.querySelector("span")!;
    return {
      afterText: tr.previousElementSibling === span,
      rightOfText: tr.getClientRects()[0]!.left >= span.getBoundingClientRect().right,
    };
  });
  expect(anchored).toEqual({ afterText: true, rightOfText: true });

  expect(requestedSources(mock)).toContain("Hugging Face Hub");
  expect(await page.locator("#brand ait-translation").count()).toBe(0);
});

test("11 译文用 #00bb7c 和原文区分：浅色区域、浅灰文字、深色区域都是这个颜色", async ({ context, background, mock, site }) => {
  const page = await context.newPage();
  await page.goto(`${site}/structures.html`);
  await toggle(background, page);
  await settle(mock, page);

  const colorOf = (selector: string) => page.$eval(selector, (el) => getComputedStyle(el).color);
  const green = "rgb(0, 187, 124)";
  expect(await colorOf("#intro > ait-translation")).toBe(green);
  expect(await colorOf("#intro")).not.toBe(green);
  expect(await colorOf("#muted > ait-translation")).toBe(green);
  expect(await colorOf("#dark-p > ait-translation")).toBe(green);
  expect(await colorOf("#oklch-p > ait-translation")).toBe(green);
});
