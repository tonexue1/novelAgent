import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import type { Agent } from "../agent.ts";

/**
 * 通用交互式 REPL（类似 Claude Code 的持续对话体验）。
 *
 * 这是 core 里的可复用组件，只依赖 {@link Agent} 接口，不认识任何具体 stage。
 * 每个 stage 的 run.ts 负责构造自己的 agent 并调用 startRepl 完成集成。
 *
 * 支持在多个"模式"间切换（一个模式 = 一个具名 agent），便于同一入口对照不同实现；
 * 单个模式时 /mode 仅用于查看。
 */

/** 一个可切换的模式：名字 + 展示标签 + 对应 agent。 */
export interface ReplMode {
  name: string;
  label: string;
  agent: Agent;
}

export interface ReplOptions {
  title: string;
  modes: ReplMode[];
  /** 初始模式名，默认取 modes[0]。 */
  initialMode?: string;
}

const COLORS = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  green: "\x1b[32m",
  cyan: "\x1b[36m",
  yellow: "\x1b[33m",
} as const;

function c(color: keyof typeof COLORS, text: string): string {
  return `${COLORS[color]}${text}${COLORS.reset}`;
}

export async function startRepl(opts: ReplOptions): Promise<void> {
  if (opts.modes.length === 0) throw new Error("startRepl 需要至少一个模式");

  const modes = new Map(opts.modes.map((m) => [m.name, m]));
  let current =
    (opts.initialMode && modes.get(opts.initialMode)) || opts.modes[0]!;

  const multiMode = opts.modes.length > 1;

  printBanner(opts.title, current, opts.modes, multiMode);

  const rl = readline.createInterface({ input: stdin, output: stdout });

  // 事件式行队列：可靠缓冲每一行，粘贴/管道多行也不丢。
  const queued: string[] = [];
  let waiting: ((line: string | null) => void) | null = null;
  let closed = false;

  const deliver = (line: string | null): void => {
    if (waiting) {
      const resolve = waiting;
      waiting = null;
      resolve(line);
    } else if (line !== null) {
      queued.push(line);
    }
  };

  rl.on("line", (line) => deliver(line));
  rl.on("close", () => {
    closed = true;
    deliver(null);
  });
  rl.on("SIGINT", () => {
    console.log(c("dim", "\n再见。"));
    rl.close();
  });

  const nextLine = (): Promise<string | null> => {
    if (queued.length > 0) return Promise.resolve(queued.shift()!);
    if (closed) return Promise.resolve(null);
    return new Promise((resolve) => {
      waiting = resolve;
    });
  };

  while (!closed || queued.length > 0) {
    stdout.write(c("cyan", `\n${current.name} › `));
    const raw = await nextLine();
    if (raw === null) break;
    const input = raw.trim();
    if (!input) continue;

    if (input.startsWith("/")) {
      if (input === "/exit" || input === "/quit") break;
      const next = handleCommand(input, opts, current, modes, multiMode);
      if (next) current = next;
      continue;
    }

    try {
      await current.agent.send(input);
    } catch (err) {
      console.error(
        c("yellow", `出错: ${err instanceof Error ? err.message : String(err)}`),
      );
    }
  }

  rl.close();
  console.log(c("dim", "再见。"));
}

function printBanner(
  title: string,
  current: ReplMode,
  allModes: ReplMode[],
  multiMode: boolean,
): void {
  console.log(c("bold", `\n${title} · 交互式命令行`));
  console.log(c("dim", "输入问题开始对话；输入 /help 查看命令，/exit 退出。"));
  if (multiMode) {
    console.log(
      c("dim", `可用模式: ${allModes.map((m) => m.name).join(" / ")}`),
    );
  }
  console.log(c("dim", `当前模式: ${current.label}\n`));
}

function printHelp(modes: ReplMode[], multiMode: boolean): void {
  const lines = [c("bold", "可用命令:"), "  /help          显示本帮助"];
  if (multiMode) {
    for (const m of modes) {
      lines.push(`  /mode ${m.name.padEnd(9)}切换到 ${m.label} 模式`);
    }
  }
  lines.push(
    "  /mode          查看当前模式",
    "  /clear         清空当前会话历史（开新话题）",
    "  /exit, /quit   退出（也可 Ctrl+C / Ctrl+D）",
    "",
    c("dim", "直接输入文字即可提问，多轮对话会保留上下文。"),
  );
  console.log(lines.join("\n"));
}

/** 处理斜杠命令。若发生模式切换，返回新的当前模式，否则返回 undefined。 */
function handleCommand(
  input: string,
  opts: ReplOptions,
  current: ReplMode,
  modes: Map<string, ReplMode>,
  multiMode: boolean,
): ReplMode | undefined {
  const [cmd, arg] = input.slice(1).trim().split(/\s+/, 2);
  switch (cmd) {
    case "help":
      printHelp(opts.modes, multiMode);
      return undefined;
    case "mode": {
      if (!arg) {
        console.log(c("cyan", `当前模式: ${current.label}`));
        return undefined;
      }
      const target = modes.get(arg);
      if (!target) {
        console.log(
          c("yellow", `未知模式 "${arg}"，可选: ${[...modes.keys()].join(" | ")}`),
        );
        return undefined;
      }
      console.log(c("green", `已切换到 ${target.label} 模式`));
      return target;
    }
    case "clear":
      current.agent.reset();
      console.log(c("green", "已清空会话历史。"));
      return undefined;
    default:
      console.log(c("yellow", `未知命令 "/${cmd}"，输入 /help 查看可用命令。`));
      return undefined;
  }
}
