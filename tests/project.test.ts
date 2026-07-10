import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  makeSlug,
  createProject,
  loadProject,
  saveChapter,
  loadChapterProse,
  listProjects,
  projectExists,
} from "../src/story/project.ts";
import { emptyMemory, emptyWorldBible } from "../src/story/memory.ts";
import type { NovelMeta, Outline } from "../src/story/types.ts";

// project.ts 用 process.cwd()/novels 作为根目录；切到临时目录避免污染仓库。
let cwd0: string;
let tmp: string;

beforeAll(() => {
  cwd0 = process.cwd();
  tmp = mkdtempSync(join(tmpdir(), "wuxia-proj-"));
  process.chdir(tmp);
});

afterAll(() => {
  process.chdir(cwd0);
  rmSync(tmp, { recursive: true, force: true });
});

function makeMeta(slug: string, title: string): NovelMeta {
  return { slug, title, createdAt: new Date().toISOString(), model: "test", chaptersWritten: 0 };
}

function makeOutline(): Outline {
  return {
    premise: "少年寻仇",
    logline: "断刀引出旧案",
    throughline: "复仇与真相",
    ending: "放下屠刀",
    chapters: [{ n: 1, title: "下山", goal: "立誓下山", status: "planned" }],
  };
}

describe("project store", () => {
  test("makeSlug 过滤非法字符", () => {
    expect(makeSlug("断刀/行:第一部")).not.toContain("/");
    expect(makeSlug("断刀/行:第一部")).not.toContain(":");
  });

  test("创建 / 加载 / 列出 往返", () => {
    const slug = makeSlug("断刀行");
    const meta = makeMeta(slug, "断刀行");
    const outline = makeOutline();
    const memory = emptyMemory(emptyWorldBible());

    expect(projectExists(slug)).toBe(false);
    createProject(meta, outline, memory);
    expect(projectExists(slug)).toBe(true);

    const p = loadProject(slug);
    expect(p.meta.title).toBe("断刀行");
    expect(p.outline.chapters[0]!.goal).toBe("立誓下山");
    expect(p.memory.characters).toEqual([]);

    const list = listProjects();
    expect(list.some((m) => m.slug === slug)).toBe(true);
  });

  test("保存与读取章节正文", () => {
    const slug = makeSlug("章节书");
    createProject(makeMeta(slug, "章节书"), makeOutline(), emptyMemory(emptyWorldBible()));

    expect(loadChapterProse(slug, 1)).toBeNull();
    saveChapter(slug, { n: 1, title: "下山", prose: "少年负刀下山。" }, [{ actor: "少年", kind: "act", content: "走了" }]);
    const md = loadChapterProse(slug, 1);
    expect(md).not.toBeNull();
    expect(md!).toContain("# 下山");
    expect(md!).toContain("少年负刀下山。");
  });

  test("加载不存在的项目抛错", () => {
    expect(() => loadProject("不存在的书")).toThrow();
  });
});
