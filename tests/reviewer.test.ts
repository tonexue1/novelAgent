import { describe, expect, test } from "bun:test";
import { parseCritique, isPass } from "../src/drama/reviewer.ts";

describe("parseCritique", () => {
  test("干净 JSON：逐条取 quote/why/fix", () => {
    const c = parseCritique(
      JSON.stringify({
        issues: [
          { quote: "他抬起头", why: "主角是女子，前文钉死", fix: "他→她" },
          { quote: "上品木灵根", why: "前文为黄阶下品灵根", fix: "改回黄阶下品灵根" },
        ],
      }),
    );
    expect(c.parsed).toBe(true);
    expect(c.issues).toHaveLength(2);
    expect(c.issues[0]).toEqual({ quote: "他抬起头", why: "主角是女子，前文钉死", fix: "他→她" });
    expect(isPass(c)).toBe(false);
  });

  test("夹带解释文字/代码围栏：仍能抽出 JSON", () => {
    const c = parseCritique(
      "好的，这是我的审校结果：\n```json\n{\"issues\":[{\"quote\":\"细沙\",\"why\":\"时令冲突\",\"fix\":\"删去\"}]}\n```\n以上。",
    );
    expect(c.parsed).toBe(true);
    expect(c.issues).toHaveLength(1);
    expect(c.issues[0]!.quote).toBe("细沙");
  });

  test("空 issues：解析成功且判为通过", () => {
    const c = parseCritique('{"issues":[]}');
    expect(c.parsed).toBe(true);
    expect(c.issues).toHaveLength(0);
    expect(isPass(c)).toBe(true);
  });

  test("串内游离双引号：兜底转义后仍可解析", () => {
    const c = parseCritique('{"issues":[{"quote":"他说"走"","why":"性别错","fix":"他→她"}]}');
    expect(c.parsed).toBe(true);
    expect(c.issues).toHaveLength(1);
    expect(c.issues[0]!.why).toBe("性别错");
  });

  test("过滤空对象/缺 quote 且缺 why 的无效条目", () => {
    const c = parseCritique(
      JSON.stringify({ issues: [{}, { fix: "只有改法" }, { quote: "有原句" }] }),
    );
    expect(c.parsed).toBe(true);
    expect(c.issues).toHaveLength(1);
    expect(c.issues[0]!.quote).toBe("有原句");
  });

  test("乱码/答非所问：parsed=false，按通过兜底", () => {
    const c = parseCritique("对不起我审不了这段");
    expect(c.parsed).toBe(false);
    expect(c.issues).toHaveLength(0);
    expect(isPass(c)).toBe(true);
  });

  test("有 JSON 但没有 issues 字段：parsed=false", () => {
    const c = parseCritique('{"notes":"看着没问题"}');
    expect(c.parsed).toBe(false);
    expect(c.issues).toHaveLength(0);
  });

  test("空串：parsed=false，按通过兜底", () => {
    const c = parseCritique("");
    expect(c.parsed).toBe(false);
    expect(isPass(c)).toBe(true);
  });
});
