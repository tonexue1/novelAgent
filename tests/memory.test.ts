import { describe, expect, test } from "bun:test";
import {
  upsertCharacter,
  mergeThreads,
  selectRelevantCharacters,
  codexToCharacter,
  renderWorldBrief,
  emptyMemory,
  emptyWorldBible,
  RELEVANT_CAP,
} from "../src/story/memory.ts";
import type { CodexCharacter, ThreadItem, ChapterPlan, StoryMemory } from "../src/story/types.ts";

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
