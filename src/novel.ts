import { LLMClient } from "./core/llm/client.ts";
import { logger } from "./core/logger.ts";
import { NovelEngine } from "./story/engine.ts";
import { listProjects, projectPath } from "./story/project.ts";
import type { DramaEvent } from "./drama/events.ts";

/**
 * 多章小说生成 CLI。
 *
 *   bun novel "一句前提"            # 新建一部小说（规划大纲 + 写第 1 章）
 *   bun novel:next <slug>          # 给已有小说续写下一章
 *   bun novel:next <slug> 3        # 一次续写 3 章
 *   bun novel:auto "一句前提"       # 新建并一口气把整本写完
 *   bun novel:list                 # 列出所有小说项目
 *
 * 每章：规划上下文 → 多 agent 演一章 → 执笔人成文 → 档案官更新记忆 → 修订后续大纲 → 存盘。
 * 产物在 novels/<slug>/（novel.json / outline.json / memory.json / chapters/chNN.md）。
 */

/** 把结构化事件打印到终端（作为 onEvent sink）。 */
function printEvent(ev: DramaEvent): void {
  switch (ev.type) {
    case "outline":
      logger.step(0, `大纲就绪：《${ev.title}》`);
      logger.info(ev.logline);
      for (const c of ev.chapters) {
        const mark = c.status === "written" ? "✓" : "·";
        logger.info(`  ${mark} 第${c.n}章《${c.title}》：${c.goal}`);
      }
      break;
    case "chapter-start":
      logger.step(ev.n, `开写第 ${ev.n} 章《${ev.title}》`);
      logger.info(`目标：${ev.goal}`);
      break;
    case "scene":
      logger.info(`【背景】${ev.background}`);
      break;
    case "beat":
      logger.info(`${ev.actor}：${ev.content}`);
      break;
    case "narration":
      logger.info(`【旁白】${ev.content}`);
      break;
    case "chapter-prose":
      console.log(`\n${"─".repeat(48)}\n# ${ev.title}\n\n${ev.content}\n`);
      break;
    case "memory-updated":
      logger.info(`【记忆】梗概已更新；未回收伏笔 ${ev.openThreads.length} 条。`);
      break;
    case "novel-complete":
      logger.final(`全书完成，共 ${ev.chaptersWritten} 章。`);
      break;
    default:
      break;
  }
}

function usage(): void {
  console.log(
    [
      "用法：",
      '  bun novel "一句前提"          新建小说并写第 1 章',
      "  bun novel:next <slug> [n]     续写下 n 章（默认 1）",
      '  bun novel:auto "一句前提"      新建并写完整本',
      "  bun novel:list                列出所有项目",
    ].join("\n"),
  );
}

async function cmdNew(
  seed: string,
  auto: boolean,
  genre?: string,
  style?: string,
  intensity?: string,
): Promise<void> {
  const engine = new NovelEngine({ client: new LLMClient(), onEvent: printEvent });
  const project = await engine.startNovel(seed, undefined, genre, style, intensity);
  const slug = project.meta.slug;

  if (!auto) {
    await engine.generateNextChapter(slug);
    logger.info(`\n已保存到 ${projectPath(slug)}`);
    logger.info(`续写下一章：bun novel:next ${slug}`);
    return;
  }

  // 一口气写完：反复推进直到无待写章节。
  for (;;) {
    const res = await engine.generateNextChapter(slug);
    if (res.done) break;
  }
  logger.info(`\n已保存到 ${projectPath(slug)}`);
}

async function cmdNext(slug: string, count: number): Promise<void> {
  if (!slug) {
    usage();
    process.exit(1);
  }
  const engine = new NovelEngine({ client: new LLMClient(), onEvent: printEvent });
  for (let i = 0; i < count; i++) {
    const res = await engine.generateNextChapter(slug);
    if (res.done) break;
  }
  logger.info(`\n已保存到 ${projectPath(slug)}`);
}

function cmdList(): void {
  const metas = listProjects();
  if (!metas.length) {
    logger.info("还没有任何小说项目。用 bun novel \"一句前提\" 新建一个。");
    return;
  }
  logger.step(0, "小说项目");
  for (const m of metas) {
    logger.info(`  ${m.slug}  《${m.title}》  已写 ${m.chaptersWritten} 章  (${m.createdAt.slice(0, 10)})`);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cmd = args[0];

  // 题材：--genre=仙侠（可选，仅新建时生效）。
  const genreFlag = args.find((a) => a.startsWith("--genre="));
  const genre = genreFlag ? genreFlag.slice("--genre=".length).trim() : undefined;

  // 写作风味：--style=辰东式史诗 / --style=chendong；强度 --intensity=strong（仅新建时生效）。
  const styleFlag = args.find((a) => a.startsWith("--style="));
  const style = styleFlag ? styleFlag.slice("--style=".length).trim() : undefined;
  const intensityFlag = args.find((a) => a.startsWith("--intensity="));
  const intensity = intensityFlag ? intensityFlag.slice("--intensity=".length).trim() : undefined;

  if (cmd === "--list" || cmd === "list") {
    cmdList();
    return;
  }
  if (cmd === "--next" || cmd === "next") {
    const slug = args[1] ?? "";
    const count = Math.max(1, parseInt(args[2] ?? "1", 10) || 1);
    await cmdNext(slug, count);
    return;
  }
  if (cmd === "--auto" || cmd === "auto") {
    const seed = args.slice(1).filter((a) => !a.startsWith("--")).join(" ").trim();
    if (!seed) return usage();
    await cmdNew(seed, true, genre, style, intensity);
    return;
  }

  // 默认：把全部非 flag 参数当作前提，新建并写第 1 章。
  const seed = args.filter((a) => !a.startsWith("--")).join(" ").trim();
  if (!seed) return usage();
  await cmdNew(seed, false, genre, style, intensity);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
