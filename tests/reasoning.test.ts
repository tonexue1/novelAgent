import { describe, expect, test } from "bun:test";
import { stripReasoning } from "../src/core/llm/client.ts";

describe("stripReasoning", () => {
  test("去掉成对 <think>…</think>，保留其后正文", () => {
    const out = stripReasoning("<think>Let me analyze the scene...</think>\n\n（独坐角落）……来得齐。");
    expect(out).toBe("（独坐角落）……来得齐。");
  });

  test("多段 think 全部去掉", () => {
    expect(stripReasoning("<think>a</think>正文一<think>b</think>正文二")).toBe("正文一正文二");
  });

  test("只有落单结束标签时取其后正文", () => {
    expect(stripReasoning("reasoning here</think>真正的回答")).toBe("真正的回答");
  });

  test("未闭合的 <think>（被截断）整段丢弃", () => {
    expect(stripReasoning("<think>思考被截断没写完")).toBe("");
  });

  test("大小写不敏感", () => {
    expect(stripReasoning("<THINK>x</THINK>答案")).toBe("答案");
  });

  test("无 think 标签原样返回（去空白）", () => {
    expect(stripReasoning("  正常 JSON 或台词  ")).toBe("正常 JSON 或台词");
  });

  test("null/undefined 透传", () => {
    expect(stripReasoning(null)).toBeNull();
    expect(stripReasoning(undefined)).toBeNull();
  });

  test("JSON 前的 think 被剥离后可被解析", () => {
    const out = stripReasoning('<think>I should output JSON</think>{"action":"end"}');
    expect(out).toBe('{"action":"end"}');
    expect(JSON.parse(out!).action).toBe("end");
  });
});
