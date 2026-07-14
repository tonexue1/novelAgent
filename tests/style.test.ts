import { describe, expect, test } from "bun:test";
import {
  STYLE_CARDS,
  DEFAULT_STYLE_INTENSITY,
  loadStyleCards,
  resolveStyleCard,
  resolveIntensity,
  renderStyleCard,
  renderStyleBrief,
  renderDirectorCard,
} from "../src/story/style.ts";

describe("loadStyleCards（从 styles/ 目录读盘）", () => {
  test("扫描内置目录，加载三张预设卡", () => {
    const cards = loadStyleCards();
    const ids = cards.map((c) => c.id);
    expect(ids).toContain("chendong");
    expect(ids).toContain("gulong");
    expect(ids).toContain("jinyong");
  });

  test("STYLE_CARDS 快照与磁盘一致", () => {
    expect(STYLE_CARDS.map((c) => c.id).sort()).toEqual(
      loadStyleCards()
        .map((c) => c.id)
        .sort(),
    );
  });
});

describe("resolveStyleCard", () => {
  test("空/none/无 → 不启用（undefined）", () => {
    expect(resolveStyleCard()).toBeUndefined();
    expect(resolveStyleCard("")).toBeUndefined();
    expect(resolveStyleCard("   ")).toBeUndefined();
    expect(resolveStyleCard(null)).toBeUndefined();
    expect(resolveStyleCard("none")).toBeUndefined();
    expect(resolveStyleCard("无")).toBeUndefined();
    expect(resolveStyleCard("默认")).toBeUndefined();
  });

  test("按 id 命中预设（大小写不敏感）", () => {
    expect(resolveStyleCard("chendong")?.id).toBe("chendong");
    expect(resolveStyleCard("ChenDong")?.id).toBe("chendong");
    expect(resolveStyleCard("gulong")?.label).toBe("古龙式冷硬");
  });

  test("按中文 label 命中预设", () => {
    expect(resolveStyleCard("辰东式史诗")?.id).toBe("chendong");
    expect(resolveStyleCard("金庸式醇厚")?.id).toBe("jinyong");
  });

  test("未匹配的非空输入 → 自定义卡", () => {
    const c = resolveStyleCard("冷峻黑色幽默");
    expect(c?.id).toBe("custom");
    expect(c?.label).toBe("冷峻黑色幽默");
    expect(c?.voice).toContain("冷峻黑色幽默");
  });

  test("每张预设卡字段完整", () => {
    for (const s of STYLE_CARDS) {
      expect(s.id).toBeTruthy();
      expect(s.label).toBeTruthy();
      expect(s.tagline).toBeTruthy();
      expect(s.rhythm).toBeTruthy();
      expect(s.voice).toBeTruthy();
      expect(s.setpiece).toBeTruthy();
    }
  });
});

describe("resolveIntensity", () => {
  test("空/非法回落默认 medium", () => {
    expect(resolveIntensity()).toBe(DEFAULT_STYLE_INTENSITY);
    expect(resolveIntensity("")).toBe("medium");
    expect(resolveIntensity("xxx")).toBe("medium");
  });

  test("识别中英文强度", () => {
    expect(resolveIntensity("light")).toBe("light");
    expect(resolveIntensity("淡")).toBe("light");
    expect(resolveIntensity("strong")).toBe("strong");
    expect(resolveIntensity("浓墨")).toBe("strong");
    expect(resolveIntensity("适中")).toBe("medium");
  });
});

describe("renderStyleCard", () => {
  test("不启用时返回空串", () => {
    expect(renderStyleCard(undefined)).toBe("");
  });

  test("渲染含卡名、强度标签与边界约束", () => {
    const card = resolveStyleCard("chendong")!;
    const strong = renderStyleCard(card, "strong");
    expect(strong).toContain("辰东式史诗");
    expect(strong).toContain("浓墨");
    expect(strong).toContain("句式节奏");
    // 分场景说明与边界约束务必存在。
    expect(strong).toContain("名场面/战斗");
    expect(strong).toContain("专有名词");
  });

  test("不同强度产出不同的强度指令", () => {
    const card = resolveStyleCard("gulong")!;
    expect(renderStyleCard(card, "light")).toContain("淡入");
    expect(renderStyleCard(card, "medium")).toContain("适中");
    expect(renderStyleCard(card, "strong")).toContain("浓墨");
  });
});

describe("renderStyleBrief", () => {
  test("不启用时返回空串", () => {
    expect(renderStyleBrief(undefined)).toBe("");
  });

  test("含卡名且比全卡短", () => {
    const card = resolveStyleCard("jinyong")!;
    const brief = renderStyleBrief(card);
    const full = renderStyleCard(card, "medium");
    expect(brief).toContain("金庸式醇厚");
    expect(brief.length).toBeLessThan(full.length);
  });
});

describe("风味卡 direction 段（供导演读）", () => {
  test("三张预设卡都带 direction.scene 与 direction.opening", () => {
    for (const id of ["chendong", "gulong", "jinyong"]) {
      const card = resolveStyleCard(id)!;
      expect(card.direction).toBeDefined();
      expect(card.direction!.scene).toBeTruthy();
      expect(card.direction!.opening).toBeTruthy();
    }
  });

  test("自定义卡不含 direction", () => {
    expect(resolveStyleCard("冷峻黑色幽默")?.direction).toBeUndefined();
  });
});

describe("renderDirectorCard", () => {
  test("无卡/无 direction 返回空串", () => {
    expect(renderDirectorCard(undefined, 1)).toBe("");
    expect(renderDirectorCard(resolveStyleCard("冷峻黑色幽默"), 1)).toBe("");
  });

  test("scene 恒常注入（任意章）", () => {
    const card = resolveStyleCard("chendong")!;
    const ch5 = renderDirectorCard(card, 5);
    expect(ch5).toContain("辰东式史诗");
    expect(ch5).toContain("场面调度");
    // 非第 1 章不注入开篇起势。
    expect(ch5).not.toContain("开篇起势");
  });

  test("opening 仅第 1 章注入", () => {
    const card = resolveStyleCard("chendong")!;
    const ch1 = renderDirectorCard(card, 1);
    expect(ch1).toContain("开篇起势");
    expect(ch1.length).toBeGreaterThan(renderDirectorCard(card, 2).length);
  });
});
