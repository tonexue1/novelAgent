import { loadConfig, type LLMConfig } from "../config.ts";
import type { ChatRequest, ChatResult, Message } from "./types.ts";

/**
 * OpenAI 兼容的 chat.completions 客户端。
 * 只依赖原生 fetch，不引入任何 SDK，方便看清一次请求到底发了什么。
 */
export class LLMClient {
  private readonly config: LLMConfig;

  constructor(config?: LLMConfig) {
    this.config = config ?? loadConfig();
  }

  get model(): string {
    return this.config.model;
  }

  /** 发起一次对话补全请求，返回归一化后的 assistant 消息。 */
  async chat(req: ChatRequest): Promise<ChatResult> {
    const body: Record<string, unknown> = {
      model: this.config.model,
      messages: req.messages,
      temperature: req.temperature ?? 0,
    };
    if (req.tools && req.tools.length > 0) {
      body.tools = req.tools;
      body.tool_choice = req.toolChoice ?? "auto";
    }
    if (req.maxTokens) body.max_tokens = req.maxTokens;

    const res = await fetch(`${this.config.baseURL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `LLM 请求失败: ${res.status} ${res.statusText}\n${text}`,
      );
    }

    const data = (await res.json()) as ChatCompletionResponse;
    const choice = data.choices?.[0];
    if (!choice) {
      throw new Error(`LLM 返回中没有 choices: ${JSON.stringify(data)}`);
    }

    const message: Message = {
      role: "assistant",
      content: choice.message.content ?? null,
      tool_calls: choice.message.tool_calls,
    };

    return { message, finishReason: choice.finish_reason ?? null };
  }
}

/** 仅覆盖我们用到的响应字段。 */
interface ChatCompletionResponse {
  choices?: Array<{
    finish_reason?: string | null;
    message: {
      role: string;
      content: string | null;
      tool_calls?: Message["tool_calls"];
    };
  }>;
}
