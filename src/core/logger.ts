/**
 * 极简的步骤级日志，用于观察 Agent loop 的每一步。
 * 用 ANSI 颜色区分不同事件类型，方便在终端看清"推理 -> 行动 -> 观察"的过程。
 */

const COLORS = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  yellow: "\x1b[33m",
  green: "\x1b[32m",
  magenta: "\x1b[35m",
  blue: "\x1b[34m",
} as const;

function paint(color: keyof typeof COLORS, text: string): string {
  return `${COLORS[color]}${text}${COLORS.reset}`;
}

export const logger = {
  /** 一轮循环的分隔标题。 */
  step(n: number, title: string): void {
    console.log(paint("blue", `\n=== Step ${n} · ${title} ===`));
  },
  thought(text: string): void {
    console.log(`${paint("cyan", "[Thought]")} ${text}`);
  },
  action(name: string, args: string): void {
    console.log(`${paint("yellow", "[Action]")} ${name} ${paint("dim", args)}`);
  },
  observation(text: string): void {
    console.log(`${paint("magenta", "[Observation]")} ${text}`);
  },
  final(text: string): void {
    console.log(`${paint("green", "[Final Answer]")} ${text}`);
  },
  info(text: string): void {
    console.log(paint("dim", text));
  },
};
