export type ValidationIssue =
  /** 输出为空 */
  | "empty"
  /** 混进了思考内容 */
  | "think"
  /** 原样照抄了原文 */
  | "same-as-source"
  /** 输出远长于原文，多半在胡言乱语或重复 */
  | "too-long"
  /** 明显不是目标语言 */
  | "wrong-language";

/**
 * 检查一段译文能不能用。返回第一个发现的问题，没问题返回 null。
 * 短文本（少于 3 个英文单词）不查「照抄」和「语言不对」：专有名词、API 名原样输出是正常的。
 */
export function validateTranslation(source: string, output: string, target: string): ValidationIssue | null {
  const out = output.trim();
  const src = source.trim();
  if (out === "") return "empty";
  if (/<\/?think\b/i.test(out)) return "think";

  const words = src.match(/[A-Za-z]+/g)?.length ?? 0;
  if (words >= 3 && normalize(out) === normalize(src)) return "same-as-source";
  if (out.length > src.length * 4 + 20) return "too-long";
  if (isChinese(target) && words >= 3 && !/\p{Script=Han}/u.test(out)) return "wrong-language";
  return null;
}

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

function isChinese(target: string): boolean {
  return target.toLowerCase().startsWith("zh");
}
