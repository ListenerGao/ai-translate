// 设置页：本机翻译服务地址、密钥、目标语言、显示方式，以及「测试连接」。
// 术语表不在这里编辑（主人 2026-10-22 定）：插件、命令行和桌面应用共用 aitd 里的一份，在桌面应用里编辑；这里只放提示。
import { AITD_API, AitdError, AitdTranslator, TranslateError, aitdHealth, checkLocalEndpoint } from "@ai-translate/core";
import { migrateGlossary } from "../shared/aitd.ts";
import { errorMessage } from "../shared/errors.ts";
import { loadSettings, saveSettings, type DisplayMode, type Settings } from "../shared/settings.ts";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const form = $<HTMLFormElement>("form");
const endpoint = $<HTMLInputElement>("endpoint");
const endpointError = $<HTMLParagraphElement>("endpoint-error");
const apiKey = $<HTMLInputElement>("api-key");
const toggleKey = $<HTMLButtonElement>("toggle-key");
const target = $<HTMLSelectElement>("target");
const autoTranslate = $<HTMLInputElement>("auto-translate");
const selectionEnabled = $<HTMLInputElement>("selection-enabled");
const testButton = $<HTMLButtonElement>("test");
const status = $<HTMLSpanElement>("status");

let current: Settings;

function describe(err: unknown): string {
  const e = err instanceof TranslateError ? err : new TranslateError("server", String(err));
  return e instanceof AitdError ? e.display : errorMessage(e.code, e.detail);
}

function setStatus(text: string, kind: "ok" | "error" | "" = ""): void {
  status.textContent = text;
  status.dataset.kind = kind;
}

function readForm(): Settings {
  const mode = document.querySelector<HTMLInputElement>('input[name="display-mode"]:checked')?.value;
  return {
    ...current,
    endpoint: endpoint.value.trim(),
    apiKey: apiKey.value.trim(),
    target: target.value,
    displayMode: (mode ?? "bilingual") as DisplayMode,
    autoTranslate: autoTranslate.checked,
    selectionEnabled: selectionEnabled.checked,
  };
}

function checkEndpoint(): boolean {
  const result = checkLocalEndpoint(endpoint.value);
  endpointError.hidden = result.ok;
  endpointError.textContent = result.ok ? "" : result.reason;
  return result.ok;
}

async function init(): Promise<void> {
  current = await loadSettings();
  endpoint.value = current.endpoint;
  apiKey.value = current.apiKey;
  target.value = current.target;
  $<HTMLInputElement>(current.displayMode === "translation-only" ? "mode-only" : "mode-bilingual").checked = true;
  autoTranslate.checked = current.autoTranslate;
  selectionEnabled.checked = current.selectionEnabled;
  checkEndpoint();
  // 插件早期版本存在自己这里的术语表：连得上 aitd 时搬过去
  await migrateGlossary();
}

endpoint.addEventListener("input", checkEndpoint);

toggleKey.addEventListener("click", () => {
  const show = apiKey.type === "password";
  apiKey.type = show ? "text" : "password";
  toggleKey.textContent = show ? "隐藏" : "显示";
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!checkEndpoint()) {
    setStatus("服务地址不对，没有保存", "error");
    return;
  }
  const before = current;
  current = readForm();
  await saveSettings(current);
  setStatus("已保存", "ok");
  // 刚填好服务地址或密钥：旧术语表这时才搬得过去
  if (before.endpoint !== current.endpoint || before.apiKey !== current.apiKey) await migrateGlossary();
});

testButton.addEventListener("click", async () => {
  if (!checkEndpoint()) {
    setStatus("服务地址不对", "error");
    return;
  }
  const s = readForm();
  setStatus("正在测试…");
  testButton.disabled = true;
  try {
    const api = await aitdHealth(s.endpoint);
    if (api === null) throw new TranslateError("unreachable");
    if (api !== AITD_API) throw new AitdError("server", "本机翻译服务和插件的版本对不上：两边更新到同一版本");
    const request = { segments: [{ id: "test", text: "Hello, world." }], source: "auto", target: s.target, model: s.modelId };
    for await (const r of new AitdTranslator(s, 0).translate(request, new AbortController().signal)) {
      setStatus(`连接正常。「Hello, world.」译为「${r.text}」`, "ok");
    }
  } catch (err) {
    setStatus(describe(err), "error");
  } finally {
    testButton.disabled = false;
  }
});

void init();
