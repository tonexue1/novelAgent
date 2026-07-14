/**
 * 自回归验证——确定性检查器（纯函数，离线、可复现、可单测）。
 *
 * 定位：这是「产出 → 监视 → 改进」闭环里的【监视】层。脚本只做启发式检查，产出机器可读
 * 的 {@link Scorecard} 与人类可读报告；风格/可读性/逻辑等主观维度交由人（agent）参与评审。
 *
 * 设计取向：
 * - 世界观覆盖率的词表【从该书自己的 WorldBible 抽取】——天然跨题材，不写死某个世界的专名。
 * - 风味词覆盖率的词表【从所选风味卡的 lexicon 抽取】——复用卡，不另配。
 * - 各分值多为【相对信号】（整改前后对比升降），不是绝对真值；阈值只用于粗判是否达标。
 */

import type { StyleCard, WorldBible } from "../story/types.ts";

/** 归一化用于文本比对：转小写、去掉所有空白/标点/符号。 */
export function normalizeText(s: string): string {
  return (s ?? "").toLowerCase().replace(/[\s\p{P}\p{S}]/gu, "");
}

/** 一条重复章命中：第 n 章与在前的 dupOf 章在 title 或 goal 上撞车。 */
export interface DuplicateHit {
  n: number;
  title: string;
  dupOf: number;
  by: "title" | "goal";
}

/**
 * 连续性硬指标：找出标题或目标（归一化后）与在前某章重复的章。
 * 与 planner.dropDuplicateChapters 同源的判定，但这里【报告命中】而非剔除。纯函数。
 */
export function findDuplicateChapters(
  chapters: { n: number; title: string; goal: string }[],
): DuplicateHit[] {
  const titleSeen = new Map<string, number>();
  const goalSeen = new Map<string, number>();
  const hits: DuplicateHit[] = [];
  for (const c of chapters) {
    const t = normalizeText(c.title);
    const g = normalizeText(c.goal);
    if (t && titleSeen.has(t)) {
      hits.push({ n: c.n, title: c.title, dupOf: titleSeen.get(t)!, by: "title" });
    } else if (g && goalSeen.has(g)) {
      hits.push({ n: c.n, title: c.title, dupOf: goalSeen.get(g)!, by: "goal" });
    }
    if (t && !titleSeen.has(t)) titleSeen.set(t, c.n);
    if (g && !goalSeen.has(g)) goalSeen.set(g, c.n);
  }
  return hits;
}

/** 覆盖率结果。 */
export interface CoverageResult {
  total: number;
  hit: number;
  coverage: number;
  hits: string[];
  missed: string[];
}

/** 把一条设定条目切成候选词（去标点、留长度 ≥2 的片段）。 */
export function splitTerms(entry: string): string[] {
  return (entry ?? "")
    .split(/[\s、，,。；;：:！!？?—\-·.()（）「」『』【】\/|]+/u)
    .map((s) => s.trim())
    .filter((s) => s.length >= 2);
}

/**
 * 条目覆盖率：一条设定条目只要它的【任一候选词】在文本中出现，即算「被引用」。
 * 用于「世界观在正文里到底落地了多少」——相对信号，越高越贴世界观。纯函数。
 */
export function entryCoverage(text: string, entries: string[]): CoverageResult {
  const clean = entries.map((e) => (e ?? "").trim()).filter(Boolean);
  const hits: string[] = [];
  const missed: string[] = [];
  for (const entry of clean) {
    const terms = splitTerms(entry);
    const referenced = terms.some((t) => t.length >= 2 && text.includes(t));
    (referenced ? hits : missed).push(entry);
  }
  const total = clean.length;
  return {
    total,
    hit: hits.length,
    coverage: total ? hits.length / total : 0,
    hits,
    missed,
  };
}

/** 汇集 WorldBible 里的世界标志条目（力量体系/地点/势力/信物/其它设定 + 时代/基调）。 */
export function worldSignatureEntries(wb: WorldBible | undefined): string[] {
  if (!wb) return [];
  return [
    ...(wb.powerSystem ?? []),
    ...(wb.locations ?? []),
    ...(wb.factions ?? []),
    ...(wb.items ?? []),
    ...(wb.lore ?? []),
    wb.era,
    wb.tone,
  ]
    .map((e) => (e ?? "").trim())
    .filter(Boolean);
}

/** 抽取风味词时要滤掉的「说明性」用词（非风味词本身）。 */
const LEXICON_STOP = new Set([
  "偏爱", "意象", "一类", "自然", "融入", "点到", "即止", "切忌", "通篇", "堆砌", "成套",
  "套话", "但要", "雄浑", "苍远", "宏大", "常以", "善用", "重情", "文白", "相间", "而不",
  "晦涩", "诗词", "典故", "风物", "市井", "细节", "温润", "冷硬", "孤绝", "繁复", "形容词",
  "叠加", "堆叠", "以及", "或者", "各种", "一些", "这种", "那种",
]);

/**
 * 从风味卡的 lexicon 抽取候选风味词（纯 CJK、长度 2-4、去掉说明性停用词）。
 * lexicon 是自然语描述，抽取必然近似；用作【相对信号】足矣。纯函数。
 */
export function extractLexiconTerms(lexicon: string): string[] {
  const raw = (lexicon ?? "").split(/[\s、，,。；;：:！!？?—\-·.()（）「」『』【】\/|]+/u);
  const out = new Set<string>();
  for (const t0 of raw) {
    const t = t0.trim();
    if (t.length < 2 || t.length > 4) continue;
    if (!/^[\u4e00-\u9fff]+$/.test(t)) continue;
    if (LEXICON_STOP.has(t)) continue;
    out.add(t);
  }
  return [...out];
}

/** 词表覆盖率：terms 中有多少个至少在 text 出现一次。纯函数。 */
export function termCoverage(text: string, terms: string[]): CoverageResult {
  const uniq = [...new Set(terms.map((t) => t.trim()).filter(Boolean))];
  const hits: string[] = [];
  const missed: string[] = [];
  for (const t of uniq) (text.includes(t) ? hits : missed).push(t);
  return {
    total: uniq.length,
    hit: hits.length,
    coverage: uniq.length ? hits.length / uniq.length : 0,
    hits,
    missed,
  };
}

/** 短句占比：以中文断句符切分，长度 ≤ maxLen 的句子占比（辰东式偏爱短句顿挫）。纯函数。 */
export function shortSentenceRatio(text: string, maxLen = 15): number {
  const sentences = (text ?? "")
    .split(/[。！？!?\n]+/u)
    .map((s) => s.trim())
    .filter(Boolean);
  if (sentences.length === 0) return 0;
  const short = sentences.filter((s) => s.length <= maxLen).length;
  return short / sentences.length;
}

/** 象声词鼓点计数（轰/砰/噗/咚/嗡…），史诗战斗常用。纯函数。 */
export function countOnomatopoeia(text: string): number {
  const m = (text ?? "").match(/[轰砰噗咚嗡铮咔嘭霍呼]/gu);
  return m ? m.length : 0;
}

/** 通用「宅斗/家常」负向词表：命中越多，越像放之四海皆通用的小院戏（越低越好）。 */
export const GENERIC_DRAMA_TERMS = [
  "小院", "院子", "家常", "口角", "拌嘴", "唠叨", "邻里", "柴米", "婆媳", "鸡毛蒜皮",
  "闲话", "家长里短", "串门", "饭桌",
];

/** 统计负向词命中明细。纯函数。 */
export function countGenericDrama(text: string): { term: string; count: number }[] {
  const out: { term: string; count: number }[] = [];
  for (const term of GENERIC_DRAMA_TERMS) {
    let count = 0;
    let idx = (text ?? "").indexOf(term);
    while (idx !== -1) {
      count++;
      idx = text.indexOf(term, idx + term.length);
    }
    if (count > 0) out.push({ term, count });
  }
  return out;
}

/** 大尺度开场的「远景」意象词（通用的史诗俯瞰词，用于粗判第 1 章是否起势立威）。 */
export const WIDE_SHOT_TERMS = [
  "天地", "苍穹", "星空", "星域", "星辰", "大地", "洪荒", "岁月", "纪元", "万古", "亘古",
  "传说", "古老", "苍茫", "浩瀚", "苍生", "众生", "天下",
];

export interface OpeningScore {
  /** 第 1 章开头前若干字里，引用到的世界标志条目数。 */
  groundedTermsInLead: number;
  /** 开头是否出现大尺度远景意象。 */
  wideShot: boolean;
  /** 取样的开头片段（供人工评审）。 */
  sampleLead: string;
  score: number;
}

/**
 * 第 1 章开场评分：开头是否「扎根世界 + 大尺度起势」。
 * - 开头 leadLen 字里引用到 ≥2 个世界标志条目 → 半分。
 * - 开头出现远景意象词 → 半分。
 * 纯函数（不读盘）。
 */
export function scoreOpening(
  ch1Text: string,
  worldEntries: string[],
  leadLen = 400,
): OpeningScore {
  const lead = (ch1Text ?? "").slice(0, leadLen);
  const grounded = entryCoverage(lead, worldEntries).hit;
  const wideShot = WIDE_SHOT_TERMS.some((t) => lead.includes(t));
  const score = (grounded >= 2 ? 0.5 : grounded === 1 ? 0.25 : 0) + (wideShot ? 0.5 : 0);
  return { groundedTermsInLead: grounded, wideShot, sampleLead: lead, score };
}

// ── 汇总 ────────────────────────────────────────────────

export interface GradeInput {
  slug: string;
  title: string;
  chaptersWritten: number;
  styleCard?: StyleCard;
  worldBible?: WorldBible;
  /** 大纲章节（用于连续性去重检测）。 */
  chapters: { n: number; title: string; goal: string }[];
  /** 已成文的各章正文（已去 markdown 标题）。 */
  proses: { n: number; text: string }[];
}

export interface Scorecard {
  slug: string;
  title: string;
  chaptersWritten: number;
  styleLabel: string;
  continuity: { score: number; duplicates: DuplicateHit[]; totalChapters: number };
  worldview: { score: number; coverage: CoverageResult };
  style: {
    score: number;
    lexicon: CoverageResult;
    shortSentenceRatio: number;
    onomatopoeia: number;
  };
  opening: OpeningScore & { available: boolean };
  genericDrama: { score: number; hits: { term: string; count: number }[]; total: number };
  overall: number;
}

const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));

/**
 * 汇总打分。输入为已从磁盘装配好的纯数据（便于单测，不读盘）。
 * overall 为各轴加权：连续性 0.35 / 世界观 0.25 / 风味 0.2 / 开场 0.1 / 去负向 0.1。
 */
export function gradeNovel(input: GradeInput): Scorecard {
  const fullText = input.proses.map((p) => p.text).join("\n");
  const worldEntries = worldSignatureEntries(input.worldBible);

  // 连续性
  const duplicates = findDuplicateChapters(input.chapters);
  const totalChapters = input.chapters.length;
  const continuityScore = totalChapters
    ? clamp01(1 - duplicates.length / totalChapters)
    : 1;

  // 世界观
  const worldCoverage = entryCoverage(fullText, worldEntries);

  // 风味
  const lexTerms = extractLexiconTerms(input.styleCard?.lexicon ?? "");
  const lexCoverage = termCoverage(fullText, lexTerms);
  const ssr = shortSentenceRatio(fullText);
  const ono = countOnomatopoeia(fullText);

  // 开场（第 1 章）
  const ch1 = input.proses.find((p) => p.n === 1);
  const opening = ch1
    ? { ...scoreOpening(ch1.text, worldEntries), available: true }
    : {
        groundedTermsInLead: 0,
        wideShot: false,
        sampleLead: "",
        score: 0,
        available: false,
      };

  // 负向（通用宅斗）
  const genericHits = countGenericDrama(fullText);
  const genericTotal = genericHits.reduce((s, h) => s + h.count, 0);
  // 以每章容许 ~1 次为阈值线性惩罚。
  const genericThreshold = Math.max(4, totalChapters);
  const genericScore = clamp01(1 - genericTotal / genericThreshold);

  const styleScore = lexTerms.length ? clamp01(lexCoverage.coverage) : 0;

  const overall =
    continuityScore * 0.35 +
    clamp01(worldCoverage.coverage) * 0.25 +
    styleScore * 0.2 +
    opening.score * 0.1 +
    genericScore * 0.1;

  return {
    slug: input.slug,
    title: input.title,
    chaptersWritten: input.chaptersWritten,
    styleLabel: input.styleCard?.label ?? "（未启用风味）",
    continuity: { score: continuityScore, duplicates, totalChapters },
    worldview: { score: clamp01(worldCoverage.coverage), coverage: worldCoverage },
    style: { score: styleScore, lexicon: lexCoverage, shortSentenceRatio: ssr, onomatopoeia: ono },
    opening,
    genericDrama: { score: genericScore, hits: genericHits, total: genericTotal },
    overall,
  };
}
