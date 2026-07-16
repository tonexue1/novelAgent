import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { LLMClient } from "./core/llm/client.ts";
import { logger } from "./core/logger.ts";
import { NovelEngine } from "./story/engine.ts";
import {
  createProject,
  listProjects,
  makeSlug,
  projectPath,
  rollbackChapters,
} from "./story/project.ts";
import { emptyMemory } from "./story/memory.ts";
import { resolveGenre } from "./story/genre.ts";
import { resolveStyleCard, resolveIntensity } from "./story/style.ts";
import type { OutlineResult } from "./story/planner.ts";
import type { NovelMeta } from "./story/types.ts";
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

/**
 * 把结构化事件打印到终端（作为 onEvent sink）。
 *
 * 只渲染 drama/engine 内部【不会自行打印】的高层事件（大纲、开章、成文、记忆、收官）。
 * 逐拍的 scene/beat/narration 已由 WuxiaDramaAgent 直接用 logger 输出，这里不再重复渲染，
 * 否则每一拍会被打印两遍。
 */
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
      "  bun novel:from-eval <目录>     从评测大纲导入成项目（不重新规划）",
      "  bun novel:rollback <slug> [n]  回退最近写的 n 章（默认 1）",
      "  bun novel:list                列出所有项目",
      "",
      "可选参数（仅新建时生效）：",
      "  --chapters=N     目标章数（如 --chapters=20；缺省由规划师定，约 6-10 章）",
      "  --genre=仙侠     题材",
      "  --style=chendong 写作风味（如 辰东式史诗）",
      "  --intensity=strong 风味强度（light/medium/strong）",
    ].join("\n"),
  );
}

async function cmdNew(
  seed: string,
  auto: boolean,
  genre?: string,
  style?: string,
  intensity?: string,
  chapters?: string,
): Promise<void> {
  const engine = new NovelEngine({ client: new LLMClient(), onEvent: printEvent });
  const project = await engine.startNovel(seed, chapters, genre, style, intensity);
  const slug = project.meta.slug;

  if (!auto) {
    await engine.generateNextChapter(slug);
    logger.info(`\n已保存到 ${projectPath(slug)}`);
    logger.info(`续写下一章：bun novel:next ${slug}`);
    return;
  }

  // 一口气写完：反复推进直到无待写章节。单章硬失败则停下（前面章节已逐章存盘，可重跑续写）。
  for (;;) {
    let res;
    try {
      res = await engine.generateNextChapter(slug);
    } catch (err) {
      console.error(
        `\x1b[31m[写作] 推进失败，就此停下（已写章节均已存盘）：` +
          `${err instanceof Error ? err.message.split("\n")[0] : String(err)}\x1b[0m`,
      );
      logger.info(`稍后可重跑续写：bun novel:next ${slug}`);
      break;
    }
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
  let written = 0;
  for (let i = 0; i < count; i++) {
    let res;
    try {
      res = await engine.generateNextChapter(slug);
    } catch (err) {
      console.error(
        `\x1b[31m[续写] 推进失败，已成功写入 ${written} 章（均已存盘），就此停下：` +
          `${err instanceof Error ? err.message.split("\n")[0] : String(err)}\x1b[0m`,
      );
      logger.info(`稍后可重跑续写：bun novel:next ${slug}`);
      break;
    }
    if (res.chapter) written++;
    if (res.done) break;
  }
  logger.info(`\n已保存到 ${projectPath(slug)}`);
}

/**
 * 从一次评测（eval-runs/<...>/）导入已规划好的大纲，落盘成一个 novels/ 项目。
 * 直接复用评测里那份 outline.json（title + outline + worldBible），不重新规划，
 * 之后即可用 `novel:next <slug>` 沿这份大纲续写正文。
 * 题材优先取 --genre，其次读同目录 input.json 的 genre；前提缺失时回落 input.seed。
 */
function cmdFromEval(
  dir: string,
  genreOverride?: string,
  style?: string,
  intensity?: string,
): void {
  if (!dir) {
    usage();
    process.exit(1);
  }
  const outlinePath = join(dir, "outline.json");
  if (!existsSync(outlinePath)) {
    console.error(`未找到大纲文件：${outlinePath}`);
    process.exit(1);
  }
  const result = JSON.parse(readFileSync(outlinePath, "utf8")) as OutlineResult;
  const { title, outline, worldBible } = result;
  if (!title || !outline || !worldBible) {
    console.error(`大纲文件格式不对（应含 title/outline/worldBible）：${outlinePath}`);
    process.exit(1);
  }

  // 同目录 input.json：拿题材与前提兜底。
  let genreInput = genreOverride;
  let seed: string | undefined;
  const inputPath = join(dir, "input.json");
  if (existsSync(inputPath)) {
    try {
      const input = JSON.parse(readFileSync(inputPath, "utf8")) as {
        seed?: string;
        genre?: string;
      };
      seed = input.seed;
      if (!genreInput) genreInput = input.genre;
    } catch {
      // 忽略损坏的 input.json，用默认题材继续。
    }
  }

  const genre = resolveGenre(genreInput);
  const styleCard = resolveStyleCard(style);
  const styleIntensity = resolveIntensity(intensity);

  // 兼容旧评测大纲：补默认 mode / 前提。
  if (!outline.mode) outline.mode = outline.arcs?.length ? "rolling" : "whole";
  if (!outline.premise && seed) outline.premise = seed;

  // 模型仅作元数据留档；纯导入不需要 API key，缺配置时回落环境变量。
  let model = process.env.OPENAI_MODEL ?? "unknown";
  try {
    model = new LLMClient().model;
  } catch {
    // 无 LLM 配置也允许离线导入。
  }

  const meta: NovelMeta = {
    slug: makeSlug(title),
    title,
    createdAt: new Date().toISOString(),
    model,
    chaptersWritten: 0,
    genre,
    styleCard,
    styleIntensity,
  };
  createProject(meta, outline, emptyMemory(worldBible));

  const total = outline.targetChapters ?? outline.chapters.length;
  logger.step(0, `已从评测大纲导入：《${title}》(${meta.slug})`);
  logger.info(`模式：${outline.mode}；题材：${genre.label}；目标约 ${total} 章`);
  logger.info(`保存到 ${projectPath(meta.slug)}`);
  logger.info(`写第 1 章：bun novel:next ${meta.slug}`);
}

/** 回退最近写的 n 章（默认 1）：删产物、大纲状态复位、记忆还原。无 LLM。 */
function cmdRollback(slug: string, count: number): void {
  if (!slug) {
    usage();
    process.exit(1);
  }
  const res = rollbackChapters(slug, count);
  if (res.undone.length === 0) {
    logger.info(`《${slug}》没有已写章节，无需回退。`);
    return;
  }
  logger.step(0, `已回退 ${res.undone.length} 章：第 ${res.undone.join("、")} 章`);
  logger.info(`现已写 ${res.chaptersWritten} 章。`);
  if (!res.memoryRestored) {
    logger.info(
      "⚠ 未找到记忆快照，记忆未精确还原（这些章写于回退功能上线前）。" +
        "如需干净重写，建议核对 memory.json 或从更早的章一并回退。",
    );
  }
  logger.info(`保存到 ${projectPath(slug)}`);
  logger.info(`重写下一章：bun novel:next ${slug}`);
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

  // 目标章数：--chapters=20（可选，仅新建时生效）。超过阈值自动切分卷滚动规划。
  const chaptersFlag = args.find((a) => a.startsWith("--chapters="));
  const chapters = chaptersFlag ? chaptersFlag.slice("--chapters=".length).trim() : undefined;

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
  if (cmd === "--from-eval" || cmd === "from-eval") {
    const dir = args.slice(1).find((a) => !a.startsWith("--")) ?? "";
    cmdFromEval(dir, genre, style, intensity);
    return;
  }
  if (cmd === "--rollback" || cmd === "rollback") {
    const slug = args[1] ?? "";
    const count = Math.max(1, parseInt(args[2] ?? "1", 10) || 1);
    cmdRollback(slug, count);
    return;
  }
  if (cmd === "--auto" || cmd === "auto") {
    const seed = args.slice(1).filter((a) => !a.startsWith("--")).join(" ").trim();
    if (!seed) return usage();
    await cmdNew(seed, true, genre, style, intensity, chapters);
    return;
  }

  // 默认：把全部非 flag 参数当作前提，新建并写第 1 章。
  const seed = args.filter((a) => !a.startsWith("--")).join(" ").trim();
  if (!seed) return usage();
  await cmdNew(seed, false, genre, style, intensity, chapters);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
