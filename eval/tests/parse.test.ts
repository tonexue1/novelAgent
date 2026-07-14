import { describe, expect, test } from "bun:test";
import { parsePlanScore, parseProseScore, parseEvalScore } from "../parse.ts";
import { PLAN_RUBRIC, PROSE_RUBRIC } from "../rubric.ts";

describe("parseEvalScore", () => {
  test("解析完整打分并按 rubric 对齐", () => {
    const raw = JSON.stringify({
      metrics: [
        { id: "structure", score: 4, comment: "结构清晰" },
        { id: "throughline", score: 5, comment: "主线稳" },
      ],
      overall: 82,
      strengths: ["主线清楚"],
      issues: ["世界观偏薄"],
      suggestions: ["补力量体系细节"],
    });
    const sc = parseEvalScore(raw, PLAN_RUBRIC);
    expect(sc.metrics).toHaveLength(PLAN_RUBRIC.length);
    expect(sc.metrics.find((m) => m.id === "structure")!.score).toBe(4);
    expect(sc.metrics.find((m) => m.id === "structure")!.comment).toBe("结构清晰");
    expect(sc.overall).toBe(82);
    expect(sc.strengths).toContain("主线清楚");
    expect(sc.suggestions).toContain("补力量体系细节");
  });

  test("缺项补 0 分并标注", () => {
    const sc = parseEvalScore('{"metrics":[{"id":"structure","score":3,"comment":"ok"}]}', PLAN_RUBRIC);
    const missing = sc.metrics.find((m) => m.id === "throughline")!;
    expect(missing.score).toBe(0);
    expect(missing.comment).toContain("未给");
  });

  test("分值越界被 clamp 到 [0,5]", () => {
    const sc = parseEvalScore(
      '{"metrics":[{"id":"structure","score":9,"comment":""},{"id":"throughline","score":-3,"comment":""}]}',
      PLAN_RUBRIC,
    );
    expect(sc.metrics.find((m) => m.id === "structure")!.score).toBe(5);
    expect(sc.metrics.find((m) => m.id === "throughline")!.score).toBe(0);
  });

  test("overall 缺失时按各项均值折算成 0-100", () => {
    // 全给 5 分 → 100
    const metrics = PLAN_RUBRIC.map((r) => ({ id: r.id, score: 5, comment: "" }));
    const sc = parseEvalScore(JSON.stringify({ metrics }), PLAN_RUBRIC);
    expect(sc.overall).toBe(100);
  });

  test("overall 用 0-5 量纲时折算成百分制", () => {
    const sc = parseEvalScore('{"metrics":[],"overall":4}', PLAN_RUBRIC);
    expect(sc.overall).toBe(80);
  });

  test("被文字/围栏包裹也能解析", () => {
    const sc = parseEvalScore('这是我的评分：```json\n{"metrics":[{"id":"structure","score":2,"comment":"x"}],"overall":40}\n``` 完毕', PLAN_RUBRIC);
    expect(sc.metrics.find((m) => m.id === "structure")!.score).toBe(2);
    expect(sc.overall).toBe(40);
  });

  test("非 JSON 返回兜底全 0 并标注解析失败", () => {
    const sc = parseEvalScore("裁判罢工了", PLAN_RUBRIC);
    expect(sc.overall).toBe(0);
    expect(sc.issues.join("")).toContain("无法解析");
    expect(sc.metrics.every((m) => m.score === 0)).toBe(true);
  });
});

describe("parsePlanScore / parseProseScore", () => {
  test("各自套用对应 rubric", () => {
    const plan = parsePlanScore('{"metrics":[]}');
    expect(plan.metrics).toHaveLength(PLAN_RUBRIC.length);
    const prose = parseProseScore('{"metrics":[]}');
    expect(prose.metrics).toHaveLength(PROSE_RUBRIC.length);
    expect(prose.metrics.some((m) => m.id === "styleFidelity")).toBe(true);
  });
});
