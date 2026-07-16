import { describe, expect, test } from "bun:test";
import {
  validateReviewFixture,
  loadReviewFixture,
  listReviewFixtures,
  listFixtures,
} from "../fixtures.ts";
import { parseReviewScore } from "../parse.ts";
import { REVIEW_RUBRIC } from "../rubric.ts";
import { renderReviewReport } from "../report.ts";

const goodReviewFixture = {
  id: "demo",
  label: "示例审校",
  goal: "推进本章",
  draft: "标题\n\n正文一段。",
  scene: {
    background: "教室",
    characters: [{ name: "甲", identity: "学生", personality: "冷", goal: "上学", style: "短句" }],
  },
  transcript: [{ actor: "甲", kind: "act", content: "嗯。" }],
  plantedBugs: ["某处时间线矛盾"],
  invariants: ["主角是甲"],
};

describe("REVIEW_RUBRIC", () => {
  test("含核心评测点：硬伤修正 + 故事保真", () => {
    const ids = REVIEW_RUBRIC.map((r) => r.id);
    expect(ids).toContain("bugCatch");
    expect(ids).toContain("storyFidelity");
    expect(ids).toContain("minimalEdit");
  });
});

describe("validateReviewFixture", () => {
  test("合法 fixture 无错误", () => {
    expect(validateReviewFixture(goodReviewFixture)).toEqual([]);
  });

  test("缺 draft/plantedBugs/invariants 分别报错", () => {
    expect(validateReviewFixture({ ...goodReviewFixture, draft: "" })).toContain("缺 draft（待审校草稿）");
    expect(validateReviewFixture({ ...goodReviewFixture, plantedBugs: [] })).toContain(
      "plantedBugs 至少 1 条（植入的已知硬伤）",
    );
    expect(validateReviewFixture({ ...goodReviewFixture, invariants: [] })).toContain(
      "invariants 至少 1 条（须保留的故事要素）",
    );
  });

  test("非对象直接报错", () => {
    expect(validateReviewFixture(null)).toEqual(["不是对象"]);
  });
});

describe("parseReviewScore", () => {
  test("按 REVIEW_RUBRIC 对齐各项；缺项补 0", () => {
    const sc = parseReviewScore(
      JSON.stringify({
        metrics: [
          { id: "bugCatch", score: 5, comment: "沙子已修" },
          { id: "storyFidelity", score: 5, comment: "故事未变" },
        ],
        overall: 90,
        strengths: ["改得准"],
        issues: [],
        suggestions: [],
      }),
    );
    expect(sc.metrics).toHaveLength(REVIEW_RUBRIC.length);
    expect(sc.metrics.find((m) => m.id === "bugCatch")!.score).toBe(5);
    // 未给分的项补 0
    expect(sc.metrics.find((m) => m.id === "noNewIssues")!.score).toBe(0);
    expect(sc.overall).toBe(90);
  });

  test("非 JSON 返回全 0 兜底", () => {
    const sc = parseReviewScore("裁判罢工了");
    expect(sc.overall).toBe(0);
    expect(sc.issues.length).toBeGreaterThan(0);
  });
});

describe("renderReviewReport", () => {
  test("含原稿/修订稿/植入硬伤/打分区块", () => {
    const md = renderReviewReport({
      fixtureLabel: "示例",
      goal: "推进",
      draft: "原稿内容XYZ",
      revised: "修订内容ABC",
      changed: true,
      plantedBugs: ["沙子漏洞"],
      invariants: ["主角是甲"],
      score: parseReviewScore('{"metrics":[],"overall":80}'),
    });
    expect(md).toContain("审校看护");
    expect(md).toContain("植入的已知硬伤");
    expect(md).toContain("须保留的故事要素");
    expect(md).toContain("原稿内容XYZ");
    expect(md).toContain("修订内容ABC");
    expect(md).toContain("80/100");
  });
});

describe("内置审校 fixture", () => {
  test("campus-sand 可加载、形状合法、且确实植入了沙子硬伤", () => {
    const fx = loadReviewFixture("campus-sand");
    expect(fx.id).toBe("campus-sand");
    expect(validateReviewFixture(fx)).toEqual([]);
    // 草稿里确实含沙子那句，硬伤描述点名"沙"。
    expect(fx.draft).toContain("肩头还沾着没拍干净的细沙");
    expect(fx.plantedBugs.join("")).toContain("沙");
    // 须保留要素里应包含关键角色与“熬”字基调。
    expect(fx.invariants.join("")).toContain("熬");
  });

  test("审校 fixture 不会污染文笔 fixture 列表", () => {
    const proseIds = listFixtures().map((f) => f.id);
    expect(proseIds).not.toContain("campus-sand");
    expect(proseIds).not.toContain("xianxia-genderroot");
    const reviewIds = listReviewFixtures().map((f) => f.id);
    expect(reviewIds).toContain("campus-sand");
    expect(reviewIds).toContain("xianxia-genderroot");
  });

  test("xianxia-genderroot：跨章保真 fixture 可加载、含性别翻转+灵根反转两处硬伤", () => {
    const fx = loadReviewFixture("xianxia-genderroot");
    expect(fx.id).toBe("xianxia-genderroot");
    expect(validateReviewFixture(fx)).toEqual([]);
    // 跨章硬伤只有靠前情锚点才审得出：fixture 必须带 storySoFar/previousChapterTail。
    expect(fx.storySoFar).toBeTruthy();
    expect(fx.previousChapterTail).toBeTruthy();
    // 前情锚点把主角钉死为女子 + 黄品下等。
    expect(fx.storySoFar!).toContain("黄品下等");
    expect(fx.storySoFar!).toContain("小师妹");
    // 草稿里确实带着两处植入硬伤：男性人称 + 灵根反转成上品木灵根。
    expect(fx.draft).toContain("上品木灵根");
    expect(fx.draft).toContain("师弟");
    // 两条 plantedBugs 分别点名性别与灵根。
    expect(fx.plantedBugs).toHaveLength(2);
    const bugs = fx.plantedBugs.join("");
    expect(bugs).toContain("性别");
    expect(bugs).toContain("灵根");
    // 须保留要素里保留判书“黄品下等”这一真设定（灵根反转的对照锚点）。
    expect(fx.invariants.join("")).toContain("黄品下等");
  });
});

describe("ReviewFixture 跨章锚点字段", () => {
  test("storySoFar/previousChapterTail 为可选，缺省不影响校验", () => {
    expect(validateReviewFixture(goodReviewFixture)).toEqual([]);
    expect(
      validateReviewFixture({
        ...goodReviewFixture,
        storySoFar: "前情：主角是女子。",
        previousChapterTail: "上一章结尾。",
      }),
    ).toEqual([]);
  });
});
