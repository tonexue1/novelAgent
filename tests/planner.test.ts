import { describe, expect, test } from "bun:test";
import { parseOutline, parseWorldBible } from "../src/story/planner.ts";

describe("parseOutline", () => {
  test("解析完整大纲结果并顺序编号", () => {
    const r = parseOutline(
      JSON.stringify({
        title: "断刀行",
        premise: "少年寻仇",
        logline: "一把断刀引出江湖旧案",
        throughline: "复仇与真相",
        ending: "放下屠刀",
        worldBible: { era: "南宋", tone: "冷硬", factions: ["血刀门"] },
        chapters: [
          { title: "下山", goal: "少年立誓下山", keyBeats: ["拜别师父"] },
          { title: "初遇", goal: "遭遇夺谱局" },
        ],
      }),
    );
    expect(r).not.toBeNull();
    expect(r!.title).toBe("断刀行");
    expect(r!.outline.chapters).toHaveLength(2);
    expect(r!.outline.chapters[0]!.n).toBe(1);
    expect(r!.outline.chapters[1]!.n).toBe(2);
    expect(r!.outline.chapters[0]!.status).toBe("planned");
    expect(r!.worldBible.factions).toContain("血刀门");
  });

  test("被文字/围栏包裹也能解析", () => {
    const r = parseOutline('```json\n{"title":"x","chapters":[{"title":"a","goal":"g"}]}\n```');
    expect(r).not.toBeNull();
    expect(r!.outline.chapters).toHaveLength(1);
  });

  test("无章节返回 null（交上层兜底）", () => {
    expect(parseOutline('{"title":"x","chapters":[]}')).toBeNull();
    expect(parseOutline("不是 JSON")).toBeNull();
  });

  test("过滤缺 goal 的章节", () => {
    const r = parseOutline('{"chapters":[{"title":"a","goal":"g"},{"title":"无目标"}]}');
    expect(r!.outline.chapters).toHaveLength(1);
  });
});

describe("parseWorldBible", () => {
  test("解析字段与数组，缺失给空", () => {
    const wb = parseWorldBible('{"era":"明","factions":["东厂"],"locations":[]}');
    expect(wb.era).toBe("明");
    expect(wb.factions).toEqual(["东厂"]);
    expect(wb.locations).toEqual([]);
    expect(wb.items).toEqual([]);
  });

  test("非 JSON 返回空圣经", () => {
    const wb = parseWorldBible("乱码");
    expect(wb.era).toBe("");
    expect(wb.factions).toEqual([]);
  });
});
