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

/**
 * 补齐缺失的右括号/右方括号。模型在超长 JSON 里偶尔漏写闭合括号（最典型是漏掉
 * 嵌套对象的 `}`，导致整份对象少一个尾 `}`，此时输出常以 `]` 收尾——按 `}` 截取反而
 * 会把内容切断）。这里字符串感知地统计未闭合的 `{` `[`，在末尾按 LIFO 追加对应闭合符。
 * 只在直接解析失败时兜底调用；对已平衡的 JSON 仅去掉尾随逗号，无其它副作用。纯函数。
 */
export function balanceBrackets(json: string): string {
  const stack: string[] = [];
  let inStr = false;
  let esc = false;
  for (let i = 0; i < json.length; i++) {
    const c = json[i]!;
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{" || c === "[") stack.push(c);
    else if (c === "}") {
      if (stack[stack.length - 1] === "{") stack.pop();
    } else if (c === "]") {
      if (stack[stack.length - 1] === "[") stack.pop();
    }
  }
  let out = json.replace(/,\s*$/, ""); // 去掉尾随逗号，避免追加闭合符后出现 `,}`
  for (let i = stack.length - 1; i >= 0; i--) out += stack[i] === "{" ? "}" : "]";
  return out;
}

/** 抽取一个 JSON 对象；失败返回 null。依次尝试：直接解析 → 修复游离双引号 → 补齐缺失括号。 */
export function extractJsonObject(text: string): Record<string, unknown> | null {
  const start = text.indexOf("{");
  if (start === -1) return null;
  const end = text.lastIndexOf("}");
  if (end > start) {
    const slice = text.slice(start, end + 1);
    const direct = parseObject(slice) ?? parseObject(escapeStrayQuotes(slice));
    if (direct) return direct;
  }
  // 兜底：模型漏写尾部闭合括号时，从首个 `{` 起补齐括号再解析（不能依赖 lastIndexOf("}")）。
  const rest = text.slice(start);
  return (
    parseObject(balanceBrackets(rest)) ?? parseObject(balanceBrackets(escapeStrayQuotes(rest)))
  );
}

/**
 * 在已解析对象里深度优先查找首个名为 key 的数组字段（含嵌套对象内）。
 * 用于兜底：模型漏写某层 `}` 时，本应在顶层的数组（如 acts）会被错误嵌进上一个对象里。
 */
export function findArrayField(obj: unknown, key: string): unknown[] | null {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  const rec = obj as Record<string, unknown>;
  if (Array.isArray(rec[key])) return rec[key] as unknown[];
  for (const v of Object.values(rec)) {
    const found = findArrayField(v, key);
    if (found) return found;
  }
  return null;
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
