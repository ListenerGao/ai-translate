import { expect, test } from "./fixtures.ts";

test("插件能加载，后台 service worker 在运行", async ({ background, extensionId }) => {
  expect(extensionId).toMatch(/^[a-p]{32}$/);
  expect(background.url()).toBe(`chrome-extension://${extensionId}/background.js`);
});
