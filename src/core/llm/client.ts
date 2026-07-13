import { loadConfig, modelForRole, type LLMConfig, type AgentRole } from "../config.ts";
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

  /**
   * 派生一个用于指定角色的客户端：共用 baseURL/apiKey，模型换成该角色的配置
   * （`OPENAI_MODEL_<ROLE>`，缺省回落到当前模型）。无覆盖时原样返回自身，避免多建对象。
   */
  withRole(role: AgentRole): LLMClient {
    const roleModel = modelForRole(role, this.config.model);
    if (roleModel === this.config.model) return this;
    return new LLMClient({ ...this.config, model: roleModel });
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
      content: stripReasoning(choice.message.content),
      tool_calls: choice.message.tool_calls,
    };

    return { message, finishReason: choice.finish_reason ?? null };
  }
}

/**
 * 剥离推理模型内联在正文里的思维链。带 thinking 的模型（经某些网关时）会把
 * <think>…</think> 直接混进 content，若不去掉就会污染角色台词/破坏 JSON 解析。
 * 兼容三种情形：成对标签、只有结束标签（正文在其后）、未闭合的开始标签（被截断）。
 */
export function stripReasoning(content: string | null | undefined): string | null {
  if (content == null) return null;
  let s = content;
  // 1) 去掉成对的 <think>…</think>
  s = s.replace(/<think>[\s\S]*?<\/think>/gi, "");
  // 2) 只有落单的结束标签时，正文在最后一个 </think> 之后
  const endIdx = s.toLowerCase().lastIndexOf("</think>");
  if (endIdx !== -1) s = s.slice(endIdx + "</think>".length);
  // 3) 未闭合的 <think>（响应被截断）：从它到结尾一并丢弃
  s = s.replace(/<think>[\s\S]*$/i, "");
  return s.trim();
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
