// 真实网页检查：用 Playwright 的 Chromium 加载插件，连本机正在运行的模型服务，翻译一个真实网页。
// 输出首段出译文的时间、开启时范围内（屏幕内 + 下方 1 屏）全部出完的时间、有格式的段落保住格式的个数；加 --scroll 从头滚到尾，列出可见但没被翻译的文字；加 --shot 截取当前屏幕。
// 用法：npm run check-page -- <url> [--scroll] [--shot out.png] [--at <选择器>]
//   --at：截图前先滚到这个元素
// 前提：npm run build；scripts/start-model.sh 在运行；网络走 https_proxy（有的话）。
import { chromium } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { scroll: { type: "boolean" }, shot: { type: "string" }, at: { type: "string" } },
});
const url = positionals[0];
if (!url) {
  console.error("用法：npm run check-page -- <url> [--scroll] [--shot out.png] [--at <选择器>]");
  process.exit(2);
}

const extension = fileURLToPath(new URL("../apps/extension/dist", import.meta.url));
const apiKey = (await readFile(`${homedir()}/Library/Application Support/ai-translate/api-key`, "utf8")).trim();
const proxy = process.env.https_proxy ?? process.env.HTTPS_PROXY;

const context = await chromium.launchPersistentContext("", {
  channel: "chromium",
  viewport: { width: 1440, height: 900 },
  ...(proxy ? { proxy: { server: proxy, bypass: "127.0.0.1,localhost" } } : {}),
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
});

try {
  let [worker] = context.serviceWorkers();
  worker ??= await context.waitForEvent("serviceworker");
  await worker.evaluate((key) => chrome.storage.local.set({ endpoint: "http://127.0.0.1:8791", apiKey: key }), apiKey);

  const page = await context.newPage();
  await page.goto(url, { waitUntil: "load", timeout: 60_000 });
  await page.waitForTimeout(1500);

  const started = Date.now();
  await worker.evaluate(async (u) => {
    const tab = (await chrome.tabs.query({})).find((t) => t.url === u);
    await globalThis.aitToggleTab(tab.id);
  }, page.url());

  // 首段出译文；范围内（屏幕内 + 下方 1 屏）没有「翻译中」
  const idle = () => page.waitForFunction(() => !document.querySelector('ait-translation[data-state="pending"]'), null, { timeout: 30_000 }).catch(() => {});
  await page.waitForFunction(() => document.querySelector('ait-translation[data-state="done"]'), null, { timeout: 30_000 });
  const firstMs = Date.now() - started;
  await idle();
  const zoneMs = Date.now() - started;

  const report = { url, firstMs, zoneMs };
  const markupStats = () =>
    page.evaluate(() => ({
      kept: document.querySelectorAll('ait-translation[data-markup="kept"]').length,
      plain: document.querySelectorAll('ait-translation[data-markup="plain"]').length,
    }));

  if (values.scroll) {
    for (let i = 0; i < 100; i++) {
      await idle();
      const bottom = await page.evaluate(() => {
        window.scrollBy(0, window.innerHeight * 0.8);
        return window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2;
      });
      await page.waitForTimeout(250);
      if (bottom) break;
    }
    await idle();
    Object.assign(report, await page.evaluate(missedText));
  }

  if (values.at) {
    await page.locator(values.at).first().scrollIntoViewIfNeeded();
    await page.waitForTimeout(500);
    await idle();
  }
  // 有格式的段落：保住格式的、退回纯文本的
  report.markup = await markupStats();

  if (values.shot) {
    await page.screenshot({ path: values.shot });
    report.shot = values.shot;
  }
  console.log(JSON.stringify(report, null, 2));
} finally {
  await context.close();
}

// 在页面里运行：列出可见但没翻译的文字，按所在元素分组（导航、按钮等按规则跳过的单独计数）
function missedText() {
  const skipped = "pre, code, script, style, noscript, nav, aside, footer, form, textarea, select, button, [contenteditable]:not([contenteditable='false']), svg, math, [role='navigation'], [role='menu'], [role='menubar'], [role='toolbar'], [role='tablist'], [aria-hidden='true']";
  const missed = {};
  let skippedByRule = 0;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const text = (n.textContent ?? "").replace(/\s+/g, " ").trim();
    if (text.length < 2 || !/\p{L}/u.test(text) || /\p{Script=Han}/u.test(text)) continue;
    const parent = n.parentElement;
    if (!parent || parent.getClientRects().length === 0 || parent.closest("[data-ait-id], ait-translation, ait-banner")) continue;
    if (parent.closest(skipped)) {
      skippedByRule++;
      continue;
    }
    const tag = parent.tagName.toLowerCase();
    (missed[tag] ??= []).length < 12 && missed[tag].push(text.slice(0, 90));
  }
  return {
    blocks: document.querySelectorAll("[data-ait-id]").length,
    translated: document.querySelectorAll('ait-translation[data-state="done"]').length,
    missed,
    skippedByRule,
  };
}
