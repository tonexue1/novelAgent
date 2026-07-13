import { describe, expect, test } from "bun:test";
import {
  parseOutline,
  parseWorldBible,
  parseSkeleton,
  parseTargetChapters,
  normalizeActCounts,
} from "../src/story/planner.ts";

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

  test("剥离标题里的'第X章/第X回'编号前缀", () => {
    const r = parseOutline(
      '{"chapters":[{"title":"第一章 血溅寒炉","goal":"g"},{"title":"第十二回·光明顶","goal":"g2"}]}',
    );
    expect(r!.outline.chapters[0]!.title).toBe("血溅寒炉");
    expect(r!.outline.chapters[1]!.title).toBe("光明顶");
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

describe("parseTargetChapters", () => {
  test("取提示里最大整数并钳制到 [3,2000]", () => {
    expect(parseTargetChapters("10 章（请严格规划为 10 章）")).toBe(10);
    expect(parseTargetChapters("6 到 10 章")).toBe(10);
    expect(parseTargetChapters("1 章")).toBe(3);
    expect(parseTargetChapters(undefined)).toBe(10);
    expect(parseTargetChapters("随便")).toBe(10);
  });
  test("支持长篇：数百章不再被截到 60", () => {
    expect(parseTargetChapters("500 章")).toBe(500);
    expect(parseTargetChapters("500 章（请严格规划为 500 章）")).toBe(500);
    expect(parseTargetChapters("100 章")).toBe(100);
    expect(parseTargetChapters("99999 章")).toBe(2000);
  });
});

describe("parseSkeleton", () => {
  test("解析书本级 canon 与幕列表", () => {
    const s = parseSkeleton(
      JSON.stringify({
        title: "旧盟刀",
        premise: "p",
        logline: "l",
        throughline: "t",
        ending: "e",
        worldBible: { era: "元末", factions: ["六扇门"] },
        acts: [
          { title: "少室风云", summary: "开篇引出九阳", chapters: 3 },
          { title: "光明顶", summary: "力挽狂澜", chapters: 4 },
        ],
      }),
    );
    expect(s).not.toBeNull();
    expect(s!.title).toBe("旧盟刀");
    expect(s!.worldBible.factions).toContain("六扇门");
    expect(s!.acts).toHaveLength(2);
    expect(s!.acts[1]!.chapters).toBe(4);
  });

  test("无 acts 返回 null（交上层回退单次生成）", () => {
    expect(parseSkeleton('{"title":"x","acts":[]}')).toBeNull();
    expect(parseSkeleton("不是 JSON")).toBeNull();
  });

  test("幕缺 chapters 时记为 0（留给 normalize 补齐）", () => {
    const s = parseSkeleton('{"acts":[{"title":"一","summary":"起"}]}');
    expect(s!.acts[0]!.chapters).toBe(0);
  });
});

describe("normalizeActCounts", () => {
  const act = (title: string, chapters: number) => ({ title, summary: title, chapters });

  test("按比例缩放使总和恰为目标", () => {
    const out = normalizeActCounts([act("a", 2), act("b", 2), act("c", 2)], 12);
    expect(out.reduce((s, a) => s + a.chapters, 0)).toBe(12);
  });

  test("处理舍入漂移仍精确命中目标", () => {
    const out = normalizeActCounts([act("a", 1), act("b", 1), act("c", 1)], 10);
    expect(out.reduce((s, a) => s + a.chapters, 0)).toBe(10);
    expect(out.every((a) => a.chapters >= 1)).toBe(true);
  });

  test("全部缺章数时平均分配且命中目标", () => {
    const out = normalizeActCounts([act("a", 0), act("b", 0)], 9);
    expect(out.reduce((s, a) => s + a.chapters, 0)).toBe(9);
    expect(out.every((a) => a.chapters >= 1)).toBe(true);
  });

  test("每幕至少 1 章", () => {
    const out = normalizeActCounts([act("a", 100), act("b", 1)], 5);
    expect(out.every((a) => a.chapters >= 1)).toBe(true);
    expect(out.reduce((s, a) => s + a.chapters, 0)).toBe(5);
  });
});
