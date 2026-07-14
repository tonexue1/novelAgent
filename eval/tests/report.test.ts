import { describe, expect, test } from "bun:test";
import { renderPlanReport, renderProseReport, renderScoreLine } from "../report.ts";
import { parsePlanScore, parseProseScore } from "../parse.ts";
import type { Outline, WorldBible } from "../../src/story/types.ts";

const planScore = parsePlanScore(
  JSON.stringify({
    metrics: [{ id: "structure", score: 4, comment: "好" }],
    overall: 70,
    strengths: ["主线清晰"],
    issues: ["世界观薄"],
    suggestions: ["补设定"],
  }),
);

const outline: Outline = {
  premise: "少年逆命",
  logline: "废材少年自创虚空之道",
  throughline: "逆命与证道",
  ending: "登临大帝",
  chapters: [
    { n: 1, title: "除族", goal: "被逐出家族", status: "planned" },
    { n: 2, title: "北行", goal: "远赴东荒", status: "planned" },
  ],
};

const worldBible: WorldBible = {
  era: "荒古",
  tone: "悲壮",
  locations: ["东荒"],
  factions: ["楚氏"],
  powerSystem: ["苦海命泉"],
  items: ["神器鼎"],
  lore: ["黑暗时代"],
};

describe("renderPlanReport", () => {
  const md = renderPlanReport({ seed: "s", title: "虚空之径", genre: "仙侠", outline, worldBible, score: planScore });

  test("含标题、1.原版、2.打分两段", () => {
    expect(md).toContain("# 评测报告：章节规划");
    expect(md).toContain("## 1. 原版");
    expect(md).toContain("## 2. 打分");
  });

  test("原版含分章与世界观", () => {
    expect(md).toContain("《除族》");
    expect(md).toContain("苦海命泉");
  });

  test("打分含综合分与评测点表", () => {
    expect(md).toContain("70/100");
    expect(md).toContain("结构完整");
  });
});

describe("renderProseReport", () => {
  const proseScore = parseProseScore('{"metrics":[{"id":"styleFidelity","score":3,"comment":"尚可"}],"overall":55}');
  const md = renderProseReport({
    fixtureLabel: "废材少年除族大典",
    style: "辰东式史诗",
    goal: "被废黜却窥见虚空",
    prose: "夜幕低垂，星河横贯天穹……",
    score: proseScore,
  });

  test("含 1.原版(正文) 与 2.打分", () => {
    expect(md).toContain("## 1. 原版");
    expect(md).toContain("星河横贯天穹");
    expect(md).toContain("## 2. 打分");
    expect(md).toContain("55/100");
    expect(md).toContain("风味契合");
  });
});

describe("renderScoreLine", () => {
  test("一行总览含综合分与最低项", () => {
    const line = renderScoreLine("规划", "虚空之径", planScore);
    expect(line).toContain("70/100");
    expect(line).toContain("最低项");
  });
});
