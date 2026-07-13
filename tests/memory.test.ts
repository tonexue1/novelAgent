import { describe, expect, test } from "bun:test";
import {
  upsertCharacter,
  mergeThreads,
  mergeCapped,
  reconcileProps,
  selectRelevantCharacters,
  protagonistOf,
  isDead,
  codexToCharacter,
  renderWorldBrief,
  renderDeadRoster,
  renderPropLedger,
  emptyMemory,
  emptyWorldBible,
  normalizeMemory,
  buildArcRecap,
  renderArcSummaries,
  RELEVANT_CAP,
} from "../src/story/memory.ts";
import type {
  CodexCharacter,
  ThreadItem,
  PropItem,
  ChapterPlan,
  StoryMemory,
  StoryEvent,
} from "../src/story/types.ts";

function codex(name: string, over: Partial<CodexCharacter> = {}): CodexCharacter {
  return {
    name,
    identity: "身份",
    personality: "内核性格",
    style: "内核腔调",
    longTermGoal: "长期目标",
    status: "在世",
    firstChapter: 1,
    lastChapter: 1,
    ...over,
  };
}

describe("upsertCharacter", () => {
  test("新角色整份加入", () => {
    const out = upsertCharacter([], codex("甲"));
    expect(out).toHaveLength(1);
    expect(out[0]!.name).toBe("甲");
  });

  test("内核字段（性格/腔调/秘密/首登场）不被覆盖", () => {
    const base = [codex("甲", { personality: "原始性格", style: "原始腔调", secret: "原秘密", firstChapter: 1 })];
    const out = upsertCharacter(base, codex("甲", {
      personality: "篡改性格",
      style: "篡改腔调",
      secret: "新秘密",
      firstChapter: 5,
      status: "重伤",
      currentGoal: "新目标",
      lastChapter: 3,
    }));
    const c = out[0]!;
    expect(c.personality).toBe("原始性格");
    expect(c.style).toBe("原始腔调");
    expect(c.secret).toBe("原秘密");
    expect(c.firstChapter).toBe(1);
    // 演变字段应更新
    expect(c.status).toBe("重伤");
    expect(c.currentGoal).toBe("新目标");
    expect(c.lastChapter).toBe(3);
  });

  test("lastChapter 取较大值", () => {
    const base = [codex("甲", { lastChapter: 4 })];
    const out = upsertCharacter(base, codex("甲", { lastChapter: 2 }));
    expect(out[0]!.lastChapter).toBe(4);
  });

  test("旧内核为空时用新值补齐", () => {
    const base = [codex("甲", { personality: "" })];
    const out = upsertCharacter(base, codex("甲", { personality: "补齐性格" }));
    expect(out[0]!.personality).toBe("补齐性格");
  });

  test("死者不可复活：已亡状态不被改回在世", () => {
    const base = [codex("封沉岳", { status: "身亡", lastChapter: 12 })];
    const out = upsertCharacter(base, codex("封沉岳", { status: "在世", lastChapter: 15 }));
    expect(out[0]!.status).toBe("身亡");
  });

  test("死者显式复活标记时才允许改状态", () => {
    const base = [codex("诈死者", { status: "身亡", lastChapter: 5 })];
    const out = upsertCharacter(base, codex("诈死者", { status: "诈死后现身，在世", lastChapter: 8 }));
    expect(out[0]!.status).toContain("在世");
  });

  test("别名归并：按别名交集识别为同一人并累积别名", () => {
    const base = [codex("封沉岳", { aliases: ["师叔"], lastChapter: 7 })];
    // 用别名"师叔"作为正名传入，应归并到封沉岳，而非新建
    const out = upsertCharacter(base, codex("师叔", { aliases: ["左腿瘸人"], lastChapter: 9 }));
    expect(out).toHaveLength(1);
    expect(out[0]!.name).toBe("封沉岳");
    expect(out[0]!.aliases).toContain("师叔");
    expect(out[0]!.aliases).toContain("左腿瘸人");
  });

  test("appearances：新值优先覆盖", () => {
    const base = [codex("甲", { appearances: 3 })];
    const out = upsertCharacter(base, codex("甲", { appearances: 4, lastChapter: 2 }));
    expect(out[0]!.appearances).toBe(4);
  });
});

describe("isDead", () => {
  test("识别多种死亡措辞", () => {
    expect(isDead("身亡")).toBe(true);
    expect(isDead("已殒命")).toBe(true);
    expect(isDead("阵亡")).toBe(true);
    expect(isDead("在世")).toBe(false);
    expect(isDead("重伤")).toBe(false);
  });
});

describe("mergeThreads", () => {
  const t = (id: string, over: Partial<ThreadItem> = {}): ThreadItem => ({
    id,
    description: id,
    status: "open",
    introducedChapter: 1,
    ...over,
  });

  test("按 id 追加与更新状态", () => {
    let threads = mergeThreads([], [t("a"), t("b")]);
    expect(threads).toHaveLength(2);
    threads = mergeThreads(threads, [t("a", { status: "resolved", resolvedChapter: 3 })]);
    expect(threads).toHaveLength(2);
    const a = threads.find((x) => x.id === "a")!;
    expect(a.status).toBe("resolved");
    expect(a.resolvedChapter).toBe(3);
  });

  test("归一化描述去重：不同 id 但去标点/空白后相同视为同一伏笔", () => {
    const base = mergeThreads([], [t("map", { description: "藏宝图下落" })]);
    const merged = mergeThreads(base, [t("treasure", { description: "藏宝图，下落。" })]);
    expect(merged).toHaveLength(1);
  });
});

describe("reconcileProps", () => {
  const p = (name: string, over: Partial<PropItem> = {}): PropItem => ({
    name,
    holder: "无人",
    location: "不明",
    status: "完好",
    lastChapter: 1,
    ...over,
  });

  test("同名道具改持有权而非新增藏处", () => {
    const base = reconcileProps([], [p("真拓本", { holder: "封沉岳", location: "香炉底" })]);
    const next = reconcileProps(base, [
      p("真拓本", { holder: "阿九", location: "贴身油布包", lastChapter: 9 }),
    ]);
    expect(next).toHaveLength(1);
    expect(next[0]!.holder).toBe("阿九");
    expect(next[0]!.location).toBe("贴身油布包");
    expect(next[0]!.lastChapter).toBe(9);
  });

  test("归一化名字去重（标点/空白不同也算同一件）", () => {
    const base = reconcileProps([], [p("青玉剑佩")]);
    const next = reconcileProps(base, [p("青玉剑佩。", { holder: "赵铁岭" })]);
    expect(next).toHaveLength(1);
    expect(next[0]!.holder).toBe("赵铁岭");
  });

  test("无名道具被跳过", () => {
    expect(reconcileProps([], [p("  ")])).toHaveLength(0);
  });
});

describe("mergeCapped", () => {
  test("并集去重 + 近义合并", () => {
    const out = mergeCapped(["丐帮", "少林寺"], ["少林寺。", "华山派"]);
    expect(out).toHaveLength(3);
  });

  test("容量封顶保留最新", () => {
    const base = Array.from({ length: 40 }, (_, i) => `设定${i}`);
    const out = mergeCapped(base, ["新设定"], 40);
    expect(out).toHaveLength(40);
    expect(out).toContain("新设定");
    expect(out).not.toContain("设定0");
  });
});

describe("codexToCharacter", () => {
  test("currentGoal 优先于 longTermGoal，并保留内核", () => {
    const c = codexToCharacter(codex("甲", { currentGoal: "眼前目标", longTermGoal: "毕生目标", secret: "s" }));
    expect(c.goal).toBe("眼前目标");
    expect(c.personality).toBe("内核性格");
    expect(c.style).toBe("内核腔调");
    expect(c.secret).toBe("s");
  });

  test("无 currentGoal 时用 longTermGoal", () => {
    const c = codexToCharacter(codex("甲", { longTermGoal: "毕生目标" }));
    expect(c.goal).toBe("毕生目标");
  });
});

describe("selectRelevantCharacters", () => {
  const plan: ChapterPlan = { n: 5, title: "t", goal: "沈孤鸿现身，与旧敌对峙", status: "planned" };

  function mem(chars: CodexCharacter[]): StoryMemory {
    return { ...emptyMemory(emptyWorldBible()), characters: chars };
  }

  test("本章点名者优先入选", () => {
    const m = mem([
      codex("路人", { lastChapter: 1 }),
      codex("沈孤鸿", { lastChapter: 2 }),
    ]);
    const { characters } = selectRelevantCharacters(m, plan, 5);
    expect(characters[0]!.name).toBe("沈孤鸿");
  });

  test("有界封顶", () => {
    const many = Array.from({ length: 12 }, (_, i) => codex(`角${i}`, { lastChapter: 5 }));
    const { characters } = selectRelevantCharacters(mem(many), plan, 5, RELEVANT_CAP);
    expect(characters.length).toBeLessThanOrEqual(RELEVANT_CAP);
  });

  test("排除已亡者（未被点名时）", () => {
    const m = mem([
      codex("亡者", { status: "已身亡", lastChapter: 1 }),
      codex("活人", { lastChapter: 1 }),
    ]);
    const { characters } = selectRelevantCharacters(m, plan, 5);
    expect(characters.some((c) => c.name === "亡者")).toBe(false);
  });

  test("回归者（缺席≥1整章）生成补账提示", () => {
    const m = mem([codex("沈孤鸿", { lastChapter: 2 })]);
    const { returningNotes } = selectRelevantCharacters(m, plan, 5);
    expect(returningNotes).toBeDefined();
    expect(returningNotes!).toContain("沈孤鸿");
  });

  test("上一章刚登场者不算回归、无补账", () => {
    const planNear: ChapterPlan = { n: 5, title: "t", goal: "众人商议", status: "planned" };
    const m = mem([codex("柳三娘", { lastChapter: 4 })]);
    const { returningNotes } = selectRelevantCharacters(m, planNear, 5);
    expect(returningNotes).toBeUndefined();
  });

  test("主角优先入选（即使本章未点名）", () => {
    const planNoName: ChapterPlan = { n: 6, title: "t", goal: "众人各怀心事", status: "planned" };
    const m = mem([
      codex("配角", { lastChapter: 5 }),
      codex("阿九", { appearances: 5, lastChapter: 5 }),
    ]);
    const { characters } = selectRelevantCharacters(m, planNoName, 6, RELEVANT_CAP, "阿九");
    expect(characters[0]!.name).toBe("阿九");
  });

  test("已亡主角不被强插", () => {
    const planNoName: ChapterPlan = { n: 6, title: "t", goal: "众人各怀心事", status: "planned" };
    const m = mem([
      codex("活人", { lastChapter: 5 }),
      codex("阿九", { appearances: 5, status: "身亡", lastChapter: 4 }),
    ]);
    const { characters } = selectRelevantCharacters(m, planNoName, 6, RELEVANT_CAP, "阿九");
    expect(characters.some((c) => c.name === "阿九")).toBe(false);
  });
});

describe("protagonistOf", () => {
  function mem(chars: CodexCharacter[]): StoryMemory {
    return { ...emptyMemory(emptyWorldBible()), characters: chars };
  }

  test("取登场章数最多者", () => {
    const p = protagonistOf(
      mem([
        codex("甲", { appearances: 2 }),
        codex("乙", { appearances: 7 }),
        codex("丙", { appearances: 3 }),
      ]),
    );
    expect(p?.name).toBe("乙");
  });

  test("登场不足 2 章不判定主角（避免开局误判）", () => {
    const p = protagonistOf(mem([codex("甲", { appearances: 1 }), codex("乙")]));
    expect(p).toBeUndefined();
  });
});

describe("renderDeadRoster / renderPropLedger", () => {
  test("死者名单只列已亡者", () => {
    const out = renderDeadRoster([
      codex("活人", { status: "在世" }),
      codex("亡者", { status: "身亡", lastChapter: 3 }),
    ]);
    expect(out).toContain("亡者");
    expect(out).not.toContain("活人");
  });

  test("道具账本渲染持有者与位置", () => {
    const out = renderPropLedger([
      { name: "真拓本", holder: "阿九", location: "油布包", status: "完好", lastChapter: 9 },
    ]);
    expect(out).toContain("真拓本");
    expect(out).toContain("阿九");
    expect(out).toContain("油布包");
  });

  test("空账本渲染空串", () => {
    expect(renderPropLedger([])).toBe("");
    expect(renderDeadRoster([])).toBe("");
  });
});

describe("renderWorldBrief", () => {
  test("渲染非空字段，空则占位", () => {
    expect(renderWorldBrief(emptyWorldBible())).toContain("尚未");
    const brief = renderWorldBrief({
      ...emptyWorldBible(),
      era: "北宋末年",
      factions: ["丐帮", "少林"],
    });
    expect(brief).toContain("北宋末年");
    expect(brief).toContain("丐帮");
  });
});

describe("分卷滚动：记忆兼容与卷综述", () => {
  test("emptyMemory 带空 arcSummaries", () => {
    expect(emptyMemory(emptyWorldBible()).arcSummaries).toEqual([]);
  });

  test("normalizeMemory 为旧档补齐 arcSummaries", () => {
    const old = { ...emptyMemory(emptyWorldBible()) } as StoryMemory;
    delete (old as { arcSummaries?: string[] }).arcSummaries;
    expect(normalizeMemory(old).arcSummaries).toEqual([]);
  });

  test("buildArcRecap 只取卷内章号区间的大事记", () => {
    const events: StoryEvent[] = [
      { chapter: 1, summary: "开局" },
      { chapter: 2, summary: "结仇" },
      { chapter: 3, summary: "藏锋" },
      { chapter: 25, summary: "下一卷的事" },
    ];
    const recap = buildArcRecap(events, 1, "初入江湖", 1, 24);
    expect(recap).toContain("第1卷《初入江湖》");
    expect(recap).toContain("第1-24章");
    expect(recap).toContain("开局");
    expect(recap).toContain("结仇");
    expect(recap).not.toContain("下一卷的事");
  });

  test("buildArcRecap 无卷内事件时给占位", () => {
    expect(buildArcRecap([], 2, "风波", 25, 48)).toContain("无大事记");
  });

  test("renderArcSummaries 有界取最近若干卷", () => {
    const many = Array.from({ length: 12 }, (_, i) => `第${i + 1}卷综述`);
    const out = renderArcSummaries(many, 3);
    expect(out).toContain("第10卷综述");
    expect(out).toContain("第12卷综述");
    expect(out).not.toContain("第9卷综述");
    expect(renderArcSummaries([])).toBe("");
    expect(renderArcSummaries(undefined)).toBe("");
  });
});
