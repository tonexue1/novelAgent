import {
  loadConfig,
  modelForRole,
  thinkingForRole,
  type LLMConfig,
  type AgentRole,
} from "../config.ts";
import type { ChatRequest, ChatResult, Message } from "./types.ts";
import { tracePrompt, traceResponse } from "./trace.ts";

/**
 * OpenAI 兼容的 chat.completions 客户端。
 * 只依赖原生 fetch，不引入任何 SDK，方便看清一次请求到底发了什么。
 */
export class LLMClient {
  private readonly config: LLMConfig;
  /** 调用来源标签（角色名），仅用于计时日志归因。 */
  private readonly label: string;

  constructor(config?: LLMConfig, label = "default") {
    this.config = config ?? loadConfig();
    this.label = label;
  }

  get model(): string {
    return this.config.model;
  }

  /**
   * 派生一个用于指定角色的客户端：共用 baseURL/apiKey，模型换成该角色的配置
   * （`OPENAI_MODEL_<ROLE>`，缺省回落到当前模型）。始终带上角色标签，便于计时归因。
   */
  withRole(role: AgentRole): LLMClient {
    const roleModel = modelForRole(role, this.config.model);
    const roleThinking = thinkingForRole(role, this.config.thinking);
    return new LLMClient({ ...this.config, model: roleModel, thinking: roleThinking }, role);
  }

  /** 当前调用标签（角色名），用于追踪/日志归因。 */
  get callLabel(): string {
    return this.label;
  }

  /**
   * 派生一个只换【调用标签】的客户端（模型/配置全部不变），用于日志计时与
   * 提示词追踪的来源归因。例如给每个角色单独打上人物名，逐拍可分辨。
   */
  withLabel(label: string): LLMClient {
    return new LLMClient(this.config, label);
  }

  /**
   * 发起一次对话补全请求，返回归一化后的 assistant 消息。
   * 遇到瞬时错误（上游 529 过载、5xx 抖动、限流、网络中断）会自动退避重试，
   * 避免整章生成因一次抖动前功尽弃；非瞬时错误（内容审核、余额、鉴权、超时）直接抛出。
   */
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
    // M3 思考开关：默认 "disabled"，跳过被丢弃的推理链，大幅提速。null 时不发送该字段。
    if (this.config.thinking) body.thinking = { type: this.config.thinking };

    // 计时埋点：统计本次请求的输入规模，用于定位瓶颈（哪个角色/环节慢）。
    const promptChars = req.messages.reduce(
      (n, m) => n + (typeof m.content === "string" ? m.content.length : 0),
      0,
    );

    // 提示词追踪（LLM_TRACE 开启才落盘）：只记一次逻辑调用，不随重试重复；成功后回填回复。
    const traceId = tracePrompt(this.label, this.config.model, req.messages, req.temperature ?? 0);

    const maxAttempts = this.config.maxRetries + 1;
    let lastErr: Error | undefined;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const result = await this.attemptChat(body, promptChars);
        traceResponse(traceId, result.message.content, result.finishReason);
        return result;
      } catch (err) {
        const transient = err instanceof TransientError;
        if (!transient || attempt >= maxAttempts) {
          // 非瞬时错误，或已用尽重试次数：抛出可读信息。
          throw transient ? new Error((err as TransientError).message) : err;
        }
        lastErr = err as Error;
        const delayMs = backoffMs(attempt);
        console.log(
          `\x1b[33m[重试] ${this.label} ${this.config.model} 第 ${attempt}/${this.config.maxRetries} 次失败：` +
            `${(err as TransientError).shortReason}；${(delayMs / 1000).toFixed(1)}s 后重试\x1b[0m`,
        );
        await sleep(delayMs);
      }
    }
    throw lastErr ?? new Error(`LLM 请求失败 (model=${this.config.model})`);
  }

  /** 单次尝试：发请求 + 解析 + 计时。瞬时失败抛 {@link TransientError}，其余抛普通 Error。 */
  private async attemptChat(
    body: Record<string, unknown>,
    promptChars: number,
  ): Promise<ChatResult> {
    const startedAt = Date.now();

    // 超时保护：上游偶尔会对超长/慢请求无限挂起，用 AbortController 兜底，
    // 否则请求永不返回，还会长期占住"生成中"的锁。
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    let res: Response;
    try {
      res = await fetch(`${this.config.baseURL}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      if (controller.signal.aborted) {
        // 超时不重试：已经等了很久，多半是这次请求本身太慢，重试只会再等一遍。
        throw new Error(
          `LLM 请求超时 (model=${this.config.model}, ${this.config.timeoutMs}ms)：上游未在时限内返回。` +
            `可换更快的模型，或用 OPENAI_TIMEOUT_MS 调大超时。`,
        );
      }
      // 网络层错误（连接重置/DNS/中断）多为瞬时，可重试。
      const msg = err instanceof Error ? err.message : String(err);
      throw new TransientError(`网络错误：${msg}`, `LLM 网络错误 (model=${this.config.model})：${msg}`);
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const full = `LLM 请求失败 (model=${this.config.model}): ${res.status} ${res.statusText}\n${text}`;
      if (isRetryableStatus(res.status)) {
        throw new TransientError(`HTTP ${res.status}`, full);
      }
      throw new Error(full);
    }

    const data = (await res.json()) as ChatCompletionResponse;
    // MiniMax 等接口常返回 HTTP 200，却把错误塞进 base_resp（如 1027 内容审核、
    // 1008 余额不足、1002 触发限流）。这里显式暴露，避免只看到"没有 choices"。
    const baseResp = data.base_resp;
    if (baseResp && typeof baseResp.status_code === "number" && baseResp.status_code !== 0) {
      const full =
        `LLM 接口返回错误 (model=${this.config.model}): ` +
        `status_code=${baseResp.status_code}${baseResp.status_msg ? ` ${baseResp.status_msg}` : ""}`;
      if (isRetryableBaseCode(baseResp.status_code)) {
        throw new TransientError(`base_resp ${baseResp.status_code}`, full);
      }
      throw new Error(full);
    }
    const choice = data.choices?.[0];
    if (!choice) {
      // 没有 choices 常伴随上游瞬时故障，按瞬时处理、给一次重试机会。
      throw new TransientError(
        "空响应（无 choices）",
        `LLM 返回中没有 choices (model=${this.config.model}): ${JSON.stringify(data).slice(0, 500)}`,
      );
    }

    const message: Message = {
      role: "assistant",
      content: stripReasoning(choice.message.content),
      tool_calls: choice.message.tool_calls,
    };

    // —— 计时日志 —— 逐次打印：角色 | 模型 | 耗时 | 输入字数 | 输出token
    const elapsedMs = Date.now() - startedAt;
    const usage = data.usage;
    const inTok = usage?.prompt_tokens != null ? `in=${usage.prompt_tokens}tok` : `in≈${promptChars}字`;
    const outTok = usage?.completion_tokens != null ? `out=${usage.completion_tokens}tok` : "";
    console.log(
      `\x1b[2m[计时] ${this.label.padEnd(9)} ${this.config.model.padEnd(16)} ` +
        `${(elapsedMs / 1000).toFixed(1).padStart(6)}s  ${inTok} ${outTok}\x1b[0m`,
    );

    return { message, finishReason: choice.finish_reason ?? null };
  }
}

/**
 * 瞬时错误标记：可安全重试（上游过载/限流/5xx/网络抖动/空响应）。
 * shortReason 用于重试日志，message 是抛给上层的完整可读信息。
 */
class TransientError extends Error {
  constructor(
    readonly shortReason: string,
    message: string,
  ) {
    super(message);
    this.name = "TransientError";
  }
}

/** 可重试的 HTTP 状态：请求超时、限流、以及各类网关/过载/5xx（含 MiniMax 的 529）。 */
function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status === 529 || status >= 500;
}

/** 可重试的 MiniMax base_resp 业务码：限流 / 服务繁忙 / 未知服务端错误。 */
function isRetryableBaseCode(code: number): boolean {
  // 1002 触发限流；1039 TPM 限流；2013 参数错误(不重试)；1027 审核/1008 余额/1004 鉴权 不重试。
  return code === 1002 || code === 1039 || code === 2049 || code === 2064;
}

/** 指数退避 + 抖动：第 1/2/3 次约 1s / 2s / 4s，封顶 15s，避免与他人重试同步撞车。 */
function backoffMs(attempt: number): number {
  const base = Math.min(1000 * 2 ** (attempt - 1), 15_000);
  return base + Math.floor(Math.random() * 500);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  /** MiniMax 等接口：HTTP 200 下的业务错误码放这里。 */
  base_resp?: { status_code?: number; status_msg?: string };
  /** OpenAI 兼容用量统计，用于计时日志里展示输入/输出 token。 */
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}
