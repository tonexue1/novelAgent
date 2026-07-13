import { describe, expect, test } from "bun:test";
import { GENRES, DEFAULT_GENRE, resolveGenre } from "../src/story/genre.ts";

describe("resolveGenre", () => {
  test("空/未定义回落默认武侠", () => {
    expect(resolveGenre()).toBe(DEFAULT_GENRE);
    expect(resolveGenre("")).toBe(DEFAULT_GENRE);
    expect(resolveGenre("   ")).toBe(DEFAULT_GENRE);
    expect(resolveGenre(null)).toBe(DEFAULT_GENRE);
    expect(DEFAULT_GENRE.id).toBe("wuxia");
  });

  test("按 id 命中预设（大小写不敏感）", () => {
    expect(resolveGenre("xianxia").id).toBe("xianxia");
    expect(resolveGenre("XianXia").id).toBe("xianxia");
    expect(resolveGenre("xuanhuan").label).toBe("玄幻");
  });

  test("按中文 label 命中预设", () => {
    expect(resolveGenre("仙侠").id).toBe("xianxia");
    expect(resolveGenre("武侠").id).toBe("wuxia");
    expect(resolveGenre("科幻").id).toBe("scifi");
  });

  test("未匹配的非空输入 → 自定义题材", () => {
    const g = resolveGenre("无限流");
    expect(g.id).toBe("custom");
    expect(g.label).toBe("无限流");
    expect(g.persona).toBe("无限流小说");
    expect(g.worldGuidance).toBeTruthy();
  });

  test("自定义题材已含'小说'后缀时不重复拼接", () => {
    const g = resolveGenre("赛博朋克小说");
    expect(g.persona).toBe("赛博朋克小说");
  });

  test("每个预设题材字段完整", () => {
    for (const g of GENRES) {
      expect(g.id).toBeTruthy();
      expect(g.label).toBeTruthy();
      expect(g.persona).toBeTruthy();
      expect(g.worldGuidance).toBeTruthy();
      expect(typeof g.styleGuidance).toBe("string");
    }
  });
});
