import { describe, expect, test } from "bun:test";
import {
  parseOutline,
  parseWorldBible,
  parseSkeleton,
  parseActList,
  parseTargetChapters,
  normalizeActCounts,
  dropDuplicateChapters,
  buildPlaceholderChapters,
  Planner,
} from "../src/story/planner.ts";
import type { OutlineCheckpoint } from "../src/story/planner.ts";
import type { ChapterPlan } from "../src/story/types.ts";
import type { LLMClient } from "../src/core/llm/client.ts";
import type { ChatRequest, ChatResult } from "../src/core/llm/types.ts";

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

describe("dropDuplicateChapters", () => {
  const ch = (n: number, title: string, goal: string): ChapterPlan => ({
    n,
    title,
    goal,
    status: "planned",
  });

  test("无重复时原样返回、顺序不变", () => {
    const list = [ch(1, "受辱", "少年被逐"), ch(2, "出走", "远赴东荒"), ch(3, "遇师", "得授心法")];
    const out = dropDuplicateChapters(list);
    expect(out).toHaveLength(3);
    expect(out.map((c) => c.title)).toEqual(["受辱", "出走", "遇师"]);
  });

  test("剔除标题重复的后来章、保留首现", () => {
    const list = [ch(1, "匣中骨", "开匣见白骨"), ch(2, "夜行", "夜奔"), ch(3, "匣中骨", "又开一次匣")];
    const out = dropDuplicateChapters(list);
    expect(out).toHaveLength(2);
    expect(out.map((c) => c.title)).toEqual(["匣中骨", "夜行"]);
  });

  test("剔除目标重复的后来章（标题不同也算重启本幕）", () => {
    const list = [ch(1, "受辱", "少年在祠堂被逐出家族"), ch(2, "北行", "北上求道"), ch(3, "再辱", "少年在祠堂被逐出家族")];
    const out = dropDuplicateChapters(list);
    expect(out).toHaveLength(2);
    expect(out.map((c) => c.n)).toEqual([1, 2]);
  });

  test("归一化：标点/空白差异视为同一（去重）", () => {
    const list = [ch(1, "血溅寒炉", "g1"), ch(2, "血溅·寒炉！", "g2")];
    const out = dropDuplicateChapters(list);
    expect(out).toHaveLength(1);
  });

  test("空标题/空目标不误伤", () => {
    const list = [ch(1, "", ""), ch(2, "", "")];
    const out = dropDuplicateChapters(list);
    expect(out).toHaveLength(2);
  });
});

describe("buildPlaceholderChapters", () => {
  const act = { title: "怀璧蒙尘", summary: "少年得宝、被逐、初试、遭追杀逃入险地。", chapters: 3 };

  test("单章时用幕名与幕摘要，不加分段标签", () => {
    const out = buildPlaceholderChapters(act, 1);
    expect(out).toHaveLength(1);
    expect(out[0]!.title).toBe("怀璧蒙尘");
    expect(out[0]!.goal).toBe(act.summary);
  });

  test("多章占位：标题与目标两两不同（绝不逐字重复）", () => {
    const out = buildPlaceholderChapters(act, 3);
    expect(out).toHaveLength(3);
    const titles = out.map((c) => c.title);
    const goals = out.map((c) => c.goal);
    expect(new Set(titles).size).toBe(3);
    expect(new Set(goals).size).toBe(3);
  });

  test("占位章能通过去重（不被 dropDuplicateChapters 误剔）", () => {
    const out = buildPlaceholderChapters(act, 3);
    expect(dropDuplicateChapters(out)).toHaveLength(3);
  });

  test("超过 4 章回落到「第N段」标签仍互不相同", () => {
    const out = buildPlaceholderChapters({ ...act, chapters: 6 }, 6);
    expect(out).toHaveLength(6);
    expect(new Set(out.map((c) => c.title)).size).toBe(6);
    expect(new Set(out.map((c) => c.goal)).size).toBe(6);
  });
});

describe("createOutline 断点续规划", () => {
  /** 按序返回预置响应的假客户端，记录每次调用的 messages 供断言。 */
  class FakeClient {
    calls: string[] = [];
    constructor(private readonly responses: string[]) {}
    async chat(req: ChatRequest): Promise<ChatResult> {
      this.calls.push(req.messages.map((m) => (typeof m.content === "string" ? m.content : "")).join("\n"));
      const content = this.responses.shift() ?? "{}";
      return { message: { role: "assistant", content }, finishReason: "stop" };
    }
  }

  const skeletonJson = JSON.stringify({
    title: "测试书",
    premise: "p",
    logline: "l",
    throughline: "t",
    ending: "e",
    worldBible: { era: "今", tone: "冷" },
    acts: [
      { title: "甲幕", summary: "起势", chapters: 2 },
      { title: "乙幕", summary: "承接", chapters: 2 },
    ],
  });
  const act1Json = JSON.stringify({
    chapters: [
      { title: "第一", goal: "甲事一" },
      { title: "第二", goal: "甲事二" },
    ],
  });
  const act2Json = JSON.stringify({
    chapters: [
      { title: "第三", goal: "乙事一" },
      { title: "第四", goal: "乙事二" },
    ],
  });

  test("全新规划：出骨架 + 逐幕细化，每步落一次进度快照", async () => {
    const fake = new FakeClient([skeletonJson, act1Json, act2Json]);
    const planner = new Planner(fake as unknown as LLMClient);
    const snapshots: OutlineCheckpoint[] = [];
    const res = await planner.createOutline("前提", "4 章", undefined, {
      onProgress: (cp) => {
        // 深拷贝，避免后续 push 影响已捕获的快照
        snapshots.push(JSON.parse(JSON.stringify(cp)));
      },
    });
    expect(res.title).toBe("测试书");
    expect(res.outline.chapters).toHaveLength(4);
    // 3 次 LLM：骨架 + 2 幕各一批
    expect(fake.calls).toHaveLength(3);
    // 落盘 3 次：骨架(actsDone=0) + 每幕各一次(1,2)
    expect(snapshots.map((s) => s.actsDone)).toEqual([0, 1, 2]);
    expect(snapshots[1]!.chapters).toHaveLength(2);
  });

  test("续规划：复用骨架、跳过已展开的幕，只展开剩余幕", async () => {
    // 先跑一遍拿到「已展开第 1 幕」的快照
    const first = new FakeClient([skeletonJson, act1Json, act2Json]);
    const p1 = new Planner(first as unknown as LLMClient);
    const snaps: OutlineCheckpoint[] = [];
    await p1.createOutline("前提", "4 章", undefined, {
      onProgress: (cp) => {
        snaps.push(JSON.parse(JSON.stringify(cp)));
      },
    });
    const resume = snaps.find((s) => s.actsDone === 1)!;
    expect(resume.chapters).toHaveLength(2);

    // 续跑：只提供第 2 幕的响应，绝不应再要骨架或重展第 1 幕
    const second = new FakeClient([act2Json]);
    const p2 = new Planner(second as unknown as LLMClient);
    const res = await p2.createOutline("前提", "4 章", undefined, { resume });

    expect(res.outline.chapters).toHaveLength(4);
    // 只调用了 1 次 LLM（第 2 幕），骨架与第 1 幕都被跳过
    expect(second.calls).toHaveLength(1);
    expect(res.outline.chapters.map((c) => c.title)).toEqual(["第一", "第二", "第三", "第四"]);
  });
});

describe("parseActList", () => {
  test("解析幕/卷列表，缺 chapters 记 0，过滤空项", () => {
    const acts = parseActList([
      { title: "甲", summary: "起", chapters: 3 },
      { title: "乙", summary: "承" },
      { nonsense: true },
      "不是对象",
    ]);
    expect(acts).toHaveLength(2);
    expect(acts[0]).toEqual({ title: "甲", summary: "起", chapters: 3 });
    expect(acts[1]!.chapters).toBe(0);
  });

  test("非数组返回空", () => {
    expect(parseActList(undefined)).toEqual([]);
    expect(parseActList({})).toEqual([]);
  });
});

describe("createRollingOutline 分卷滚动开书", () => {
  class FakeClient {
    calls: string[] = [];
    constructor(private readonly responses: string[]) {}
    async chat(req: ChatRequest): Promise<ChatResult> {
      this.calls.push(req.messages.map((m) => (typeof m.content === "string" ? m.content : "")).join("\n"));
      return { message: { role: "assistant", content: this.responses.shift() ?? "{}" }, finishReason: "stop" };
    }
  }

  const roadmapJson = JSON.stringify({
    title: "长卷书",
    premise: "p",
    logline: "l",
    throughline: "t",
    ending: "e",
    worldBible: { era: "今", tone: "冷" },
    acts: [
      { title: "初卷", summary: "起", chapters: 2 },
      { title: "中卷", summary: "承", chapters: 2 },
      { title: "末卷", summary: "合", chapters: 2 },
    ],
  });
  const arc1Json = JSON.stringify({
    chapters: [
      { title: "开篇一", goal: "起一" },
      { title: "开篇二", goal: "起二" },
    ],
  });

  test("只出路线图 + 展开第一卷（chapters 只含第一卷，arcs 为完整路线图）", async () => {
    const fake = new FakeClient([roadmapJson, arc1Json]);
    const planner = new Planner(fake as unknown as LLMClient);
    const res = await planner.createRollingOutline("前提", "6 章", undefined);

    expect(res.outline.mode).toBe("rolling");
    expect(res.outline.arcs).toHaveLength(3);
    expect(res.outline.targetChapters).toBe(6);
    // 只展开第一卷：chapters 全部 arc===1
    expect(res.outline.chapters).toHaveLength(2);
    expect(res.outline.chapters.every((c) => c.arc === 1)).toBe(true);
    expect(res.outline.arcs![0]!.status).toBe("active");
    expect(res.outline.arcs![1]!.status).toBe("planned");
    // 只调用 2 次：路线图 + 第一卷一批（绝不展开后续卷）
    expect(fake.calls).toHaveLength(2);
  });
});

describe("reviseRoadmap 路线图修订", () => {
  class FakeClient {
    calls: string[] = [];
    constructor(private readonly responses: string[]) {}
    async chat(req: ChatRequest): Promise<ChatResult> {
      this.calls.push(req.messages.map((m) => (typeof m.content === "string" ? m.content : "")).join("\n"));
      return { message: { role: "assistant", content: this.responses.shift() ?? "{}" }, finishReason: "stop" };
    }
  }

  const wb = { era: "", tone: "", locations: [], factions: [], powerSystem: [], items: [], lore: [] };
  const input = {
    title: "书",
    throughline: "t",
    ending: "旧结局",
    worldBible: wb,
    doneArcs: [{ title: "卷一", summary: "已完成", chapters: 3 }],
    remainingArcs: [
      { title: "旧卷二", summary: "原定二", chapters: 3 },
      { title: "旧卷三", summary: "原定三", chapters: 3 },
    ],
    memoryNote: "主角：张三",
    remainingChapters: 6,
  };

  test("解析修订后的后续卷与结局", async () => {
    const revised = JSON.stringify({
      ending: "新结局",
      arcs: [{ title: "新卷二", summary: "据实况改", chapters: 6 }],
    });
    const fake = new FakeClient([revised]);
    const planner = new Planner(fake as unknown as LLMClient);
    const out = await planner.reviseRoadmap(input);
    expect(out).not.toBeNull();
    expect(out!.ending).toBe("新结局");
    expect(out!.arcs).toHaveLength(1);
    expect(out!.arcs[0]!.title).toBe("新卷二");
  });

  test("解析失败重试后返回 null（交上层沿用原路线图）", async () => {
    const fake = new FakeClient(["不是JSON", "还是不行"]);
    const planner = new Planner(fake as unknown as LLMClient);
    const out = await planner.reviseRoadmap(input);
    expect(out).toBeNull();
    expect(fake.calls).toHaveLength(2);
  });

  test("无后续卷时不调用 LLM，直接返回 null", async () => {
    const fake = new FakeClient([]);
    const planner = new Planner(fake as unknown as LLMClient);
    const out = await planner.reviseRoadmap({ ...input, remainingArcs: [] });
    expect(out).toBeNull();
    expect(fake.calls).toHaveLength(0);
  });
});
