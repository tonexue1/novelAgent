import { describe, expect, test } from "bun:test";
import { acceptRevision, reflectReview } from "../src/drama/reflect.ts";
import type { Reviewer, CritiqueResult, ReviewIssue } from "../src/drama/reviewer.ts";
import type { Novelist } from "../src/drama/novelist.ts";
import type { Scene, Beat } from "../src/drama/scene.ts";

const scene: Scene = { background: "", characters: [] };
const transcript: Beat[] = [];

function pass(): CritiqueResult {
  return { issues: [], parsed: true };
}
function fail(...quotes: string[]): CritiqueResult {
  const issues: ReviewIssue[] = quotes.map((q) => ({ quote: q, why: "硬伤", fix: "改" }));
  return { issues, parsed: true };
}

/** 脚本化评审：按调用次序依次返回预设结果。 */
function fakeReviewer(script: CritiqueResult[]): Reviewer {
  let i = 0;
  return {
    critique: async () => script[Math.min(i++, script.length - 1)]!,
  } as unknown as Reviewer;
}

/** 脚本化执笔人：用给定函数把当前稿变成修订稿。 */
function fakeNovelist(fn: (prose: string) => string): Novelist {
  return {
    revise: async (prose: string) => fn(prose),
  } as unknown as Novelist;
}

describe("acceptRevision", () => {
  const base = "一".repeat(100);

  test("空修订稿：拒绝", () => {
    expect(acceptRevision(base, "   ")).toBe(false);
  });

  test("与原文一字不差：拒绝（视为没改动）", () => {
    expect(acceptRevision(base, base)).toBe(false);
  });

  test("长度相当的定向修订：采纳", () => {
    expect(acceptRevision(base, base.slice(0, 99) + "二")).toBe(true);
  });

  test("骤缩到不足一半：拒绝（疑似截断）", () => {
    expect(acceptRevision(base, "一".repeat(40))).toBe(false);
  });

  test("正好到阈值：采纳", () => {
    expect(acceptRevision(base, "一".repeat(50))).toBe(true);
  });

  test("原文为空：非空修订稿即采纳", () => {
    expect(acceptRevision("", "新写的一段")).toBe(true);
  });
});

describe("reflectReview", () => {
  test("首轮即无硬伤：原样返回，passed=true，1 轮", async () => {
    const r = await reflectReview(
      fakeReviewer([pass()]),
      fakeNovelist((p) => p + "改坏"),
      "原稿",
      scene,
      transcript,
      undefined,
      { maxRounds: 2 },
    );
    expect(r.passed).toBe(true);
    expect(r.prose).toBe("原稿");
    expect(r.rounds).toHaveLength(1);
    expect(r.rounds[0]!.revised).toBe(false);
  });

  test("挑刺→定向修订→复审通过：收敛，passed=true", async () => {
    const base = "正文".repeat(50);
    const r = await reflectReview(
      fakeReviewer([fail("他"), pass()]),
      fakeNovelist((p) => p.replace("正文", "改文")),
      base,
      scene,
      transcript,
      undefined,
      { maxRounds: 3 },
    );
    expect(r.passed).toBe(true);
    expect(r.prose.startsWith("改文")).toBe(true);
    expect(r.rounds).toHaveLength(2);
    expect(r.rounds[0]!.revised).toBe(true);
  });

  test("修订稿被防截断护栏挡下：保留上一版并退出，passed=false", async () => {
    const base = "正文".repeat(50);
    const r = await reflectReview(
      fakeReviewer([fail("他"), fail("他")]),
      fakeNovelist(() => "太短"),
      base,
      scene,
      transcript,
      undefined,
      { maxRounds: 3 },
    );
    expect(r.passed).toBe(false);
    expect(r.prose).toBe(base);
    expect(r.rounds).toHaveLength(1);
    expect(r.rounds[0]!.revised).toBe(false);
  });

  test("用满轮数仍有硬伤：返回最后修订稿，passed=false", async () => {
    const base = "正文".repeat(50);
    let n = 0;
    const r = await reflectReview(
      fakeReviewer([fail("a"), fail("b"), fail("c")]),
      fakeNovelist((p) => p + `修${n++}`),
      base,
      scene,
      transcript,
      undefined,
      { maxRounds: 2 },
    );
    expect(r.passed).toBe(false);
    expect(r.rounds).toHaveLength(2);
    expect(r.prose).toContain("修");
  });

  test("评审未能解析（parsed=false）：按通过兜底早退", async () => {
    const r = await reflectReview(
      fakeReviewer([{ issues: [], parsed: false }]),
      fakeNovelist((p) => p),
      "原稿",
      scene,
      transcript,
      undefined,
      { maxRounds: 2 },
    );
    expect(r.passed).toBe(true);
    expect(r.rounds[0]!.parsed).toBe(false);
  });

  test("评审抛异常（超时等）：不外抛，记 error 轮、保留原稿收手", async () => {
    const boom = { critique: async () => { throw new Error("请求超时\n第二行"); } } as unknown as Reviewer;
    const r = await reflectReview(
      boom,
      fakeNovelist((p) => p + "改"),
      "原稿",
      scene,
      transcript,
      undefined,
      { maxRounds: 2 },
    );
    expect(r.passed).toBe(false);
    expect(r.prose).toBe("原稿");
    expect(r.rounds).toHaveLength(1);
    expect(r.rounds[0]!.error).toBe("请求超时");
  });

  test("修订抛异常：保留此前已采纳的修订，记 error 轮收手", async () => {
    const base = "正文".repeat(50);
    let calls = 0;
    const novelist = {
      revise: async (p: string) => {
        calls++;
        if (calls === 1) return p.replace("正文", "改文"); // 第一轮成功
        throw new Error("请求超时"); // 第二轮炸
      },
    } as unknown as Novelist;
    const r = await reflectReview(
      fakeReviewer([fail("a"), fail("b"), fail("c")]),
      novelist,
      base,
      scene,
      transcript,
      undefined,
      { maxRounds: 3 },
    );
    expect(r.passed).toBe(false);
    expect(r.prose.startsWith("改文")).toBe(true); // 第一轮修订被保留
    expect(r.rounds).toHaveLength(2);
    expect(r.rounds[1]!.error).toBe("请求超时");
  });

  test("maxRounds<=0：不做反射，原样返回", async () => {
    const r = await reflectReview(
      fakeReviewer([fail("x")]),
      fakeNovelist((p) => p + "改"),
      "原稿",
      scene,
      transcript,
      undefined,
      { maxRounds: 0 },
    );
    expect(r.prose).toBe("原稿");
    expect(r.rounds).toHaveLength(0);
  });
});
