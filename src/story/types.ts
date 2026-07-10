/**
 * 多章小说（整书）层的数据模型。
 *
 * 与 `src/drama/`（单章/单幕）分层：drama 只管"演一幕 + 成一章文"，story 管
 * 跨章的主情节规划(Outline)与故事记忆(StoryMemory)，并把它们落盘成一个可续写的
 * 小说项目。设定 canon（世界观圣经 + 人物档案）与叙事进度（事件/伏笔/梗概）分开管理。
 */

// ── 主情节规划（outline.json） ─────────────────────────

/** 一章的规划：目标驱动，写完后 status 置 written。 */
export interface ChapterPlan {
  n: number;
  /** 计划标题（成文时可被实际章节标题覆盖）。 */
  title: string;
  /** 本章要推进什么（喂给导演/执笔人的核心指引）。 */
  goal: string;
  /** 关键节拍（可选）。 */
  keyBeats?: string[];
  status: "planned" | "written";
}

/** 整书大纲：可被 reviseOutline 修订后续章节。 */
export interface Outline {
  /** 前提/引子。 */
  premise: string;
  /** 一句话主线（logline）。 */
  logline: string;
  /** 贯穿全书的主要冲突/追求。 */
  throughline: string;
  /** 结局方向（可修订）。 */
  ending: string;
  chapters: ChapterPlan[];
}

// ── 稳定 canon：世界观圣经 ──────────────────────────────

/** 相对稳定的世界设定；开篇奠基，之后只追加/校订、禁止自相矛盾。 */
export interface WorldBible {
  /** 时代/背景基调。 */
  era: string;
  /** 全书风格基调（如"冷硬写实的江湖恩仇"）。 */
  tone: string;
  /** 重要地点。 */
  locations: string[];
  /** 门派/势力。 */
  factions: string[];
  /** 武功体系/世界规则。 */
  powerSystem: string[];
  /** 关键信物/MacGuffin。 */
  items: string[];
  /** 其它设定要点。 */
  lore: string[];
}

// ── 稳定 canon：人物档案 ────────────────────────────────

/**
 * 人物档案（canon）。字段与 drama 层的 {@link Character} 对齐，便于用
 * {@link codexToCharacter} 原样重建 CharacterActor（同名、同性格、同腔调）。
 *
 * personality / style 是【不可变内核】，一经确立不被覆盖，防止人设漂移；
 * status / currentGoal / relationships / arcNotes / lastChapter 随剧情演变。
 */
export interface CodexCharacter {
  name: string;
  aliases?: string[];
  identity: string;
  /** 不可变内核。 */
  personality: string;
  /** 说话风格，不可变内核。 */
  style: string;
  /** 长期动机/弧线。 */
  longTermGoal: string;
  /** 当前阶段目标（可演变）。 */
  currentGoal?: string;
  relationships?: { who: string; relation: string }[];
  secret?: string;
  secretRevealed?: boolean;
  /** 现状：在世/伤/亡/失踪/下落等。 */
  status: string;
  appearance?: string;
  /** 成长弧线笔记；回归者的"缺席期间发生了什么"也补在这里。 */
  arcNotes?: string;
  /** 首次登场原话样本（1-2 句），复现时作为口吻 few-shot。 */
  voiceSample?: string;
  firstChapter: number;
  lastChapter: number;
}

// ── 叙事进度 ───────────────────────────────────────────

/** 伏笔/悬念线程。 */
export interface ThreadItem {
  id: string;
  description: string;
  status: "open" | "resolved";
  introducedChapter: number;
  resolvedChapter?: number;
}

/** 一条大事记。 */
export interface StoryEvent {
  chapter: number;
  summary: string;
}

/** 故事记忆：canon（世界观 + 人物档案）+ 进度（事件/伏笔/梗概）。 */
export interface StoryMemory {
  worldBible: WorldBible;
  /** 人物档案（canon，随章 upsert）。 */
  characters: CodexCharacter[];
  events: StoryEvent[];
  threads: ThreadItem[];
  /** 有界"故事梗概至今"，控制 prompt 体积。 */
  rollingSummary: string;
}

// 注：喂给 drama 层的章节上下文类型 DramaContext 定义在 src/drama/scene.ts，
// 只依赖 Character（下层），由 story 引擎组装，避免 drama 反向依赖 story。

// ── 项目元数据（novel.json） ────────────────────────────

export interface NovelMeta {
  slug: string;
  title: string;
  createdAt: string;
  model: string;
  chaptersWritten: number;
}

/** 一章的产出（成文 + 原始 beats，便于重生成/调试）。 */
export interface GeneratedChapter {
  n: number;
  title: string;
  prose: string;
}

/** 内存中加载的完整项目。 */
export interface NovelProject {
  meta: NovelMeta;
  outline: Outline;
  memory: StoryMemory;
}
