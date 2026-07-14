/**
 * 武侠场景的数据结构与渲染。纯数据 + 纯函数，不含 LLM。
 *
 * 与麻将不同：这里没有硬规则约束"谁何时行动"。人物、背景都是运行时由导演
 * 动态生成的；行动顺序由导演 agent 逐拍判断（见 director.ts）。
 */

/** 一个 NPC 角色的人物设定。 */
export interface Character {
  /** 姓名/称号，如"独臂刀客 沈孤鸿"。 */
  name: string;
  /** 身份背景。 */
  identity: string;
  /** 性格。 */
  personality: string;
  /** 当前目标/动机（驱动其行动）。 */
  goal: string;
  /** 不轻易示人的秘密（可空）。 */
  secret?: string;
  /** 说话风格。 */
  style: string;
}

/** 一幕场景：背景 + 出场人物。 */
export interface Scene {
  /** 时间地点氛围与起因。 */
  background: string;
  characters: Character[];
}

/** 场面记录里的一条：某角色的行动，或旁白/环境事件。 */
export interface Beat {
  /** 行动者姓名；旁白用 "旁白"。 */
  actor: string;
  kind: "act" | "narration";
  content: string;
}

/**
 * 章节上下文：多章小说里，把整书记忆的相关片段喂给单章的导演/执笔人，
 * 用来承接前文、复现旧角色、扣住本章目标。只依赖 {@link Character}（下层），
 * 由 story 引擎组装后传入；不传则为单幕独立模式，行为与从前一致。
 */
export interface DramaContext {
  /** 第几章。 */
  chapterNo: number;
  /** 本章目标（导演/执笔人要推进的核心）。 */
  goal: string;
  /** 世界观圣经的精炼渲染。 */
  worldBrief: string;
  /** 需复现的旧角色（已从人物档案还原，含性格/风格/秘密）。 */
  returningCharacters: Character[];
  /** 回归者补账提示（缺席若干章者需交代去向）。 */
  returningNotes?: string;
  /** 故事梗概至今（有界）。 */
  storySoFar: string;
  /** 未回收伏笔（渲染好的文本）。 */
  openThreads: string;
  /** 上一章结尾片段，保证承接。 */
  previousChapterTail?: string;
  /** 已故人物名单（渲染好的文本）：这些人不得以在世身份登场。 */
  deadRoster?: string;
  /** 关键道具账本（渲染好的文本）：每件道具当前持有者/位置。 */
  propLedger?: string;
  /** 当前故事推进到的地点/局面锚点，避免原地打转。 */
  currentLocation?: string;
  /** 已发生大事记（渲染好的文本），供"勿重复"对账。 */
  achievements?: string;
  /** 题材定位短语（如"仙侠修真小说"），替换提示词里写死的"武侠"。缺省视为武侠。 */
  genrePersona?: string;
  /** 题材文笔/腔调提示（可空）。 */
  genreStyle?: string;
  /**
   * 写作风味卡（渲染好的文本，强注入执笔成文）。承载「作者笔法」——句式/意象/语气/
   * 名场面写法/章末钩子。只作用于叙述层，不覆盖人物各自的说话腔调。可空。
   */
  narrationStyle?: string;
  /** 写作风味的精简版（一句话，弱注入导演旁白/开场）。可空。 */
  narrationStyleBrief?: string;
  /**
   * 导演运镜风味（渲染好的文本，注入导演开场/运镜）。承载「作者怎么搭场面/起势」——
   * 场面尺度、扎根世界的标志元素、群像镜头、第 1 章开篇框架。与 narrationStyle（执笔层）
   * 出自同一张风味卡的不同段落。可空（回落导演通用底线）。
   */
  directionStyle?: string;
}

/** 渲染出场人物名单（喂给导演/角色的公开信息）。 */
export function renderCast(scene: Scene): string {
  return scene.characters
    .map((c, i) => `${i + 1}. ${c.name}——${c.identity}；目标：${c.goal}`)
    .join("\n");
}

/** 渲染需复现的旧角色（含性格/说话风格/秘密），供导演忠实沿用。 */
export function renderReturningCast(characters: Character[]): string {
  if (characters.length === 0) return "";
  return characters
    .map((c) =>
      [
        `- ${c.name}（${c.identity}）`,
        `  性格：${c.personality}`,
        `  说话风格：${c.style}`,
        c.secret ? `  秘密（沿用，勿擅自揭露）：${c.secret}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    )
    .join("\n");
}

/** 渲染最近若干条场面记录。 */
export function renderTranscript(beats: Beat[], limit = 12): string {
  if (beats.length === 0) return "（开场，尚无人行动）";
  return beats
    .slice(-limit)
    .map((b) => (b.kind === "narration" ? `【旁白】${b.content}` : `${b.actor}：${b.content}`))
    .join("\n");
}

/** 角色名单里的名字列表。 */
export function castNames(scene: Scene): string[] {
  return scene.characters.map((c) => c.name);
}
