import { describe, expect, test } from "bun:test";
import { validateFixture, listFixtures, loadFixture } from "../fixtures.ts";

const goodFixture = {
  id: "demo",
  label: "示例",
  seed: "s",
  goal: "推进本章",
  scene: {
    background: "夜雨客栈",
    characters: [{ name: "甲", identity: "客", personality: "冷", goal: "等人", style: "短句" }],
  },
  transcript: [{ actor: "甲", kind: "act", content: "坐。" }],
};

describe("validateFixture", () => {
  test("合法 fixture 无错误", () => {
    expect(validateFixture(goodFixture)).toEqual([]);
  });

  test("非对象直接报错", () => {
    expect(validateFixture(null)).toEqual(["不是对象"]);
    expect(validateFixture("x").length).toBeGreaterThan(0);
  });

  test("缺 id/goal/scene/transcript 分别报错", () => {
    expect(validateFixture({ ...goodFixture, id: "" })).toContain("缺 id");
    expect(validateFixture({ ...goodFixture, goal: "" })).toContain("缺 goal");
    const { scene, ...noScene } = goodFixture;
    expect(validateFixture(noScene)).toContain("缺 scene");
    expect(validateFixture({ ...goodFixture, transcript: [] })).toContain("transcript 至少 1 条");
  });

  test("scene 缺 background / 无人物报错", () => {
    expect(validateFixture({ ...goodFixture, scene: { background: "", characters: [] } })).toContain(
      "scene 缺 background",
    );
  });

  test("transcript 条目缺 content 报错", () => {
    const errs = validateFixture({
      ...goodFixture,
      transcript: [{ actor: "甲", kind: "act", content: "" }],
    });
    expect(errs.some((e) => e.includes("content"))).toBe(true);
  });
});

describe("内置 fixtures", () => {
  test("目录下的 fixtures 均合法且 id 唯一", () => {
    const fx = listFixtures();
    expect(fx.length).toBeGreaterThanOrEqual(3);
    const ids = fx.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("按 id 加载三种风味 fixture", () => {
    expect(loadFixture("zhetian-trial").style).toBe("chendong");
    expect(loadFixture("gulong-tavern").style).toBe("gulong");
    expect(loadFixture("jinyong-market").style).toBe("jinyong");
  });

  test("加载不存在的 id 抛错", () => {
    expect(() => loadFixture("no-such-fixture")).toThrow();
  });
});
