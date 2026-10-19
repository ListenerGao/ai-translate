// 译文回归检查：用正在运行的模型服务把固定样例（tests/quality/samples.json）全部翻一遍，自动查硬伤，再和基线比。
// 换模型、换量化版本、改提示词或术语之后跑一次：出现基线没有的新问题时退出码为 1。
// 用法：npm run qa [-- --endpoint http://127.0.0.1:8791] [--update-baseline]
//   --update-baseline：人看过报告、确认这次的译文可以接受后，把它存成新基线（译文没变的条目保留原来的人工评分）
// 前提：模型服务在运行（scripts/start-model.sh）；密钥读 ~/Library/Application Support/ai-translate/api-key。
import { BUILTIN_GLOSSARY, LlamaServerTranslator, getModelProfile } from "@ai-translate/core";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { checkTranslation, flagKey, type Flag, type Sample } from "./qa/checks.ts";

interface BaselineItem {
  translation: string;
  /** 人工（或外部 AI）评分：good 准确通顺、minor 小毛病、bad 有错误 */
  rating?: "good" | "minor" | "bad";
  note?: string;
}

interface Baseline {
  label: string;
  updated: string;
  items: Record<string, BaselineItem>;
}

interface Row {
  sample: Sample;
  translation: string;
  error?: string;
  ms: number;
  flags: Flag[];
  newFlags: Flag[];
  base?: BaselineItem;
}

const root = fileURLToPath(new URL("..", import.meta.url));
const { values } = parseArgs({ options: { endpoint: { type: "string", default: "http://127.0.0.1:8791" }, "update-baseline": { type: "boolean" } } });
const endpoint = values.endpoint ?? "http://127.0.0.1:8791";
const samples = JSON.parse(readFileSync(join(root, "tests/quality/samples.json"), "utf8")) as Sample[];
const baselineFile = join(root, "tests/quality/baseline.json");
const baseline = existsSync(baselineFile) ? (JSON.parse(readFileSync(baselineFile, "utf8")) as Baseline) : null;
const apiKey = readFileSync(join(homedir(), "Library/Application Support/ai-translate/api-key"), "utf8").trim();
const RATING: Record<string, string> = { good: "准确通顺", minor: "小毛病", bad: "有错误" };

// 量化版本从模型服务加载的文件名里取
let label = "未知版本";
try {
  const props = (await (await fetch(`${endpoint}/props`, { headers: { Authorization: `Bearer ${apiKey}` } })).json()) as { model_path?: string };
  label = /Index-Translate-2B\.(\w+)\.gguf$/.exec(props.model_path ?? "")?.[1] ?? basename(props.model_path ?? label);
} catch {
  console.error(`连不上模型服务 ${endpoint}：先运行 scripts/start-model.sh`);
  process.exit(2);
}

// 和插件同一条路径翻译：内置术语、带格式的段落按标记翻，4 路并行（模型服务的槽位数）
const translator = new LlamaServerTranslator({ endpoint, apiKey, profile: getModelProfile("index-translate-2b") });
const rows: Row[] = [];
let next = 0;
const started = performance.now();
await Promise.all(
  Array.from({ length: 4 }, async () => {
    while (next < samples.length) {
      const sample = samples[next++]!;
      const t0 = performance.now();
      let translation = "";
      let error: string | undefined;
      try {
        const segment = { id: sample.id, text: sample.source, ...(sample.markup === undefined ? {} : { markup: sample.markup }) };
        for await (const r of translator.translate({ segments: [segment], source: "auto", target: "zh", model: "index-translate-2b", glossary: [...BUILTIN_GLOSSARY] }, new AbortController().signal)) {
          translation = r.text;
        }
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      }
      const base = baseline?.items[sample.id];
      const flags = error === undefined ? checkTranslation(sample, translation) : [];
      const known = new Set(base === undefined ? [] : checkTranslation(sample, base.translation).map(flagKey));
      const newFlags = flags.filter((f) => !known.has(flagKey(f)));
      rows.push({ sample, translation, ms: Math.round(performance.now() - t0), flags, newFlags, ...(error === undefined ? {} : { error }), ...(base === undefined ? {} : { base }) });
    }
  }),
);
rows.sort((a, b) => samples.indexOf(a.sample) - samples.indexOf(b.sample));
const totalSeconds = (performance.now() - started) / 1000;

// ---------- 汇总 ----------
const changed = rows.filter((r) => r.base !== undefined && r.base.translation !== r.translation);
const errors = rows.filter((r) => r.error !== undefined);
const withNew = rows.filter((r) => r.newFlags.length > 0);
const byCheck = new Map<string, { all: number; fresh: number }>();
for (const r of rows) {
  for (const f of r.flags) {
    const c = byCheck.get(f.check) ?? { all: 0, fresh: 0 };
    c.all++;
    if (r.newFlags.includes(f)) c.fresh++;
    byCheck.set(f.check, c);
  }
}
const avgMs = Math.round(rows.reduce((s, r) => s + r.ms, 0) / rows.length);
const summary = [
  `模型 Index-Translate-2B ${label}；样例 ${rows.length} 条，4 路并行共 ${totalSeconds.toFixed(1)} 秒，单条平均 ${avgMs} 毫秒`,
  baseline === null ? "还没有基线：加 --update-baseline 把这次的结果存成基线" : `基线 ${baseline.label}（${baseline.updated}）：译文相同 ${rows.length - changed.length - errors.length} 条，变化 ${changed.length} 条`,
  `自动检查：${byCheck.size === 0 ? "没有问题" : [...byCheck].map(([k, c]) => `${k} ${c.all} 处（新增 ${c.fresh}）`).join("，")}`,
  errors.length > 0 ? `翻译失败 ${errors.length} 条：${errors.map((r) => r.sample.id).join("、")}` : "",
  withNew.length > 0 ? `新出现的问题（基线没有）：${withNew.map((r) => `${r.sample.id} ${r.newFlags.map((f) => `${f.check}「${f.detail}」`).join("、")}`).join("；")}` : "没有新出现的问题",
].filter((l) => l !== "");

// ---------- 报告 ----------
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const flagList = (flags: Flag[], fresh: Flag[]) =>
  flags.map((f) => `<span class="flag${fresh.includes(f) ? " new" : ""}">${esc(f.check)}：${esc(f.detail)}</span>`).join(" ");
const rowHtml = (r: Row) => `<tr>
  <td>${esc(r.sample.id)}<br><span class="muted">${esc(r.sample.kind)}</span></td>
  <td lang="en">${esc(r.sample.source)}</td>
  <td>${r.base === undefined ? '<span class="muted">（无基线）</span>' : `${esc(r.base.translation)}${r.base.rating ? `<br><span class="rating ${r.base.rating}">${RATING[r.base.rating]}</span>` : ""}${r.base.note ? ` <span class="muted">${esc(r.base.note)}</span>` : ""}`}</td>
  <td>${r.error === undefined ? esc(r.translation) : `<span class="flag new">翻译失败：${esc(r.error)}</span>`}<br>${flagList(r.flags, r.newFlags)}</td>
</tr>`;
const table = (title: string, list: Row[], empty: string) => `<h2>${title}（${list.length}）</h2>${list.length === 0 ? `<p class="muted">${empty}</p>` : `<div class="wrap"><table><tr><th>条目</th><th>原文</th><th>基线译文</th><th>本次译文与检查结果</th></tr>${list.map(rowHtml).join("")}</table></div>`}`;
const flagged = rows.filter((r) => r.flags.length > 0 && r.newFlags.length === 0 && !changed.includes(r));
const stamp = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).slice(0, 16).replace(/[-:]/g, "").replace(" ", "-");
const reportFile = join(root, ".tmp/qa", `qa-${label}-${stamp}.html`);
mkdirSync(join(root, ".tmp/qa"), { recursive: true });
writeFileSync(reportFile, `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>译文回归检查</title>
<style>
:root { --bg: #f5f6f8; --surface: #fff; --fg: #18202c; --muted: #5a6375; --line: #c5ccd8; --good: #15803d; --minor: #b45309; --bad: #b91c1c; color-scheme: light; }
@media (prefers-color-scheme: dark) { :root { --bg: #0f131a; --surface: #171c25; --fg: #e3e7ee; --muted: #9aa3b5; --line: #353d4c; --good: #4ade80; --minor: #fbbf24; --bad: #f87171; color-scheme: dark; } }
body { margin: 0; background: var(--bg); color: var(--fg); font: 14px/1.6 -apple-system, "PingFang SC", system-ui, sans-serif; }
main { max-width: 1200px; margin: 0 auto; padding: 32px 16px 64px; }
h1 { font-size: 24px; margin: 0 0 8px; } h2 { font-size: 18px; margin: 28px 0 8px; }
.summary { background: var(--surface); border: 1px solid var(--line); border-radius: 10px; padding: 12px 16px 12px 34px; margin: 0; }
.wrap { overflow-x: auto; } table { border-collapse: collapse; width: 100%; background: var(--surface); }
th, td { text-align: left; vertical-align: top; padding: 8px 10px; border-bottom: 1px solid var(--line); }
th { color: var(--muted); font-size: 13px; } td:nth-child(2) { font-family: Georgia, serif; width: 30%; } td:nth-child(3), td:nth-child(4) { width: 30%; }
.muted { color: var(--muted); font-size: 12px; } .flag { display: inline-block; font-size: 12px; padding: 0 6px; border-radius: 6px; border: 1px solid var(--line); margin: 2px 4px 0 0; }
.flag.new { border-color: var(--bad); color: var(--bad); } .rating { font-size: 12px; } .rating.good { color: var(--good); } .rating.minor { color: var(--minor); } .rating.bad { color: var(--bad); }
</style></head><body><main>
<h1>译文回归检查</h1>
<ul class="summary">${summary.map((l) => `<li>${esc(l)}</li>`).join("")}</ul>
${table("新出现的问题", withNew, "没有基线以外的新问题。")}
${table("和基线不同的译文", changed.filter((r) => r.newFlags.length === 0), "译文和基线完全一样。")}
${table("基线里就有的问题", flagged, "没有。")}
<p class="muted">自动检查只查硬伤：残留英文（全小写、没翻的普通词）、数字丢失、格式标记没保住、内置术语没按规定译、译文异常（空、照抄原文等）。语义对不对要人看「和基线不同的译文」。</p>
</main></body></html>`);

for (const line of summary) console.log(line);
console.log(`报告：${reportFile}`);

if (values["update-baseline"]) {
  const items: Record<string, BaselineItem> = {};
  for (const r of rows) {
    if (r.error !== undefined) continue;
    const old = baseline?.items[r.sample.id];
    // 译文没变才保留原来的人工评分；变了就要重新评
    const keep = old !== undefined && old.translation === r.translation;
    items[r.sample.id] = { translation: r.translation, ...(keep && old.rating ? { rating: old.rating } : {}), ...(keep && old.note ? { note: old.note } : {}) };
  }
  const updated = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).slice(0, 16);
  writeFileSync(baselineFile, `${JSON.stringify({ label, updated, items } satisfies Baseline, null, 2)}\n`);
  console.log(`已更新基线：${baselineFile}（${Object.keys(items).length} 条）`);
}

process.exit(errors.length > 0 || withNew.length > 0 ? 1 : 0);
