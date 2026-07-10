import { LLMClient } from "../core/llm/client.ts";
import type { DramaEventSink } from "../drama/events.ts";
import type { DramaContext } from "../drama/scene.ts";
import { WuxiaDramaAgent } from "../drama/agent.ts";
import { Planner } from "./planner.ts";
import { Archivist } from "./archivist.ts";
import {
  emptyMemory,
  codexToCharacter,
  selectRelevantCharacters,
  renderWorldBrief,
  renderOpenThreads,
  tailOf,
} from "./memory.ts";
import {
  createProject,
  loadProject,
  saveMeta,
  saveOutline,
  saveMemory,
  saveChapter,
  loadChapterProse,
  makeSlug,
} from "./project.ts";
import type {
  NovelMeta,
  NovelProject,
  Outline,
  GeneratedChapter,
  ChapterPlan,
} from "./types.ts";

/**
 * 编排器：把"规划 → 演章 → 成文 → 更新记忆 → 修订大纲 → 存盘"串成多章生成流水线。
 * 一次只推进一章（generateNextChapter），成本随章数线性、单章有界，可随时中断续写。
 */

export interface NovelEngineOptions {
  client?: LLMClient;
  /** 结构化事件回调（CLI 打印/Web SSE 转发）。同一 sink 也接到单章的逐拍事件。 */
  onEvent?: DramaEventSink;
  /** 单章最多演多少拍。 */
  maxBeats?: number;
}

export interface NextChapterResult {
  /** 是否已全书写完（无待写章节）。 */
  done: boolean;
  chapter?: GeneratedChapter;
  project: NovelProject;
}

function splitProse(raw: string): { title: string; body: string } {
  const text = raw.trim();
  const nl = text.indexOf("\n");
  if (nl === -1) return { title: text.slice(0, 20) || "无题", body: text };
  const title = text.slice(0, nl).trim().replace(/^#+\s*/, "").replace(/^标题[:：]\s*/, "");
  const body = text.slice(nl + 1).trim();
  return { title: title || "无题", body: body || text };
}

export class NovelEngine {
  private readonly client: LLMClient;
  private readonly planner: Planner;
  private readonly archivist: Archivist;
  private readonly drama: WuxiaDramaAgent;
  private readonly onEvent?: DramaEventSink;

  constructor(opts: NovelEngineOptions = {}) {
    this.client = opts.client ?? new LLMClient();
    this.planner = new Planner(this.client);
    this.archivist = new Archivist(this.client);
    this.drama = new WuxiaDramaAgent({
      client: this.client,
      onEvent: opts.onEvent,
      maxBeats: opts.maxBeats,
    });
    this.onEvent = opts.onEvent;
  }

  private emitOutline(outline: Outline, title: string): void {
    this.onEvent?.({
      type: "outline",
      title,
      premise: outline.premise,
      logline: outline.logline,
      chapters: outline.chapters.map((c) => ({
        n: c.n,
        title: c.title,
        goal: c.goal,
        status: c.status,
      })),
    });
  }

  /** 新建一部小说：规划大纲 + 世界观圣经，落盘并返回元数据。 */
  async startNovel(seed: string, chapterHint?: string): Promise<NovelProject> {
    const { title, outline, worldBible } = await this.planner.createOutline(seed, chapterHint);
    const memory = emptyMemory(worldBible);
    const meta: NovelMeta = {
      slug: makeSlug(title),
      title,
      createdAt: new Date().toISOString(),
      model: this.client.model,
      chaptersWritten: 0,
    };
    createProject(meta, outline, memory);
    this.emitOutline(outline, title);
    return { meta, outline, memory };
  }

  /** 推进下一待写章节：演章 → 成文 → 更新记忆 → 修订后续大纲 → 存盘。 */
  async generateNextChapter(slug: string): Promise<NextChapterResult> {
    const project = loadProject(slug);
    const { outline, memory, meta } = project;

    const plan = outline.chapters.find((c) => c.status !== "written");
    if (!plan) {
      this.onEvent?.({ type: "novel-complete", chaptersWritten: meta.chaptersWritten });
      return { done: true, project };
    }

    this.onEvent?.({ type: "chapter-start", n: plan.n, title: plan.title, goal: plan.goal });

    // 组装喂给 drama 的章节上下文（有界）。
    const { characters, returningNotes } = selectRelevantCharacters(memory, plan, plan.n);
    const previousProse = plan.n > 1 ? loadChapterProse(slug, plan.n - 1) : null;
    const ctx: DramaContext = {
      chapterNo: plan.n,
      goal: plan.goal,
      worldBrief: renderWorldBrief(memory.worldBible),
      returningCharacters: characters.map(codexToCharacter),
      returningNotes,
      storySoFar: memory.rollingSummary,
      openThreads: renderOpenThreads(memory.threads),
      previousChapterTail: previousProse ? tailOf(stripHeading(previousProse)) : undefined,
    };

    // 1) 演一章（多 agent 涌现）。
    const chapterSeed = plan.n === 1 ? outline.premise || plan.goal : plan.goal;
    const { scene, transcript } = await this.drama.playScene(chapterSeed, ctx);

    // 2) 执笔成文（单 agent 统一文笔）。
    const raw = await this.drama.novelizeScene(scene, transcript, chapterSeed, ctx);
    const { title, body } = splitProse(raw);
    const chapter: GeneratedChapter = { n: plan.n, title, prose: body };

    // 3) 更新记忆（档案官）。
    const nextMemory = await this.archivist.updateMemory(memory, {
      chapterNo: plan.n,
      goal: plan.goal,
      scene,
      transcript,
      prose: body,
    });

    // 4) 标记本章已写、存盘。
    const writtenChapters: ChapterPlan[] = outline.chapters.map((c) =>
      c.n === plan.n ? { ...c, title, status: "written" as const } : c,
    );
    let nextOutline: Outline = { ...outline, chapters: writtenChapters };

    saveChapter(slug, chapter, transcript);
    saveMemory(slug, nextMemory);

    // 5) 按实际走向修订后续章节。
    nextOutline = await this.planner.reviseOutline(nextOutline, nextMemory);
    saveOutline(slug, nextOutline);

    const nextMeta: NovelMeta = { ...meta, chaptersWritten: meta.chaptersWritten + 1 };
    saveMeta(nextMeta);

    // 6) 广播章节与记忆更新事件。
    this.onEvent?.({ type: "chapter-prose", n: chapter.n, title: chapter.title, content: body });
    this.onEvent?.({
      type: "memory-updated",
      summary: nextMemory.rollingSummary,
      openThreads: nextMemory.threads.filter((t) => t.status === "open").map((t) => t.description),
      latestEvent: nextMemory.events[nextMemory.events.length - 1]?.summary,
    });
    this.emitOutline(nextOutline, meta.title);

    const finalProject: NovelProject = {
      meta: nextMeta,
      outline: nextOutline,
      memory: nextMemory,
    };
    const stillLeft = nextOutline.chapters.some((c) => c.status !== "written");
    if (!stillLeft) {
      this.onEvent?.({ type: "novel-complete", chaptersWritten: nextMeta.chaptersWritten });
    }
    return { done: !stillLeft, chapter, project: finalProject };
  }
}

/** 去掉正文里的 markdown 标题行，取纯正文用于承接。 */
function stripHeading(md: string): string {
  return md.replace(/^#.*\n+/, "").trim();
}
