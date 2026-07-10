import { describe, expect, test } from "bun:test";
import { parseScene, parseDirectorDecision } from "../src/drama/director.ts";

describe("parseScene", () => {
  test("解析背景与人物", () => {
    const s = parseScene(
      JSON.stringify({
        background: "雨夜客栈",
        characters: [
          { name: "沈孤鸿", identity: "刀客", personality: "沉默", goal: "复仇", style: "话少" },
          { name: "柳三娘", identity: "捕快", personality: "泼辣", goal: "请功", secret: "内鬼", style: "机锋" },
        ],
      }),
    );
    expect(s).not.toBeNull();
    expect(s!.background).toBe("雨夜客栈");
    expect(s!.characters).toHaveLength(2);
    expect(s!.characters[1]!.secret).toBe("内鬼");
  });

  test("被文字包裹的 JSON 也能解析", () => {
    const s = parseScene('好的：\n{"background":"荒庙","characters":[{"name":"甲"},{"name":"乙"}]}\n完');
    expect(s).not.toBeNull();
    expect(s!.characters.map((c) => c.name)).toEqual(["甲", "乙"]);
  });

  test("人物不足 2 或缺背景返回 null（交上层兜底）", () => {
    expect(parseScene('{"background":"x","characters":[{"name":"甲"}]}')).toBeNull();
    expect(parseScene('{"background":"","characters":[{"name":"甲"},{"name":"乙"}]}')).toBeNull();
    expect(parseScene("不是 JSON")).toBeNull();
  });

  test("过滤无名字的人物项", () => {
    const s = parseScene(
      '{"background":"b","characters":[{"name":"甲"},{"identity":"无名"},{"name":"乙"}]}',
    );
    expect(s!.characters.map((c) => c.name)).toEqual(["甲", "乙"]);
  });
});

describe("parseDirectorDecision", () => {
  const names = ["沈孤鸿", "柳三娘", "醉丐"];

  test("解析 act + 合法 actor + 旁白", () => {
    const d = parseDirectorDecision(
      '{"stage":"灯火摇曳","action":"act","actor":"柳三娘","reason":"她被点名"}',
      names,
    );
    expect(d.action).toBe("act");
    expect(d.actor).toBe("柳三娘");
    expect(d.stage).toBe("灯火摇曳");
  });

  test("解析 end", () => {
    expect(parseDirectorDecision('{"action":"end","reason":"了断"}', names).action).toBe("end");
  });

  test("actor 不在名单里则置空", () => {
    const d = parseDirectorDecision('{"action":"act","actor":"路人甲"}', names);
    expect(d.action).toBe("act");
    expect(d.actor).toBeUndefined();
  });

  test("无法解析默认继续演（act，actor 空）", () => {
    const d = parseDirectorDecision("胡言乱语", names);
    expect(d.action).toBe("act");
    expect(d.actor).toBeUndefined();
  });

  test("旁白夹带角色对白（引号台词）时丢弃旁白，仍继续行动", () => {
    const d = parseDirectorDecision(
      '{"stage":"柳三娘噙着笑：“马爷这话在理”","action":"act","actor":"柳三娘"}',
      names,
    );
    expect(d.stage).toBeUndefined();
    expect(d.action).toBe("act");
    expect(d.actor).toBe("柳三娘");
  });

  test("旁白夹带“某某道：”式引语时也丢弃", () => {
    const d = parseDirectorDecision(
      '{"stage":"马瘸子干笑道：新人来了","action":"act","actor":"沈孤鸿"}',
      names,
    );
    expect(d.stage).toBeUndefined();
    expect(d.actor).toBe("沈孤鸿");
  });

  test("纯环境旁白保留", () => {
    const d = parseDirectorDecision(
      '{"stage":"院落里卷起一阵旋风，枯叶簌簌作响","action":"act","actor":"醉丐"}',
      names,
    );
    expect(d.stage).toBe("院落里卷起一阵旋风，枯叶簌簌作响");
    expect(d.actor).toBe("醉丐");
  });
});
