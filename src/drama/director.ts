import type { LLMClient } from "../core/llm/client.ts";
import {
  type Scene,
  type Character,
  type Beat,
  renderCast,
  renderTranscript,
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

/**
 * 解析导演每拍决策。actor 必须是在场人物之一，否则置空（交上层回退）。
 * 无法解析时默认继续演（action=act，actor 空），由上层选人 + maxBeats 兜底终止。纯函数。
 */
export function parseDirectorDecision(text: string, validNames: string[]): DirectorDecision {
  const obj = extractJsonObject(text);
  if (!obj) return { action: "act" };

  const rawAction = typeof obj.action === "string" ? obj.action.toLowerCase() : "";
  const action: DirectorDecision["action"] = rawAction === "end" ? "end" : "act";

  const stage = typeof obj.stage === "string" && obj.stage.trim() ? obj.stage.trim() : undefined;
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

  /** 根据用户一句开场，生成背景与出场人物。 */
  async openScene(seed: string): Promise<Scene | null> {
    const system = [
      "你是一位武侠小说导演/说书人。根据用户给的一句开场，构造一个充满戏剧张力、适合多人博弈的场景。",
      "要求：",
      "- 人物之间要有潜在的冲突、秘密或利益纠葛；出场人物 3-4 人；每人给出鲜明的身份、性格、目标，尽量有一两个人带秘密。",
      "- 每个人的 style（说话风格）必须【彼此迥异且非常具体】：点明用词习惯、句子长短、腔调、口头禅或语言毛病。",
      '  例如"惜字如金、多用短句、几乎不用形容词"／"满口市井黑话、爱骂人、句子糙"／"文绉绉爱掉书袋、引经据典"／"啰嗦、结巴、爱自我怀疑、废话多"／"阴阳怪气、爱反问"。',
      "- 切忌把所有人都写成同一种“文雅诗化”腔——他们要像四个来自不同世界的人。",
      '只输出一个 JSON 对象：{"background":"时间地点氛围与起因","characters":[{"name":"姓名/称号","identity":"身份","personality":"性格","goal":"目标","secret":"秘密(可省略)","style":"说话风格(要具体且与他人不同)"}]}',
      "不要输出 JSON 以外的任何文字。",
    ].join("\n");
    const user = `开场：${seed}`;

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
  ): Promise<DirectorDecision> {
    const system = [
      "你是这幕武侠戏的导演。基于背景与目前的场面，决定下一拍怎么走。",
      "你可以先用一句旁白推动气氛或加入环境事件（如有人闯入、灯灭、马蹄声由远及近），也可以不加。",
      '只输出一个 JSON 对象：{"stage":"可空的旁白/环境事件","action":"act"或"end","actor":"action=act时必须是在场人物之一的名字","reason":"一句话缘由"}',
      "调度准则：",
      "- 优先制造并推进冲突；让刚被点名、被挑衅或被针对的人有机会回应。",
      "- 避免同一个人连续独白太久，让不同人物轮番登场、彼此碰撞。",
      "- 当冲突充分、到达一个高潮或了断时，用 end 收场，不要拖沓。",
      "不要输出 JSON 以外的任何文字。",
    ].join("\n");
    const user = [
      `【背景】${scene.background}`,
      `【在场人物】\n${renderCast(scene)}`,
      `【目前的场面】\n${renderTranscript(transcript)}`,
      `【进度】已进行 ${beatNo}/${maxBeats} 拍。`,
      "请输出你的下一拍决策 JSON。",
    ].join("\n\n");

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
      "你是说书人。为这一幕武侠戏做一个简短有味道的收场白（2-4 句），点出这一幕的结局与余韵，像章回小说的结尾。只输出收场白本身。";
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
