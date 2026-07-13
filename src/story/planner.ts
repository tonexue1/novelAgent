import type { LLMClient } from "../core/llm/client.ts";
import { extractJsonObject, str, strArray } from "../core/json.ts";
import {
  renderWorldBrief,
  renderOpenThreads,
  renderEventsRecap,
  protagonistOf,
} from "./memory.ts";
import type {
  Outline,
  ChapterPlan,
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

export interface OutlineResult {
  title: string;
  outline: Outline;
  worldBible: WorldBible;
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

  const chapters = parseChapterPlans(o.chapters);
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
export function parseSkeleton(text: string): Skeleton | null {
  const o = extractJsonObject(text);
  if (!o) return null;
  const acts: ActPlan[] = Array.isArray(o.acts)
    ? o.acts
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
        .filter((a): a is ActPlan => a !== null)
    : [];
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
  ): Promise<OutlineResult> {
    const target = parseTargetChapters(chapterHint);
    // 每幕约 5 章，钳制在 3~8 幕，避免幕过多或每幕过长。
    const actCount = Math.max(3, Math.min(8, Math.round(target / 5)));

    const skeleton = await this.planSkeleton(seed, target, actCount, genre);
    if (!skeleton) {
      console.error("\x1b[31m[规划] 主干骨架生成失败，回退到单次整体规划。\x1b[0m");
      return this.singleCallOutline(seed, chapterHint, genre);
    }

    const acts = normalizeActCounts(skeleton.acts, target);
    console.log(
      `\x1b[36m[规划] 骨架已成《${skeleton.title}》：${acts.length} 幕、共 ${target} 章，开始逐幕细化（串行承接）…\x1b[0m`,
    );

    // 逐幕【串行】细化：把已展开的上一幕末尾数章作承接锚点传给下一幕，杜绝接缝重复。
    const chapters: ChapterPlan[] = [];
    for (let i = 0; i < acts.length; i++) {
      const prevTail = chapters.slice(-2);
      const list = await this.expandAct(skeleton, acts, i, prevTail, genre);
      for (const c of list) chapters.push({ ...c, n: chapters.length + 1, status: "planned" });
      console.log(
        `\x1b[36m[规划] 第 ${i + 1}/${acts.length} 幕《${acts[i]!.title}》已细化（累计 ${chapters.length} 章）。\x1b[0m`,
      );
    }
    if (chapters.length === 0) {
      console.error("\x1b[31m[规划] 逐幕细化全部失败，回退到单次整体规划。\x1b[0m");
      return this.singleCallOutline(seed, chapterHint);
    }

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
      `- 【题材设定铁律】${genre.worldGuidance}`,
      "- 【命名与不剧透铁律】书名、幕名都不得直接泄露某个需要长期隐藏的身份或结局关键真名；" +
        "也不要用「无名客／神秘人／无名少年」这类占位式名号。若主角身份是核心悬念，请用中性、贴合其当下处境的化名或意象来命名，把真相留到剧情自然揭晓。",
      "- 世界观圣经要具体：时代基调、重要地点、势力组织、力量体系/规则、关键信物、其它设定，且都要贴合上述题材。",
      "只输出一个 JSON 对象：",
      '{"title":"书名","premise":"前提","logline":"一句话主线","throughline":"贯穿冲突","ending":"结局方向",',
      '"worldBible":{"era":"时代基调","tone":"风格基调","locations":["地点"],"factions":["势力组织"],"powerSystem":["力量体系/规则"],"items":["关键信物"],"lore":["其它设定"]},',
      '"acts":[{"title":"幕名","summary":"本幕主要剧情与目标","chapters":5}]}',
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
    let tail = prevTail;
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
        tail,
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
      tail = chapters.slice(-2);
    }

    if (chapters.length > 0) return chapters;

    // 兜底：全部批次都失败，用幕摘要生成占位章，保证章数不塌陷。
    console.error(`\x1b[31m[规划] 第 ${index + 1} 幕《${act.title}》改用占位章兜底。\x1b[0m`);
    return Array.from({ length: total }, (_, i) => ({
      n: i + 1,
      title: `${act.title}·${i + 1}`,
      goal: act.summary,
      status: "planned" as const,
    }));
  }

  /** 展开某一幕的一批分章（≤ MAX 章）；失败重试一次，仍失败返回空数组交上层处理。 */
  private async expandActBatch(
    skeleton: Skeleton,
    acts: ActPlan[],
    index: number,
    prevTail: ChapterPlan[],
    genre: GenreSpec,
    memoryNote: string | undefined,
    count: number,
    isFinalBatch: boolean,
  ): Promise<ChapterPlan[]> {
    const act = acts[index]!;
    const prev = acts[index - 1];
    const next = acts[index + 1];

    const tailText = prevTail
      .map((c) => `第${c.n}章《${c.title}》：${c.goal}`)
      .join("\n");

    const endingRule = !isFinalBatch
      ? "- 本批只是本幕的一部分，【不要收束本幕】；末章自然留白，把后续推进留给下一批。"
      : next
        ? "- 本批为本幕收尾，末章要为下一幕自然搭桥，但【不要替下一幕把事做完】——把下一幕的核心情节留给下一幕。"
        : "- 本幕为收官，末章要收束全书、呼应结局方向。";

    const system = [
      `你是这部${genre.persona}长篇的主编，正在把一部书里的【某一幕】细化成具体分章。`,
      `请生成【恰好 ${count} 章】，每章给出【标题 title】与【本章目标 goal】（这一章要推进的核心事件/冲突/转折），并给 2-3 条关键节拍 keyBeats。`,
      "要求：",
      "- 各章环环相扣、逐步推进本幕目标，并与全书主线一致；不要原地打转、不要与相邻幕/相邻章重复。",
      tailText
        ? "- 【承接铁律】下面会给出【已写章节】。你的第一章必须【紧接其后】继续推进，绝不能重写、复述或换个说法再演一遍这些已发生的情节（例如托孤、出谷、成婚、削发等只能发生一次）。"
        : "- 本幕为开篇，第一章直接切入起势。",
      endingRule,
      "- 章节标题只写一个有味道的短语（如“血溅寒炉”），不要加“第X章/第X回”之类编号前缀（全书会统一重排章号）。",
      "- 【命名铁律】标题与目标里若涉及某个身份待揭晓的主角，用其化名或中性称呼指代，不得泄露真实姓名；也不要用「无名客／神秘人」这类占位式称呼。",
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
      tailText ? `【已写章节（你的首章须紧接其后，不得重演）】\n${tailText}` : "",
      `【本幕（第 ${index + 1} 幕，共 ${acts.length} 幕）】《${act.title}》：${act.summary}`,
      next ? `【下一幕（勿越俎代庖）】《${next.title}》：${next.summary}` : "【下一幕】（本幕为收官）",
      `请生成恰好 ${count} 章的 JSON。`,
    ]
      .filter(Boolean)
      .join("\n\n");
    const messages = [
      { role: "system" as const, content: system },
      { role: "user" as const, content: user },
    ];
    for (let attempt = 1; attempt <= 2; attempt++) {
      const { message } = await this.client.chat({
        messages,
        temperature: 0.82,
        maxTokens: Math.min(8000, count * 400 + 1500),
      });
      const o = extractJsonObject(message.content ?? "");
      const chapters = parseChapterPlans(o?.chapters);
      if (chapters.length > 0) return chapters;
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
      `- 【题材设定铁律】${genre.worldGuidance}`,
      "- 【命名与不剧透铁律】书名、幕名都不得直接泄露某个需要长期隐藏的身份或结局关键真名；" +
        "也不要用「无名客／神秘人／无名少年」这类占位式名号。若主角身份是核心悬念，请用中性、贴合其当下处境的化名或意象来命名，把真相留到剧情自然揭晓。",
      "- 世界观圣经要具体：时代基调、重要地点、势力组织、力量体系/规则、关键信物、其它设定，且都要贴合上述题材。",
      "只输出一个 JSON 对象：",
      '{"title":"书名","premise":"前提","logline":"一句话主线","throughline":"贯穿冲突","ending":"结局方向",',
      '"worldBible":{"era":"时代基调","tone":"风格基调","locations":["地点"],"factions":["势力组织"],"powerSystem":["力量体系/规则"],"items":["关键信物"],"lore":["其它设定"]},',
      '"chapters":[{"title":"章节标题","goal":"本章目标","keyBeats":["关键节拍"]}]}',
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
