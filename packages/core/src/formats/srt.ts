// SRT 字幕的解析与重组：序号、时间轴、空行逐字不动，只替换每条字幕的文字。
// 一条字幕有多行文字时合成一行翻，译文写成一行；双语时原文行在上、译文一行在下。
// 字幕里的格式：开头的 {\an8} 等位置标签原样留在开头；整条包在 <i>…</i> 等标签里时剥掉再包回去；
// 句中的 <i>、<b>、<u>、<font> 按插件同一套标记发给模型，标记没保住就按纯文本写回。
// 格式不对（缺序号、缺时间轴、条目之间缺空行）直接报错并给出行号，不猜。
import { canUseMarkup, parseMarkup, plainText, stripMarkers, toTagged, type InlineNode, type ParsedNode } from "../inline.ts";

export interface SrtUnit {
  id: string;
  /** 这条字幕的文字从原文件第几行开始（1 起），报错时用 */
  line: number;
  text: string;
  markup?: string;
}

export interface SrtDoc {
  units: SrtUnit[];
  /** translations：id → 模型的译文（可能带标记）；没有译文的字幕保留原文 */
  render(translations: ReadonlyMap<string, string>, options?: { bilingual?: boolean }): string;
}

/** 字幕格式不对：line 是出错的行号（1 起） */
export class SrtFormatError extends Error {
  readonly line: number;

  constructor(line: number, message: string) {
    super(message);
    this.name = "SrtFormatError";
    this.line = line;
  }
}

const INDEX = /^\s*\d+\s*$/;
const TIMING = /^\s*\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}\s*-->\s*\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}(?:\s.*)?$/;
const TAG = /<\/?(?:b|i|u|font)\b[^>]*>|\{\\[^}]*\}/gi;
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}　-〿＀-￯]/u;

interface Cue {
  unit: SrtUnit;
  /** 文字行在 lines 里的范围 [start, end) */
  start: number;
  end: number;
  /** 开头的位置标签，如 {\an8} */
  prefix: string;
  /** 整条外面包的标签，由外到内 */
  wrappers: { open: string; close: string }[];
  /** 标记编号 → 原来的标签写法 */
  raw: Map<number, { open: string; close?: string }>;
}

/** 多行合成一行：两边都是中日韩文字时直接相连，否则加空格 */
function joinLines(lines: readonly string[]): string {
  return lines
    .map((l) => l.trim())
    .filter((l) => l !== "")
    .reduce((acc, l) => (acc === "" ? l : CJK.test(acc.at(-1)!) && CJK.test(l[0]!) ? acc + l : `${acc} ${l}`), "");
}

/** 字幕文字拆成格式树：成对的 b / i / u / font 是标记，其他标签原样保留；标签不成对时全部原样保留 */
function parseTags(text: string, raw: Cue["raw"]): InlineNode[] {
  const parts = text.split(new RegExp(`(${TAG.source})`, "gi"));
  // 先检查是否成对，不成对就不当格式处理
  const stack: string[] = [];
  let balanced = true;
  for (let k = 1; k < parts.length; k += 2) {
    const name = /^<\/?(\w+)/.exec(parts[k]!)?.[1]?.toLowerCase();
    if (name === undefined) continue;
    if (parts[k]!.startsWith("</")) balanced &&= stack.pop() === name;
    else stack.push(name);
  }
  balanced &&= stack.length === 0;

  let nextId = 1;
  const root: InlineNode[] = [];
  const open: { node: Extract<InlineNode, { type: "tag" }>; name: string }[] = [];
  const children = () => open.at(-1)?.node.children ?? root;
  for (const [k, part] of parts.entries()) {
    if (k % 2 === 0) {
      if (part !== "") children().push({ type: "text", text: part });
      continue;
    }
    const name = /^<\/?(\w+)/.exec(part)?.[1]?.toLowerCase();
    if (!balanced || name === undefined) {
      const id = nextId++;
      raw.set(id, { open: part });
      children().push({ type: "atom", id, text: "" });
    } else if (part.startsWith("</")) {
      raw.get(open.pop()!.node.id)!.close = part;
    } else {
      const node: Extract<InlineNode, { type: "tag" }> = { type: "tag", id: nextId++, children: [] };
      raw.set(node.id, { open: part });
      children().push(node);
      open.push({ node, name });
    }
  }
  return root;
}

function rebuild(nodes: readonly ParsedNode[], raw: Cue["raw"]): string {
  return nodes
    .map((n) => {
      if (n.type === "text") return n.text.replace(/\s+/g, " ");
      const r = raw.get(n.id)!;
      return n.type === "atom" ? r.open : `${r.open}${rebuild(n.children, raw)}${r.close ?? ""}`;
    })
    .join("");
}

/** 只是空白的文本节点不算内容 */
const isBlank = (n: InlineNode) => n.type === "text" && n.text.trim() === "";

function makeCue(id: string, lines: readonly string[], start: number, end: number): Cue | null {
  let text = joinLines(lines.slice(start, end));
  const prefix = /^(?:\{\\[^}]*\}\s*)*/.exec(text)![0];
  text = text.slice(prefix.length);
  const tags: Cue["raw"] = new Map();
  let nodes = parseTags(text, tags);
  // 整条包在同一种标签里（包括每行各包一层 <i>）：剥掉，翻完再包回去
  const wrappers: Cue["wrappers"] = [];
  for (;;) {
    const content = nodes.filter((n) => !isBlank(n));
    if (content.length === 0 || !content.every((n) => n.type === "tag")) break;
    const first = tags.get(content[0]!.id)!;
    if (!content.every((n) => tags.get(n.id)!.open === first.open && tags.get(n.id)!.close === first.close)) break;
    wrappers.push({ open: first.open, close: first.close ?? "" });
    nodes = nodes.flatMap((n) => (n.type === "tag" ? n.children : [n]));
  }
  // 剥掉外层后标记从 1 重新编号，发给模型的写法和网页一致
  const raw: Cue["raw"] = new Map();
  let next = 1;
  const renumber = (ns: readonly InlineNode[]): InlineNode[] =>
    ns.map((n) => {
      if (n.type === "text") return n;
      const id = next++;
      raw.set(id, tags.get(n.id)!);
      return n.type === "atom" ? { ...n, id } : { ...n, id, children: renumber(n.children) };
    });
  nodes = renumber(nodes);
  const plain = plainText(nodes);
  if (!/\p{L}/u.test(plain)) return null;
  const unit: SrtUnit = { id, line: start + 1, text: plain, ...(canUseMarkup(nodes) ? { markup: toTagged(nodes) } : {}) };
  return { unit, start, end, prefix, wrappers, raw };
}

/** 译文写成一行：标记保住按原来的标签重建，否则用纯文本；再包回外层标签 */
function cueLine(cue: Cue, output: string): string | null {
  let text: string | null = null;
  if (cue.unit.markup !== undefined) {
    const parsed = parseMarkup(output.trim(), cue.unit.markup);
    if (parsed !== null) text = rebuild(parsed, cue.raw).trim();
  }
  text ??= stripMarkers(output);
  if (text === "") return null;
  for (const w of cue.wrappers.toReversed()) text = `${w.open}${text}${w.close}`;
  return text;
}

/** 解析 SRT；格式不对抛 SrtFormatError。BOM 和换行风格（LF / CRLF）在重组时原样还原 */
export function parseSrt(source: string): SrtDoc {
  const bom = source.startsWith("﻿") ? "﻿" : "";
  const body = source.slice(bom.length);
  const eol = body.includes("\r\n") ? "\r\n" : "\n";
  const lines = body.split(/\r?\n/);
  const cues: Cue[] = [];

  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trim() === "") {
      i++;
      continue;
    }
    if (!INDEX.test(lines[i]!)) throw new SrtFormatError(i + 1, "这里应该是字幕序号（一个数字）");
    if (!TIMING.test(lines[i + 1] ?? "")) throw new SrtFormatError(i + 2, "这里应该是时间轴，如 00:00:01,000 --> 00:00:03,500");
    const start = i + 2;
    for (i = start; i < lines.length && lines[i]!.trim() !== ""; i++) {
      if (TIMING.test(lines[i]!)) throw new SrtFormatError(i + 1, "字幕文字里出现了时间轴：上一条字幕后面缺了空行");
    }
    const cue = makeCue(`s${cues.length + 1}`, lines, start, i);
    if (cue !== null) cues.push(cue);
  }

  return {
    units: cues.map((c) => c.unit),
    render(translations, options = {}) {
      const out: string[] = [];
      let pos = 0;
      for (const cue of cues) {
        out.push(...lines.slice(pos, cue.start));
        const output = translations.get(cue.unit.id);
        const line = output === undefined ? null : cueLine(cue, output);
        if (line === null) out.push(...lines.slice(cue.start, cue.end));
        else if (options.bilingual) out.push(...lines.slice(cue.start, cue.end), line);
        else out.push(cue.prefix + line);
        pos = cue.end;
      }
      out.push(...lines.slice(pos));
      return bom + out.join(eol);
    },
  };
}
