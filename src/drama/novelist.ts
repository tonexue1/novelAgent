import type { LLMClient } from "../core/llm/client.ts";
import { type Scene, type Beat, renderCast, renderTranscript } from "./scene.ts";

/**
 * 执笔人（单 agent 收尾）。
 *
 * 这是"多 agent 产情节、单 agent 出文笔"混合模式的关键一环：
 *   - 导演 + 角色即兴演出，产出带【涌现性】的原始 beats（谁做了什么、抖了什么包袱）；
 *   - 执笔人再用【全局视角】把整幕 transcript 一次性改写成小说体——补心理、补环境、
 *     调节奏、埋伏笔与回收。
 *
 * 由此：情节的意外感来自多 agent，文笔的连贯感来自这一步单 agent。这正好回应了
 * "多角色轮流朗诵读着散、单个作者写得连贯"的根因——把整幕交给一个脑子统一执笔。
 */
export class Novelist {
  constructor(private readonly client: LLMClient) {}

  /** 把整幕即兴记录改写成一章小说体正文（含标题）。 */
  async write(scene: Scene, transcript: Beat[], seed?: string): Promise<string> {
    const system = [
      "你是一位文笔老练的武侠/幻想小说家。下面会给你一幕戏的【原始即兴记录】（多名角色临场演出 + 导演旁白）。",
      "请把它改写成一章【完整、连贯、好读】的小说正文，质感像正式出版的章回小说。",
      "",
      "硬性要求（务必遵守）：",
      "- 忠于已发生的事实：谁做了什么、说了什么、最终结局，都不得推翻或改写；不要凭空加入重大新情节或新人物。",
      "- 你可以并且应该补充：心理活动、环境细节、动作神态、场景过渡、必要的铺垫与呼应回收，让它读起来是一篇完整小说，而非台词堆叠。",
      "- 用第三人称叙述，叙述 / 对白 / 动作 / 心理描写自然交织，不要写成“旁白 + 台词”的剧本格式。",
      "- 节奏要有张弛：先铺垫、再推进、后爆发，结尾留一句余韵，切忌全程满格。",
      "- 保持每个人物鲜明的说话风格与性格差异，贴合其原本的腔调。",
      "",
      "输出格式：第一行是一个有味道的章节标题——只写一个短语即可（如“匣中血”“禁书区夜话”），不要加“标题：”之类前缀，也不要带“第X章”“第一回”之类编号。空一行后是正文。只输出这一章正文，不要任何解释或点评。",
    ].join("\n");

    const user = [
      seed ? `【故事缘起】${seed}` : "",
      `【背景】${scene.background}`,
      `【登场人物】\n${renderCast(scene)}`,
      `【原始即兴记录】\n${renderTranscript(transcript, 100)}`,
      "请据此改写成一章小说正文。",
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
    return message.content?.trim() || "（执笔人搁笔，未能成文。）";
  }
}
