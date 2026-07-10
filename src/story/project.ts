import {
  mkdirSync,
  existsSync,
  writeFileSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import type {
  NovelMeta,
  Outline,
  StoryMemory,
  NovelProject,
  GeneratedChapter,
} from "./types.ts";

/**
 * 磁盘项目存储：一部小说 = 一个目录 novels/<slug>/。
 *
 *   novel.json                  项目元数据
 *   outline.json                主情节规划（可修订）
 *   memory.json                 故事记忆（canon + 进度）
 *   chapters/chNN.md            成文正文
 *   chapters/chNN.transcript.json  原始 beats（可选，便于重生成/调试）
 *
 * 纯 node fs，无第三方依赖。JSON 一律 2 空格缩进、保留中文（不转义）。
 */

/** 项目根目录：惰性读取 cwd，便于测试切换工作目录做隔离。 */
function root(): string {
  return join(process.cwd(), "novels");
}

function novelDir(slug: string): string {
  return join(root(), slug);
}

function chaptersDir(slug: string): string {
  return join(novelDir(slug), "chapters");
}

/** 由标题生成文件系统安全的 slug；同名冲突时追加时间戳后缀。 */
export function makeSlug(title: string): string {
  const base =
    title
      .trim()
      .replace(/[\\/:*?"<>|]+/g, "") // 去掉 Windows 非法字符
      .replace(/\s+/g, "-")
      .slice(0, 40) || "wuxia";
  let slug = base;
  if (existsSync(novelDir(slug))) slug = `${base}-${Date.now()}`;
  return slug;
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2), "utf8");
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** 创建项目目录与初始三件套。 */
export function createProject(
  meta: NovelMeta,
  outline: Outline,
  memory: StoryMemory,
): void {
  mkdirSync(chaptersDir(meta.slug), { recursive: true });
  saveMeta(meta);
  saveOutline(meta.slug, outline);
  saveMemory(meta.slug, memory);
}

export function saveMeta(meta: NovelMeta): void {
  writeJson(join(novelDir(meta.slug), "novel.json"), meta);
}

export function saveOutline(slug: string, outline: Outline): void {
  writeJson(join(novelDir(slug), "outline.json"), outline);
}

export function saveMemory(slug: string, memory: StoryMemory): void {
  writeJson(join(novelDir(slug), "memory.json"), memory);
}

/** 保存一章的成文与（可选）原始 beats。 */
export function saveChapter(
  slug: string,
  chapter: GeneratedChapter,
  transcript?: unknown,
): void {
  const dir = chaptersDir(slug);
  mkdirSync(dir, { recursive: true });
  const md = `# ${chapter.title}\n\n${chapter.prose}\n`;
  writeFileSync(join(dir, `ch${pad2(chapter.n)}.md`), md, "utf8");
  if (transcript !== undefined) {
    writeJson(join(dir, `ch${pad2(chapter.n)}.transcript.json`), transcript);
  }
}

/** 读取一章成文（若存在）。 */
export function loadChapterProse(slug: string, n: number): string | null {
  const path = join(chaptersDir(slug), `ch${pad2(n)}.md`);
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf8");
}

export function projectExists(slug: string): boolean {
  return existsSync(join(novelDir(slug), "novel.json"));
}

/** 加载完整项目（元数据 + 大纲 + 记忆）。 */
export function loadProject(slug: string): NovelProject {
  if (!projectExists(slug)) {
    throw new Error(`小说项目不存在：${slug}（在 novels/ 下未找到）`);
  }
  const dir = novelDir(slug);
  return {
    meta: readJson<NovelMeta>(join(dir, "novel.json")),
    outline: readJson<Outline>(join(dir, "outline.json")),
    memory: readJson<StoryMemory>(join(dir, "memory.json")),
  };
}

/** 列出所有项目的元数据（按创建时间倒序）。 */
export function listProjects(): NovelMeta[] {
  const ROOT = root();
  if (!existsSync(ROOT)) return [];
  const metas: NovelMeta[] = [];
  for (const name of readdirSync(ROOT)) {
    const metaPath = join(ROOT, name, "novel.json");
    if (existsSync(metaPath)) {
      try {
        metas.push(readJson<NovelMeta>(metaPath));
      } catch {
        // 跳过损坏的项目
      }
    }
  }
  return metas.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** 项目目录的绝对路径（用于给用户展示保存位置）。 */
export function projectPath(slug: string): string {
  return novelDir(slug);
}
