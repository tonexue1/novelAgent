import { describe, expect, test } from "bun:test";
import {
  MAX_SCORE,
  PLAN_RUBRIC,
  PROSE_RUBRIC,
  renderRubricForPrompt,
  rubricLabels,
} from "../rubric.ts";

describe("rubric 定义", () => {
  test("满分为 5", () => {
    expect(MAX_SCORE).toBe(5);
  });

  test("两套评测点均非空、字段完整", () => {
    for (const rubric of [PLAN_RUBRIC, PROSE_RUBRIC]) {
      expect(rubric.length).toBeGreaterThan(0);
      for (const item of rubric) {
        expect(item.id).toBeTruthy();
        expect(item.label).toBeTruthy();
        expect(item.desc).toBeTruthy();
      }
    }
  });

  test("每套评测点 id 唯一", () => {
    for (const rubric of [PLAN_RUBRIC, PROSE_RUBRIC]) {
      const ids = rubric.map((r) => r.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  test("规划含关键项、文笔含风味契合与忠实度", () => {
    const planIds = PLAN_RUBRIC.map((r) => r.id);
    expect(planIds).toContain("nonRepetition");
    expect(planIds).toContain("genreFit");
    const proseIds = PROSE_RUBRIC.map((r) => r.id);
    expect(proseIds).toContain("styleFidelity");
    expect(proseIds).toContain("faithfulness");
  });

  test("renderRubricForPrompt 逐项编号且含 id", () => {
    const text = renderRubricForPrompt(PLAN_RUBRIC);
    expect(text).toContain("1. structure");
    expect(text.split("\n").length).toBe(PLAN_RUBRIC.length);
  });

  test("rubricLabels 映射 id→label", () => {
    const m = rubricLabels(PROSE_RUBRIC);
    expect(m.get("styleFidelity")).toBe("风味契合");
  });
});
