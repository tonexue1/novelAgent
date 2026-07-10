/**
 * OpenAI 兼容 chat.completions 接口相关的核心类型。
 * 这些类型在所有阶段之间复用。
 */

export type Role = "system" | "user" | "assistant" | "tool";

/** 一条对话消息。字段布局对齐 OpenAI chat.completions。 */
export interface Message {
  role: Role;
  /** 文本内容。assistant 发起纯工具调用时可能为 null。 */
  content: string | null;
  /** assistant 发起的工具调用（原生 Function Call）。 */
  tool_calls?: ToolCall[];
  /** role 为 "tool" 时，指向被回填结果的那次调用 id。 */
  tool_call_id?: string;
  /** 工具消息或函数名。 */
  name?: string;
}

/** 模型返回的一次工具调用。 */
export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    /** JSON 字符串形式的参数，需要自行解析。 */
    arguments: string;
  };
}

/** 传给 API 的工具描述（tools 数组的元素）。 */
export interface ToolSpec {
  type: "function";
  function: {
    name: string;
    description: string;
    /** JSON Schema 描述的参数结构。 */
    parameters: object;
  };
}

/** 调用 LLM 的入参。 */
export interface ChatRequest {
  messages: Message[];
  tools?: ToolSpec[];
  /** 是否强制/允许工具调用，默认 "auto"。 */
  toolChoice?: "auto" | "none";
  temperature?: number;
  maxTokens?: number;
}

/** 归一化后的返回：一条 assistant 消息 + 结束原因。 */
export interface ChatResult {
  message: Message;
  finishReason: string | null;
}
