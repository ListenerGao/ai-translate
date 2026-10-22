// 设置页：服务地址校验、保存、测试连接（术语表不在这里编辑，只有提示）
import { API_KEY, expect, test } from "./fixtures.ts";

test("设置页：非本机地址不能保存；其他设置保存到插件；测试连接走 aitd", async ({ context, extensionId, aitd, mock, background }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options.html`);
  await expect(page.locator("#endpoint")).toHaveValue(aitd.url);

  await page.fill("#endpoint", "https://example.com");
  await expect(page.locator("#endpoint-error")).toContainText("只能连接本机服务");
  await page.click("button[type=submit]");
  await expect(page.locator("#status")).toHaveText("服务地址不对，没有保存");
  expect(await background.evaluate(() => chrome.storage.local.get("endpoint"))).toEqual({ endpoint: expect.stringContaining("127.0.0.1") });

  await page.fill("#endpoint", aitd.url);
  await page.check("#mode-only");
  await page.check("#auto-translate");
  await page.uncheck("#selection-enabled");
  await page.click("button[type=submit]");
  await expect(page.locator("#status")).toHaveText("已保存");
  const saved = await background.evaluate(() => chrome.storage.local.get(["displayMode", "apiKey", "autoTranslate", "selectionEnabled"]));
  expect(saved).toEqual({ displayMode: "translation-only", apiKey: API_KEY, autoTranslate: true, selectionEnabled: false });

  await page.click("#test");
  await expect(page.locator("#status")).toContainText("连接正常");
  expect(mock.requests.at(-1)?.source).toBe("Hello, world.");

  await page.fill("#api-key", "wrong");
  await page.click("#test");
  await expect(page.locator("#status")).toHaveText("密钥不对：到插件设置页重新填写");
});
