import { describe, expect, test } from "bun:test";
import { parseMemoryUpdate } from "../src/story/archivist.ts";

describe("parseMemoryUpdate", () => {
  test("解析完整更新", () => {
    const u = parseMemoryUpdate(
      JSON.stringify({
        event: "少年夺回断刀",
        rollingSummary: "至此少年已下山并夺回断刀。",
        worldAdditions: { locations: ["断魂崖"], factions: ["血刀门"] },
        threads: [
          { id: "map", description: "藏宝图下落", status: "open" },
          { id: "kill", description: "灭门真凶", status: "resolved" },
        ],
        characterUpdates: [
          {
            name: "少年",
            status: "受伤",
            currentGoal: "查明真凶",
            relationships: [{ who: "师父", relation: "亡师" }],
            secretRevealed: true,
          },
        ],
      }),
    );
    expect(u.event).toBe("少年夺回断刀");
    expect(u.worldAdditions.locations).toContain("断魂崖");
    expect(u.threads).toHaveLength(2);
    expect(u.threads.find((t) => t.id === "kill")!.status).toBe("resolved");
    expect(u.characterUpdates).toHaveLength(1);
    expect(u.characterUpdates[0]!.secretRevealed).toBe(true);
    expect(u.characterUpdates[0]!.relationships![0]!.who).toBe("师父");
  });

  test("缺字段时给安全默认", () => {
    const u = parseMemoryUpdate("{}");
    expect(u.event).toBe("");
    expect(u.threads).toEqual([]);
    expect(u.characterUpdates).toEqual([]);
    expect(u.worldAdditions.locations).toEqual([]);
  });

  test("非法状态归一为 open；无 id 时用描述兜底", () => {
    const u = parseMemoryUpdate('{"threads":[{"description":"某悬念","status":"???"}]}');
    expect(u.threads[0]!.status).toBe("open");
    expect(u.threads[0]!.id.length).toBeGreaterThan(0);
  });

  test("过滤无名字的人物更新与无描述的伏笔", () => {
    const u = parseMemoryUpdate('{"threads":[{"status":"open"}],"characterUpdates":[{"status":"在世"}]}');
    expect(u.threads).toEqual([]);
    expect(u.characterUpdates).toEqual([]);
  });

  test("被文字包裹也能解析", () => {
    const u = parseMemoryUpdate('结果如下：\n{"event":"决战开始"}\n完毕');
    expect(u.event).toBe("决战开始");
  });

  test("解析道具账本、别名与当前进度锚点", () => {
    const u = parseMemoryUpdate(
      JSON.stringify({
        event: "阿九夺回真拓本",
        currentLocation: "断魂渡渡口，僵持已破",
        props: [
          { name: "真拓本", holder: "阿九", location: "贴身油布包", status: "完好" },
          { name: "", holder: "无名", location: "x", status: "y" },
        ],
        characterUpdates: [
          { name: "封沉岳", aliases: ["师叔", "左腿瘸人"], status: "在世" },
        ],
      }),
    );
    expect(u.currentLocation).toBe("断魂渡渡口，僵持已破");
    expect(u.props).toHaveLength(1);
    expect(u.props[0]!.name).toBe("真拓本");
    expect(u.props[0]!.holder).toBe("阿九");
    expect(u.characterUpdates[0]!.aliases).toEqual(["师叔", "左腿瘸人"]);
  });

  test("缺 props/currentLocation 时给安全默认", () => {
    const u = parseMemoryUpdate("{}");
    expect(u.props).toEqual([]);
    expect(u.currentLocation).toBe("");
  });
});
