import { writeFileSync } from "node:fs";
import { LLMClient } from "./core/llm/client.ts";
import { startRepl } from "./core/cli/repl.ts";
import { logger } from "./core/logger.ts";
import { WuxiaDramaAgent } from "./drama/agent.ts";

/**
 * 武侠剧场入口：多 Agent 即兴演出（导演调度）+ 执笔人成文。
 *
 *   bun start                                   # 交互式，输入一句开场即开演
 *   bun start "雨夜，蒙面人踹开客栈门"              # 一次性演一幕，末尾由执笔人成文
 *   bun start --save "雨夜……"                    # 同上，并把成文另存为 wuxia-<时间戳>.md
 *   bun start --save=chapter1.md "雨夜……"        # 指定保存路径
 *   bun start --no-novelize "雨夜……"             # 关闭执笔人，只出导演的即兴收场白
 *
 * 收尾默认走"执笔人"（单 agent）把整幕即兴记录改写成小说体：情节靠多 agent 涌现，文笔靠单 agent 统一。
 * 提示：每一拍导演选人 + 角色行动各一次 LLM 调用，一幕会有一二十次调用。
 */
async function main() {
  const args = process.argv.slice(2);
  const flags = args.filter((a) => a.startsWith("--"));
  const seed = args.filter((a) => !a.startsWith("--")).join(" ").trim();

  const novelize = !flags.includes("--no-novelize");
  const saveFlag = flags.find((f) => f === "--save" || f.startsWith("--save="));

  const agent = new WuxiaDramaAgent({ client: new LLMClient(), novelize });

  if (seed) {
    logger.info(`开场: ${seed}`);
    const prose = await agent.run(seed);
    if (saveFlag) {
      const eq = saveFlag.indexOf("=");
      const path = eq >= 0 ? saveFlag.slice(eq + 1) : `wuxia-${Date.now()}.md`;
      writeFileSync(path, prose, "utf8");
      logger.info(`已保存到 ${path}`);
    }
    return;
  }

  await startRepl({
    title: "武侠剧场（多 Agent · 导演调度 + 执笔人成文）",
    modes: [{ name: "wuxia", label: "Wuxia 武侠", agent }],
  });
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
