/**
 * 裁判返回文本 → 结构化打分的防御式解析（纯函数，可单测，不碰 LLM/IO）。
 *
 * 裁判是 LLM，输出可能夹带解释文字、缺项、分值越界。这里保证：
 * - 被文字/围栏包裹也能抽出 JSON；
 * - 只认 rubric 里的评测点，按其顺序对齐；缺项补 0 分并标注；
 * - 每项分值 clamp 到 [0, MAX_SCORE]；overall 缺失/非法时按各项均值折算成 0-100。
 */

import { extractJsonObject, str, strArray } from "../src/core/json.ts";
import {
  MAX_SCORE,
  PLAN_RUBRIC,
  PROSE_RUBRIC,
  REVIEW_RUBRIC,
  rubricLabels,
  type EvalScore,
  type MetricScore,
  type RubricItem,
} from "./rubric.ts";

function clampScore(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(MAX_SCORE, Math.round(n)));
}

/** 从裁判返回的 metrics 数组里，取某评测点的 {score, comment}。 */
function pickMetric(
  raw: unknown[],
  id: string,
): { score: number; comment: string; found: boolean } {
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    if (str(o.id) === id) {
      return { score: clampScore(o.score), comment: str(o.comment), found: true };
    }
  }
  return { score: 0, comment: "(裁判未给此项评分)", found: false };
}

/**
 * 按给定 rubric 解析裁判文本成 EvalScore。纯函数。
 * 未解析出 JSON 时返回全 0 的兜底结构（并在 issues 里标注解析失败）。
 */
export function parseEvalScore(text: string, rubric: RubricItem[]): EvalScore {
  const labels = rubricLabels(rubric);
  const obj = extractJsonObject(text ?? "");
  if (!obj) {
    return {
      metrics: rubric.map((r) => ({ id: r.id, label: r.label, score: 0, max: MAX_SCORE, comment: "(解析失败)" })),
      overall: 0,
      strengths: [],
      issues: ["裁判返回无法解析为 JSON。"],
      suggestions: [],
    };
  }

  const rawMetrics = Array.isArray(obj.metrics) ? obj.metrics : [];
  const metrics: MetricScore[] = rubric.map((r) => {
    const picked = pickMetric(rawMetrics, r.id);
    return {
      id: r.id,
      label: labels.get(r.id) ?? r.label,
      score: picked.score,
      max: MAX_SCORE,
      comment: picked.comment,
    };
  });

  // overall：裁判给的优先（支持 0-5 或 0-100 两种量纲，统一折算到 0-100）；否则按各项均值。
  const sum = metrics.reduce((s, m) => s + m.score, 0);
  const meanPct = metrics.length ? (sum / (metrics.length * MAX_SCORE)) * 100 : 0;
  let overall = meanPct;
  const rawOverall = typeof obj.overall === "number" ? obj.overall : Number(obj.overall);
  if (Number.isFinite(rawOverall)) {
    overall = rawOverall <= MAX_SCORE ? (rawOverall / MAX_SCORE) * 100 : rawOverall;
  }
  overall = Math.max(0, Math.min(100, Math.round(overall)));

  return {
    metrics,
    overall,
    strengths: strArray(obj.strengths),
    issues: strArray(obj.issues),
    suggestions: strArray(obj.suggestions),
  };
}

/** 解析章节规划打分。 */
export function parsePlanScore(text: string): EvalScore {
  return parseEvalScore(text, PLAN_RUBRIC);
}

/** 解析文笔风味打分。 */
export function parseProseScore(text: string): EvalScore {
  return parseEvalScore(text, PROSE_RUBRIC);
}

/** 解析审校打分。 */
export function parseReviewScore(text: string): EvalScore {
  return parseEvalScore(text, REVIEW_RUBRIC);
}
