import { describe, expect, test } from "bun:test";
import {
  normalizeText,
  findDuplicateChapters,
  splitTerms,
  entryCoverage,
  worldSignatureEntries,
  extractLexiconTerms,
  termCoverage,
  shortSentenceRatio,
  countOnomatopoeia,
  countGenericDrama,
  scoreOpening,
  gradeNovel,
  type GradeInput,
} from "../src/verify/graders.ts";
import { renderReport, renderSummaryLine } from "../src/verify/report.ts";
import type { WorldBible, StyleCard } from "../src/story/types.ts";

describe("normalizeText", () => {
  test("去空白/标点、转小写", () => {
    expect(normalizeText("血溅·寒炉！")).toBe("血溅寒炉");
    expect(normalizeText("  A B, c. ")).toBe("abc");
  });
});

describe("findDuplicateChapters", () => {
  const ch = (n: number, title: string, goal: string) => ({ n, title, goal });

  test("无重复返回空", () => {
    const hits = findDuplicateChapters([ch(1, "受辱", "被逐"), ch(2, "出走", "北行")]);
    expect(hits).toHaveLength(0);
  });

  test("标题重复命中，指向首现章", () => {
    const hits = findDuplicateChapters([ch(1, "匣中骨", "a"), ch(2, "夜行", "b"), ch(3, "匣中骨", "c")]);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.n).toBe(3);
    expect(hits[0]!.dupOf).toBe(1);
    expect(hits[0]!.by).toBe("title");
  });

  test("目标重复也命中（标题不同）", () => {
    const hits = findDuplicateChapters([ch(1, "受辱", "祠堂被逐"), ch(2, "再辱", "祠堂被逐")]);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.by).toBe("goal");
  });
});

describe("splitTerms / entryCoverage", () => {
  test("splitTerms 按标点切分、留长度≥2", () => {
    expect(splitTerms("轮海秘境——激活生命之海")).toEqual(["轮海秘境", "激活生命之海"]);
  });

  test("条目任一候选词命中即算覆盖", () => {
    const text = "他终于激活了苦海，踏入轮海秘境。";
    const cov = entryCoverage(text, ["轮海秘境——激活生命之海", "不死山禁地"]);
    expect(cov.total).toBe(2);
    expect(cov.hit).toBe(1);
    expect(cov.hits[0]).toContain("轮海秘境");
    expect(cov.missed[0]).toContain("不死山");
  });
});

describe("worldSignatureEntries", () => {
  test("汇集各字段为条目", () => {
    const wb: WorldBible = {
      era: "荒古",
      tone: "悲壮",
      locations: ["东荒", "不死山"],
      factions: ["姜家"],
      powerSystem: ["苦海命泉"],
      items: ["神器鼎"],
      lore: ["黑暗时代"],
    };
    const entries = worldSignatureEntries(wb);
    expect(entries).toContain("不死山");
    expect(entries).toContain("苦海命泉");
    expect(entries).toContain("荒古");
  });

  test("undefined 返回空", () => {
    expect(worldSignatureEntries(undefined)).toEqual([]);
  });
});

describe("extractLexiconTerms / termCoverage", () => {
  test("抽取纯 CJK 2-4 字词并去停用词", () => {
    const terms = extractLexiconTerms("偏爱苍茫、亘古、万古、威压、大道");
    expect(terms).toContain("亘古");
    expect(terms).toContain("万古");
    expect(terms).toContain("威压");
    expect(terms).not.toContain("偏爱");
  });

  test("覆盖率统计命中/未命中", () => {
    const cov = termCoverage("威压弥漫，万古如一。", ["万古", "威压", "枯寂"]);
    expect(cov.total).toBe(3);
    expect(cov.hit).toBe(2);
    expect(cov.missed).toContain("枯寂");
  });
});

describe("句式/象声/负向", () => {
  test("短句占比", () => {
    // 3 句：短、短、长
    const r = shortSentenceRatio("他来了。刀出鞘。这是一个漫长而充满宿命意味的黄昏时分故事开端。");
    expect(r).toBeCloseTo(2 / 3, 5);
  });

  test("象声词计数", () => {
    expect(countOnomatopoeia("轰！砰的一声，咚。")).toBe(3);
  });

  test("通用宅斗负向命中明细", () => {
    const hits = countGenericDrama("小院里家常拌嘴，小院外无人。");
    const map = Object.fromEntries(hits.map((h) => [h.term, h.count]));
    expect(map["小院"]).toBe(2);
    expect(map["家常"]).toBe(1);
  });
});

describe("scoreOpening", () => {
  const worldEntries = ["东荒", "不死山", "苦海"];

  test("开头扎根世界 + 远景 → 满分", () => {
    const s = scoreOpening("洪荒天地，东荒之上，不死山传说流传万古。少年立于苦海之畔。", worldEntries);
    expect(s.wideShot).toBe(true);
    expect(s.groundedTermsInLead).toBeGreaterThanOrEqual(2);
    expect(s.score).toBeCloseTo(1, 5);
  });

  test("小院家常开场 → 低分", () => {
    const s = scoreOpening("小院里，母亲在念叨着家常琐事，锅里炖着菜。", worldEntries);
    expect(s.wideShot).toBe(false);
    expect(s.score).toBeLessThan(0.5);
  });
});

describe("gradeNovel 汇总", () => {
  const styleCard: StyleCard = {
    id: "chendong",
    label: "辰东式史诗",
    tagline: "t",
    rhythm: "r",
    lexicon: "苍茫、万古、威压、大道",
    voice: "v",
    setpiece: "s",
    hook: "h",
    avoid: "a",
    direction: { scene: "sc", opening: "op" },
  };
  const worldBible: WorldBible = {
    era: "荒古",
    tone: "悲壮",
    locations: ["东荒", "不死山"],
    factions: ["姜家"],
    powerSystem: ["苦海命泉"],
    items: ["神器鼎"],
    lore: ["黑暗时代"],
  };

  const good: GradeInput = {
    slug: "test",
    title: "测试书",
    chaptersWritten: 2,
    styleCard,
    worldBible,
    chapters: [
      { n: 1, title: "苦海", goal: "少年立于东荒" },
      { n: 2, title: "北行", goal: "北上不死山" },
    ],
    proses: [
      { n: 1, text: "洪荒天地，东荒苍茫。少年立于苦海命泉之畔，万古威压加身，姜家神器鼎震动。轰！" },
      { n: 2, text: "他北上不死山，黑暗时代将临，大道枯寂。" },
    ],
  };

  test("好样本：无重复、世界观有覆盖、开场达标", () => {
    const sc = gradeNovel(good);
    expect(sc.continuity.duplicates).toHaveLength(0);
    expect(sc.continuity.score).toBe(1);
    expect(sc.worldview.coverage.hit).toBeGreaterThan(0);
    expect(sc.opening.available).toBe(true);
    expect(sc.opening.score).toBeGreaterThanOrEqual(0.5);
    expect(sc.overall).toBeGreaterThan(0.5);
  });

  test("坏样本：重复章拉低连续性分", () => {
    const bad: GradeInput = {
      ...good,
      chapters: [
        { n: 1, title: "苦海", goal: "少年立于东荒" },
        { n: 2, title: "苦海", goal: "少年立于东荒" },
      ],
    };
    const sc = gradeNovel(bad);
    expect(sc.continuity.duplicates.length).toBeGreaterThan(0);
    expect(sc.continuity.score).toBeLessThan(1);
  });

  test("缺第 1 章正文 → opening 不可用", () => {
    const sc = gradeNovel({ ...good, proses: [{ n: 2, text: "只有第二章" }] });
    expect(sc.opening.available).toBe(false);
  });
});

describe("report 渲染", () => {
  test("renderReport 含标题、总分、门槛判定；renderSummaryLine 一行", () => {
    const sc = gradeNovel({
      slug: "s",
      title: "书",
      chaptersWritten: 1,
      worldBible: { era: "", tone: "", locations: [], factions: [], powerSystem: [], items: [], lore: [] },
      chapters: [{ n: 1, title: "a", goal: "g" }],
      proses: [{ n: 1, text: "正文" }],
    });
    const md = renderReport(sc);
    expect(md).toContain("# 验证报告");
    expect(md).toContain("门槛判定");
    expect(md).toContain("5 轴评审");
    expect(renderSummaryLine(sc)).toContain("总分");
  });
});
