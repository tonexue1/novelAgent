/**
 * 从 LLM 文本输出里稳健地抽取 JSON。模型常在 JSON 前后夹带解释文字或
 * ```json 代码围栏，这里只截取第一个 { 到最后一个 } / 第一个 [ 到最后一个 ]。
 */

/** 抽取一个 JSON 对象；失败返回 null。 */
export function extractJsonObject(text: string): Record<string, unknown> | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  try {
    const value = JSON.parse(text.slice(start, end + 1));
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** 取字符串字段，非字符串则空串。 */
export function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/** 取字符串数组：过滤非字符串与空串。 */
export function strArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => (typeof x === "string" ? x.trim() : "")).filter(Boolean);
}
