// 按文本长短决定译文放哪：1~4 个单词的短文本先试着放在同一行右边，5 个单词起放原文下方（主人定）。

/** 不靠空格分词的文字：中日韩、泰、老挝、高棉、缅甸 */
const NO_SPACE_SCRIPTS =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;

/** 单词：字母或数字连在一起，中间可以有撇号、连字符、小数点（don't、self-hosted、2.0） */
const WORD = /[\p{L}\p{N}]+(?:['’.\-][\p{L}\p{N}]+)*/gu;

export const INLINE_MAX_WORDS = 4;

/** 按空格分词的单词数；不靠空格分词的文字返回 null，不套用长短规则 */
export function wordCount(text: string): number | null {
  if (NO_SPACE_SCRIPTS.test(text)) return null;
  return text.match(WORD)?.length ?? 0;
}

/** 1~4 个单词的短文本：译文先试着跟在同一行右边，不撑高标题、菜单、表格这类紧凑元素 */
export function isShortText(text: string): boolean {
  const n = wordCount(text);
  return n !== null && n >= 1 && n <= INLINE_MAX_WORDS;
}
