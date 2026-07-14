import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Message } from "./types.ts";

/**
 * 提示词追踪（调试用，默认关闭、零开销）。
 *
 * 开启后，把每一次 LLM 调用【收到的完整 system+user 消息】与【该次调用的回复】
 * 成对累积成一个格式化 JSON 数组落盘，便于逐拍回看"每个 agent（导演 / 各个角色 /
 * 执笔人 / 规划 / 档案）看到了什么上下文、又回了什么"。每条记录带自增 seq 与
 * label（调用来源，角色带人物名）、response（回复正文）、finishReason、latencyMs。
 *
 *   LLM_TRACE=1               → 落盘到 debug/llm-trace-<启动时刻>.json
 *   LLM_TRACE=/path/to.json   → 落盘到指定文件
 *   LLM_TRACE_STDOUT=1        → 额外在终端打印每条一行摘要
 *
 * 用法：tracePrompt() 在发请求前记录输入并返回 id；请求成功后用 traceResponse(id, ...)
 * 回填回复。每次读写都重写整份文件（单章十几次调用，开销可忽略），得到标准 JSON
 * （可被编辑器折叠/格式化）。追踪绝不抛错、绝不影响主流程（写盘失败静默吞掉）。
 */

interface TraceRecord {
  seq: number;
  ts: string;
  label: string;
  model: string;
  temperature?: number;
  messages: { role: string; content: string | null }[];
  /** 该次调用的回复正文（成功回填；失败或未返回则缺省）。 */
  response?: string | null;
  /** 结束原因（stop / length / ...）。 */
  finishReason?: string | null;
  /** 从发请求到拿到回复的耗时（毫秒）。 */
  latencyMs?: number;
}

// undefined=未初始化；null=未开启；string=目标文件路径。
let resolvedFile: string | null | undefined;
const records: TraceRecord[] = [];
const startedAt: number[] = []; // 与 records 同下标，记录各次调用的起始时刻。

function traceFile(): string | null {
  if (resolvedFile !== undefined) return resolvedFile;
  const flag = process.env.LLM_TRACE?.trim();
  if (!flag) {
    resolvedFile = null;
    return null;
  }
  if (flag === "1" || flag.toLowerCase() === "true") {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    resolvedFile = join(process.cwd(), "debug", `llm-trace-${stamp}.json`);
  } else {
    resolvedFile = flag; // 用户指定的具体文件路径
  }
  try {
    mkdirSync(dirname(resolvedFile), { recursive: true });
  } catch {
    // 建目录失败也不影响主流程；后续写盘若失败会被静默吞掉。
  }
  console.log(`\x1b[35m[LLM-TRACE] 提示词追踪已开启 → ${resolvedFile}\x1b[0m`);
  return resolvedFile;
}

function flush(file: string): void {
  try {
    writeFileSync(file, JSON.stringify(records, null, 2), "utf8");
  } catch {
    // 追踪失败绝不影响正文生成。
  }
}

const stdoutOn = (): boolean => !!process.env.LLM_TRACE_STDOUT?.trim();

/**
 * 记录一次 LLM 调用的输入上下文（system+user 等全部消息），返回该记录的 id。
 * 未开启追踪时返回 -1（此时 traceResponse 会静默跳过）。
 */
export function tracePrompt(
  label: string,
  model: string,
  messages: Message[],
  temperature?: number,
): number {
  const file = traceFile();
  if (!file) return -1;
  const id = records.length;
  records.push({
    seq: id + 1,
    ts: new Date().toISOString(),
    label,
    model,
    temperature,
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
  });
  startedAt[id] = Date.now();
  flush(file);
  if (stdoutOn()) console.log(`\x1b[35m[LLM-TRACE #${id + 1}→] ${label}（${model}）\x1b[0m`);
  return id;
}

/** 回填某次调用的回复。id 为 tracePrompt 返回值；未开启或 id 非法则静默跳过。 */
export function traceResponse(
  id: number,
  content: string | null,
  finishReason: string | null,
): void {
  const file = traceFile();
  if (!file || id < 0 || id >= records.length) return;
  const rec = records[id]!;
  rec.response = content;
  rec.finishReason = finishReason;
  const start = startedAt[id];
  if (start) rec.latencyMs = Date.now() - start;
  flush(file);
  if (stdoutOn()) {
    const chars = content?.length ?? 0;
    console.log(`\x1b[35m[LLM-TRACE #${rec.seq}←] ${rec.label} 回复 ${chars} 字\x1b[0m`);
  }
}
