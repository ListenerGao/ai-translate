// 设置页：服务地址、密钥、目标语言、显示方式、术语表，以及「测试连接」。
import { checkLocalEndpoint, getModelProfile, parseGlossary } from "@ai-translate/core";
import { LlamaServerTranslator } from "../background/translator.ts";
import { TranslateError, errorMessage } from "../shared/errors.ts";
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
const autoTranslate = $<HTMLInputElement>("auto-translate");
const selectionEnabled = $<HTMLInputElement>("selection-enabled");
const testButton = $<HTMLButtonElement>("test");
const status = $<HTMLSpanElement>("status");

let current: Settings;

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
    glossaryText: glossary.value,
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
  glossary.value = current.glossaryText;
  $<HTMLInputElement>(current.displayMode === "translation-only" ? "mode-only" : "mode-bilingual").checked = true;
  autoTranslate.checked = current.autoTranslate;
  selectionEnabled.checked = current.selectionEnabled;
  checkEndpoint();
  checkGlossary();
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
  current = readForm();
  await saveSettings(current);
  setStatus("已保存", "ok");
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
    const translator = new LlamaServerTranslator({ endpoint: s.endpoint, apiKey: s.apiKey, profile: getModelProfile(s.modelId) });
    const request = { segments: [{ id: "test", text: "Hello, world." }], source: "auto", target: s.target, model: s.modelId };
    for await (const r of translator.translate(request, new AbortController().signal)) {
      setStatus(`连接正常。「Hello, world.」译为「${r.text}」`, "ok");
    }
  } catch (err) {
    const e = err instanceof TranslateError ? err : new TranslateError("server", String(err));
    setStatus(errorMessage(e.code, e.detail), "error");
  } finally {
    testButton.disabled = false;
  }
});

void init();
