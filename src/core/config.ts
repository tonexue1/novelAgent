/**
 * 读取 OpenAI 兼容接口的环境变量配置。
 * Bun 会自动加载项目根目录的 .env 文件。
 */

export interface LLMConfig {
  baseURL: string;
  apiKey: string;
  model: string;
}

/**
 * 可按角色分别指定模型的 agent 角色。演戏用擅长角色扮演的模型、成书/谋篇用文笔与
 * 逻辑更强的模型，各取所长。通过环境变量 `OPENAI_MODEL_<ROLE>` 覆盖，缺省回落到
 * `OPENAI_MODEL`。例如 OPENAI_MODEL_CHARACTER=MiniMax-M2-her、OPENAI_MODEL_NOVELIST=MiniMax-M3。
 */
export const AGENT_ROLES = [
  "director",
  "character",
  "novelist",
  "planner",
  "archivist",
] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];

/** 解析某角色应使用的模型：OPENAI_MODEL_<ROLE> 优先，否则回落到 fallback（通常是 OPENAI_MODEL）。 */
export function modelForRole(role: AgentRole, fallback: string): string {
  const override = process.env[`OPENAI_MODEL_${role.toUpperCase()}`]?.trim();
  return override || fallback;
}

/**
 * 读取并校验 LLM 配置。缺失关键项时抛出带指引的错误，
 * 便于第一次运行的人知道该配置什么。
 */
export function loadConfig(): LLMConfig {
  const baseURL = process.env.OPENAI_BASE_URL?.trim();
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  const model = process.env.OPENAI_MODEL?.trim();

  const missing: string[] = [];
  if (!baseURL) missing.push("OPENAI_BASE_URL");
  if (!apiKey) missing.push("OPENAI_API_KEY");
  if (!model) missing.push("OPENAI_MODEL");

  if (missing.length > 0) {
    throw new Error(
      `缺少环境变量: ${missing.join(", ")}。\n` +
        `请复制 .env.example 为 .env 并填写这些值 (参考 README)。`,
    );
  }

  // 去掉末尾多余的斜杠，避免拼出 //chat/completions
  return {
    baseURL: baseURL!.replace(/\/+$/, ""),
    apiKey: apiKey!,
    model: model!,
  };
}
