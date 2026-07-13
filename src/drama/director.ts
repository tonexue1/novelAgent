import type { LLMClient } from "../core/llm/client.ts";
import {
  type Scene,
  type Character,
  type Beat,
  type DramaContext,
  renderCast,
  renderTranscript,
  renderReturningCast,
  castNames,
} from "./scene.ts";

/**
 * 导演的每拍决策：
 * - stage ：可选的旁白/环境事件（在角色行动前先播报，用来推动气氛或制造变数）。
 * - action：act=让某人行动；end=这一幕收场。
 * - actor ：action=act 时，行动的人物名字（须为在场人物）。
 */
export interface DirectorDecision {
  stage?: string;
  action: "act" | "end";
  actor?: string;
  reason?: string;
}

function extractJsonObject(text: string): Record<string, unknown> | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  try {
    const value = JSON.parse(text.slice(start, end + 1));
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** 解析导演生成的场景。字段缺失/非法则返回 null，交由上层兜底。纯函数。 */
export function parseScene(text: string): Scene | null {
  const obj = extractJsonObject(text);
  if (!obj) return null;

  const background = typeof obj.background === "string" ? obj.background.trim() : "";
  const rawChars = Array.isArray(obj.characters) ? obj.characters : [];
  const characters: Character[] = [];
  for (const rc of rawChars) {
    if (!rc || typeof rc !== "object") continue;
    const o = rc as Record<string, unknown>;
    const name = typeof o.name === "string" ? o.name.trim() : "";
    if (!name) continue;
    characters.push({
      name,
      identity: str(o.identity),
      personality: str(o.personality),
      goal: str(o.goal),
      secret: typeof o.secret === "string" && o.secret.trim() ? o.secret.trim() : undefined,
      style: str(o.style),
    });
  }

  if (!background || characters.length < 2) return null;
  return { background, characters };
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/** 旁白里是否夹带了对白（中/英文引号或“道：/说：”式引语）——用于识别旁白越权替角色说话。 */
function hasQuotedDialogue(text: string): boolean {
  if (/[“”「」『』]/.test(text)) return true; // 中文/日式引号里的台词
  if (/["'][^"']{2,}["']/.test(text)) return true; // 英文直引号包裹的一段话
  if (/(道|说|问|答|喝|喊|笑)\s*[:：]/.test(text)) return true; // “某某道：” 式引语
  return false;
}

/**
 * 解析导演每拍决策。actor 必须是在场人物之一，否则置空（交上层回退）。
 * 无法解析时默认继续演（action=act，actor 空），由上层选人 + maxBeats 兜底终止。纯函数。
 */
export function parseDirectorDecision(text: string, validNames: string[]): DirectorDecision {
  const obj = extractJsonObject(text);
  if (!obj) return { action: "act" };

  const rawAction = typeof obj.action === "string" ? obj.action.toLowerCase() : "";
  const action: DirectorDecision["action"] = rawAction === "end" ? "end" : "act";

  // 旁白只应是客观环境/氛围。若导演在旁白里塞进了角色对白（出现引号台词），
  // 说明它越权替角色说话——直接丢弃这段旁白，让该角色自己在 act 拍里发声。
  const rawStage = typeof obj.stage === "string" ? obj.stage.trim() : "";
  const stage = rawStage && !hasQuotedDialogue(rawStage) ? rawStage : undefined;
  const reason = typeof obj.reason === "string" && obj.reason.trim() ? obj.reason.trim() : undefined;
  const rawActor = typeof obj.actor === "string" ? obj.actor.trim() : "";
  const actor = validNames.includes(rawActor) ? rawActor : undefined;

  return { stage, action, actor, reason };
}

/**
 * 导演/说书人：本场景的调度者。
 *
 * 它承担了麻将里"引擎"的角色，但这里没有硬规则——"下一个谁行动"完全由它
 * 依据剧情张力、谁被点名、人物动机来判断。这就是无固定规则约束下的多 agent
 * 调度：用一个 LLM 调度者（AutoGen GroupChatManager 式）来决定发言/行动顺序。
 */
export class Director {
  constructor(private readonly client: LLMClient) {}

  /**
   * 根据一句开场，生成背景与出场人物。
   * 传入 {@link DramaContext} 时进入"多章"模式：本章须扣住 goal、契合世界观、
   * 并【忠实复现】给定的旧角色（沿用其性格/说话风格/秘密），仅按需新增角色。
   */
  async openScene(seed: string, ctx?: DramaContext): Promise<Scene | null> {
    const persona = ctx?.genrePersona ?? "武侠小说";
    const baseRules = [
      `你是一位${persona}导演/说书人。构造一个充满戏剧张力、适合多人博弈的场景。`,
      ctx?.genreStyle ? `整体风格基调：${ctx.genreStyle}` : "",
      ctx?.narrationStyleBrief ? `背景与旁白的${ctx.narrationStyleBrief}` : "",
      "要求：",
      "- 人物之间要有潜在的冲突、秘密或利益纠葛；出场人物 3-4 人；每人给出鲜明的身份、性格、目标，尽量有一两个人带秘密。",
      "- 每个人的 style（说话风格）必须【彼此迥异且非常具体】：点明用词习惯、句子长短、腔调、口头禅或语言毛病。",
      '  例如"惜字如金、多用短句、几乎不用形容词"／"满口市井黑话、爱骂人、句子糙"／"文绉绉爱掉书袋、引经据典"／"啰嗦、结巴、爱自我怀疑、废话多"／"阴阳怪气、爱反问"。',
      "- 切忌把所有人都写成同一种“文雅诗化”腔——他们要像四个来自不同世界的人。",
      "- 【命名铁律】每个人物都要有具体、贴合世界观、像真实存在的姓名或诨号；" +
        "严禁用「无名客／无名少年／神秘少年／黑衣少年／某某客」这类占位式、一眼就看出‘在刻意藏名’的称呼当作正式姓名。",
      "- 【藏身份铁律】若某人物的真实身份是需要长期隐藏的秘密：给他一个自然可信、能在江湖上正常使用的化名或诨号；" +
        "这个化名【绝不可】包含或暗示其真实姓名、家族姓氏，也不得与其最终身份/名号同源（例如真名含某字，化名就不能用该字或其近义）；" +
        "真实身份只写进该人物的 secret 字段，绝不能出现在 name 或 identity 里。",
    ];

    const contextRules = ctx
      ? [
          "",
          "本章属于一部连载小说，务必与既有设定连贯（以下为铁律，违反即出戏）：",
          "- 场景与人物要扣住【本章目标】推进主线；不要重演【已发生·勿重复】里的情节。",
          "- 若【需复现的旧角色】里有人应在本章登场，必须【原样沿用】其姓名、身份、性格、说话风格与秘密，不得改写人设、不得改名或换人；可为其安排契合当前处境的新目标。",
          "- 【已故人物】名单里的人【绝不能以在世身份登场】（可作回忆/尸体/被提及，但不得说话行动）。",
          "- 【关键道具】的当前持有者/位置以账本为准，不得另编新的藏处或让道具凭空出现在别处。",
          "- 场景地点应【由【当前进度】推进到新的局面】，不要把上一章的对峙原样再演一遍。",
          "- 可按需新增角色，但不要与世界设定冲突，且新增要克制（优先复用既有角色）。",
          "- 有【回归者提示】时，让相关人物的登场与其上次状态自洽。",
        ]
      : [];

    const system = [
      ...baseRules,
      ...contextRules,
      '只输出一个 JSON 对象：{"background":"时间地点氛围与起因","characters":[{"name":"姓名/称号","identity":"身份","personality":"性格","goal":"目标","secret":"秘密(可省略)","style":"说话风格(要具体且与他人不同)"}]}',
      "不要输出 JSON 以外的任何文字。",
    ].join("\n");

    const user = ctx
      ? [
          `【本章目标】第${ctx.chapterNo}章：${ctx.goal}`,
          ctx.currentLocation ? `【当前进度】故事已推进到：${ctx.currentLocation}` : "",
          `【世界设定要点】\n${ctx.worldBrief}`,
          ctx.returningCharacters.length
            ? `【需复现的旧角色】\n${renderReturningCast(ctx.returningCharacters)}`
            : "",
          ctx.deadRoster ? `【已故人物（不得以在世身份登场）】\n${ctx.deadRoster}` : "",
          ctx.propLedger ? `【关键道具账本（持有者/位置以此为准）】\n${ctx.propLedger}` : "",
          ctx.returningNotes ? `【回归者提示】\n${ctx.returningNotes}` : "",
          ctx.storySoFar ? `【故事梗概至今】\n${ctx.storySoFar}` : "",
          ctx.achievements ? `【已发生·勿重复】\n${ctx.achievements}` : "",
          ctx.openThreads ? `【未回收伏笔】\n${ctx.openThreads}` : "",
          ctx.previousChapterTail ? `【上一章结尾】\n${ctx.previousChapterTail}` : "",
          "请据此构造本章的开场场景与人物。",
        ]
          .filter(Boolean)
          .join("\n\n")
      : `开场：${seed}`;

    const { message } = await this.client.chat({
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0.9,
    });
    return parseScene(message.content ?? "");
  }

  /** 决定下一拍：谁行动 / 是否收场，并可附一句旁白或环境事件。 */
  async nextBeat(
    scene: Scene,
    transcript: Beat[],
    beatNo: number,
    maxBeats: number,
    ctx?: DramaContext,
  ): Promise<DirectorDecision> {
    // 多章模式：本章有明确目标，达成即收场，避免为凑拍数而反复对峙、原地打转。
    const goalRules = ctx
      ? [
          "【本章目标铁律】本幕属于连载小说的一章，目标是推进主线：",
          `  → ${ctx.goal}`,
          "- 你的首要职责是让这一目标【实际发生】（该交代的交代、该交接的交接、该了断的了断），而不是无限拉扯气氛。",
          "- 一旦本章目标的关键增量已经在场面中达成，【立即 end 收场】，不要为凑拍数再加对峙。",
          "- 严禁重复演已经发生过的情节（见【已发生·勿重复】）；每一拍都要推着目标往前走。",
        ]
      : [];
    const system = [
      `你是这幕${ctx?.genrePersona ?? "武侠小说"}戏的导演。基于背景与目前的场面，决定下一拍怎么走。`,
      "你可以先用一句【旁白】推动气氛或加入环境变数（如灯灭、风起、马蹄声由远及近、屋瓦坠落、有人推门而入），也可以留空不加。",
      ctx?.narrationStyleBrief ? `旁白的${ctx.narrationStyleBrief}` : "",
      '只输出一个 JSON 对象：{"stage":"可空的旁白/环境事件","action":"act"或"end","actor":"action=act时必须是在场人物之一的名字","reason":"一句话缘由"}',
      "【旁白铁律】旁白是全知视角的舞台说明，只写环境、氛围、天气、场面变化这类客观事物：",
      "- 绝不许替任何在场人物说话或做动作：不得出现人物对白（不得有引号台词），不得写“某某笑道／某某冷冷道／某某拔剑／某某转头看向谁”这类具体的人物言行或神态。",
      "- 要让某个人物开口或出手，不要写进旁白，而应设 action=act 并把 actor 设为该人物，由他本人这一拍自己演。",
      "- 即使是新登场/闯入者，旁白也只能交代“院门外有人拄拐踱入”这类客观事实；此人具体说什么、做什么表情动作，必须留到其后的 act 拍由该角色本人完成。",
      "- 若这一拍没有纯环境性的内容可写，就把 stage 留空，直接让 actor 行动。",
      ...goalRules,
      "调度准则：",
      "- 优先制造并推进冲突；让刚被点名、被挑衅或被针对的人有机会回应。",
      "- 避免同一个人连续独白太久，让不同人物轮番登场、彼此碰撞。",
      "- 当冲突充分、到达一个高潮或了断时，用 end 收场，不要拖沓。",
      "不要输出 JSON 以外的任何文字。",
    ].join("\n");
    const user = [
      `【背景】${scene.background}`,
      `【在场人物】\n${renderCast(scene)}`,
      ctx?.achievements ? `【已发生·勿重复】\n${ctx.achievements}` : "",
      `【目前的场面】\n${renderTranscript(transcript)}`,
      `【进度】已进行 ${beatNo}/${maxBeats} 拍。${ctx ? "目标已达成就尽快 end。" : ""}`,
      "请输出你的下一拍决策 JSON。",
    ]
      .filter(Boolean)
      .join("\n\n");

    const { message } = await this.client.chat({
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0.8,
    });
    return parseDirectorDecision(message.content ?? "", castNames(scene));
  }

  /** 收场白。 */
  async epilogue(scene: Scene, transcript: Beat[]): Promise<string> {
    const system =
      "你是说书人。为这一幕戏做一个简短有味道的收场白（2-4 句），点出这一幕的结局与余韵，像章回小说的结尾。只输出收场白本身。";
    const user = [
      `【背景】${scene.background}`,
      `【全场经过】\n${renderTranscript(transcript, 100)}`,
      "请写收场白。",
    ].join("\n\n");

    const { message } = await this.client.chat({
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0.8,
    });
    return message.content?.trim() || "欲知后事如何，且听下回分解。";
  }
}
