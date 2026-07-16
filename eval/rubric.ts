/**
 * 评测点（rubric）与类型定义——纯数据 + 纯函数，可单测。
 *
 * 「LLM 评 LLM」体系的评分口径集中在这里：两套评测点(章节规划 / 文笔风味)，
 * 每项 1-5 分。裁判 prompt 与报告渲染都从这份 rubric 生成，改评测点只改这一处。
 */

/** 满分（每项评测点）。 */
export const MAX_SCORE = 5;

/** 一条评测点。 */
export interface RubricItem {
  /** 稳定标识（英文，供机器对齐）。 */
  id: string;
  /** 中文短名。 */
  label: string;
  /** 评分指引（喂裁判、也用于报告说明）。 */
  desc: string;
}

/** 章节规划评测点。 */
export const PLAN_RUBRIC: RubricItem[] = [
  { id: "structure", label: "结构完整", desc: "书名/前提/logline/贯穿冲突/结局方向/世界观圣经齐备且彼此自洽。" },
  { id: "throughline", label: "主线贯穿", desc: "各幕各章都围绕核心冲突推进、指向结局，不跑偏、不散。" },
  { id: "progression", label: "递进无停滞", desc: "逐章逐幕层层升级，有新增量，不原地打转、不回环重演。" },
  { id: "nonRepetition", label: "无重复无重启", desc: "语义层无重复的幕/章，同一事件(受辱/出走/托孤等)不被换说法再演。" },
  { id: "hooks", label: "章节钩子", desc: "每章都有清晰、可推进的目标与转折/悬念，具备追读驱动力。" },
  { id: "genreFit", label: "题材贴合", desc: "世界观与情节贴合所选题材(力量体系/势力/信物/基调)。" },
  { id: "worldbuilding", label: "世界观具体度", desc: "设定具体、可用、有辨识度，而非放之四海皆可的空泛套话。" },
  { id: "concealment", label: "身份悬念保护", desc: "书名/幕名/章名不泄露需长期隐藏的身份或结局关键真名(无此诉求可给满分)。" },
  { id: "convergence", label: "收束性", desc: "章节总量收敛、指向结局，不无限拉长、不烂尾。" },
  { id: "pacing", label: "节奏分布", desc: "起承转合分布合理，铺垫/推进/高潮/收束比例得当。" },
];

/**
 * 审校评测点：给审校 agent「看护」——既要【抓到并修掉】植入的自洽硬伤（沙子类），
 * 又【不能改变故事】。前两项是核心（修硬伤 + 保真），后三项守住"最小改动、不添乱"。
 */
export const REVIEW_RUBRIC: RubricItem[] = [
  { id: "bugCatch", label: "硬伤修正", desc: "找出并修正【已知硬伤】里的逻辑/常识/时令/时间线/设定矛盾（如暑假的沙留到开学）。漏改则低分。" },
  { id: "storyFidelity", label: "故事保真", desc: "情节走向、人物、结局、设定与原稿一致，【须保留要素】悉数保留，没把故事改掉。" },
  { id: "minimalEdit", label: "改动克制", desc: "只动出问题处，未大段重写、润色、改文风或增删情节；能保留原句就保留。" },
  { id: "noNewIssues", label: "未引入新硬伤", desc: "修订本身没带来新的矛盾、常识错误、病句或前后不一致。" },
  { id: "structureKept", label: "标题结构保留", desc: "保留章节标题与整体结构（首行标题、空行、正文）。" },
];

/** 文笔风味评测点。 */
export const PROSE_RUBRIC: RubricItem[] = [
  { id: "styleFidelity", label: "风味契合", desc: "贴合目标风味卡(如辰东:短句鼓点/说书人腔/万古尺度/群像镜头；古龙:留白警句；金庸:醇厚)。" },
  { id: "faithfulness", label: "忠于交互记录", desc: "不篡改、不新增交互记录(transcript)里的重大事实/结局/人物言行。" },
  { id: "weaving", label: "叙述编织", desc: "叙述/对白/心理/动作/环境自然交织，非台词堆叠或旁白+台词的剧本体。" },
  { id: "rhythm", label: "节奏张弛", desc: "有铺垫-推进-爆发-余韵的张弛，不全程满格、不平铺直叙。" },
  { id: "worldTexture", label: "世界质感", desc: "叙述自然带出世界标志质感(力量体系/禁地/天地格局)，非通用背景。" },
  { id: "voiceDistinction", label: "人物腔调区分", desc: "各人物说话风格分明、彼此迥异，贴合其人设腔调。" },
  { id: "intensityFit", label: "风味强度得当", desc: "高潮处上强度、日常处收敛，风味鲜明但服务剧情，不空洞堆砌辞藻。" },
  { id: "readability", label: "可读性", desc: "行文流畅、连贯、好读，不出戏、不卡壳。" },
];

// ── 类型 ────────────────────────────────────────────────

/** 单项评分。 */
export interface MetricScore {
  id: string;
  label: string;
  score: number;
  max: number;
  comment: string;
}

/** 一次评测的完整打分（两条线通用）。 */
export interface EvalScore {
  metrics: MetricScore[];
  /** 综合分（0-100，便于跨轴汇总；由裁判给或据各项均值折算）。 */
  overall: number;
  strengths: string[];
  issues: string[];
  suggestions: string[];
}

export type PlanScore = EvalScore;
export type ProseScore = EvalScore;

/** 一场戏的交互记录条目（与 drama 层 Beat 对齐）。 */
export interface FixtureBeat {
  actor: string;
  kind: "act" | "narration";
  content: string;
}

/**
 * 文笔评测用的交互 fixture：自带 scene + transcript + 目标/题材/风味，
 * 让「跑 novelist 出文再评」可复现、与 drama 随机性解耦。
 */
export interface ProseFixture {
  id: string;
  label: string;
  seed: string;
  /** 题材(id/label/自定义)，喂 resolveGenre。 */
  genre?: string;
  /** 目标风味卡(id/label/自定义)，喂 resolveStyleCard；也是评风味契合的标尺。 */
  style?: string;
  /** 风味强度(light/medium/strong)。 */
  intensity?: string;
  /** 本章目标。 */
  goal: string;
  /** 章号（可选，默认 2；设为 1 会触发开篇立威等第 1 章专属注入）。 */
  chapterNo?: number;
  /** 世界设定要点（可选，喂 ctx.worldBrief）。 */
  worldBrief?: string;
  /** 场景背景与出场人物。 */
  scene: {
    background: string;
    characters: {
      name: string;
      identity: string;
      personality: string;
      goal: string;
      secret?: string;
      style: string;
    }[];
  };
  /** 即兴演出记录。 */
  transcript: FixtureBeat[];
}

/**
 * 审校评测用的 fixture：在一段【草稿正文】里植入已知硬伤（如"沙子"），
 * 交审校 agent 修，再由裁判核对——硬伤是否被修掉、故事是否被保留。
 * 复用 ProseFixture 的 scene/transcript/goal 上下文，另加草稿与两组"答案"。
 */
export interface ReviewFixture {
  id: string;
  label: string;
  /** 本章目标。 */
  goal: string;
  /** 题材(id/label/自定义)，喂 resolveGenre。 */
  genre?: string;
  /** 风味卡(可选)。 */
  style?: string;
  /** 风味强度(可选)。 */
  intensity?: string;
  /** 章号（可选，默认 1）。 */
  chapterNo?: number;
  /** 世界设定要点（可选）。 */
  worldBrief?: string;
  /**
   * 故事梗概至今（可选）：喂 ctx.storySoFar，作为审校【跨章保真】的事实/人物锚点来源。
   * 跨章硬伤（如主角性别、灵根品阶在后一章被悄悄改掉）只有把前情当锚点才审得出来。
   */
  storySoFar?: string;
  /** 上一章结尾片段（可选）：喂 ctx.previousChapterTail，供时间线/承接与跨章设定核对。 */
  previousChapterTail?: string;
  /** 场景背景与出场人物（审校的"原始情节依据"之一）。 */
  scene: {
    background: string;
    characters: {
      name: string;
      identity: string;
      personality: string;
      goal: string;
      secret?: string;
      style: string;
    }[];
  };
  /** 即兴演出记录（审校核对"谁说谁做"的依据）。 */
  transcript: FixtureBeat[];
  /** 待审校的草稿正文（首行标题、空行、正文），内含已知硬伤。 */
  draft: string;
  /** 已知硬伤：审校应当找出并修正（供裁判核对是否修掉）。 */
  plantedBugs: string[];
  /** 须保留的故事要素：审校绝不能改动（供裁判核对"不改变故事"）。 */
  invariants: string[];
}

/** 把一套 rubric 渲染成喂裁判的评分项清单（编号 + 短名 + 指引）。纯函数。 */
export function renderRubricForPrompt(rubric: RubricItem[]): string {
  return rubric.map((r, i) => `${i + 1}. ${r.id}（${r.label}）：${r.desc}`).join("\n");
}

/** rubric 的 id→label 映射，供解析/渲染补全 label。 */
export function rubricLabels(rubric: RubricItem[]): Map<string, string> {
  return new Map(rubric.map((r) => [r.id, r.label]));
}
