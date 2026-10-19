// Markdown 分段与重组：只替换要翻的文字，其余逐字不动（换行风格、空行、缩进、代码块、链接地址都原样）。
// 覆盖常见写法：标题、段落、列表项、引用、表格单元格；跳过围栏和缩进代码块、front matter、HTML 块、链接和脚注定义、只有链接或图片的行。
// 认不出的写法原样保留、不翻。段内的链接、加粗、斜体、删除线、行内代码、图片按插件同一套标记发给模型（<gN>…</gN>、<xN/>），
// 翻完按原来的符号写回；标记没保住就按纯文本译文写回 -- 丢格式，不丢文字。
import { canUseMarkup, parseMarkup, plainText, stripMarkers, toTagged, type InlineNode, type ParsedNode } from "../inline.ts";

/** 一段要翻的文字：text 是纯文本；有格式时 markup 是带标记的写法 */
export interface MarkdownUnit {
  id: string;
  /** 在原文件里从第几行开始（1 起），报错时用 */
  line: number;
  text: string;
  markup?: string;
}

export interface MarkdownDoc {
  units: MarkdownUnit[];
  /** translations：段落 id → 模型的译文（可能带标记）；没有译文的段落保留原文 */
  render(translations: ReadonlyMap<string, string>, options?: { bilingual?: boolean }): string;
}

type Syntax = { kind: "tag"; open: string; close: string; link: boolean } | { kind: "atom"; raw: string };

interface UnitData {
  unit: MarkdownUnit;
  /** 原文的 Markdown 写法：没有译文时原样写回 */
  source: string;
  syntax: Map<number, Syntax>;
}

type Layout =
  | { type: "heading"; prefix: string; suffix: string; setext: boolean }
  | { type: "paragraph"; indent: string }
  | { type: "item"; prefix: string; continuation: string };

interface Cell {
  lead: string;
  trail: string;
  raw: string;
  data: UnitData | null;
}

// 每个块记下它在原文里的行号（start 起 count 行）：没翻的块按原来的行逐字写回
type Block =
  | { kind: "raw"; start: number }
  | { kind: "unit"; start: number; count: number; data: UnitData; layout: Layout }
  | { kind: "row"; start: number; indent: string; lead: boolean; trail: string; cells: Cell[] }
  | { kind: "quote"; start: number; prefixes: string[]; lines: string[]; inner: Block[] };

/** 输出的一行；src 是原样写回的原文行号 */
interface Line {
  text: string;
  src?: number;
}

// ---------- 行内 ----------

const ESCAPABLE = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/;
const WORD = /[\p{L}\p{N}]/u;

/** 从 i 处的反引号串开始，找到配对的结束位置（结束串之后）；不成对返回 -1 */
function codeSpanEnd(s: string, i: number): number {
  const run = /^`+/.exec(s.slice(i))![0];
  for (let j = s.indexOf(run, i + run.length); j > 0; j = s.indexOf(run, j + 1)) {
    let k = j + run.length;
    if (s[j - 1] !== "`" && s[k] !== "`") return k;
    while (s[k] === "`") k++;
    j = k - 1;
  }
  return -1;
}

/** 从 i 开始找配对的右括号，跳过转义和行内代码；找不到返回 -1 */
function matchClose(s: string, i: number, open: string, close: string): number {
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    const c = s[j]!;
    if (c === "\\") j++;
    else if (c === "`") {
      const end = codeSpanEnd(s, j);
      if (end > 0) j = end - 1;
    } else if (c === open) depth++;
    else if (c === close && --depth === 0) return j;
  }
  return -1;
}

/** 找强调的结束符：同一种符号、长度相同、前面不是空白；_ 后面不能紧跟字母数字（snake_case 不算） */
function emphasisClose(s: string, from: number, delim: string): number {
  const ch = delim[0]!;
  for (let j = from; j < s.length; j++) {
    const c = s[j]!;
    if (c === "\\") {
      j++;
      continue;
    }
    if (c === "`") {
      const end = codeSpanEnd(s, j);
      if (end > 0) j = end - 1;
      continue;
    }
    if (c !== ch) continue;
    let k = j;
    while (s[k] === ch) k++;
    if (k - j === delim.length && j > from && !/\s/.test(s[j - 1]!) && !(ch === "_" && WORD.test(s[k] ?? ""))) return j;
    j = k - 1;
  }
  return -1;
}

function parseInline(src: string): { nodes: InlineNode[]; syntax: Map<number, Syntax> } {
  const syntax = new Map<number, Syntax>();
  let nextId = 1;

  const parse = (s: string): InlineNode[] => {
    const nodes: InlineNode[] = [];
    let text = "";
    const flush = () => {
      if (text !== "") nodes.push({ type: "text", text });
      text = "";
    };
    const atom = (raw: string, plain: string) => {
      flush();
      const id = nextId++;
      syntax.set(id, { kind: "atom", raw });
      nodes.push({ type: "atom", id, text: plain });
    };
    const tag = (open: string, inner: string, close: string, link: boolean) => {
      flush();
      const id = nextId++;
      syntax.set(id, { kind: "tag", open, close, link });
      nodes.push({ type: "tag", id, children: parse(inner) });
    };

    let i = 0;
    while (i < s.length) {
      const rest = s.slice(i);
      const c = s[i]!;
      // 转义字符
      if (c === "\\" && ESCAPABLE.test(s[i + 1] ?? "")) {
        atom(s.slice(i, i + 2), s[i + 1]!);
        i += 2;
        continue;
      }
      // 行内代码
      if (c === "`") {
        const run = /^`+/.exec(rest)![0];
        const end = codeSpanEnd(s, i);
        if (end > 0) {
          atom(s.slice(i, end), s.slice(i + run.length, end - run.length).trim());
          i = end;
        } else {
          text += run;
          i += run.length;
        }
        continue;
      }
      // 脚注引用 [^1]
      const footnote = /^\[\^[^\]\s]+\]/.exec(rest);
      if (footnote !== null) {
        atom(footnote[0], "");
        i += footnote[0].length;
        continue;
      }
      // 图片：整个原样保留（alt 不翻）
      if (rest.startsWith("![")) {
        const close = matchClose(s, i + 1, "[", "]");
        const end = close > 0 && s[close + 1] === "(" ? matchClose(s, close + 1, "(", ")") : -1;
        if (end > 0) {
          atom(s.slice(i, end + 1), "");
          i = end + 1;
          continue;
        }
      }
      // 链接 [文字](地址)、[文字][引用]：文字翻译，地址原样
      if (c === "[") {
        const close = matchClose(s, i, "[", "]");
        const next = close < 0 ? "" : s[close + 1];
        const end = next === "(" ? matchClose(s, close + 1, "(", ")") : next === "[" ? s.indexOf("]", close + 2) : -1;
        if (end > 0) {
          tag("[", s.slice(i + 1, close), s.slice(close, end + 1), true);
          i = end + 1;
          continue;
        }
      }
      // 自动链接、行内 HTML
      if (c === "<") {
        const m =
          /^<(?:[A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*|[^\s<>@]+@[^\s<>@]+)>/.exec(rest) ??
          /^(?:<\/?[A-Za-z][A-Za-z0-9-]*(?:\s[^<>]*)?\/?>|<!--[\s\S]*?-->)/.exec(rest);
        if (m !== null) {
          atom(m[0], "");
          i += m[0].length;
          continue;
        }
      }
      // 加粗、斜体、删除线：开头符号后面不是空白；_ 前面紧跟字母数字时不算（snake_case）
      const delim = /^(\*\*|__|~~|\*|_)/.exec(rest)?.[1];
      if (delim !== undefined && /\S/.test(s[i + delim.length] ?? " ") && !(delim[0] === "_" && WORD.test(s[i - 1] ?? ""))) {
        const end = emphasisClose(s, i + delim.length, delim);
        if (end > 0) {
          tag(delim, s.slice(i + delim.length, end), delim, false);
          i = end + delim.length;
          continue;
        }
      }
      // 普通文字：同一种符号连写的整串一起跳过，免得把 *** 的后半截当成开头
      const run = /^([*_~])\1*/.exec(rest)?.[0] ?? c;
      text += run;
      i += run.length;
    }
    flush();
    return nodes;
  };

  return { nodes: parse(src), syntax };
}

// 译文没有空格分词，强调符号常常紧贴文字和标点。按 CommonMark 的左右侧规则，有两种写法会失效：
//   标点在符号里侧、外侧紧贴文字（「**注意：**这是」）→ 把首尾标点挪到符号外面（「**注意**：这是」）
//   _ 外侧紧贴文字（「这是_重点_内容」）→ 改用 *
// 只在符号外侧紧贴文字时调整，两侧是空格或标点时保持原来的写法。
const SPACE_OR_PUNCT = /[\s\p{P}\p{S}]/u;
const MARKDOWN_PUNCT = "*_~[]()`\\<>!";
const isPunct = (c: string) => /\p{P}/u.test(c) && !MARKDOWN_PUNCT.includes(c);

function rebuild(nodes: readonly ParsedNode[], syntax: Map<number, Syntax>): string {
  type Part = string | { mark: string; inner: string };
  const parts: Part[] = nodes.map((n) => {
    if (n.type === "text") return n.text.replace(/\s*\n\s*/g, " ");
    const s = syntax.get(n.id)!;
    if (n.type === "atom" || s.kind === "atom") return s.kind === "atom" ? s.raw : "";
    const inner = rebuild(n.children, syntax);
    return s.link ? `${s.open}${inner}${s.close}` : { mark: s.open, inner };
  });
  const edge = (p: Part | undefined, last: boolean) => (p === undefined ? undefined : typeof p === "string" ? (last ? p.at(-1) : p[0]) : p.mark[0]);
  return parts
    .map((p, k) => {
      if (typeof p === "string") return p;
      const before = edge(parts[k - 1], true);
      const after = edge(parts[k + 1], false);
      const tight = (c: string | undefined) => c !== undefined && !SPACE_OR_PUNCT.test(c);
      if (!tight(before) && !tight(after)) return `${p.mark}${p.inner}${p.mark}`;
      const mark = p.mark.replaceAll("_", "*");
      let a = 0;
      let b = p.inner.length;
      while (a < b && isPunct(p.inner[a]!)) a++;
      while (b > a && isPunct(p.inner[b - 1]!)) b--;
      if (a === b) return `${mark}${p.inner}${mark}`;
      return `${p.inner.slice(0, a)}${mark}${p.inner.slice(a, b)}${mark}${p.inner.slice(b)}`;
    })
    .join("");
}

/** 只有链接、图片和分隔符号（徽章行、导航行）：不翻 */
function onlyLinks(nodes: readonly InlineNode[], syntax: Map<number, Syntax>): boolean {
  return nodes.every((n) => {
    if (n.type === "text") return /^[\s|·•,;/\\-]*$/.test(n.text);
    if (n.type === "atom") return true;
    const s = syntax.get(n.id)!;
    return (s.kind === "tag" && s.link) || onlyLinks(n.children, syntax);
  });
}

/** 文字部分（不算行内代码、链接地址等原样保留的部分）有没有字母 */
function hasWords(nodes: readonly InlineNode[]): boolean {
  return nodes.some((n) => (n.type === "text" ? /\p{L}/u.test(n.text) : n.type === "tag" && hasWords(n.children)));
}

// ---------- 块 ----------

const FENCE = /^(\s*)(`{3,}|~{3,})/;
const HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const ATX = /^( {0,3}#{1,6})([ \t]+)(.*?)((?:[ \t]+#+)?[ \t]*)$/;
const QUOTE = /^( {0,3}> ?)/;
const ITEM = /^( *)([-*+]|\d{1,9}[.)])( +)(\[[ xX]\] +)?(.*)$/;
const LINK_DEF = /^ {0,3}\[[^\]]+\]:\s*\S/;
const TABLE_DELIM = /^ *\|? *:?-+:? *(\| *:?-+:? *)*\|? *$/;
const SETEXT = /^ {0,3}(=+|-+)[ \t]*$/;
// HTML 块：CommonMark 的块级标签开头、单独一行的完整标签、注释；段落里的 <kbd> 等按段内格式原样保留
const RAW_TAGS = "pre|script|style|textarea";
const BLOCK_TAGS =
  "address|article|aside|blockquote|body|center|details|dialog|dd|div|dl|dt|fieldset|figcaption|figure|footer|form|h[1-6]|head|header|hr|html|iframe|li|main|nav|ol|p|picture|section|summary|table|tbody|td|tfoot|th|thead|tr|ul|video|audio|img|br";
const HTML_BLOCK = new RegExp(
  `^ {0,3}(?:<!--|<(?:${RAW_TAGS})(?:[\\s>]|$)|<\\/?(?:${BLOCK_TAGS})(?:[\\s/>]|$)|<\\/?[A-Za-z][A-Za-z0-9-]*(?:\\s[^<>]*)?\\/?>\\s*$)`,
  "i",
);
const RAW_START = new RegExp(`^\\s*<(?:${RAW_TAGS})`, "i");
const RAW_END = new RegExp(`</(?:${RAW_TAGS})>`, "i");

function startsBlock(line: string): boolean {
  return FENCE.test(line) || HR.test(line) || ATX.test(line) || QUOTE.test(line) || ITEM.test(line) || HTML_BLOCK.test(line);
}

const isDelimRow = (line: string | undefined) => line !== undefined && line.includes("|") && line.includes("-") && TABLE_DELIM.test(line);

/** 表格一行拆成单元格，\| 不算分隔 */
function splitRow(line: string): { indent: string; lead: boolean; trail: string; cells: string[] } {
  const indent = /^\s*/.exec(line)![0];
  let body = line.slice(indent.length);
  const lead = body.startsWith("|");
  if (lead) body = body.slice(1);
  const end = /(?<!\\)\|\s*$/.exec(body);
  const trail = end === null ? "" : end[0];
  if (end !== null) body = body.slice(0, end.index);
  return { indent, lead, trail, cells: body.split(/(?<!\\)\|/) };
}

class Parser {
  readonly units: MarkdownUnit[] = [];
  #next = 1;

  /** 一段文字成为要翻的单元；没有要翻的字（数字、代码、只有链接图片）返回 null，原样保留 */
  unit(source: string, line: number): UnitData | null {
    const text = source.trim();
    if (!/\p{L}/u.test(text)) return null;
    const { nodes, syntax } = parseInline(text);
    if (!hasWords(nodes) || onlyLinks(nodes, syntax)) return null;
    const unit: MarkdownUnit = { id: `m${this.#next++}`, line: line + 1, text: plainText(nodes), ...(canUseMarkup(nodes) ? { markup: toTagged(nodes) } : {}) };
    this.units.push(unit);
    return { unit, source: text, syntax };
  }

  /** offset：lines 在原文件里的起始行号（引用里的内容是去掉 > 后单独解析的） */
  parse(lines: readonly string[], offset = 0): Block[] {
    const blocks: Block[] = [];
    const raw = (start: number) => blocks.push({ kind: "raw", start });
    const unit = (start: number, end: number, data: UnitData | null, layout: Layout) => {
      if (data !== null) blocks.push({ kind: "unit", start, count: end - start, data, layout });
      else for (let k = start; k < end; k++) raw(k);
    };
    let i = 0;
    let inList = false;

    // front matter：文件开头 --- 包住的 YAML（或 +++ 包住的 TOML）
    if (lines[0] === "---" || lines[0] === "+++") {
      const end = lines.findIndex((l, j) => j > 0 && (l === lines[0] || (lines[0] === "---" && l === "...")));
      if (end > 0) for (; i <= end; i++) raw(i);
    }

    while (i < lines.length) {
      const line = lines[i]!;
      if (line.trim() === "") {
        raw(i++);
        continue;
      }
      // 顶格的非列表内容结束列表；列表里缩进的内容不算缩进代码块
      if (!/^\s/.test(line) && !ITEM.test(line)) inList = false;
      if (!inList && /^( {4}|\t)/.test(line)) {
        for (; i < lines.length && (/^( {4}|\t)/.test(lines[i]!) || lines[i]!.trim() === ""); i++) raw(i);
        continue;
      }
      // 围栏代码块：结束符同一种符号、不短于开头
      const fence = FENCE.exec(line);
      if (fence !== null) {
        const close = new RegExp(`^\\s*\\${fence[2]![0]}{${fence[2]!.length},}\\s*$`);
        raw(i);
        for (i++; i < lines.length; i++) {
          raw(i);
          if (close.test(lines[i]!)) {
            i++;
            break;
          }
        }
        continue;
      }
      // HTML 块：注释到 -->，pre / script / style / textarea 到结束标签，其他到空行
      if (HTML_BLOCK.test(line)) {
        const done = line.trimStart().startsWith("<!--")
          ? (j: number) => lines[j]!.includes("-->")
          : RAW_START.test(line)
            ? (j: number) => RAW_END.test(lines[j]!)
            : (j: number) => (lines[j + 1] ?? "").trim() === "";
        for (; i < lines.length; i++) {
          raw(i);
          if (done(i)) {
            i++;
            break;
          }
        }
        continue;
      }
      // 链接定义、脚注定义、分隔线
      if (LINK_DEF.test(line) || HR.test(line)) {
        raw(i++);
        continue;
      }
      // ATX 标题
      const atx = ATX.exec(line);
      if (atx !== null) {
        unit(i, i + 1, this.unit(atx[3]!, offset + i), { type: "heading", prefix: atx[1]! + atx[2]!, suffix: atx[4]!, setext: false });
        i++;
        continue;
      }
      // 表格：表头行、分隔行、数据行，到空行或不带 | 的行为止
      if (line.includes("|") && isDelimRow(lines[i + 1])) {
        for (let row = 0; i < lines.length && lines[i]!.trim() !== "" && lines[i]!.includes("|"); i++, row++) {
          if (row === 1) {
            raw(i);
            continue;
          }
          const { indent, lead, trail, cells } = splitRow(lines[i]!);
          blocks.push({
            kind: "row",
            start: i,
            indent,
            lead,
            trail,
            cells: cells.map((cell) => ({ lead: /^\s*/.exec(cell)![0], trail: /\s*$/.exec(cell)![0], raw: cell.trim(), data: this.unit(cell, offset + i) })),
          });
        }
        continue;
      }
      // 引用：去掉一层 >，里面按 Markdown 再解析一遍
      if (QUOTE.test(line)) {
        const start = i;
        const prefixes: string[] = [];
        const inner: string[] = [];
        for (; i < lines.length && QUOTE.test(lines[i]!); i++) {
          const prefix = QUOTE.exec(lines[i]!)![1]!;
          prefixes.push(prefix);
          inner.push(lines[i]!.slice(prefix.length));
        }
        blocks.push({ kind: "quote", start, prefixes, lines: inner, inner: this.parse(inner, offset + start) });
        continue;
      }
      // 列表项：第一行加上紧接着的续行，合成一行翻
      const item = ITEM.exec(line);
      if (item !== null) {
        const [, indent, marker, gap, task = "", first] = item;
        const start = i;
        const text = [first!];
        for (i++; i < lines.length && lines[i]!.trim() !== "" && !startsBlock(lines[i]!); i++) text.push(lines[i]!.trim());
        const continuation = " ".repeat(indent!.length + marker!.length + gap!.length);
        unit(start, i, this.unit(text.join(" "), offset + start), { type: "item", prefix: indent! + marker! + gap! + task, continuation });
        inList = true;
        continue;
      }
      // 段落：到空行或下一个块为止；下一行是 === / --- 时是 setext 标题
      const start = i;
      const indent = /^\s*/.exec(line)![0];
      let setext = false;
      for (; i < lines.length && lines[i]!.trim() !== ""; i++) {
        if (i > start && SETEXT.test(lines[i]!)) {
          setext = true;
          break;
        }
        if (i > start && startsBlock(lines[i]!)) break;
      }
      const para = lines.slice(start, i);
      // 定义列表（「: 释义」开头的行）不是标准写法，整段原样保留
      const data = para.some((l) => /^\s*:\s/.test(l)) ? null : this.unit(para.map((l) => l.trim()).join(" "), offset + start);
      if (setext) i++;
      unit(start, i, data, setext ? { type: "heading", prefix: indent, suffix: "", setext } : { type: "paragraph", indent });
    }
    return blocks;
  }
}

/** 译文写回成 Markdown：标记保住就按原来的符号重建，否则用纯文本；没有译文返回 null */
function translated(data: UnitData, translations: ReadonlyMap<string, string>): string | null {
  const output = translations.get(data.unit.id);
  if (output === undefined) return null;
  if (data.unit.markup !== undefined) {
    const parsed = parseMarkup(output.trim(), data.unit.markup);
    if (parsed !== null) return rebuild(parsed, data.syntax).trim();
  }
  return stripMarkers(output);
}

function renderBlocks(blocks: readonly Block[], lines: readonly string[], translations: ReadonlyMap<string, string>, bilingual: boolean): Line[] {
  const out: Line[] = [];
  const original = (start: number, count = 1) => {
    for (let k = start; k < start + count; k++) out.push({ text: lines[k]!, src: k });
  };
  for (const b of blocks) {
    if (b.kind === "raw") {
      original(b.start);
    } else if (b.kind === "quote") {
      // 原样的行用它原来的 > 前缀；新写的行统一用第一行的前缀
      const marker = b.prefixes[0]!.trimEnd();
      for (const l of renderBlocks(b.inner, b.lines, translations, bilingual)) {
        if (l.src !== undefined) out.push({ text: b.prefixes[l.src]! + l.text, src: b.start + l.src });
        else out.push({ text: l.text === "" ? marker : `${marker} ${l.text}` });
      }
    } else if (b.kind === "row") {
      const done = b.cells.map((c) => (c.data === null ? null : translated(c.data, translations)));
      if (done.every((t) => t === null)) {
        original(b.start);
        continue;
      }
      const cells = b.cells.map((c, k) => {
        const t = done[k]?.replace(/(?<!\\)\|/g, "\\|");
        if (t === undefined) return c.lead + c.raw + c.trail;
        return c.lead + (bilingual ? `${c.raw}<br>${t}` : t) + c.trail;
      });
      out.push({ text: `${b.indent}${b.lead ? "|" : ""}${cells.join("|")}${b.trail}` });
    } else {
      const t = translated(b.data, translations);
      const l = b.layout;
      if (t === null) {
        original(b.start, b.count);
      } else if (l.type === "heading") {
        // 双语标题写成「原文 / 译文」一行，目录里不会多出一个标题
        out.push({ text: l.prefix + (bilingual ? `${b.data.source} / ${t}` : t) + l.suffix });
        if (l.setext) original(b.start + b.count - 1);
      } else if (l.type === "item") {
        // 双语：原文行尾用反斜杠换行，译文缩进到列表内容那一列
        if (bilingual) out.push({ text: `${l.prefix}${b.data.source}\\` }, { text: l.continuation + t });
        else out.push({ text: l.prefix + t });
      } else {
        if (bilingual) {
          original(b.start, b.count);
          out.push({ text: "" });
        }
        out.push({ text: l.indent + t });
      }
    }
  }
  return out;
}

/** 解析 Markdown；BOM 和换行风格（LF / CRLF）在重组时原样还原 */
export function parseMarkdown(source: string): MarkdownDoc {
  const bom = source.startsWith("﻿") ? "﻿" : "";
  const body = source.slice(bom.length);
  const eol = body.includes("\r\n") ? "\r\n" : "\n";
  const lines = body.split(/\r?\n/);
  const parser = new Parser();
  const blocks = parser.parse(lines);
  return {
    units: parser.units,
    render: (translations, options = {}) =>
      bom +
      renderBlocks(blocks, lines, translations, options.bilingual ?? false)
        .map((l) => l.text)
        .join(eol),
  };
}
