// 段内格式：链接、加粗等元素和行内代码，在 core 里用一棵抽象的结构树表示，插件负责 DOM 和它之间的转换。
// 发给模型时写成带编号的标记文本（Goal 2 CP0 实测选定的尖括号写法）：
//   <g1>…</g1> 包住要翻译的文字（链接、加粗等），<x2/> 代表原样保留、不翻译的元素（行内代码、图片、换行）。

export type InlineNode =
  | { type: "text"; text: string }
  | { type: "tag"; id: number; children: InlineNode[] }
  | { type: "atom"; id: number; text: string };

/** 一段里标记太多时模型容易出错，超过就按纯文本翻译 */
export const MAX_MARKERS = 20;

const MARKER = /<\/?g\d+>|<x\d+\/>/;
const MARKERS = /<\/?g\d+>|<x\d+\/>/g;
const SPLIT = /(<\/?g\d+>|<x\d+\/>)/;
const CJK = /[\p{Script=Han}　-〿＀-￯]/u;

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** 去掉格式后的纯文字：标记透明，原样保留的元素用它自己的文字 */
export function plainText(nodes: readonly InlineNode[]): string {
  const rec = (ns: readonly InlineNode[]): string =>
    ns.map((n) => (n.type === "text" ? n.text : n.type === "atom" ? n.text : rec(n.children))).join("");
  return collapse(rec(nodes));
}

/** 写成带标记的文本 */
export function toTagged(nodes: readonly InlineNode[]): string {
  const rec = (ns: readonly InlineNode[]): string =>
    ns.map((n) => (n.type === "text" ? n.text : n.type === "atom" ? `<x${n.id}/>` : `<g${n.id}>${rec(n.children)}</g${n.id}>`)).join("");
  return collapse(rec(nodes));
}

/** 有格式、原文里没有长得像标记的文字、标记数不超过上限，才用带标记的翻译 */
export function canUseMarkup(nodes: readonly InlineNode[]): boolean {
  let markers = 0;
  let clash = false;
  const rec = (ns: readonly InlineNode[]) => {
    for (const n of ns) {
      if (n.type === "text") clash ||= MARKER.test(n.text);
      else if (n.type === "atom") markers += 1;
      else {
        markers += 2;
        rec(n.children);
      }
    }
  };
  rec(nodes);
  return markers > 0 && !clash && markers <= MAX_MARKERS;
}

/** 文本里的标记，按出现顺序 */
export function markersOf(tagged: string): string[] {
  return tagged.match(MARKERS) ?? [];
}

export function stripMarkers(text: string): string {
  return collapse(text.replace(MARKERS, ""));
}

export type ParsedNode =
  | { type: "text"; text: string }
  | { type: "tag"; id: number; children: ParsedNode[] }
  | { type: "atom"; id: number };

/**
 * 解析模型输出的带标记译文。原文里的每个标记必须恰好出现一次、成对标记嵌套合法、不能多出标记；
 * 标记的先后顺序可以变（语序调整）。不合格返回 null。
 */
export function parseMarkup(output: string, source: string): ParsedNode[] | null {
  const tags = new Set<number>();
  const atoms = new Set<number>();
  for (const m of markersOf(source)) {
    const id = Number(m.match(/\d+/)![0]);
    (m.startsWith("<x") ? atoms : tags).add(id);
  }

  const root: ParsedNode[] = [];
  const stack: { id: number; children: ParsedNode[] }[] = [{ id: 0, children: root }];
  const seenTags = new Set<number>();
  const seenAtoms = new Set<number>();

  for (const [i, part] of output.split(SPLIT).entries()) {
    const top = stack.at(-1)!;
    if (i % 2 === 0) {
      if (part !== "") top.children.push({ type: "text", text: part });
      continue;
    }
    const id = Number(part.match(/\d+/)![0]);
    if (part.startsWith("<x")) {
      if (!atoms.has(id) || seenAtoms.has(id)) return null;
      seenAtoms.add(id);
      top.children.push({ type: "atom", id });
    } else if (part.startsWith("</")) {
      if (top.id !== id || stack.length === 1) return null;
      stack.pop();
    } else {
      if (!tags.has(id) || seenTags.has(id)) return null;
      seenTags.add(id);
      const node: ParsedNode = { type: "tag", id, children: [] };
      top.children.push(node);
      stack.push(node);
    }
  }
  if (stack.length !== 1 || seenTags.size !== tags.size || seenAtoms.size !== atoms.size) return null;
  return root;
}

/**
 * 去掉标记两侧多余的空格：目标是中文，且标记两边最近的可见字符都是中文时，模型常把标记当英文单词前后加空格。
 * 中文和英文之间的空格保留；原样保留的元素（行内代码等）按非中文处理，两侧空格保留。
 */
export function normalizeMarkupSpacing(output: string, target: string): string {
  if (!target.toLowerCase().startsWith("zh")) return output;
  const parts = output.split(SPLIT);
  const visibleBefore = (i: number): string => {
    for (let j = i - 1; j >= 0; j--) {
      const p = parts[j]!;
      if (j % 2 === 1) {
        if (p.startsWith("<x")) return "x";
        continue;
      }
      const t = p.trimEnd();
      if (t !== "") return t.at(-1)!;
    }
    return "";
  };
  const visibleAfter = (i: number): string => {
    for (let j = i + 1; j < parts.length; j++) {
      const p = parts[j]!;
      if (j % 2 === 1) {
        if (p.startsWith("<x")) return "x";
        continue;
      }
      const t = p.trimStart();
      if (t !== "") return t[0]!;
    }
    return "";
  };
  for (let i = 0; i < parts.length; i += 2) {
    let s = parts[i]!;
    if (i > 0 && /^\s/.test(s)) {
      const after = s.trimStart()[0] ?? visibleAfter(i);
      if (CJK.test(visibleBefore(i)) && CJK.test(after)) s = s.trimStart();
    }
    if (i < parts.length - 1 && /\s$/.test(s)) {
      const before = s.trimEnd().at(-1) ?? visibleBefore(i);
      if (CJK.test(before) && CJK.test(visibleAfter(i))) s = s.trimEnd();
    }
    parts[i] = s;
  }
  return parts.join("");
}
