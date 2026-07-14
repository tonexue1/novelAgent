/**
 * 读取 OpenAI 兼容接口的环境变量配置。
 * Bun 会自动加载项目根目录的 .env 文件。
 */

/**
 * MiniMax-M3 的思考开关（OpenAI 兼容接口的 `thinking.type`）：
 *   - "disabled"：跳过思考直接作答（快，省 token）。
 *   - "adaptive"：开启思考（慢，会生成大量随后被我们剥离的推理 token）。
 *   - null：不发送该字段（用于非 MiniMax 端点，避免未知参数报错）。
 * 说明：M2.x 系列忽略此参数，思考始终开启。
 */
export type ThinkingMode = "disabled" | "adaptive" | null;

export interface LLMConfig {
  baseURL: string;
  apiKey: string;
  model: string;
  /** 单次请求超时（毫秒）。防止上游卡住导致无限等待、并长期占住生成锁。 */
  timeoutMs: number;
  /** M3 思考开关；缺省 "disabled"（推理反正会被剥离，关掉可大幅提速）。 */
  thinking: ThinkingMode;
  /** 遇到瞬时错误（限流/过载/5xx/网络抖动）时的最大重试次数（不含首次）。 */
  maxRetries: number;
}

/** 单次 LLM 请求默认超时（毫秒）。成文/推理模型可能较慢，给足 4 分钟。 */
export const DEFAULT_TIMEOUT_MS = 240_000;

/** 瞬时错误默认重试次数（不含首次）。上游 529 过载/500 抖动很常见，重试几次即可自愈。 */
export const DEFAULT_MAX_RETRIES = 3;

/** 读取非负整数环境变量；缺失/非法时回落到默认值。 */
function readIntEnv(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

/** 把环境变量值解析成 ThinkingMode。空/off/none → null（不发送）。 */
function parseThinking(raw: string | undefined, fallback: ThinkingMode): ThinkingMode {
  const v = raw?.trim().toLowerCase();
  if (v == null || v === "") return fallback;
  if (v === "off" || v === "none" || v === "omit") return null;
  if (v === "adaptive" || v === "on" || v === "enabled") return "adaptive";
  if (v === "disabled" || v === "disable") return "disabled";
  return fallback;
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
  "eval",
] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];

/** 解析某角色应使用的模型：OPENAI_MODEL_<ROLE> 优先，否则回落到 fallback（通常是 OPENAI_MODEL）。 */
export function modelForRole(role: AgentRole, fallback: string): string {
  const override = process.env[`OPENAI_MODEL_${role.toUpperCase()}`]?.trim();
  return override || fallback;
}

/** 解析某角色的思考开关：OPENAI_THINKING_<ROLE> 优先，否则回落到全局 fallback。 */
export function thinkingForRole(role: AgentRole, fallback: ThinkingMode): ThinkingMode {
  return parseThinking(process.env[`OPENAI_THINKING_${role.toUpperCase()}`], fallback);
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
    timeoutMs: Number(process.env.OPENAI_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS,
    // 默认关掉 M3 思考：推理内容反正会被 stripReasoning 丢弃，关掉能省下大量解码时间。
    thinking: parseThinking(process.env.OPENAI_THINKING, "disabled"),
    maxRetries: readIntEnv(process.env.OPENAI_MAX_RETRIES, DEFAULT_MAX_RETRIES),
  };
}
