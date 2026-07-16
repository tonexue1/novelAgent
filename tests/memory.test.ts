import { describe, expect, test } from "bun:test";
import { entityKey, mergeCapped } from "../src/story/memory.ts";

describe("entityKey", () => {
  test("剥史诗前缀 + 取分隔符前主名，同一实体归一", () => {
    const a = entityKey("幽冥魔宫万年私域偏殿暖阁——黑玉壁纹深处藏沉睡旧物");
    const b = entityKey("幽冥魔宫私域偏殿暖阁：魔尊私域，已迎来第三人");
    expect(a).toBe(b);
  });

  test("不同实体主名不会误并", () => {
    const a = entityKey("偏殿暖阁——黑玉砌壁");
    const b = entityKey("血卫夜宴大殿——玄冰铺就");
    expect(a).not.toBe(b);
  });
});

describe("mergeCapped 实体级去重", () => {
  test("同一地点仅史诗前缀/尾述不同的多条塌成一条，保留最新表述", () => {
    const base = [
      "幽冥魔宫万年私域偏殿暖阁——黑玉壁纹深处藏沉睡旧物",
      "幽冥魔宫万年私域偏殿暖阁：魔尊私域，已迎来第三人",
    ];
    const add = ["幽冥魔宫私域偏殿暖阁：新增熬药台细节（最新）"];
    const out = mergeCapped(base, add);
    const 偏殿 = out.filter((s) => s.includes("偏殿暖阁"));
    expect(偏殿.length).toBe(1);
    expect(偏殿[0]).toBe("幽冥魔宫私域偏殿暖阁：新增熬药台细节（最新）");
  });

  test("不同地点各自保留", () => {
    const out = mergeCapped(
      ["偏殿暖阁——黑玉砌壁"],
      ["血卫夜宴大殿——玄冰铺就", "九幽寒池——池底封剑"],
    );
    expect(out.length).toBe(3);
  });

  test("超过 cap 时保留最近活跃的条目", () => {
    const base = Array.from({ length: 45 }, (_, i) => `地点${i}——描述`);
    const out = mergeCapped(base, ["地点0——被再次提及（应保活）"]);
    expect(out.length).toBe(40);
    expect(out).toContain("地点0——被再次提及（应保活）");
  });
});
