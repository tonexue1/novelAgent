import { describe, expect, test } from "bun:test";
import { extractJsonObject, escapeStrayQuotes } from "../src/core/json.ts";

describe("extractJsonObject", () => {
  test("直接解析合法 JSON", () => {
    const o = extractJsonObject('前言{"a":1,"b":"文字"}后记');
    expect(o).toEqual({ a: 1, b: "文字" });
  });

  test("非对象/无花括号返回 null", () => {
    expect(extractJsonObject("没有 JSON")).toBeNull();
    expect(extractJsonObject("[1,2,3]")).toBeNull();
  });

  test("修复：字符串值内未转义的英文双引号（真实失败样本）", () => {
    // 复刻 planner 细化失败的样本：中文串里的 "清道" 破坏了 JSON。
    const raw =
      '{"chapters":[{"title":"风雪北道","goal":"遭遇专为截杀散修而设的"清道"修士，初试脱身。","keyBeats":["风雪相阻"]}]}';
    // 直接 JSON.parse 会失败，extractJsonObject 应修复后解析成功。
    expect(() => JSON.parse(raw)).toThrow();
    const o = extractJsonObject(raw);
    expect(o).not.toBeNull();
    const chapters = o!.chapters as Array<Record<string, unknown>>;
    expect(chapters).toHaveLength(1);
    expect(chapters[0]!.title).toBe("风雪北道");
    expect(chapters[0]!.goal).toBe('遭遇专为截杀散修而设的"清道"修士，初试脱身。');
  });

  test("修复：多处游离引号", () => {
    const raw = '{"a":"他说"走"，我便"走"了","b":"正常"}';
    const o = extractJsonObject(raw);
    expect(o).not.toBeNull();
    expect(o!.a).toBe('他说"走"，我便"走"了');
    expect(o!.b).toBe("正常");
  });
});

describe("escapeStrayQuotes", () => {
  test("合法 JSON 原样返回（可再次解析）", () => {
    const s = '{"a":"x","b":["y","z"],"c":1}';
    expect(JSON.parse(escapeStrayQuotes(s))).toEqual({ a: "x", b: ["y", "z"], c: 1 });
  });

  test("闭合引号后接结构符（: , } ]）不被误转义", () => {
    const s = '{"k":"v"}';
    expect(escapeStrayQuotes(s)).toBe('{"k":"v"}');
  });

  test("已转义的引号保持不变", () => {
    const s = '{"a":"含\\"转义\\"引号"}';
    expect(escapeStrayQuotes(s)).toBe(s);
    expect(JSON.parse(escapeStrayQuotes(s))).toEqual({ a: '含"转义"引号' });
  });
});
