import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { modelForRole } from "../src/core/config.ts";

const KEYS = [
  "OPENAI_MODEL_CHARACTER",
  "OPENAI_MODEL_NOVELIST",
  "OPENAI_MODEL_DIRECTOR",
];

// .env 里可能配了 OPENAI_MODEL_<ROLE>（Bun 测试会自动加载 .env），每个用例前先清空，
// 保证测试不受本机配置影响。
beforeEach(() => {
  for (const k of KEYS) delete process.env[k];
});

afterEach(() => {
  for (const k of KEYS) delete process.env[k];
});

describe("modelForRole", () => {
  test("无覆盖时回落到 fallback", () => {
    expect(modelForRole("character", "base-model")).toBe("base-model");
  });

  test("OPENAI_MODEL_<ROLE> 覆盖生效", () => {
    process.env.OPENAI_MODEL_CHARACTER = "role-play-model";
    expect(modelForRole("character", "base-model")).toBe("role-play-model");
    // 未设置的角色仍回落
    expect(modelForRole("novelist", "base-model")).toBe("base-model");
  });

  test("空白覆盖视为未设置", () => {
    process.env.OPENAI_MODEL_DIRECTOR = "   ";
    expect(modelForRole("director", "base-model")).toBe("base-model");
  });
});
