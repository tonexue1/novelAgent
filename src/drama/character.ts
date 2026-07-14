import type { LLMClient } from "../core/llm/client.ts";
import { type Character, type Scene, type Beat, renderCast, renderTranscript } from "./scene.ts";

/**
 * 角色行动者：把一个人物设定包成能"见机行事"的 agent。
 *
 * 轮到自己时，它读【背景 + 当前场面 + 导演给的提示】，以第一人称给出一段
 * 有语言、有动作的表演。人物设定（性格/目标/秘密/说话风格）塑造它的行为，
 * 这也是"多角色对话"里性格差异与戏剧张力的来源。
 */

/** 由人物设定构建该角色的系统提示词。genrePersona 缺省视为"武侠小说"。 */
export function buildCharacterSystem(c: Character, genrePersona = "武侠小说"): string {
  return [
    `你在出演一部${genrePersona}里的角色：${c.name}。`,
    `身份：${c.identity}`,
    `性格：${c.personality}`,
    `目标：${c.goal}`,
    c.secret ? `你有一个秘密（不要轻易透露）：${c.secret}` : "",
    `说话风格（务必贯穿每一句，这是你区别于他人的核心）：${c.style}`,
    "",
    "表演要求：",
    "- 始终以第一人称保持这个角色，绝不跳出戏、绝不替别人说话或行动。",
    "- 若你的身份/性格设定带有生理限制（如哑、盲、聋、重伤、失声），务必据此表演：哑者/失声者不说话，只以手势、书写、眼神、点头摇头、喉间呜咽与动作表意（用括号写动作，不要写出成句台词）；盲者不靠视觉、聋者不靠听觉。绝不违背这一设定。",
    "- 用你【自己独特的说话风格】说话：用词、句子长短、语气、口头禅都要严格贴合上面的风格，让人一听就知道是你，而不是别人。",
    "- 不要用千篇一律的“华丽散文诗”腔（除非你的风格本就如此）：该粗俗就粗俗、该木讷就木讷、该油滑就油滑、该文绉绉就文绉绉。",
    "- 尽量直接回应上一位说的【具体某句话】，像真的在对话，而不是各说各的独白。",
    "- 一段话之内可以说话、可有简短动作/神态（括号里），紧扣性格与目标；控制在 3 句以内。",
    "- 只输出你这一次的表演内容本身，不要加旁白、不要写别人的反应。",
  ]
    .filter(Boolean)
    .join("\n");
}

export class CharacterActor {
  constructor(
    private readonly client: LLMClient,
    readonly character: Character,
  ) {}

  /**
   * 轮到该角色行动。
   * @param hint 导演给的临场提示（可空），例如"门外传来马蹄声，你听到了"。
   */
  async act(scene: Scene, transcript: Beat[], hint?: string, genrePersona?: string): Promise<string> {
    const system = buildCharacterSystem(this.character, genrePersona);
    const user = [
      `【场景背景】${scene.background}`,
      `【在场人物】\n${renderCast(scene)}`,
      `【目前的场面】\n${renderTranscript(transcript)}`,
      hint ? `【此刻】${hint}` : "",
      `现在轮到你（${this.character.name}）行动，请给出你的表演。`,
    ]
      .filter(Boolean)
      .join("\n\n");

    const { message } = await this.client.chat({
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0.9,
    });
    return message.content?.trim() || "(沉默不语)";
  }
}
