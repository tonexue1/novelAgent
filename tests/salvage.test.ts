import { describe, expect, test } from "bun:test";
import { canSalvageScene } from "../src/drama/agent.ts";
import type { Beat } from "../src/drama/scene.ts";

const act = (actor: string): Beat => ({ actor, kind: "act", content: "……" });
const narr = (): Beat => ({ actor: "旁白", kind: "narration", content: "【旁白】" });

describe("canSalvageScene", () => {
  test("攒够 3 次角色发言即可就地收场成文", () => {
    expect(canSalvageScene([act("甲"), act("乙"), act("甲")])).toBe(true);
  });

  test("不足 3 次发言时救不回来", () => {
    expect(canSalvageScene([act("甲"), act("乙")])).toBe(false);
    expect(canSalvageScene([])).toBe(false);
  });

  test("旁白不计入发言数", () => {
    expect(canSalvageScene([narr(), narr(), narr(), act("甲")])).toBe(false);
    expect(canSalvageScene([narr(), act("甲"), narr(), act("乙"), narr(), act("甲")])).toBe(true);
  });

  test("可自定义门槛", () => {
    expect(canSalvageScene([act("甲")], 1)).toBe(true);
    expect(canSalvageScene([act("甲"), act("乙"), act("甲"), act("乙")], 5)).toBe(false);
  });
});
