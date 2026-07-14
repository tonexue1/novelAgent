/**
 * 从 LLM 文本输出里稳健地抽取 JSON。模型常在 JSON 前后夹带解释文字或
 * ```json 代码围栏，这里只截取第一个 { 到最后一个 } / 第一个 [ 到最后一个 ]。
 */

function parseObject(s: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(s);
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** 从位置 i 起找到第一个非空白字符（仅 ASCII 空白）；没有则返回空串。 */
function nextNonSpace(s: string, i: number): string {
  for (let j = i; j < s.length; j++) {
    const c = s[j]!;
    if (c !== " " && c !== "\n" && c !== "\r" && c !== "\t") return c;
  }
  return "";
}

/**
 * 修复模型最常见的 JSON 破绽：在【字符串值内部】写了未转义的英文双引号
 * （如中文串里的 `"清道"`），会提前闭合字符串导致 JSON.parse 失败。
 *
 * 扫描式启发：处于字符串内时，遇到 `"` 仅当其后第一个非空白字符是结构分隔符
 * （`:` `,` `}` `]` 或串尾）才视为闭合引号，否则判定为游离内引号并转义为 `\"`。
 * 已转义的 `\"` 原样跳过。只在直接解析失败时兜底调用，对合法 JSON 无副作用。纯函数。
 */
export function escapeStrayQuotes(json: string): string {
  let out = "";
  let inStr = false;
  for (let i = 0; i < json.length; i++) {
    const ch = json[i]!;
    if (!inStr) {
      out += ch;
      if (ch === '"') inStr = true;
      continue;
    }
    if (ch === "\\") {
      // 保留转义对（如 \" \\ \n），整体照搬。
      out += ch + (json[i + 1] ?? "");
      i++;
      continue;
    }
    if (ch === '"') {
      const nxt = nextNonSpace(json, i + 1);
      if (nxt === "" || nxt === ":" || nxt === "," || nxt === "}" || nxt === "]") {
        out += ch; // 真·闭合引号
        inStr = false;
      } else {
        out += '\\"'; // 游离内引号 → 转义
      }
      continue;
    }
    out += ch;
  }
  return out;
}

/** 抽取一个 JSON 对象；失败返回 null。解析失败时尝试修复游离双引号再解析一次。 */
export function extractJsonObject(text: string): Record<string, unknown> | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  const slice = text.slice(start, end + 1);
  return parseObject(slice) ?? parseObject(escapeStrayQuotes(slice));
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
