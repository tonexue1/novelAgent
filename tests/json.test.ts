import { describe, expect, test } from "bun:test";
import {
  extractJsonObject,
  escapeStrayQuotes,
  balanceBrackets,
  findArrayField,
} from "../src/core/json.ts";

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

  test("修复：模型漏写尾部 `}`，以 `]` 收尾也能解析（真实骨架失败样本形态）", () => {
    // 复刻 planner 骨架失败：worldBible 少一个 `}`，acts 被嵌进 worldBible，整体少一个尾 `}`。
    const raw =
      '{"title":"龙头渡","worldBible":{"era":"当代","tone":"冷硬","acts":[{"title":"下山","summary":"少年退学","chapters":10}]}';
    expect(() => JSON.parse(raw)).toThrow();
    const o = extractJsonObject(raw);
    expect(o).not.toBeNull();
    expect(o!.title).toBe("龙头渡");
    // acts 被错误嵌在 worldBible 里，findArrayField 深度找回。
    const acts = findArrayField(o, "acts");
    expect(acts).toHaveLength(1);
    expect((acts![0] as Record<string, unknown>).title).toBe("下山");
  });
});

describe("balanceBrackets", () => {
  test("补齐缺失的尾部 `}`", () => {
    expect(JSON.parse(balanceBrackets('{"a":1'))).toEqual({ a: 1 });
    expect(JSON.parse(balanceBrackets('{"a":[1,2]'))).toEqual({ a: [1, 2] });
  });

  test("以 `]` 收尾、缺外层 `}` 时补齐", () => {
    expect(JSON.parse(balanceBrackets('{"a":{"b":[1]'))).toEqual({ a: { b: [1] } });
  });

  test("去掉尾随逗号避免 `,}`", () => {
    expect(JSON.parse(balanceBrackets('{"a":1,'))).toEqual({ a: 1 });
  });

  test("已平衡的 JSON 不被破坏", () => {
    const s = '{"a":1,"b":[2,3]}';
    expect(JSON.parse(balanceBrackets(s))).toEqual({ a: 1, b: [2, 3] });
  });

  test("字符串里的括号不参与计数", () => {
    const s = '{"a":"里面有 { [ 括号"';
    expect(JSON.parse(balanceBrackets(s))).toEqual({ a: "里面有 { [ 括号" });
  });
});

describe("findArrayField", () => {
  test("顶层数组直接命中", () => {
    expect(findArrayField({ acts: [1, 2] }, "acts")).toEqual([1, 2]);
  });

  test("嵌套数组深度找回", () => {
    expect(findArrayField({ worldBible: { acts: [{ t: 1 }] } }, "acts")).toEqual([{ t: 1 }]);
  });

  test("缺失或非对象返回 null", () => {
    expect(findArrayField({ x: 1 }, "acts")).toBeNull();
    expect(findArrayField(null, "acts")).toBeNull();
    expect(findArrayField([1, 2, 3], "acts")).toBeNull();
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
