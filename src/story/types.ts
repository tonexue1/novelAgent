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
  /** 所属卷号（分卷滚动模式下标记本章属于第几卷）。 */
  arc?: number;
}

/**
 * 一卷（arc）的路线图条目：分卷滚动模式下，开书时先生成整书的分卷路线图，
 * 之后逐卷按需展开成分章（chapters）。每卷 status 随进度推进。
 */
export interface ArcPlan {
  n: number;
  title: string;
  /** 本卷主旨/主要剧情（2-4 句）。 */
  summary: string;
  /** 本卷计划章数。 */
  chapters: number;
  status: "planned" | "active" | "done";
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
  /**
   * 规划模式：
   *   - "whole"（默认/旧档）：开书一次性规划全书，reviseOutline 修订后续。
   *   - "rolling"：分卷滚动——只展开当前卷，写完自动展开下一卷，支持数百章长篇。
   * 缺省（旧档）视为 "whole"。
   */
  mode?: "whole" | "rolling";
  /** 分卷路线图（仅 rolling 模式）。 */
  arcs?: ArcPlan[];
  /** 当前活跃卷号（仅 rolling 模式）。 */
  currentArc?: number;
  /** 目标总章数（仅 rolling 模式，用于判断何时收官）。 */
  targetChapters?: number;
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
  /** 累计登场章数（用于识别主角/主要人物）。 */
  appearances?: number;
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

/**
 * 关键道具账本项：每件道具【唯一当前持有者/位置】，杜绝"到处都藏着真本"。
 * 更新时是"改持有权/位置"，而不是每章追加一个新藏处。
 */
export interface PropItem {
  /** 道具名（稳定标识，如"真拓本""青玉剑佩"）。 */
  name: string;
  /** 当前持有者（人物名；无人持有可写"无/遗失"）。 */
  holder: string;
  /** 当前所在位置。 */
  location: string;
  /** 状态（如"完好/损毁/一分为二/下落不明"）。 */
  status: string;
  /** 最近更新章号。 */
  lastChapter: number;
}

/** 故事记忆：canon（世界观 + 人物档案）+ 进度（事件/伏笔/梗概）。 */
export interface StoryMemory {
  worldBible: WorldBible;
  /** 人物档案（canon，随章 upsert）。 */
  characters: CodexCharacter[];
  events: StoryEvent[];
  threads: ThreadItem[];
  /** 关键道具账本：每件唯一当前持有者/位置。 */
  props: PropItem[];
  /** 当前故事推进到的地点/时间锚点，供下一章承接、避免原地打转。 */
  currentLocation: string;
  /** 有界"故事梗概至今"，控制 prompt 体积。 */
  rollingSummary: string;
  /**
   * 卷级综述（每卷收尾归档一条）。rollingSummary 只保近期主干（有界），
   * arcSummaries 保各卷长期主干，供规划下一卷时跨数百章不丢线索、也不膨胀。
   */
  arcSummaries?: string[];
}

// 注：喂给 drama 层的章节上下文类型 DramaContext 定义在 src/drama/scene.ts，
// 只依赖 Character（下层），由 story 引擎组装，避免 drama 反向依赖 story。

// ── 项目元数据（novel.json） ────────────────────────────

/**
 * 题材描述符：把"武侠/玄幻/仙侠…"抽象成注入各 agent 提示词的配置。
 * persona 替换提示词里的"武侠小说"；worldGuidance 指导规划世界观贴题材；
 * styleGuidance 提示文笔/腔调（可空）。纯数据，随项目落盘以支持自定义题材续写。
 */
export interface GenreSpec {
  id: string;
  /** 中文题材名，如"武侠""仙侠"。 */
  label: string;
  /** agent 自我定位用的题材短语，如"仙侠修真小说"。 */
  persona: string;
  /** 规划世界观时的题材专属引导（力量体系/势力/信物应如何贴题材）。 */
  worldGuidance: string;
  /** 文笔/腔调提示（可空）。 */
  styleGuidance: string;
}

/**
 * 写作风味卡：把某种「作者笔法」抽象成可注入提示词的结构，与题材(GenreSpec)正交——
 * 题材管「写什么世界」，风味管「怎么写这段字」。只作用于【叙述层】（执笔成文 + 导演旁白），
 * 不覆盖每个人物各自的说话腔调（对白层由角色 style 决定）。
 *
 * 各字段是「抽象笔法」而非原文样本：只描述句式/意象/语气等模式，绝不含任何作品的
 * 专有名词、人物或情节，避免复刻与雷同。纯数据，随项目落盘以支持全程一致的文风。
 */
export interface StyleCard {
  id: string;
  /** 风味名，如"辰东式史诗"。 */
  label: string;
  /** 一句话定位。 */
  tagline: string;
  /** 句式与节奏。 */
  rhythm: string;
  /** 标志词库/意象偏好（供自然融入，忌通篇堆砌）。 */
  lexicon: string;
  /** 叙事视角与语气。 */
  voice: string;
  /** 名场面/高潮/战斗的写法（仅在冲突高潮时上强度，日常场景收敛）。 */
  setpiece: string;
  /** 章末钩子/收束方式。 */
  hook: string;
  /** 忌讳：这种风味要刻意避免什么。 */
  avoid: string;
}

/** 风味强度：淡入 / 适中 / 浓墨。控制风味规则注入的力度。 */
export type StyleIntensity = "light" | "medium" | "strong";

export interface NovelMeta {
  slug: string;
  title: string;
  createdAt: string;
  model: string;
  chaptersWritten: number;
  /** 题材（随项目持久化）。旧档缺失时上层回落到默认武侠。 */
  genre?: GenreSpec;
  /** 写作风味卡（随项目持久化）。缺失表示不启用风味，回落题材默认腔调。 */
  styleCard?: StyleCard;
  /** 风味强度（默认 medium）。 */
  styleIntensity?: StyleIntensity;
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
