// 插件特有的一件事：第一阶段的术语表存在插件设置里，改连 aitd 后搬到 aitd。连 aitd 的客户端在 core 的 aitd-client.ts。
import { getGlossary, parseGlossary, putGlossary } from "@ai-translate/core";
import { loadSettings, saveSettings } from "./settings.ts";

/**
 * 插件里还有、aitd 的又是空的，就搬过去并清掉插件里的；aitd 没启动就下次再试。
 * 插件里的术语表有写错的行（翻译时本来就跳过了）：只搬写对的那些。
 */
export async function migrateGlossary(): Promise<void> {
  const settings = await loadSettings();
  if (settings.glossaryText.trim() === "") return;
  try {
    if ((await getGlossary(settings)).trim() !== "") return;
    let result = await putGlossary(settings, settings.glossaryText);
    if (!result.ok) result = await putGlossary(settings, parseGlossary(settings.glossaryText).entries.map((e) => `${e.from}=${e.to}`).join("\n"));
    if (result.ok) await saveSettings({ glossaryText: "" });
  } catch {
    // aitd 没启动或密钥不对：下次再搬
  }
}
