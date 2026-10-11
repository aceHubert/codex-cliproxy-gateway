/** excludedModels 多行文本框的行 ↔ 数组转换；与 log-size-field 同一模式，纯函数便于单测。 */

/** 文本框 → 规则数组：按行拆分、去首尾空白、丢空行；全空文本得到空数组（清空）。 */
export function splitExcludedLines(text: string): string[] {
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

/** 规则数组 → 文本框内容：每行一条。 */
export function joinExcludedLines(patterns: string[] | undefined): string {
  return (patterns ?? []).join("\n");
}
