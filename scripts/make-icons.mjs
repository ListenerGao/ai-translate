// 生成图标：底色 #2852C8 的圆角方块加白色「中→A」（和桌面应用菜单栏、插件划词工具条同款，主人 2026-10-20 定）。
// - 插件：apps/extension/icons/icon-{16,32,48,128}.png
// - 桌面应用：apps/desktop/Resources/AppIcon.icns，按 macOS 图标的留白画好各个尺寸，再用 iconutil 打包
// 用 Playwright 自带的 Chromium 渲染。图标改样式时重跑一次即可。
// 用法：PLAYWRIGHT_BROWSERS_PATH=0 node scripts/make-icons.mjs [extension | desktop]（不带参数两个都生成）
import { chromium } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const which = process.argv[2];
const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 1 });

// 「中→A」翻译图标，取自 Remix Icon 4.9.1 的 translate（https://remixicon.com，许可允许在软件里当界面图标用），和插件划词工具条相同
const TRANSLATE_ICON =
  "M5 15V17C5 18.0544 5.81588 18.9182 6.85074 18.9945L7 19H10V21H7C4.79086 21 3 19.2091 3 17V15H5ZM18 10L22.4 21H20.245L19.044 18H14.954L13.755 21H11.601L16 10H18ZM17 12.8852L15.753 16H18.245L17 12.8852ZM8 2V4H12V11H8V14H6V11H2V4H6V2H8ZM17 3C19.2091 3 21 4.79086 21 7V9H19V7C19 5.89543 18.1046 5 17 5H14V3H17ZM6 6H4V9H6V6ZM10 6H8V9H10V6Z";

/** 在 canvas×canvas 的透明画布上画边长 box 的圆角方块，居中，里面是白色「中→A」；小尺寸图案占比放大，笔画才看得清 */
async function render(path, canvas, box, glyphRatio = 0.68) {
  const radius = Math.round(box * 0.22);
  const glyph = Math.round(box * glyphRatio);
  await page.setViewportSize({ width: canvas, height: canvas });
  await page.setContent(`<!doctype html><html><body style="margin:0;background:transparent;width:${canvas}px;height:${canvas}px;
      display:flex;align-items:center;justify-content:center">
    <div style="width:${box}px;height:${box}px;border-radius:${radius}px;background:#2852C8;
      display:flex;align-items:center;justify-content:center">
      <svg viewBox="0 0 24 24" width="${glyph}" height="${glyph}"><path fill="#fff" d="${TRANSLATE_ICON}"/></svg></div></body></html>`);
  await page.screenshot({ path, omitBackground: true });
}

if (which === undefined || which === "extension") {
  const out = fileURLToPath(new URL("../apps/extension/icons/", import.meta.url));
  await mkdir(out, { recursive: true });
  for (const size of [16, 32, 48, 128]) await render(`${out}icon-${size}.png`, size, size, size === 16 ? 0.9 : 0.68);
  console.log(`icons written to ${out}`);
}

if (which === undefined || which === "desktop") {
  // macOS 图标：1024 的画布里方块占 824，四周留白（和系统自带 App 一致）
  const out = fileURLToPath(new URL("../apps/desktop/Resources/AppIcon.icns", import.meta.url));
  const tmp = await mkdtemp(join(tmpdir(), "ait-icon-"));
  const set = join(tmp, "AppIcon.iconset");
  await mkdir(set);
  for (const size of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) {
      const px = size * scale;
      await render(join(set, `icon_${size}x${size}${scale === 2 ? "@2x" : ""}.png`), px, Math.round((px * 824) / 1024));
    }
  }
  await mkdir(fileURLToPath(new URL("../apps/desktop/Resources/", import.meta.url)), { recursive: true });
  execFileSync("iconutil", ["-c", "icns", set, "-o", out]);
  await rm(tmp, { recursive: true, force: true });
  console.log(`icon written to ${out}`);
}

await browser.close();
