import type { LLMClient } from "../core/llm/client.ts";
import { extractJsonObject, str, strArray } from "../core/json.ts";
import { renderWorldBrief, renderOpenThreads } from "./memory.ts";
import type {
  Outline,
  ChapterPlan,
  WorldBible,
  StoryMemory,
} from "./types.ts";

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
      title: str(o.title) || `第${plans.length + 1}章`,
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

export class Planner {
  constructor(private readonly client: LLMClient) {}

  /** 据一句前提，生成整书大纲 + 初始世界观圣经。 */
  async createOutline(seed: string, chapterHint = DEFAULT_CHAPTER_HINT): Promise<OutlineResult> {
    const system = [
      "你是一位资深武侠小说主编，负责为一部长篇武侠小说做整体策划。",
      "根据用户给的一句前提，产出：书名、前提、一句话主线(logline)、贯穿全书的主要冲突(throughline)、结局方向，",
      "一套【世界观圣经】(worldBible)，以及一份【分章大纲】(chapters)。",
      "要求：",
      `- 分章 ${chapterHint}，每章给出【标题】与【本章目标 goal】（这一章要推进的核心事件/冲突/转折），可给 2-3 条关键节拍 keyBeats。`,
      "- 各章要环环相扣、层层推进，指向结局；避免各章孤立。",
      "- 世界观圣经要具体：时代基调、重要地点、门派势力、武功体系/规则、关键信物、其它设定。",
      "只输出一个 JSON 对象：",
      '{"title":"书名","premise":"前提","logline":"一句话主线","throughline":"贯穿冲突","ending":"结局方向",',
      '"worldBible":{"era":"时代基调","tone":"风格基调","locations":["地点"],"factions":["门派/势力"],"powerSystem":["武功体系/规则"],"items":["关键信物"],"lore":["其它设定"]},',
      '"chapters":[{"title":"章节标题","goal":"本章目标","keyBeats":["关键节拍"]}]}',
      "不要输出 JSON 以外的任何文字。",
    ].join("\n");

    const { message } = await this.client.chat({
      messages: [
        { role: "system", content: system },
        { role: "user", content: `前提：${seed}` },
      ],
      temperature: 0.85,
    });

    const parsed = parseOutline(message.content ?? "");
    if (parsed) return parsed;
    // 兜底：至少给一个能跑的单章大纲。
    return {
      title: "无名武侠",
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
  async reviseOutline(outline: Outline, memory: StoryMemory): Promise<Outline> {
    const written = outline.chapters.filter((c) => c.status === "written");
    const planned = outline.chapters.filter((c) => c.status !== "written");
    // 没有待写章节则无需修订。
    if (planned.length === 0) return outline;

    const system = [
      "你是这部武侠长篇的主编。已经写完了若干章，现在根据【故事实际走向】修订后续尚未写的章节大纲。",
      "要求：",
      "- 只规划后续尚未写的章节；不要重写已写章节。",
      "- 依据已发生的事实、未回收的伏笔与主线，让后续章节顺理成章地推进到结局。",
      "- 可增删/调整后续章节，可微调结局方向。",
      "只输出一个 JSON 对象：",
      '{"ending":"（可微调的）结局方向","chapters":[{"title":"章节标题","goal":"本章目标","keyBeats":["关键节拍"]}]}',
      "其中 chapters 只含【后续尚未写】的章节。不要输出 JSON 以外的任何文字。",
    ].join("\n");

    const user = [
      `【主线】${outline.throughline}`,
      `【结局方向】${outline.ending}`,
      `【已写章节】\n${written.map((c) => `第${c.n}章《${c.title}》：${c.goal}`).join("\n") || "（无）"}`,
      `【故事梗概至今】\n${memory.rollingSummary || "（无）"}`,
      `【未回收伏笔】\n${renderOpenThreads(memory.threads)}`,
      `【世界设定要点】\n${renderWorldBrief(memory.worldBible)}`,
      `【原定后续章节】\n${planned.map((c) => `《${c.title}》：${c.goal}`).join("\n")}`,
      "请输出修订后的后续章节 JSON。",
    ].join("\n\n");

    const { message } = await this.client.chat({
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0.8,
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
