import { defineConfig } from "@playwright/test";

// 插件只能在 Playwright 自带的 Chromium 里侧载（Chrome / Edge 已移除侧载参数），浏览器由 fixtures 启动
export default defineConfig({
  testDir: "tests/e2e",
  timeout: 60_000,
  workers: 1,
  reporter: [["list"]],
});
