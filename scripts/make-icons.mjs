// 生成插件图标 apps/extension/icons/icon-{16,32,48,128}.png：蓝底圆角方块加白色「译」字。
// 用 Playwright 自带的 Chromium 渲染，系统要有中文字体（macOS 自带苹方）。图标改样式时重跑一次即可。
// 用法：PLAYWRIGHT_BROWSERS_PATH=0 node scripts/make-icons.mjs
import { chromium } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const out = fileURLToPath(new URL("../apps/extension/icons/", import.meta.url));
await mkdir(out, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 1 });
for (const size of [16, 32, 48, 128]) {
  const radius = Math.round(size * 0.22);
  const font = Math.round(size * 0.68);
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<!doctype html><html><body style="margin:0;background:transparent">
    <div style="width:${size}px;height:${size}px;border-radius:${radius}px;background:#2753C8;color:#fff;
      display:flex;align-items:center;justify-content:center;
      font:600 ${font}px/1 'PingFang SC','Hiragino Sans GB','Noto Sans SC',sans-serif">译</div></body></html>`);
  await page.screenshot({ path: `${out}icon-${size}.png`, omitBackground: true });
}
await browser.close();
console.log(`icons written to ${out}`);
