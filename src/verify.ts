import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { LLMClient } from "./core/llm/client.ts";
import { NovelEngine } from "./story/engine.ts";
import { loadProject, loadChapterProse, projectPath } from "./story/project.ts";
import { gradeNovel, type GradeInput } from "./verify/graders.ts";
import { renderReport, renderSummaryLine } from "./verify/report.ts";

/**
 * 自回归验证 CLI（「产出 → 监视 → 改进」的入口）。
 *
 *   bun run verify <slug>                      # 离线：对已生成的 novels/<slug> 跑确定性检查器
 *   bun run verify --live "<一句前提>"          # 真生成前 N 章（默认 3）再评分（需 API key）
 *       [--chapters=N] [--genre=仙侠] [--style=chendong] [--intensity=strong]
 *
 * 离线模式不调 LLM、可入 CI；--live 模式慢、耗 token、非确定。
 * 两种模式都产出 scorecard + novels/<slug>/verify-report.md，供人（agent）参与 5 轴评审。
 */

/** 去掉正文的 markdown 标题行，取纯正文。 */
function stripHeading(md: string): string {
  return md.replace(/^#.*\n+/, "").trim();
}

/** 从磁盘装配 GradeInput（读 meta/outline + 各章正文）。 */
function assembleFromDisk(slug: string): GradeInput {
  const { meta, outline, memory } = loadProject(slug);
  const chapters = outline.chapters.map((c) => ({ n: c.n, title: c.title, goal: c.goal }));
  const proses: { n: number; text: string }[] = [];
  for (const c of outline.chapters) {
    const md = loadChapterProse(slug, c.n);
    if (md) proses.push({ n: c.n, text: stripHeading(md) });
  }
  return {
    slug,
    title: meta.title,
    chaptersWritten: meta.chaptersWritten,
    styleCard: meta.styleCard,
    worldBible: memory.worldBible,
    chapters,
    proses,
  };
}

/** 跑检查器、打印总览、落盘报告。 */
function runGrade(slug: string): void {
  const input = assembleFromDisk(slug);
  const scorecard = gradeNovel(input);
  const report = renderReport(scorecard);
  const reportPath = join(projectPath(slug), "verify-report.md");
  writeFileSync(reportPath, report, "utf8");

  console.log("\n" + renderSummaryLine(scorecard));
  if (scorecard.continuity.duplicates.length) {
    console.log(
      `\x1b[33m⚠ 检出 ${scorecard.continuity.duplicates.length} 处重复章（连续性硬伤）：\x1b[0m`,
    );
    for (const d of scorecard.continuity.duplicates) {
      console.log(`   第 ${d.n} 章《${d.title}》≈ 第 ${d.dupOf} 章（${d.by === "title" ? "标题" : "目标"}）`);
    }
  }
  console.log(`\n报告已写入：${reportPath}\n`);
}

function flag(args: string[], name: string): string | undefined {
  const f = args.find((a) => a.startsWith(`--${name}=`));
  return f ? f.slice(`--${name}=`.length).trim() : undefined;
}

async function runLive(args: string[]): Promise<void> {
  const seed = args.filter((a) => !a.startsWith("--")).join(" ").trim();
  if (!seed) {
    console.error('用法：bun run verify --live "<一句前提>" [--chapters=N] [--genre=] [--style=] [--intensity=]');
    process.exit(1);
  }
  const n = Math.max(1, parseInt(flag(args, "chapters") ?? "3", 10) || 3);
  const genre = flag(args, "genre");
  const style = flag(args, "style");
  const intensity = flag(args, "intensity");

  let client: LLMClient;
  try {
    client = new LLMClient();
  } catch (err) {
    console.error(
      `\x1b[31m--live 模式需要可用的 LLM（请在 .env 配置 OPENAI_API_KEY/OPENAI_MODEL）。\x1b[0m\n` +
        (err instanceof Error ? err.message : String(err)) +
        `\n改用离线模式：bun run verify <已有 slug>`,
    );
    process.exit(1);
    return;
  }

  const engine = new NovelEngine({ client });
  console.log(`\x1b[36m[产出] 新建并生成前 ${n} 章…（题材=${genre ?? "默认"} 风味=${style ?? "无"} 强度=${intensity ?? "默认"}）\x1b[0m`);
  const project = await engine.startNovel(seed, `${n} 章`, genre, style, intensity);
  const slug = project.meta.slug;
  for (let i = 0; i < n; i++) {
    const res = await engine.generateNextChapter(slug);
    if (res.done) break;
  }
  console.log(`\x1b[36m[监视] 生成完毕，开始评分…\x1b[0m`);
  runGrade(slug);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === "--live") {
    await runLive(args.slice(1));
    return;
  }
  const slug = args.find((a) => !a.startsWith("--"));
  if (!slug) {
    console.error(
      [
        "用法：",
        "  bun run verify <slug>                     离线：对 novels/<slug> 跑确定性检查器",
        '  bun run verify --live "<一句前提>"         真生成前 N 章再评分（需 API key）',
        "      [--chapters=N] [--genre=仙侠] [--style=chendong] [--intensity=strong]",
      ].join("\n"),
    );
    process.exit(1);
    return;
  }
  runGrade(slug);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
