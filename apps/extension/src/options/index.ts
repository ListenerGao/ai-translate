// 设置页：本机翻译服务地址、密钥、目标语言、显示方式、术语表（存在 aitd 里），以及「测试连接」。
import { BUILTIN_GLOSSARY, TranslateError, checkLocalEndpoint, parseGlossary } from "@ai-translate/core";
import { AITD_API, AitdError, AitdTranslator, aitdHealth, getGlossary, migrateGlossary, putGlossary } from "../shared/aitd.ts";
import { errorMessage } from "../shared/errors.ts";
import { loadSettings, saveSettings, type DisplayMode, type Settings } from "../shared/settings.ts";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const form = $<HTMLFormElement>("form");
const endpoint = $<HTMLInputElement>("endpoint");
const endpointError = $<HTMLParagraphElement>("endpoint-error");
const apiKey = $<HTMLInputElement>("api-key");
const toggleKey = $<HTMLButtonElement>("toggle-key");
const target = $<HTMLSelectElement>("target");
const glossary = $<HTMLTextAreaElement>("glossary");
const glossaryErrors = $<HTMLUListElement>("glossary-errors");
const glossaryState = $<HTMLParagraphElement>("glossary-state");
$<HTMLParagraphElement>("builtin-glossary").textContent =
  `内置术语（一直生效，自己写同一个原文会覆盖）：${BUILTIN_GLOSSARY.map((e) => `${e.from}=${e.to}`).join("、")}`;
const autoTranslate = $<HTMLInputElement>("auto-translate");
const selectionEnabled = $<HTMLInputElement>("selection-enabled");
const testButton = $<HTMLButtonElement>("test");
const status = $<HTMLSpanElement>("status");

let current: Settings;
/** 从 aitd 读到的术语表；读不到时为 null，这时术语表不能改 */
let savedGlossary: string | null = null;

function describe(err: unknown): string {
  const e = err instanceof TranslateError ? err : new TranslateError("server", String(err));
  return e instanceof AitdError ? e.display : errorMessage(e.code, e.detail);
}

/** 术语表从 aitd 读；插件里还留着旧术语表的，先搬过去 */
async function loadGlossary(): Promise<void> {
  await migrateGlossary();
  try {
    savedGlossary = await getGlossary(current);
    glossary.value = savedGlossary;
    glossary.disabled = false;
    glossaryState.hidden = true;
  } catch (err) {
    savedGlossary = null;
    glossary.value = "";
    glossary.disabled = true;
    glossaryState.textContent = `术语表暂时不能查看和修改：${describe(err)}`;
    glossaryState.hidden = false;
  }
  checkGlossary();
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

function checkGlossary(): void {
  const { errors } = parseGlossary(glossary.value);
  glossaryErrors.hidden = errors.length === 0;
  glossaryErrors.replaceChildren(
    ...errors.map((e) => {
      const li = document.createElement("li");
      li.textContent = `第 ${e.line} 行：${e.message}`;
      return li;
    }),
  );
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
  await loadGlossary();
}

endpoint.addEventListener("input", checkEndpoint);
glossary.addEventListener("input", checkGlossary);

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
  const glossaryChanged = savedGlossary !== null && glossary.value !== savedGlossary;
  if (glossaryChanged && parseGlossary(glossary.value).errors.length > 0) {
    setStatus("术语表有错误，没有保存", "error");
    return;
  }
  const before = current;
  current = readForm();
  await saveSettings(current);
  if (glossaryChanged) {
    try {
      const result = await putGlossary(current, glossary.value);
      if (!result.ok) {
        setStatus(`术语表第 ${result.lines.map((l) => l.line).join("、")} 行有错误，术语表没有保存`, "error");
        return;
      }
      savedGlossary = glossary.value;
    } catch (err) {
      setStatus(`其他设置已保存，术语表没保存：${describe(err)}`, "error");
      return;
    }
  }
  setStatus("已保存", "ok");
  // 换了服务地址或密钥：按新的重新读术语表
  if (before.endpoint !== current.endpoint || before.apiKey !== current.apiKey) await loadGlossary();
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
