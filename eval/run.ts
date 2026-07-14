import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { LLMClient } from "../src/core/llm/client.ts";
import { Planner } from "../src/story/planner.ts";
import type { OutlineCheckpoint } from "../src/story/planner.ts";
import { Novelist } from "../src/drama/novelist.ts";
import { resolveGenre } from "../src/story/genre.ts";
import {
  resolveStyleCard,
  resolveIntensity,
  renderStyleCard,
  renderStyleBrief,
  renderDirectorCard,
} from "../src/story/style.ts";
import type { DramaContext, Scene, Beat } from "../src/drama/scene.ts";
import { EvalAgent } from "./agent.ts";
import { loadFixture, listFixtures } from "./fixtures.ts";
import { renderPlanReport, renderProseReport, renderScoreLine } from "./report.ts";
import type { EvalScore, ProseFixture } from "./rubric.ts";
import type { Outline, WorldBible } from "../src/story/types.ts";

/** 目标章数超过此值即自动切【分卷滚动规划】（骨架 + 只展开第一卷），避免整书硬展开又慢又崩。 */
const EVAL_ROLLING_THRESHOLD = 40;

/**
 * 评测 CLI（LLM 评 LLM）。
 *
 *   bun run eval plan "<一句前提>" [--genre=仙侠] [--style=chendong] [--chapters=10]
 *   bun run eval prose <fixtureId|path> [--style=chendong] [--intensity=strong]
 *   bun run eval fixtures                              # 列出内置 fixtures
 *
 * 流程：运行产出(outline / prose) → 交裁判 EvalAgent → 结构化打分 → 落盘
 * eval-runs/<ts>-<kind>/{input.json, 原版, score.json, report.md}，供人(agent)手动查看。
 * 需 API key（裁判与被评生成都要调 LLM）。
 */

function flag(args: string[], name: string): string | undefined {
  const f = args.find((a) => a.startsWith(`--${name}=`));
  return f ? f.slice(`--${name}=`.length).trim() : undefined;
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function runsRoot(): string {
  return join(process.cwd(), "eval-runs");
}

/** 落盘一次评测运行；返回运行目录。 */
function persist(kind: string, name: string, files: Record<string, string>): string {
  const safe = name.replace(/[\\/:*?"<>|\s]+/g, "-").slice(0, 40) || kind;
  const dir = join(runsRoot(), `${timestamp()}-${kind}-${safe}`);
  mkdirSync(dir, { recursive: true });
  for (const [file, content] of Object.entries(files)) {
    writeFileSync(join(dir, file), content, "utf8");
  }
  return dir;
}

/** 断点续规划的快照文件（按 前提+题材+章数 定位，同一请求重跑即命中）。 */
interface PlanCheckpointFile {
  seed: string;
  genre?: string;
  target: number;
  checkpoint: OutlineCheckpoint;
}

/** 规划断点快照路径：按 前提/题材/目标章数 的哈希定位到一个稳定文件。 */
function checkpointPath(seed: string, genre: string | undefined, target: number): string {
  const hash = createHash("sha1").update(`${seed}|${genre ?? ""}|${target}`).digest("hex").slice(0, 16);
  return join(runsRoot(), ".checkpoints", `plan-${hash}.json`);
}

/** 读取匹配当前请求的规划断点；无/损坏/不匹配则返回 undefined（当作全新规划）。 */
function loadCheckpoint(
  path: string,
  seed: string,
  genre: string | undefined,
  target: number,
): OutlineCheckpoint | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const data = JSON.parse(readFileSync(path, "utf8")) as PlanCheckpointFile;
    if (data.seed !== seed || (data.genre ?? "") !== (genre ?? "") || data.target !== target) {
      return undefined;
    }
    const cp = data.checkpoint;
    return cp && cp.skeleton && Array.isArray(cp.chapters) ? cp : undefined;
  } catch {
    return undefined;
  }
}

function makeClient(): LLMClient {
  try {
    return new LLMClient();
  } catch (err) {
    console.error(
      `\x1b[31m评测需要可用的 LLM（请在 .env 配置 OPENAI_API_KEY/OPENAI_MODEL；裁判模型可用 OPENAI_MODEL_EVAL 指定）。\x1b[0m\n` +
        (err instanceof Error ? err.message : String(err)),
    );
    process.exit(1);
  }
}

async function runPlanEval(args: string[]): Promise<void> {
  const seed = args.filter((a) => !a.startsWith("--")).join(" ").trim();
  if (!seed) {
    console.error('用法：bun run eval plan "<一句前提>" [--genre=仙侠] [--chapters=10] [--rolling]');
    process.exit(1);
  }
  const genreInput = flag(args, "genre");
  const n = Math.max(3, parseInt(flag(args, "chapters") ?? "10", 10) || 10);
  const genre = resolveGenre(genreInput);

  const client = makeClient();
  const planner = new Planner(client.withRole("planner"));

  // 分卷滚动：显式 --rolling 或目标超过阈值时，只出路线图 + 展开第一卷（快、省、不崩）。
  const rolling = args.includes("--rolling") || n > EVAL_ROLLING_THRESHOLD;

  let title: string;
  let outline: Outline;
  let worldBible: WorldBible;

  if (rolling) {
    console.log(
      `\x1b[36m[产出] 分卷滚动规划…（题材=${genreInput ?? "默认"}，目标 ${n} 章，只展开第 1 卷）\x1b[0m`,
    );
    ({ title, outline, worldBible } = await planner.createRollingOutline(seed, `${n} 章`, genre));
  } else {
    // 断点续规划：命中同一请求的快照则续跑，避免长篇一次抖动前功尽弃。
    const cpPath = checkpointPath(seed, genreInput, n);
    const resume = loadCheckpoint(cpPath, seed, genreInput, n);
    if (resume) {
      console.log(
        `\x1b[36m[产出] 命中规划断点（已展开 ${resume.actsDone}/${resume.skeleton.acts.length} 幕、` +
          `${resume.chapters.length} 章），续跑…\x1b[0m`,
      );
    } else {
      console.log(`\x1b[36m[产出] 规划大纲中…（题材=${genreInput ?? "默认"}，目标 ${n} 章）\x1b[0m`);
    }
    mkdirSync(dirname(cpPath), { recursive: true });

    ({ title, outline, worldBible } = await planner.createOutline(seed, `${n} 章`, genre, {
      resume,
      onProgress: (cp) => {
        const payload: PlanCheckpointFile = { seed, genre: genreInput, target: n, checkpoint: cp };
        writeFileSync(cpPath, JSON.stringify(payload, null, 2), "utf8");
      },
    }));
    // 规划完整跑完：清掉断点快照，避免下次误续旧进度。
    if (existsSync(cpPath)) rmSync(cpPath);
  }

  console.log(`\x1b[36m[监视] 交裁判打分…\x1b[0m`);
  const score = await new EvalAgent(client).evalPlan({ seed, genre: genreInput, title, outline, worldBible });

  const report = renderPlanReport({ seed, title, genre: genreInput, outline, worldBible, score });
  const dir = persist("plan", title, {
    "input.json": JSON.stringify({ seed, genre: genreInput, chapters: n }, null, 2),
    "outline.json": JSON.stringify({ title, outline, worldBible }, null, 2),
    "score.json": JSON.stringify(score, null, 2),
    "report.md": report,
  });
  console.log("\n" + renderScoreLine("规划", title, score));
  console.log(`报告：${join(dir, "report.md")}\n`);
}

/** 由 fixture 装配 DramaContext（复用 genre/style 的渲染，与正式生成同源）。 */
function contextFromFixture(fx: ProseFixture, styleOverride?: string, intensityOverride?: string): {
  ctx: DramaContext;
  scene: Scene;
  transcript: Beat[];
  styleLabel?: string;
} {
  const genre = resolveGenre(fx.genre);
  const styleCard = resolveStyleCard(styleOverride ?? fx.style);
  const intensity = resolveIntensity(intensityOverride ?? fx.intensity);
  const chapterNo = fx.chapterNo ?? 2;

  const scene: Scene = {
    background: fx.scene.background,
    characters: fx.scene.characters.map((c) => ({ ...c })),
  };
  const transcript: Beat[] = fx.transcript.map((b) => ({
    actor: b.actor,
    kind: b.kind,
    content: b.content,
  }));

  const ctx: DramaContext = {
    chapterNo,
    goal: fx.goal,
    worldBrief: fx.worldBrief ?? "",
    returningCharacters: [],
    storySoFar: "",
    openThreads: "",
    genrePersona: genre.persona,
    genreStyle: genre.styleGuidance,
    narrationStyle: renderStyleCard(styleCard, intensity) || undefined,
    narrationStyleBrief: renderStyleBrief(styleCard) || undefined,
    directionStyle: renderDirectorCard(styleCard, chapterNo) || undefined,
  };
  return { ctx, scene, transcript, styleLabel: styleCard?.label };
}

async function runProseEval(args: string[]): Promise<void> {
  const idOrPath = args.find((a) => !a.startsWith("--"));
  if (!idOrPath) {
    console.error("用法：bun run eval prose <fixtureId|path> [--style=chendong] [--intensity=strong]");
    process.exit(1);
    return;
  }
  const styleOverride = flag(args, "style");
  const intensityOverride = flag(args, "intensity");

  let fx: ProseFixture;
  try {
    fx = loadFixture(idOrPath);
  } catch (err) {
    console.error(`\x1b[31m${err instanceof Error ? err.message : String(err)}\x1b[0m`);
    process.exit(1);
    return;
  }

  const client = makeClient();
  const { ctx, scene, transcript, styleLabel } = contextFromFixture(fx, styleOverride, intensityOverride);

  console.log(`\x1b[36m[产出]「${fx.label}」成文中…（风味=${styleLabel ?? "无"}）\x1b[0m`);
  const novelist = new Novelist(client.withRole("novelist"));
  const raw = await novelist.write(scene, transcript, fx.seed, ctx);
  const prose = raw.trim();

  console.log(`\x1b[36m[监视] 交裁判打分…\x1b[0m`);
  const styleCard = resolveStyleCard(styleOverride ?? fx.style);
  const styleIntensity = resolveIntensity(intensityOverride ?? fx.intensity);
  const score = await new EvalAgent(client).evalProse({
    prose,
    goal: fx.goal,
    transcript,
    styleCard,
    styleIntensity,
  });

  const report = renderProseReport({
    fixtureLabel: fx.label,
    style: styleLabel,
    goal: fx.goal,
    prose,
    score,
  });
  const dir = persist("prose", fx.id, {
    "input.json": JSON.stringify(fx, null, 2),
    "prose.md": `# ${fx.label}\n\n${prose}\n`,
    "score.json": JSON.stringify(score, null, 2),
    "report.md": report,
  });
  console.log("\n" + renderScoreLine("文笔", fx.label, score));
  console.log(`报告：${join(dir, "report.md")}\n`);
}

function listFixturesCmd(): void {
  const fx = listFixtures();
  if (!fx.length) {
    console.log("（eval/fixtures/ 下暂无 fixture）");
    return;
  }
  console.log("内置文笔评测 fixtures：");
  for (const f of fx) console.log(`  ${f.id}  —  ${f.label}（风味：${f.style ?? "无"}）`);
}

function usage(): void {
  console.log(
    [
      "用法：",
      '  bun run eval plan "<一句前提>" [--genre=仙侠] [--chapters=10] [--rolling]',
      "  bun run eval prose <fixtureId|path> [--style=chendong] [--intensity=strong]",
      "  bun run eval fixtures",
      "  （plan：--rolling 或 --chapters>40 时自动切分卷滚动，只出路线图+第一卷）",
    ].join("\n"),
  );
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const sub = args[0];
  const rest = args.slice(1);
  if (sub === "plan") return runPlanEval(rest);
  if (sub === "prose") return runProseEval(rest);
  if (sub === "fixtures") return listFixturesCmd();
  usage();
  process.exit(1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
