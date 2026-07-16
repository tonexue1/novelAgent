/**
 * 评测报告渲染（纯函数，可单测）。统一形态：`## 1. 原版` + `## 2. 打分`。
 */

import type { EvalScore } from "./rubric.ts";
import type { Outline, WorldBible } from "../src/story/types.ts";

function scoreTable(sc: EvalScore): string[] {
  const L: string[] = [];
  L.push("| 评测点 | 得分 | 评语 |");
  L.push("| --- | --- | --- |");
  for (const m of sc.metrics) {
    L.push(`| ${m.label} | ${m.score}/${m.max} | ${m.comment.replace(/\n+/g, " ")} |`);
  }
  return L;
}

function scoreBlock(sc: EvalScore): string[] {
  const L: string[] = [];
  L.push("## 2. 打分（评测 agent）");
  L.push("");
  L.push(`综合分：**${sc.overall}/100**`);
  L.push("");
  L.push(...scoreTable(sc));
  L.push("");
  if (sc.strengths.length) {
    L.push("优点：");
    for (const s of sc.strengths) L.push(`- ${s}`);
    L.push("");
  }
  if (sc.issues.length) {
    L.push("问题：");
    for (const s of sc.issues) L.push(`- ${s}`);
    L.push("");
  }
  if (sc.suggestions.length) {
    L.push("修改建议：");
    for (const s of sc.suggestions) L.push(`- ${s}`);
    L.push("");
  }
  return L;
}

function renderWorldBible(wb: WorldBible | undefined): string[] {
  if (!wb) return [];
  const L: string[] = [];
  const line = (k: string, v: string | string[]) => {
    const val = Array.isArray(v) ? v.join("、") : v;
    if (val) L.push(`- ${k}：${val}`);
  };
  line("时代", wb.era);
  line("基调", wb.tone);
  line("地点", wb.locations);
  line("势力", wb.factions);
  line("力量体系", wb.powerSystem);
  line("信物", wb.items);
  line("其它设定", wb.lore);
  return L;
}

/** 渲染章节规划评测报告。 */
export function renderPlanReport(input: {
  seed: string;
  title: string;
  genre?: string;
  outline: Outline;
  worldBible?: WorldBible;
  score: EvalScore;
}): string {
  const L: string[] = [];
  L.push(`# 评测报告：章节规划 —《${input.title}》`);
  L.push("");
  L.push(`- 题材：${input.genre ?? "（默认）"}　综合分：**${input.score.overall}/100**`);
  L.push(`- 前提：${input.seed}`);
  L.push("");
  L.push("## 1. 原版（生成的大纲）");
  L.push("");
  if (input.outline.logline) L.push(`- 一句话主线：${input.outline.logline}`);
  if (input.outline.throughline) L.push(`- 贯穿冲突：${input.outline.throughline}`);
  if (input.outline.ending) L.push(`- 结局方向：${input.outline.ending}`);
  const wb = renderWorldBible(input.worldBible);
  if (wb.length) {
    L.push("");
    L.push("世界观圣经：");
    L.push(...wb);
  }
  L.push("");
  const rolling = input.outline.mode === "rolling" && (input.outline.arcs?.length ?? 0) > 0;
  if (rolling) {
    L.push(
      `分卷路线图（共 ${input.outline.arcs!.length} 卷、目标约 ${input.outline.targetChapters ?? input.outline.chapters.length} 章）：`,
    );
    for (const a of input.outline.arcs!) {
      L.push(`卷${a.n}. 《${a.title}》（约${a.chapters}章）：${a.summary}`);
    }
    L.push("");
    L.push(`第一卷已细化分章（共 ${input.outline.chapters.length} 章）：`);
  } else {
    L.push(`分章（共 ${input.outline.chapters.length} 章）：`);
  }
  for (const c of input.outline.chapters) {
    L.push(`${c.n}. 《${c.title}》：${c.goal}`);
  }
  L.push("");
  L.push(...scoreBlock(input.score));
  return L.join("\n");
}

/** 渲染文笔风味评测报告。 */
export function renderProseReport(input: {
  fixtureLabel: string;
  style?: string;
  goal: string;
  prose: string;
  score: EvalScore;
}): string {
  const L: string[] = [];
  L.push(`# 评测报告：文笔风味 —「${input.fixtureLabel}」`);
  L.push("");
  L.push(`- 目标风味：${input.style ?? "（未启用）"}　综合分：**${input.score.overall}/100**`);
  L.push(`- 本章目标：${input.goal}`);
  L.push("");
  L.push("## 1. 原版（成文正文）");
  L.push("");
  L.push(input.prose);
  L.push("");
  L.push(...scoreBlock(input.score));
  return L.join("\n");
}

/** 渲染审校评测报告：原稿 / 修订稿 / 打分，并列出植入硬伤与须保留要素。 */
export function renderReviewReport(input: {
  fixtureLabel: string;
  goal: string;
  draft: string;
  revised: string;
  changed: boolean;
  plantedBugs: string[];
  invariants: string[];
  score: EvalScore;
}): string {
  const L: string[] = [];
  L.push(`# 评测报告：审校看护 —「${input.fixtureLabel}」`);
  L.push("");
  L.push(`- 综合分：**${input.score.overall}/100**　审校是否改动原稿：${input.changed ? "是" : "否（原样返回）"}`);
  L.push(`- 本章目标：${input.goal}`);
  L.push("");
  L.push("## 植入的已知硬伤（审校应修正）");
  L.push("");
  for (const b of input.plantedBugs) L.push(`- ${b}`);
  L.push("");
  L.push("## 须保留的故事要素（审校不得改动）");
  L.push("");
  for (const v of input.invariants) L.push(`- ${v}`);
  L.push("");
  L.push("## 1. 原稿（含植入硬伤）");
  L.push("");
  L.push(input.draft);
  L.push("");
  L.push("## 1b. 修订稿（审校产出）");
  L.push("");
  L.push(input.revised);
  L.push("");
  L.push(...scoreBlock(input.score));
  return L.join("\n");
}

/** 一行终端总览。 */
export function renderScoreLine(kind: string, label: string, sc: EvalScore): string {
  const worst = [...sc.metrics].sort((a, b) => a.score - b.score)[0];
  return (
    `[${kind}]「${label}」综合 ${sc.overall}/100` +
    (worst ? `｜最低项：${worst.label} ${worst.score}/${worst.max}` : "")
  );
}
