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

/** 渲染出场人物名单（喂给导演/角色的公开信息）。 */
export function renderCast(scene: Scene): string {
  return scene.characters
    .map((c, i) => `${i + 1}. ${c.name}——${c.identity}；目标：${c.goal}`)
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

/**
 * 兜底开局：当导演生成场景失败或用户未给开场时使用，保证 demo 永远能跑。
 * 一个经典客栈对峙场景。
 */
export const DEFAULT_SCENE: Scene = {
  background:
    "暴雨夜，川北野岭上的『风雪客栈』。一张残破的藏宝图残卷流落江湖，传说指向前朝镖银。今夜，几路人马鬼使神差地聚在这间客栈里，谁都不肯先走。",
  characters: [
    {
      name: "独臂刀客 沈孤鸿",
      identity: "曾经的镖局总镖头，右臂在十年前的劫案中被斩断",
      personality: "沉默寡言，眼神锐利，出手极快",
      goal: "找出当年灭他满门的仇人",
      secret: "他其实认得藏宝图上的暗记",
      style: "惜字如金，多用短句，几乎不寒暄，一开口便冷硬如刀",
    },
    {
      name: "俏判官 柳三娘",
      identity: "行走江湖的女捕快，亦正亦邪",
      personality: "泼辣精明，笑里藏刀",
      goal: "拿到藏宝图向上头请功",
      style: "泼辣爽利，爱用反问和俏皮话挤兑人，市井气重",
    },
    {
      name: "醉丐 邋遢老儿",
      identity: "看似乞丐，实为丐帮隐世长老",
      personality: "嬉皮笑脸，深不可测",
      goal: "搅局，看这群人自相残杀",
      secret: "他才是藏宝图真正的主人",
      style: "满口疯话胡话、颠三倒四，爱打岔说笑，话里藏话",
    },
    {
      name: "白衣书生 温若寒",
      identity: "进京赶考的书生，实则身负血海深仇",
      personality: "文弱外表下藏着狠戾",
      goal: "接近沈孤鸿，伺机复仇",
      style: "文绉绉、彬彬有礼、爱引经据典，笑意底下藏针",
    },
  ],
};
