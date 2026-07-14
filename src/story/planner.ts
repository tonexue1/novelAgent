import type { LLMClient } from "../core/llm/client.ts";
import type { Message } from "../core/llm/types.ts";
import { extractJsonObject, findArrayField, str, strArray } from "../core/json.ts";
import {
  renderWorldBrief,
  renderOpenThreads,
  renderEventsRecap,
  protagonistOf,
} from "./memory.ts";
import type {
  Outline,
  ChapterPlan,
  ArcPlan,
  WorldBible,
  StoryMemory,
  GenreSpec,
} from "./types.ts";
import { DEFAULT_GENRE } from "./genre.ts";

/**
 * 规划师：整书主情节的策划者。
 * - createOutline：一次奠基前提/主线/结局方向/分章目标 + 初始世界观圣经。
 * - reviseOutline：写完一章后，按实际走向修订"尚未写"的后续章节目标。
 *
 * 解析用纯函数 parseOutline / parseWorldBible，非法时兜底，保证流程不断。
 */

/** 默认规划的章节数区间。 */
const DEFAULT_CHAPTER_HINT = "6 到 10 章";

/**
 * 喂给模型的 JSON 铁律：别在字符串值里写裸英文双引号——这是 LLM 输出 JSON 最常见的破绽
 * （如中文串里的 "清道"），会提前闭合字符串导致解析失败。虽有 escapeStrayQuotes 兜底修复，
 * 仍在提示层从源头压低出错率。
 */
const JSON_QUOTE_RULE =
  '- 【JSON 铁律】所有字符串值内不得出现未转义的英文双引号（"）；若内容需要引用，请改用中文引号「」或“”，以免破坏 JSON。';

/**
 * 书名质量铁律：把"起个好书名"从提示层顶起来。auto 生成的书名最容易平庸、文艺
 * 而无钩子（如《百年烟火》《山河负剑录》这类空泛意象），这条要求书名抓人、契合
 * 题材读者口味，并明确点名要避开的套路。
 */
const BOOK_TITLE_RULE =
  "- 【书名铁律】书名要抓人、有记忆点、朗朗上口，一眼勾起好奇、让目标读者想立刻点开，且【必须贴合前提的主角与核心关系/情感】，不能是与故事内核无关的意象。" +
  "【优先做法】用一个【具体的意象/象征物/关键信物/一句黑话/一个地名或场景】来命名（如以某件贯穿全书的信物、某句规矩、某个符号为名），让书名像一枚钩子而非一句简介；现代言情/青春题材也可直接落在人物关系或情感上。" +
  "【严禁】把主角身份或前提原样拼进书名的直白概括式命名（如“草根+教父”“废柴+逆袭”“少年+复仇”这类把设定塞满标题的写法）；也严禁土味、油腻、像烂片译名的口语堆砌。" +
  "契合题材：现代题材（都市/悬疑）可具体、可略长带钩子但要显质感；武侠/仙侠/玄幻/奇幻宜凝练有意境且有独特记忆点。" +
  "严禁空泛文艺、辞藻堆砌、烂大街的通用意象（如“烟火/山河/风云/苍穹/浮生/繁华”一类）与套路化老后缀（《XX录》《XX诀》《XX传》《XX歌》《XX赋》）。" +
  "宁可具体、克制、有质感，也不要直白平庸或油腻。";

/**
 * 忠于前提铁律：防止规划把用户的小前提偷换成题材默认套路（如把校园恋爱改写成豪门商战）。
 * 前提的主角、核心关系与情感钩子、隐含子类型必须始终是全书的心脏。
 */
const PREMISE_FIDELITY_RULE =
  "- 【忠于前提铁律】必须紧扣用户前提本身的【主角、核心关系与情感钩子、隐含子类型】立意：前提是校花与废柴的校园恋爱，就写这段恋爱的甜与虐、成长与错过，主角就是那个“废柴”，别把它偷换成豪门并购、夺嫡商战之类的题材套路；前提是市井小人物，就写市井。" +
  "可以合理扩展世界、人物与冲突，但前提许下的那段核心关系/情感/看点必须自始至终是主线的心脏，书名、各幕、结局都要围绕它展开，而不是喧宾夺主地另起炉灶。";

export interface OutlineResult {
  title: string;
  outline: Outline;
  worldBible: WorldBible;
}

/**
 * 断点续规划的进度快照：已展开完 {@link actsDone} 幕、累计 {@link chapters} 章。
 * skeleton 里的 acts 已归一到目标章数，恢复时直接复用、跳过前 actsDone 幕。
 */
export interface OutlineCheckpoint {
  skeleton: Skeleton;
  actsDone: number;
  chapters: ChapterPlan[];
}

export interface CreateOutlineOptions {
  /** 从上次进度快照【断点续规划】：复用 skeleton，跳过已展开的幕。 */
  resume?: OutlineCheckpoint;
  /**
   * 每推进一步（骨架成型、每展开完一幕）就回调一次，交调用方落盘快照。
   * 这是断点续规划的持久化钩子——落盘后即便进程崩溃/超时，重跑也能接着展开。
   */
  onProgress?: (checkpoint: OutlineCheckpoint) => void | Promise<void>;
}

function parseWorldBibleObj(o: Record<string, unknown> | null): WorldBible {
  const wb = (o && typeof o === "object" ? o : {}) as Record<string, unknown>;
  return {
    era: str(wb.era),
    tone: str(wb.tone),
    locations: strArray(wb.locations),
    factions: strArray(wb.factions),
    powerSystem: strArray(wb.powerSystem),
    items: strArray(wb.items),
    lore: strArray(wb.lore),
  };
}

/** 从任意文本解析世界观圣经（纯函数，供测试/兜底）。 */
export function parseWorldBible(text: string): WorldBible {
  return parseWorldBibleObj(extractJsonObject(text));
}

/** 去掉标题里模型自带的"第X章/第X回"编号前缀（全书统一重排章号，避免"第5章《第一章…》"）。 */
function cleanChapterTitle(title: string): string {
  return title
    .replace(/^第\s*[0-9一二三四五六七八九十百零两]{1,5}\s*[章回节卷][：:·、.\s-]*/u, "")
    .trim();
}

function parseChapterPlans(v: unknown): ChapterPlan[] {
  if (!Array.isArray(v)) return [];
  const plans: ChapterPlan[] = [];
  for (const raw of v) {
    if (!raw || typeof raw !== "object") continue;
    const o = raw as Record<string, unknown>;
    const goal = str(o.goal);
    if (!goal) continue;
    plans.push({
      n: plans.length + 1,
      title: cleanChapterTitle(str(o.title)) || `第${plans.length + 1}章`,
      goal,
      keyBeats: strArray(o.keyBeats),
      status: "planned",
    });
  }
  return plans;
}

/**
 * 从文本解析整份大纲结果（纯函数）。缺字段时给出安全默认，chapters 为空时不合法。
 * 返回 null 表示解析失败，交上层兜底。
 */
export function parseOutline(text: string): OutlineResult | null {
  const o = extractJsonObject(text);
  if (!o) return null;

  const chapters = parseChapterPlans(
    Array.isArray(o.chapters) ? o.chapters : findArrayField(o, "chapters"),
  );
  if (chapters.length === 0) return null;

  const premise = str(o.premise);
  const outline: Outline = {
    premise,
    logline: str(o.logline),
    throughline: str(o.throughline),
    ending: str(o.ending),
    chapters,
  };
  const title = str(o.title) || chapters[0]!.title || "无名武侠";
  return { title, outline, worldBible: parseWorldBibleObj(o.worldBible as Record<string, unknown>) };
}

// ── 分批（分层）规划：主干幕 → 逐幕细化 ──────────────────

/** 一幕/一卷（主干骨架的一段），含该段计划章数。 */
export interface ActPlan {
  title: string;
  /** 这一幕/卷的主要剧情与目标。 */
  summary: string;
  /** 该幕/卷计划分多少章。 */
  chapters: number;
}

/** 全书骨架：书本级 canon + 主干幕/卷列表（尚未细化到分章）。 */
export interface Skeleton {
  title: string;
  premise: string;
  logline: string;
  throughline: string;
  ending: string;
  worldBible: WorldBible;
  acts: ActPlan[];
}

/** 目标章数上限（分卷滚动模式支持长篇连载）。 */
export const MAX_TARGET_CHAPTERS = 2000;

/** 单次 LLM 展开分章的批量上限：过多会让大 JSON 解析失败/截断，故分批展开。 */
export const MAX_CHAPTERS_PER_BATCH = 12;

/** 从 chapterHint 里取目标章数（取其中最大的整数），限制在 [3,MAX]；无则回落到 10。 */
export function parseTargetChapters(hint: string | undefined): number {
  const nums = (hint ?? "").match(/\d+/g)?.map(Number) ?? [];
  const target = nums.length ? Math.max(...nums) : 10;
  return Math.max(3, Math.min(MAX_TARGET_CHAPTERS, target));
}

/** 从文本解析主干骨架（纯函数）；acts 为空或缺关键字段时返回 null，交上层兜底。 */
/** 解析一个幕/卷列表（title/summary/chapters）；过滤空项。纯函数，供骨架与路线图修订共用。 */
export function parseActList(v: unknown): ActPlan[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((raw) => {
      if (!raw || typeof raw !== "object") return null;
      const a = raw as Record<string, unknown>;
      const summary = str(a.summary) || str(a.goal);
      const title = str(a.title);
      if (!summary && !title) return null;
      const n = Number(a.chapters);
      return {
        title: title || summary.slice(0, 12),
        summary: summary || title,
        chapters: Number.isFinite(n) && n > 0 ? Math.round(n) : 0,
      } as ActPlan;
    })
    .filter((a): a is ActPlan => a !== null);
}

export function parseSkeleton(text: string): Skeleton | null {
  const o = extractJsonObject(text);
  if (!o) return null;
  // 兜底：模型漏写 worldBible 的 `}` 时，acts 会被错误嵌进 worldBible 里，深度查找找回。
  const acts = parseActList(Array.isArray(o.acts) ? o.acts : findArrayField(o, "acts"));
  if (acts.length === 0) return null;
  return {
    title: str(o.title) || "无名武侠",
    premise: str(o.premise),
    logline: str(o.logline),
    throughline: str(o.throughline),
    ending: str(o.ending),
    worldBible: parseWorldBibleObj(o.worldBible as Record<string, unknown>),
    acts,
  };
}

/** 归一化用于去重比对：转小写、去掉所有空白与标点，只留下可比对的实义字符。 */
function normalizeForDedup(s: string): string {
  return (s ?? "").toLowerCase().replace(/[\s\p{P}\p{S}]/gu, "");
}

/**
 * 兜底去重：同一次 {@link Planner.expandAct} 结果内，标题或目标（归一化后）与在前某章
 * 重复的，直接剔除，保留首现、顺序不变。纯函数。
 *
 * 用于防止分批展开时模型「重启本幕」——把「受辱→出走」整条弧线换个说法再演一遍
 * （连章名都撞）。这是 prompt 层「禁重启铁律」之外的最后一道确定性兜底。
 */
export function dropDuplicateChapters(chapters: ChapterPlan[]): ChapterPlan[] {
  const seenTitles = new Set<string>();
  const seenGoals = new Set<string>();
  const out: ChapterPlan[] = [];
  for (const c of chapters) {
    const t = normalizeForDedup(c.title);
    const g = normalizeForDedup(c.goal);
    if ((t && seenTitles.has(t)) || (g && seenGoals.has(g))) continue;
    if (t) seenTitles.add(t);
    if (g) seenGoals.add(g);
    out.push(c);
  }
  return out;
}

/** 阶段标签：4 章以内用「起承转合」，更多则回落到「第N段」，始终两两不同。 */
function phaseLabels(n: number): string[] {
  const base = ["起", "承", "转", "合"];
  if (n <= base.length) return base.slice(0, n);
  return Array.from({ length: n }, (_, i) => `第${i + 1}段`);
}

/**
 * 占位兜底章（某幕 LLM 细化彻底失败时的最后退路）。
 *
 * 【铁律】绝不生成「逐字相同」的多章——那会把递进/无重复评分直接打到谷底
 * （历史上一整幕塌陷成 `幕名·1/2/3` 三条一字不差的章，正是评测 12 分的元凶）。
 * 这里用阶段标签把幕摘要切成【彼此不同】的阶段性目标，既保住章数，
 * 又保证各章目标互不相同（能被 {@link dropDuplicateChapters} 保留）。纯函数。
 */
export function buildPlaceholderChapters(act: ActPlan, total: number): ChapterPlan[] {
  const n = Math.max(1, total);
  if (n === 1) {
    return [{ n: 1, title: act.title, goal: act.summary, status: "planned" }];
  }
  const labels = phaseLabels(n);
  return Array.from({ length: n }, (_, i) => ({
    n: i + 1,
    title: `${act.title}·${labels[i]}`,
    goal: `【本幕${labels[i]}·第${i + 1}/${n}段】${act.summary}`,
    status: "planned" as const,
  }));
}

/** 把各幕的计划章数按比例缩放，使其总和恰好等于目标章数；每幕至少 1 章。 */
export function normalizeActCounts(acts: ActPlan[], target: number): ActPlan[] {
  if (acts.length === 0) return acts;
  // 原始计数：非法/缺失按平均分配。
  const raw = acts.map((a) => (a.chapters > 0 ? a.chapters : 0));
  let sum = raw.reduce((x, y) => x + y, 0);
  let counts: number[];
  if (sum === 0) {
    const base = Math.floor(target / acts.length);
    counts = acts.map(() => Math.max(1, base));
  } else {
    counts = raw.map((c) => Math.max(1, Math.round((c * target) / sum)));
  }
  // 修正舍入漂移，使总和 == target；每幕不低于 1。
  let drift = target - counts.reduce((x, y) => x + y, 0);
  let guard = 0;
  while (drift !== 0 && guard++ < 1000) {
    if (drift > 0) {
      // 加到当前最小的幕上，保持均衡。
      let idx = 0;
      for (let i = 1; i < counts.length; i++) if (counts[i]! < counts[idx]!) idx = i;
      counts[idx]!++;
      drift--;
    } else {
      // 从当前最大的幕上减，且不低于 1。
      let idx = -1;
      for (let i = 0; i < counts.length; i++) {
        if (counts[i]! > 1 && (idx === -1 || counts[i]! > counts[idx]!)) idx = i;
      }
      if (idx === -1) break;
      counts[idx]!--;
      drift++;
    }
  }
  return acts.map((a, i) => ({ ...a, chapters: counts[i]! }));
}

export class Planner {
  constructor(private readonly client: LLMClient) {}

  /**
   * 据一句前提，生成整书大纲 + 初始世界观圣经。
   *
   * 采用【分批/分层】规划，避免一次性生成几十章被 max_tokens 截断：
   *   1) 主干幕：一次调用产出书本级 canon（书名/主线/结局/世界圣经）+ 若干"幕"骨架；
   *   2) 逐幕细化：【串行】展开每一幕，并把【上一幕实际生成的末尾 1-2 章】作为承接锚点
   *      喂给下一幕（铁律"首章紧接其后、不得重演"），消除幕间接缝重复；
   *   3) 拼接重排章号，组装成完整 Outline。
   * 任何一步失败都有兜底：骨架失败 → 回退单次整体生成；某幕细化失败 → 用该幕摘要生成占位章。
   */
  async createOutline(
    seed: string,
    chapterHint = DEFAULT_CHAPTER_HINT,
    genre: GenreSpec = DEFAULT_GENRE,
    options: CreateOutlineOptions = {},
  ): Promise<OutlineResult> {
    const target = parseTargetChapters(chapterHint);
    // 每幕约 5 章，钳制在 3~8 幕，避免幕过多或每幕过长。
    const actCount = Math.max(3, Math.min(8, Math.round(target / 5)));

    // 断点续规划：若给了有效快照，复用其 skeleton 与已展开的章，从 actsDone 幕接着展开。
    const resume =
      options.resume && options.resume.skeleton.acts.length > 0 ? options.resume : undefined;

    let skeleton: Skeleton;
    let acts: ActPlan[];
    let chapters: ChapterPlan[];
    let startAct: number;

    if (resume) {
      skeleton = resume.skeleton;
      acts = skeleton.acts; // 快照里的 acts 已归一，直接复用
      chapters = resume.chapters.map((c, i) => ({ ...c, n: i + 1, status: "planned" as const }));
      startAct = Math.min(resume.actsDone, acts.length);
      console.log(
        `\x1b[36m[规划] 断点续规划《${skeleton.title}》：已展开 ${startAct}/${acts.length} 幕、` +
          `${chapters.length} 章，从第 ${startAct + 1} 幕接着展开…\x1b[0m`,
      );
    } else {
      const fresh = await this.planSkeleton(seed, target, actCount, genre);
      if (!fresh) {
        console.error("\x1b[31m[规划] 主干骨架生成失败，回退到单次整体规划。\x1b[0m");
        return this.singleCallOutline(seed, chapterHint, genre);
      }
      // 把归一后的 acts 固化进 skeleton，保证续规划时幕划分与本次完全一致。
      acts = normalizeActCounts(fresh.acts, target);
      skeleton = { ...fresh, acts };
      chapters = [];
      startAct = 0;
      console.log(
        `\x1b[36m[规划] 骨架已成《${skeleton.title}》：${acts.length} 幕、共 ${target} 章，开始逐幕细化（串行承接）…\x1b[0m`,
      );
      // 先落一次骨架快照：即便第 1 幕就崩，重跑也能省下重新出骨架的开销。
      await options.onProgress?.({ skeleton, actsDone: 0, chapters: [] });
    }

    // 逐幕【串行】细化：把已展开的上一幕末尾数章作承接锚点传给下一幕，杜绝接缝重复。
    // 【容错铁律】任一幕细化即便整幕抛错（理论上 expandAct 已内部吞错，这里再兜一层），
    // 也只用占位章顶替【该幕】，绝不让已完成的前几幕付诸东流——保证整本一定跑完并落盘。
    for (let i = startAct; i < acts.length; i++) {
      const prevTail = chapters.slice(-2);
      let list: ChapterPlan[];
      try {
        list = await this.expandAct(skeleton, acts, i, prevTail, genre);
      } catch (err) {
        console.error(
          `\x1b[31m[规划] 第 ${i + 1}/${acts.length} 幕《${acts[i]!.title}》细化抛错，改用占位章顶替本幕：` +
            `${err instanceof Error ? err.message : String(err)}\x1b[0m`,
        );
        list = buildPlaceholderChapters(acts[i]!, acts[i]!.chapters);
      }
      for (const c of list) chapters.push({ ...c, n: chapters.length + 1, status: "planned" });
      // 每展开完一幕就落盘快照——这是断点续规划的关键：崩了/超时了重跑就从这里接着来。
      await options.onProgress?.({ skeleton, actsDone: i + 1, chapters });
      console.log(
        `\x1b[36m[规划] 第 ${i + 1}/${acts.length} 幕《${acts[i]!.title}》已细化（累计 ${chapters.length} 章）。\x1b[0m`,
      );
    }
    if (chapters.length === 0) {
      console.error("\x1b[31m[规划] 逐幕细化全部失败，回退到单次整体规划。\x1b[0m");
      return this.singleCallOutline(seed, chapterHint);
    }

    // 全局兜底去重：expandAct 只在【幕内】去重，这里再跨幕兜一道，
    // 杜绝任何逐字重复章（含接缝重复/占位塌陷）漏进成品，去重后重排章号。
    const deduped = dropDuplicateChapters(chapters);
    if (deduped.length < chapters.length) {
      console.error(
        `\x1b[33m[规划] 跨幕检出并剔除 ${chapters.length - deduped.length} 章重复。\x1b[0m`,
      );
    }
    chapters = deduped.map((c, i) => ({ ...c, n: i + 1 }));

    console.log(`\x1b[36m[规划] 细化完成：实际 ${chapters.length} 章。\x1b[0m`);
    const outline: Outline = {
      premise: skeleton.premise || seed,
      logline: skeleton.logline,
      throughline: skeleton.throughline,
      ending: skeleton.ending,
      chapters,
    };
    return { title: skeleton.title, outline, worldBible: skeleton.worldBible };
  }

  /**
   * 分卷滚动开书：出【书本级 canon + 分卷路线图】，但只展开【第一卷】的分章。
   *
   * 与 {@link createOutline}（整书一次性展开）相对：长篇（数百章）用它，避免开局就把
   * 全书几百章硬展开——那样又慢又贵，还会因一次抖动前功尽弃。后续卷由写作流程在
   * 各卷写完时按需展开（见 NovelEngine.expandNextArc）。
   *
   * 返回的 Outline 为 rolling 形态：chapters 只含第一卷，arcs 为完整分卷路线图。
   */
  async createRollingOutline(
    seed: string,
    chapterHint = DEFAULT_CHAPTER_HINT,
    genre: GenreSpec = DEFAULT_GENRE,
  ): Promise<OutlineResult> {
    const target = parseTargetChapters(chapterHint);
    const roadmap = await this.planRoadmap(seed, target, genre);
    if (!roadmap || roadmap.acts.length === 0) {
      console.error("\x1b[31m[规划] 分卷路线图生成失败，回退到整书一次性规划。\x1b[0m");
      return this.createOutline(seed, chapterHint, genre);
    }

    const acts = normalizeActCounts(roadmap.acts, target);
    const skeleton: Skeleton = { ...roadmap, acts };
    console.log(
      `\x1b[36m[规划] 路线图已成《${skeleton.title}》：${acts.length} 卷、共 ${target} 章，仅展开第 1 卷…\x1b[0m`,
    );

    let firstArc: ChapterPlan[];
    try {
      firstArc = await this.expandAct(skeleton, acts, 0, [], genre);
    } catch (err) {
      console.error(
        `\x1b[31m[规划] 第 1 卷展开抛错，改用占位章顶替：` +
          `${err instanceof Error ? err.message : String(err)}\x1b[0m`,
      );
      firstArc = buildPlaceholderChapters(acts[0]!, acts[0]!.chapters);
    }
    const chapters: ChapterPlan[] = firstArc.map((c, i) => ({
      ...c,
      n: i + 1,
      status: "planned" as const,
      arc: 1,
    }));

    const arcs: ArcPlan[] = acts.map((a, i) => ({
      n: i + 1,
      title: a.title,
      summary: a.summary,
      chapters: a.chapters,
      status: i === 0 ? "active" : "planned",
    }));

    const outline: Outline = {
      premise: skeleton.premise || seed,
      logline: skeleton.logline,
      throughline: skeleton.throughline,
      ending: skeleton.ending,
      chapters,
      mode: "rolling",
      arcs,
      currentArc: 1,
      targetChapters: target,
    };
    return { title: skeleton.title, outline, worldBible: skeleton.worldBible };
  }

  /**
   * 分卷滚动模式的第 1 步：一次性生成【书本级 canon + 分卷路线图】（只到卷级，不细化分章）。
   * 卷数按目标章数 / 每卷约 24 章估算，钳制在 [4,24] 卷，支撑数百章长篇连载。
   * 返回的 acts 即"卷"列表（章数由 normalizeActCounts 归一到目标总章数）。
   */
  async planRoadmap(
    seed: string,
    target: number,
    genre: GenreSpec = DEFAULT_GENRE,
  ): Promise<Skeleton | null> {
    const CHAPTERS_PER_ARC = 24;
    const arcCount = Math.max(4, Math.min(24, Math.round(target / CHAPTERS_PER_ARC)));
    return this.planSkeleton(seed, target, arcCount, genre);
  }

  /**
   * 分卷滚动的【自适应】：在展开下一卷【之前】，据故事实际走向修订【尚未展开的后续卷】路线图。
   *
   * 这是"showrunner 级"编排（每卷仅一次、有界、便宜），区别于场景导演的逐拍决策：
   * 只重排后续卷（不动已写卷），可增删/合并/调整后续卷与结局方向，让路线图跟着实际剧情走、
   * 并收敛向结局。解析失败/空则返回 null，交上层沿用原路线图（安全无副作用）。
   */
  async reviseRoadmap(input: {
    title: string;
    throughline: string;
    ending: string;
    worldBible: WorldBible;
    /** 已完成/当前卷（只读，供承接对齐）。 */
    doneArcs: ActPlan[];
    /** 尚未展开的后续卷（待修订）。 */
    remainingArcs: ActPlan[];
    /** 故事记忆摘要（主角/近况/各卷综述/未回收伏笔/进度锚点）。 */
    memoryNote: string;
    /** 剩余章预算（后续卷章数之和应约等于它）。 */
    remainingChapters: number;
    genre?: GenreSpec;
  }): Promise<{ ending: string; arcs: ActPlan[] } | null> {
    const genre = input.genre ?? DEFAULT_GENRE;
    if (input.remainingArcs.length === 0) return null;

    const system = [
      `你是这部${genre.persona}长篇连载的总编（showrunner）。前面若干卷已经写完，现在要据【故事实际走向】修订【尚未展开的后续卷】的分卷路线图。`,
      "要求：",
      "- 只重排【后续尚未展开的卷】；不要改写已完成的卷，但要与其自然承接。",
      "- 每一卷都要带来新的推进，指向结局；可增删/合并后续卷、调整各卷主旨与章数、并可微调结局方向。",
      `- 后续卷章数之和应约等于剩余章预算 ${input.remainingChapters} 章；要收敛向结局，不要无限拉长。`,
      `- 【题材设定铁律】${genre.worldGuidance}`,
      "只输出一个 JSON 对象：",
      '{"ending":"（可微调的）结局方向","arcs":[{"title":"卷名","summary":"本卷主旨与目标","chapters":整数}]}',
      JSON_QUOTE_RULE,
      "其中 arcs 只含【后续尚未展开】的卷。不要输出 JSON 以外的任何文字。",
    ].join("\n");

    const user = [
      `【书名】${input.title}`,
      `【全书主线】${input.throughline}`,
      `【结局方向】${input.ending}`,
      `【世界设定要点】\n${renderWorldBrief(input.worldBible)}`,
      input.memoryNote ? `【故事实况（据此修订，勿与既有事实矛盾）】\n${input.memoryNote}` : "",
      `【已完成的卷（勿改，仅供承接）】\n${
        input.doneArcs.map((a, i) => `第${i + 1}卷《${a.title}》：${a.summary}`).join("\n") || "（无）"
      }`,
      `【原定后续卷】\n${input.remainingArcs
        .map((a, i) => `后续第${i + 1}卷《${a.title}》（约${a.chapters}章）：${a.summary}`)
        .join("\n")}`,
      `请输出修订后的【后续卷】路线图 JSON（章数之和约 ${input.remainingChapters}）。`,
    ]
      .filter(Boolean)
      .join("\n\n");

    for (let attempt = 1; attempt <= 2; attempt++) {
      let content: string | null;
      try {
        ({
          message: { content },
        } = await this.client.chat({
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
          temperature: 0.8,
          maxTokens: 4000,
        }));
      } catch (err) {
        console.error(
          `\x1b[31m[规划] 路线图修订 chat 失败（尝试 ${attempt}/2）：${err instanceof Error ? err.message : String(err)}\x1b[0m`,
        );
        continue;
      }
      const o = extractJsonObject(content ?? "");
      const arcs = parseActList(o?.arcs ?? o?.acts);
      if (arcs.length > 0) {
        return { ending: str(o?.ending) || input.ending, arcs };
      }
    }
    return null;
  }

  /** 第 1 步：生成主干骨架（书本级 canon + 幕列表）。失败重试一次，仍失败返回 null。 */
  private async planSkeleton(
    seed: string,
    target: number,
    actCount: number,
    genre: GenreSpec = DEFAULT_GENRE,
  ): Promise<Skeleton | null> {
    const system = [
      `你是一位资深${genre.persona}主编，为一部长篇${genre.persona}做【顶层策划】。此步只搭主干骨架，不细化到每一章。`,
      "根据用户给的一句前提，产出：书名、前提、一句话主线(logline)、贯穿全书的主要冲突(throughline)、结局方向、一套【世界观圣经】(worldBible)，",
      `以及把全书切分为约 ${actCount} 个【幕 act】的骨架，各幕合计约 ${target} 章。`,
      "要求：",
      "- 每一幕给出【幕名 title】【本幕主要剧情与目标 summary（2-4 句，交代这一幕从何处起、要达成什么、推进到何处）】【本幕计划章数 chapters（整数）】。",
      `- 所有幕的 chapters 之和应约等于 ${target}。各幕要环环相扣、层层推进，指向结局；避免各幕孤立或原地打转。`,
      PREMISE_FIDELITY_RULE,
      `- 【题材设定铁律】${genre.worldGuidance}`,
      "- 【命名与不剧透铁律】书名、幕名都不得直接泄露某个需要长期隐藏的身份或结局关键真名；" +
        "也不要用「无名客／神秘人／无名少年」这类占位式名号。若主角身份是核心悬念，请用中性、贴合其当下处境的化名或意象来命名，把真相留到剧情自然揭晓。",
      BOOK_TITLE_RULE,
      "- 世界观圣经要具体：时代基调、重要地点、势力组织、力量体系/规则、关键信物、其它设定，且都要贴合上述题材。",
      "只输出一个 JSON 对象：",
      '{"title":"书名","premise":"前提","logline":"一句话主线","throughline":"贯穿冲突","ending":"结局方向",',
      '"worldBible":{"era":"时代基调","tone":"风格基调","locations":["地点"],"factions":["势力组织"],"powerSystem":["力量体系/规则"],"items":["关键信物"],"lore":["其它设定"]},',
      '"acts":[{"title":"幕名","summary":"本幕主要剧情与目标","chapters":5}]}',
      JSON_QUOTE_RULE,
      "不要输出 JSON 以外的任何文字。",
    ].join("\n");
    const messages = [
      { role: "system" as const, content: system },
      { role: "user" as const, content: `前提：${seed}` },
    ];
    for (let attempt = 1; attempt <= 2; attempt++) {
      const { message, finishReason } = await this.client.chat({
        messages,
        temperature: 0.85,
        maxTokens: 6000,
      });
      const skeleton = parseSkeleton(message.content ?? "");
      if (skeleton) return skeleton;
      console.error(
        `\x1b[31m[规划] 骨架解析失败（第 ${attempt}/2 次，finish_reason=${finishReason}，` +
          `内容 ${message.content?.length ?? 0} 字）。\x1b[0m`,
      );
    }
    return null;
  }

  /**
   * 第 2 步：把某一幕/卷细化成它名下的若干章。
   *
   * 章数较多时（如分卷滚动模式一卷 20+ 章），一次性生成大 JSON 容易解析失败/截断；
   * 这里把整幕【分批】展开（每批 ≤ {@link MAX_CHAPTERS_PER_BATCH} 章），批间用上一批末章
   * 承接，只有【最后一批】才收束本幕/搭桥下一幕。任一批失败仅影响该批，最终仍不为空则返回；
   * 全部失败才退回占位章，保证章数不塌陷。
   *
   * prevTail 是【上一幕/批已实际生成的末尾数章】，作为承接锚点，杜绝接缝重复。
   */
  async expandAct(
    skeleton: Skeleton,
    acts: ActPlan[],
    index: number,
    prevTail: ChapterPlan[] = [],
    genre: GenreSpec = DEFAULT_GENRE,
    memoryNote?: string,
  ): Promise<ChapterPlan[]> {
    const act = acts[index]!;
    const total = act.chapters;
    const chapters: ChapterPlan[] = [];
    let produced = 0;
    const batches = Math.max(1, Math.ceil(total / MAX_CHAPTERS_PER_BATCH));

    for (let b = 0; b < batches; b++) {
      const remaining = total - produced;
      if (remaining <= 0) break;
      const cnt = Math.min(MAX_CHAPTERS_PER_BATCH, remaining);
      const isFinalBatch = b === batches - 1;
      const list = await this.expandActBatch(
        skeleton,
        acts,
        index,
        prevTail,
        chapters, // 本幕已细化的【全部】章，用于禁止重启本幕（不再只给末尾 2 章）
        total,
        produced,
        genre,
        memoryNote,
        cnt,
        isFinalBatch,
      );
      if (list.length === 0) {
        console.error(
          `\x1b[31m[规划] 第 ${index + 1} 幕《${act.title}》第 ${b + 1}/${batches} 批细化失败。\x1b[0m`,
        );
        continue;
      }
      for (const c of list) chapters.push(c);
      produced += list.length;
    }

    // 确定性兜底去重：即便 prompt 铁律失守，也把重启本幕造成的重复章剔掉。
    if (chapters.length > 0) {
      const deduped = dropDuplicateChapters(chapters);
      if (deduped.length < chapters.length) {
        console.error(
          `\x1b[33m[规划] 第 ${index + 1} 幕《${act.title}》检出并剔除 ${chapters.length - deduped.length} 章重复。\x1b[0m`,
        );
      }
      return deduped;
    }

    // 兜底：全部批次都失败，用幕摘要生成【阶段性互不相同】的占位章，
    // 既保住章数、又绝不逐字重复（见 buildPlaceholderChapters 的铁律说明）。
    console.error(`\x1b[31m[规划] 第 ${index + 1} 幕《${act.title}》改用占位章兜底。\x1b[0m`);
    return buildPlaceholderChapters(act, total);
  }

  /**
   * 展开某一幕的一批分章（≤ MAX 章）；失败重试一次，仍失败返回空数组交上层处理。
   *
   * 关键：把【本幕已细化的全部章】(producedInAct) 连同进度 (total/produced) 一起喂给模型，
   * 并明确「本批只写第 X–Y 章、须紧接已细化章节继续、严禁重启本幕」，杜绝第 2 批把整幕弧线
   * 换个说法重演一遍的连续性硬伤。prevTail 仅作【跨幕接缝】的承接锚点（上一幕末尾数章）。
   */
  private async expandActBatch(
    skeleton: Skeleton,
    acts: ActPlan[],
    index: number,
    prevTail: ChapterPlan[],
    producedInAct: ChapterPlan[],
    total: number,
    produced: number,
    genre: GenreSpec,
    memoryNote: string | undefined,
    count: number,
    isFinalBatch: boolean,
  ): Promise<ChapterPlan[]> {
    const act = acts[index]!;
    const prev = acts[index - 1];
    const next = acts[index + 1];

    // 跨幕接缝锚点：上一幕末尾数章（仅第一批、且本幕尚无已细化章时才有承接意义）。
    const seamText = prevTail
      .map((c) => `第${c.n}章《${c.title}》：${c.goal}`)
      .join("\n");
    // 本幕已细化的全部章（幕内本地编号），用于禁止重启本幕、禁止重复情节与标题。
    const producedText = producedInAct
      .map((c, i) => `第${i + 1}章《${c.title}》：${c.goal}`)
      .join("\n");

    const from = produced + 1;
    const to = produced + count;
    const progressLine =
      `本幕共 ${total} 章；已细化前 ${produced} 章（见【本幕已细化章节】）；` +
      `本批只写第 ${from}–${to} 章（恰好 ${count} 章）。`;

    const endingRule = !isFinalBatch
      ? "- 本批只是本幕的一部分，【不要收束本幕】；末章自然留白，把后续推进留给下一批。"
      : next
        ? "- 本批为本幕收尾，末章要为下一幕自然搭桥，但【不要替下一幕把事做完】——把下一幕的核心情节留给下一幕。"
        : "- 本幕为收官，末章要收束全书、呼应结局方向。";

    const continuityRule = producedText
      ? "- 【禁重启铁律】上面【本幕已细化章节】里的情节已经发生过。你写的第 " +
        from +
        " 章必须【紧接第 " +
        produced +
        " 章的结尾继续往后推进】，严禁重启本幕、严禁把这些情节（受辱、出走、托孤、成婚、削发、被逐等只能发生一次的事件）换个说法再演一遍，也严禁重复其章节标题。"
      : seamText
        ? "- 【承接铁律】下面会给出【上一幕末尾】。你的第一章必须【紧接其后】继续推进，绝不能重写、复述或换个说法再演一遍这些已发生的情节。"
        : "- 本幕为开篇，第一章直接切入起势。";

    const system = [
      `你是这部${genre.persona}长篇的主编，正在把一部书里的【某一幕】细化成具体分章。`,
      progressLine,
      `每章给出【标题 title】与【本章目标 goal】（这一章要推进的核心事件/冲突/转折），并给 2-3 条关键节拍 keyBeats。`,
      "要求：",
      "- 各章环环相扣、逐步推进本幕目标，并与全书主线一致；不要原地打转、不要与相邻幕/相邻章重复。",
      continuityRule,
      endingRule,
      "- 章节标题只写一个有味道的短语（如“血溅寒炉”），不要加“第X章/第X回”之类编号前缀（全书会统一重排章号）。",
      "- 【命名铁律】标题与目标里若涉及某个身份待揭晓的主角，用其化名或中性称呼指代，不得泄露真实姓名；也不要用「无名客／神秘人」这类占位式称呼。",
      JSON_QUOTE_RULE,
      `只输出一个 JSON 对象：{"chapters":[{"title":"章节标题","goal":"本章目标","keyBeats":["关键节拍"]}]}，其中恰好 ${count} 章。`,
      "不要输出 JSON 以外的任何文字。",
    ].join("\n");
    const user = [
      `【书名】${skeleton.title}`,
      `【全书主线】${skeleton.throughline}`,
      `【结局方向】${skeleton.ending}`,
      `【世界设定要点】\n${renderWorldBrief(skeleton.worldBible)}`,
      prev ? `【上一幕】《${prev.title}》：${prev.summary}` : "【上一幕】（本幕为开篇）",
      memoryNote ? `【前情记忆（据此承接，勿与既有事实矛盾、勿重演已发生情节）】\n${memoryNote}` : "",
      producedText
        ? `【本幕已细化章节（禁止重启、禁止重复其情节与标题，须紧接其后继续）】\n${producedText}`
        : seamText
          ? `【上一幕末尾（你的首章须紧接其后，不得重演）】\n${seamText}`
          : "",
      `【本幕（第 ${index + 1} 幕，共 ${acts.length} 幕）】《${act.title}》：${act.summary}`,
      next ? `【下一幕（勿越俎代庖）】《${next.title}》：${next.summary}` : "【下一幕】（本幕为收官）",
      `请生成第 ${from}–${to} 章、恰好 ${count} 章的 JSON。`,
    ]
      .filter(Boolean)
      .join("\n\n");
    const messages = [
      { role: "system" as const, content: system },
      { role: "user" as const, content: user },
    ];
    // 细化失败会退到占位兜底（质量骤降），故多给几次重试压低失败率。
    // 【容错铁律】单批的任何异常（超时/非瞬时错误/解析失败）都【就地吞掉】，
    // 绝不向上抛——否则一次抖动会连累整本已生成的幕全部丢弃、连落盘都做不到。
    for (let attempt = 1; attempt <= 3; attempt++) {
      // 逐次抬高 token 预算，避免每章预算压线导致 JSON 被截断（finish_reason=length）。
      const maxTokens = Math.min(8000, count * (500 + attempt * 200) + 2000);
      let message: Message;
      let finishReason: string | null;
      try {
        ({ message, finishReason } = await this.client.chat({
          messages,
          temperature: 0.82,
          maxTokens,
        }));
      } catch (err) {
        console.error(
          `\x1b[31m[规划] 第 ${index + 1} 幕《${act.title}》第 ${from}–${to} 章 chat 失败` +
            `（尝试 ${attempt}/3）：${err instanceof Error ? err.message : String(err)}\x1b[0m`,
        );
        continue;
      }
      const o = extractJsonObject(message.content ?? "");
      const chapters = parseChapterPlans(o?.chapters);
      if (chapters.length > 0) return chapters;
      // 解析不出章节：把 finish_reason 与内容规模打出来，便于定位是截断还是格式问题。
      const content = message.content ?? "";
      console.error(
        `\x1b[33m[规划] 第 ${index + 1} 幕《${act.title}》第 ${from}–${to} 章解析失败` +
          `（尝试 ${attempt}/3，finish_reason=${finishReason}，内容 ${content.length} 字，` +
          `max_tokens=${maxTokens}）：${content.slice(0, 120).replace(/\n/g, " ")}…\x1b[0m`,
      );
    }
    return [];
  }

  /** 兜底：老式单次整体规划（骨架/细化失败时使用）。给足 token 并重试一次。 */
  private async singleCallOutline(
    seed: string,
    chapterHint: string,
    genre: GenreSpec = DEFAULT_GENRE,
  ): Promise<OutlineResult> {
    const system = [
      `你是一位资深${genre.persona}主编，负责为一部长篇${genre.persona}做整体策划。`,
      "根据用户给的一句前提，产出：书名、前提、一句话主线(logline)、贯穿全书的主要冲突(throughline)、结局方向，",
      "一套【世界观圣经】(worldBible)，以及一份【分章大纲】(chapters)。",
      "要求：",
      `- 分章 ${chapterHint}，每章给出【标题】与【本章目标 goal】（这一章要推进的核心事件/冲突/转折），可给 2-3 条关键节拍 keyBeats。`,
      "- 各章要环环相扣、层层推进，指向结局；避免各章孤立。",
      PREMISE_FIDELITY_RULE,
      `- 【题材设定铁律】${genre.worldGuidance}`,
      "- 【命名与不剧透铁律】书名、幕名都不得直接泄露某个需要长期隐藏的身份或结局关键真名；" +
        "也不要用「无名客／神秘人／无名少年」这类占位式名号。若主角身份是核心悬念，请用中性、贴合其当下处境的化名或意象来命名，把真相留到剧情自然揭晓。",
      BOOK_TITLE_RULE,
      "- 世界观圣经要具体：时代基调、重要地点、势力组织、力量体系/规则、关键信物、其它设定，且都要贴合上述题材。",
      "只输出一个 JSON 对象：",
      '{"title":"书名","premise":"前提","logline":"一句话主线","throughline":"贯穿冲突","ending":"结局方向",',
      '"worldBible":{"era":"时代基调","tone":"风格基调","locations":["地点"],"factions":["势力组织"],"powerSystem":["力量体系/规则"],"items":["关键信物"],"lore":["其它设定"]},',
      '"chapters":[{"title":"章节标题","goal":"本章目标","keyBeats":["关键节拍"]}]}',
      JSON_QUOTE_RULE,
      "不要输出 JSON 以外的任何文字。",
    ].join("\n");
    const messages = [
      { role: "system" as const, content: system },
      { role: "user" as const, content: `前提：${seed}` },
    ];
    for (let attempt = 1; attempt <= 2; attempt++) {
      const { message } = await this.client.chat({ messages, temperature: 0.85, maxTokens: 8000 });
      const parsed = parseOutline(message.content ?? "");
      if (parsed) return parsed;
    }
    return {
      title: `无名${genre.label}`,
      outline: {
        premise: seed,
        logline: seed,
        throughline: "",
        ending: "",
        chapters: [{ n: 1, title: "第一章", goal: seed, status: "planned" }],
      },
      worldBible: parseWorldBibleObj(null),
    };
  }

  /**
   * 写完一章后修订后续。保留已写(written)章节不动，只重排"尚未写"的章节目标，
   * 可微调结局方向。返回新的 Outline（章号重排）。
   */
  async reviseOutline(
    outline: Outline,
    memory: StoryMemory,
    genre: GenreSpec = DEFAULT_GENRE,
  ): Promise<Outline> {
    const written = outline.chapters.filter((c) => c.status === "written");
    const planned = outline.chapters.filter((c) => c.status !== "written");
    // 没有待写章节则无需修订。
    if (planned.length === 0) return outline;

    const protagonist = protagonistOf(memory);
    const system = [
      `你是这部${genre.persona}长篇的主编。已经写完了若干章，现在根据【故事实际走向】修订后续尚未写的章节大纲。`,
      "要求（对账铁律，防止原地打转）：",
      "- 只规划后续尚未写的章节；不要重写、不要重排已写章节。",
      "- 【严禁重复】已在【已发生大事】里发生过的情节/对峙；每一章都必须带来【新的推进点】。",
      "- 【多数情况下每章要换地点/换局面】：不要让后续几章停在同一地点把同一场戏反复演。",
      protagonist
        ? `- 以主角【${protagonist.name}】为中心：每章目标都要推进其成长弧线与主线追求，而非发散成群像混战。`
        : "- 保持主线聚焦，不要发散成无关支线。",
      "- 依据已发生的事实、未回收的伏笔与主线，让后续章节顺理成章地推进到结局。",
      "- 可增删/调整后续章节，可微调结局方向；但后续章节总数要收敛（指向结局，不要无限拉长）。",
      "只输出一个 JSON 对象：",
      '{"ending":"（可微调的）结局方向","chapters":[{"title":"章节标题","goal":"本章目标","keyBeats":["关键节拍"]}]}',
      JSON_QUOTE_RULE,
      "其中 chapters 只含【后续尚未写】的章节。不要输出 JSON 以外的任何文字。",
    ].join("\n");

    const user = [
      `【主线】${outline.throughline}`,
      `【结局方向】${outline.ending}`,
      protagonist ? `【主角】${protagonist.name}（${protagonist.identity}）` : "",
      `【已写章节】\n${written.map((c) => `第${c.n}章《${c.title}》：${c.goal}`).join("\n") || "（无）"}`,
      `【已发生大事（勿在后续重复）】\n${renderEventsRecap(memory.events, 12) || "（无）"}`,
      memory.currentLocation ? `【当前进度锚点】${memory.currentLocation}` : "",
      `【故事梗概至今】\n${memory.rollingSummary || "（无）"}`,
      `【未回收伏笔】\n${renderOpenThreads(memory.threads)}`,
      `【世界设定要点】\n${renderWorldBrief(memory.worldBible)}`,
      `【原定后续章节】\n${planned.map((c) => `《${c.title}》：${c.goal}`).join("\n")}`,
      "请输出修订后的后续章节 JSON。",
    ]
      .filter(Boolean)
      .join("\n\n");

    const { message } = await this.client.chat({
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0.8,
      maxTokens: 8000,
    });

    const o = extractJsonObject(message.content ?? "");
    const revisedPlans = parseChapterPlans(o?.chapters);
    // 解析失败则保留原后续，避免把大纲改没了。
    const tail = revisedPlans.length > 0 ? revisedPlans : planned.map((c) => ({ ...c }));

    const ending = str(o?.ending) || outline.ending;
    const merged: ChapterPlan[] = [...written];
    for (const p of tail) {
      merged.push({ ...p, n: merged.length + 1, status: "planned" });
    }
    return { ...outline, ending, chapters: merged };
  }
}
