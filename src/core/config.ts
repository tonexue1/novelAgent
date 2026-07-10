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
