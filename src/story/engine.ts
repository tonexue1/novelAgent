import { LLMClient } from "../core/llm/client.ts";
import type { DramaEventSink } from "../drama/events.ts";
import type { DramaContext } from "../drama/scene.ts";
import { WuxiaDramaAgent } from "../drama/agent.ts";
import {
  Planner,
  parseTargetChapters,
  normalizeActCounts,
  buildPlaceholderChapters,
} from "./planner.ts";
import type { Skeleton } from "./planner.ts";
import { Archivist } from "./archivist.ts";
import {
  emptyMemory,
  normalizeMemory,
  codexToCharacter,
  selectRelevantCharacters,
  protagonistOf,
  renderWorldBrief,
  renderOpenThreads,
  renderDeadRoster,
  renderPropLedger,
  renderEventsRecap,
  renderArcSummaries,
  buildArcRecap,
  tailOf,
} from "./memory.ts";
import {
  createProject,
  loadProject,
  saveMeta,
  saveOutline,
  saveMemory,
  saveMemorySnapshot,
  saveChapter,
  loadChapterProse,
  makeSlug,
} from "./project.ts";
import type {
  NovelMeta,
  NovelProject,
  Outline,
  ArcPlan,
  GeneratedChapter,
  ChapterPlan,
  StoryMemory,
  GenreSpec,
  StyleCard,
  StyleIntensity,
} from "./types.ts";
import { resolveGenre, DEFAULT_GENRE } from "./genre.ts";
import {
  resolveStyleCard,
  resolveIntensity,
  renderStyleCard,
  renderStyleBrief,
  renderDirectorCard,
  DEFAULT_STYLE_INTENSITY,
} from "./style.ts";

/** 目标章数超过此值即启用分卷滚动规划（否则一次性规划全书）。 */
const ROLLING_THRESHOLD = 40;

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
    // 按角色分模型（未配置则回落到 OPENAI_MODEL）；drama 内部再拆 director/character/novelist。
    this.planner = new Planner(this.client.withRole("planner"));
    this.archivist = new Archivist(this.client.withRole("archivist"));
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
      mode: outline.mode,
      arcs: outline.arcs?.map((a) => ({
        n: a.n,
        title: a.title,
        summary: a.summary,
        chapters: a.chapters,
        status: a.status,
      })),
      currentArc: outline.currentArc,
      targetChapters: outline.targetChapters,
    });
  }

  /**
   * 新建一部小说：规划大纲 + 世界观圣经，落盘并返回元数据。genre 可传 id/label/自定义题材名。
   * 目标章数 > {@link ROLLING_THRESHOLD} 时启用【分卷滚动规划】（只展开第 1 卷，写完再展开下一卷），
   * 以支撑数百章长篇连载；否则沿用一次性整书规划（whole）。
   */
  async startNovel(
    seed: string,
    chapterHint?: string,
    genreInput?: string,
    styleInput?: string,
    intensityInput?: string,
  ): Promise<NovelProject> {
    const genre = resolveGenre(genreInput);
    const styleCard = resolveStyleCard(styleInput);
    const styleIntensity = resolveIntensity(intensityInput);
    const target = parseTargetChapters(chapterHint);
    if (target > ROLLING_THRESHOLD) {
      return this.startRollingNovel(seed, target, genre, styleCard, styleIntensity);
    }

    const { title, outline, worldBible } = await this.planner.createOutline(
      seed,
      chapterHint,
      genre,
    );
    outline.mode = "whole";
    const memory = emptyMemory(worldBible);
    const meta: NovelMeta = {
      slug: makeSlug(title),
      title,
      createdAt: new Date().toISOString(),
      model: this.client.model,
      chaptersWritten: 0,
      genre,
      styleCard,
      styleIntensity,
    };
    createProject(meta, outline, memory);
    this.emitOutline(outline, title);
    return { meta, outline, memory };
  }

  /**
   * 分卷滚动新建：先出书本级 canon + 分卷路线图，只展开第 1 卷的分章。
   * 规划部分复用 {@link Planner.createRollingOutline}；本方法只负责落盘与广播事件。
   * 若路线图生成失败，createRollingOutline 会回退到整书规划（返回非 rolling 大纲），
   * 这里据 outline.mode 兼容处理：rolling 才广播卷开始事件。
   */
  private async startRollingNovel(
    seed: string,
    target: number,
    genre: GenreSpec,
    styleCard: StyleCard | undefined,
    styleIntensity: StyleIntensity,
  ): Promise<NovelProject> {
    const { title, outline, worldBible } = await this.planner.createRollingOutline(
      seed,
      `${target} 章`,
      genre,
    );
    const memory = emptyMemory(worldBible);
    const meta: NovelMeta = {
      slug: makeSlug(title),
      title,
      createdAt: new Date().toISOString(),
      model: this.client.model,
      chaptersWritten: 0,
      genre,
      styleCard,
      styleIntensity,
    };
    createProject(meta, outline, memory);
    this.emitOutline(outline, title);
    const firstArc = outline.arcs?.[0];
    if (outline.mode === "rolling" && firstArc) {
      this.onEvent?.({ type: "arc-start", n: 1, title: firstArc.title, summary: firstArc.summary });
    }
    return { meta, outline, memory };
  }

  /** 推进下一待写章节：演章 → 成文 → 更新记忆 →（whole 模式）修订后续大纲 → 存盘。 */
  async generateNextChapter(slug: string): Promise<NextChapterResult> {
    const project = loadProject(slug);
    const { outline, meta } = project;
    // 兼容旧存档：补齐 props/currentLocation/appearances 等新增字段。
    const memory = normalizeMemory(project.memory);
    // 兼容旧存档：缺题材时回落默认武侠。
    const genre: GenreSpec = meta.genre ?? DEFAULT_GENRE;
    // 写作风味（旧档缺失即不启用，回落题材默认腔调）。
    const styleCard: StyleCard | undefined = meta.styleCard;
    const styleIntensity: StyleIntensity = meta.styleIntensity ?? DEFAULT_STYLE_INTENSITY;
    const rolling = outline.mode === "rolling";

    // 分卷滚动：若当前卷已写完，先归档本卷并展开下一卷（就地修改并存盘 outline/memory）。
    if (rolling && !outline.chapters.some((c) => c.status !== "written")) {
      const advanced = await this.expandNextArc(slug, outline, memory, meta, genre);
      if (!advanced) {
        this.onEvent?.({ type: "novel-complete", chaptersWritten: meta.chaptersWritten });
        return { done: true, project };
      }
    }

    const plan = outline.chapters.find((c) => c.status !== "written");
    if (!plan) {
      this.onEvent?.({ type: "novel-complete", chaptersWritten: meta.chaptersWritten });
      return { done: true, project };
    }

    this.onEvent?.({ type: "chapter-start", n: plan.n, title: plan.title, goal: plan.goal });
    const chapterStartedAt = Date.now();

    // 回退支持：先落一份"写本章之前"的记忆快照，rollback 时可精确还原到本章之前。
    saveMemorySnapshot(slug, plan.n, memory);

    // 组装喂给 drama 的章节上下文（有界）：以主角为中心、带上世界状态铁律。
    const protagonist = protagonistOf(memory);
    const { characters, returningNotes } = selectRelevantCharacters(
      memory,
      plan,
      plan.n,
      undefined,
      protagonist?.name,
    );
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
      deadRoster: renderDeadRoster(memory.characters),
      propLedger: renderPropLedger(memory.props),
      currentLocation: memory.currentLocation,
      achievements: renderEventsRecap(memory.events),
      genrePersona: genre.persona,
      genreStyle: genre.styleGuidance,
      narrationStyle: renderStyleCard(styleCard, styleIntensity) || undefined,
      narrationStyleBrief: renderStyleBrief(styleCard) || undefined,
      directionStyle: renderDirectorCard(styleCard, plan.n) || undefined,
    };

    // 1) 演一章（多 agent 涌现）。
    const chapterSeed = plan.n === 1 ? outline.premise || plan.goal : plan.goal;
    const { scene, transcript } = await this.drama.playScene(chapterSeed, ctx);

    // 2) 执笔成文（单 agent 统一文笔）。
    const raw = await this.drama.novelizeScene(scene, transcript, chapterSeed, ctx);
    const { title, body } = splitProse(raw);
    const chapter: GeneratedChapter = { n: plan.n, title, prose: body };

    // 3) 更新记忆（档案官）。
    const archivistStartedAt = Date.now();
    const nextMemory = await this.archivist.updateMemory(
      memory,
      {
        chapterNo: plan.n,
        goal: plan.goal,
        scene,
        transcript,
        prose: body,
      },
      genre,
    );
    console.log(
      `\x1b[36m[计时·档案] 更新记忆耗时 ${((Date.now() - archivistStartedAt) / 1000).toFixed(1)}s\x1b[0m`,
    );

    // 4) 标记本章已写、存盘。
    const writtenChapters: ChapterPlan[] = outline.chapters.map((c) =>
      c.n === plan.n ? { ...c, title, status: "written" as const } : c,
    );
    let nextOutline: Outline = { ...outline, chapters: writtenChapters };

    saveChapter(slug, chapter, transcript);
    saveMemory(slug, nextMemory);

    // 5) 修订后续章节。
    //    - whole：按实际走向修订后续所有待写章节（指向结局）。
    //    - rolling：卷内不做整书修订（成本恒定）；后续卷在其展开时结合记忆规划。
    if (!rolling) {
      const reviseStartedAt = Date.now();
      nextOutline = await this.planner.reviseOutline(nextOutline, nextMemory, genre);
      console.log(
        `\x1b[36m[计时·修订大纲] 耗时 ${((Date.now() - reviseStartedAt) / 1000).toFixed(1)}s\x1b[0m`,
      );
    }
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
    console.log(
      `\x1b[35m[计时·整章] 第 ${plan.n} 章总耗时 ` +
        `${((Date.now() - chapterStartedAt) / 1000).toFixed(1)}s\x1b[0m`,
    );
    const remaining = nextOutline.chapters.some((c) => c.status !== "written");
    // rolling：本卷可能已写完但仍有后续卷（且未达目标章数）→ 下一次调用会展开下一卷。
    const moreArcs =
      rolling &&
      (nextOutline.arcs ?? []).some((a) => a.n > (nextOutline.currentArc ?? 1)) &&
      nextMeta.chaptersWritten < (nextOutline.targetChapters ?? nextMeta.chaptersWritten);
    const stillLeft = remaining || moreArcs;
    if (!stillLeft) {
      this.onEvent?.({ type: "novel-complete", chaptersWritten: nextMeta.chaptersWritten });
    }
    return { done: !stillLeft, chapter, project: finalProject };
  }

  /**
   * 分卷滚动：当前卷已全部写完时，归档本卷综述并展开下一卷（就地修改 outline/memory 并存盘）。
   * 返回 true 表示已展开下一卷（有新章可写）；false 表示无更多卷/已达目标章数（全书收官）。
   */
  private async expandNextArc(
    slug: string,
    outline: Outline,
    memory: StoryMemory,
    meta: NovelMeta,
    genre: GenreSpec,
  ): Promise<boolean> {
    const arcs = outline.arcs ?? [];
    const cur = outline.currentArc ?? 1;
    const written = outline.chapters.length;
    const target = outline.targetChapters ?? written;
    const nextArc = arcs.find((a) => a.n === cur + 1);
    if (!nextArc || written >= target) return false;

    // 1) 归档当前卷综述（据事件区间，纯函数，无额外 LLM）。
    const curArc = arcs.find((a) => a.n === cur);
    const curChapters = outline.chapters.filter((c) => (c.arc ?? cur) === cur);
    const startCh = curChapters[0]?.n ?? 1;
    const endCh = curChapters[curChapters.length - 1]?.n ?? written;
    const recap = buildArcRecap(memory.events, cur, curArc?.title ?? `第${cur}卷`, startCh, endCh);
    memory.arcSummaries = [...(memory.arcSummaries ?? []), recap];
    saveMemory(slug, memory);

    // 2) 组装记忆摘要（供路线图修订 + 下一卷展开共用）。
    const protagonist = protagonistOf(memory);
    const memoryNote = [
      protagonist ? `主角：${protagonist.name}（${protagonist.identity}）` : "",
      memory.rollingSummary ? `近期梗概：${memory.rollingSummary}` : "",
      renderArcSummaries(memory.arcSummaries)
        ? `各卷综述：\n${renderArcSummaries(memory.arcSummaries)}`
        : "",
      renderOpenThreads(memory.threads) !== "（暂无未回收伏笔）"
        ? `未回收伏笔：\n${renderOpenThreads(memory.threads)}`
        : "",
      memory.currentLocation ? `当前进度：${memory.currentLocation}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    // 2.5) showrunner 级自适应：展开前据实况修订【后续尚未展开的卷】路线图（每卷一次，失败即沿用原路线图）。
    await this.reviseRemainingRoadmap(outline, memory, meta, genre, memoryNote);

    // 修订可能重排了后续卷：重新读取（可能被修订过的）卷列表与下一卷。
    const arcsNow = outline.arcs ?? [];
    const nextArcNow = arcsNow.find((a) => a.n === cur + 1);
    if (!nextArcNow) return false; // 修订后收敛为提前收官

    // 3) 结合记忆展开下一卷。
    this.onEvent?.({
      type: "arc-start",
      n: nextArcNow.n,
      title: nextArcNow.title,
      summary: nextArcNow.summary,
    });
    console.log(
      `\x1b[36m[规划] 第 ${cur} 卷已完，展开第 ${nextArcNow.n}/${arcsNow.length} 卷《${nextArcNow.title}》…\x1b[0m`,
    );

    const skeleton: Skeleton = {
      title: meta.title,
      premise: outline.premise,
      logline: outline.logline,
      throughline: outline.throughline,
      ending: outline.ending,
      worldBible: memory.worldBible,
      acts: arcsNow.map((a) => ({ title: a.title, summary: a.summary, chapters: a.chapters })),
    };
    const prevTail = outline.chapters.slice(-2).map((c) => ({ ...c }));

    let list = await this.planner.expandAct(
      skeleton,
      skeleton.acts,
      nextArcNow.n - 1,
      prevTail,
      genre,
      memoryNote,
    );
    if (list.length === 0) {
      console.error(`\x1b[31m[规划] 第 ${nextArcNow.n} 卷展开失败，用占位章兜底。\x1b[0m`);
      list = buildPlaceholderChapters(
        { title: nextArcNow.title, summary: nextArcNow.summary, chapters: nextArcNow.chapters },
        Math.max(1, nextArcNow.chapters),
      );
    }

    // 4) 追加新章（续号、标记卷号），更新卷状态与当前卷。
    let n = outline.chapters.length;
    for (const c of list) {
      n++;
      outline.chapters.push({ ...c, n, status: "planned", arc: nextArcNow.n });
    }
    for (const a of arcsNow) {
      if (a.n === cur) a.status = "done";
      else if (a.n === nextArcNow.n) a.status = "active";
    }
    outline.currentArc = nextArcNow.n;
    saveOutline(slug, outline);
    this.emitOutline(outline, meta.title);
    return true;
  }

  /**
   * showrunner 级自适应：据故事实况修订【后续尚未展开的卷】路线图（就地改写 outline.arcs / ending）。
   * 每卷仅一次、有界、便宜；解析失败或异常一律沿用原路线图（best-effort，绝不因它中断写作）。
   */
  private async reviseRemainingRoadmap(
    outline: Outline,
    memory: StoryMemory,
    meta: NovelMeta,
    genre: GenreSpec,
    memoryNote: string,
  ): Promise<void> {
    const arcs = outline.arcs ?? [];
    const cur = outline.currentArc ?? 1;
    const written = outline.chapters.length;
    const target = outline.targetChapters ?? written;
    const remaining = arcs.filter((a) => a.n > cur);
    if (remaining.length === 0) return;

    const toAct = (a: ArcPlan) => ({ title: a.title, summary: a.summary, chapters: a.chapters });
    const remainingChapters = Math.max(remaining.length, target - written);

    let revised: { ending: string; arcs: { title: string; summary: string; chapters: number }[] } | null;
    try {
      revised = await this.planner.reviseRoadmap({
        title: meta.title,
        throughline: outline.throughline,
        ending: outline.ending,
        worldBible: memory.worldBible,
        doneArcs: arcs.filter((a) => a.n <= cur).map(toAct),
        remainingArcs: remaining.map(toAct),
        memoryNote,
        remainingChapters,
        genre,
      });
    } catch (err) {
      console.error(
        `\x1b[33m[规划] 路线图修订抛错，沿用原路线图：${err instanceof Error ? err.message : String(err)}\x1b[0m`,
      );
      return;
    }
    if (!revised || revised.arcs.length === 0) return;

    // 卷数不能超过剩余章预算（否则每卷至少 1 章无法凑成总预算），超出则截断。
    const capped = revised.arcs.slice(0, Math.max(1, remainingChapters));
    const normalized = normalizeActCounts(capped, remainingChapters);
    const kept = arcs.filter((a) => a.n <= cur);
    const newRemaining: ArcPlan[] = normalized.map((a, i) => ({
      n: cur + 1 + i,
      title: a.title,
      summary: a.summary,
      chapters: a.chapters,
      status: "planned" as const,
    }));
    outline.arcs = [...kept, ...newRemaining];
    outline.ending = revised.ending || outline.ending;
    console.log(
      `\x1b[36m[规划] 路线图已据实况修订：后续 ${remaining.length} 卷 → ${newRemaining.length} 卷（剩余约 ${remainingChapters} 章）。\x1b[0m`,
    );
  }
}

/** 去掉正文里的 markdown 标题行，取纯正文用于承接。 */
function stripHeading(md: string): string {
  return md.replace(/^#.*\n+/, "").trim();
}
