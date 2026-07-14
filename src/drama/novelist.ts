import type { LLMClient } from "../core/llm/client.ts";
import {
  type Scene,
  type Beat,
  type DramaContext,
  renderCast,
  renderTranscript,
} from "./scene.ts";

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

  /**
   * 把整幕即兴记录改写成一章小说体正文（含标题）。
   * 传入 {@link DramaContext} 时进入"多章"模式：正文要承接上一章、扣住本章目标，
   * 与故事梗概保持连贯。
   */
  async write(
    scene: Scene,
    transcript: Beat[],
    seed?: string,
    ctx?: DramaContext,
  ): Promise<string> {
    const continuity = ctx
      ? [
          "",
          "本章是一部连载小说的第 " + ctx.chapterNo + " 章，务必与前文连贯：",
          "- 承接上一章结尾、自然过渡，但【绝不复述或重演】上一章已经写过的场面、动作与对白：本章正文要从上一章结尾【之后】的时刻写起，直接进入本章内容，别把上一章末尾那几段重讲一遍。也不要从头重新交代已知设定。",
          "- 围绕【本章目标】展开，推进主线；与【故事梗概至今】保持一致，不得与既有事实矛盾。",
          "- 【已故人物】里的人只能作回忆/被提及/尸首出现，绝不能写成当下还在说话行动的活人。",
          "- 【关键道具】的持有者/位置以账本为准，不要凭空改写谁拿着它、藏在哪。",
          "- 不要重述【已发生·勿重复】里已写过的情节；本章要往前推进，而非复盘。",
        ]
      : [];

    const persona = ctx?.genrePersona ?? "武侠/幻想小说";
    const styleBlock = ctx?.narrationStyle
      ? ["", "本书的叙述风味（务必贯彻到叙述、旁白与描写中）：", ctx.narrationStyle]
      : [];
    // 第 1 章开篇：把风味卡的「开篇起势」运镜指引也纳入成文，让开篇立威、带出世界质感。
    const openingBlock =
      ctx?.chapterNo === 1 && ctx.directionStyle
        ? ["", "本章是全书开篇，务必按下述运镜起势（开篇先立威造势、带出世界格局，再落到人物）：", ctx.directionStyle]
        : [];
    const system = [
      `你是一位文笔老练的${persona}家。下面会给你一幕戏的【原始即兴记录】（多名角色临场演出 + 导演旁白）。`,
      "请把它改写成一章【完整、连贯、好读】的小说正文，质感像正式出版的章回小说。",
      ctx?.genreStyle ? `文笔基调：${ctx.genreStyle}` : "",
      ...styleBlock,
      ...openingBlock,
      ...continuity,
      "",
      "硬性要求（务必遵守）：",
      "- 忠于已发生的事实：谁做了什么、说了什么、最终结局，都不得推翻或改写；不要凭空加入重大新情节或新人物。",
      "- 严格保持每条发言/动作的【归属】：谁说的、谁做的，必须与原始记录里的行动者一致，绝不可张冠李戴、合并或对调说话人；由此带出的称谓（母亲/爹/哥…）也要与真正的说话人身份吻合。",
      "- 你可以并且应该补充：心理活动、环境细节、动作神态、场景过渡、必要的铺垫与呼应回收，让它读起来是一篇完整小说，而非台词堆叠。",
      "- 用第三人称叙述，叙述 / 对白 / 动作 / 心理描写自然交织，不要写成“旁白 + 台词”的剧本格式。",
      "- 节奏要有张弛：先铺垫、再推进、后爆发，结尾留一句余韵，切忌全程满格。",
      "- 保持每个人物鲜明的说话风格与性格差异，贴合其原本的腔调。",
      "",
      "输出格式：第一行是一个有味道的章节标题——只写一个短语即可（如“匣中血”“禁书区夜话”），不要加“标题：”之类前缀，也不要带“第X章”“第一回”之类编号。空一行后是正文。只输出这一章正文，不要任何解释或点评。",
    ].join("\n");

    const user = [
      seed ? `【故事缘起】${seed}` : "",
      ctx ? `【本章目标】${ctx.goal}` : "",
      ctx?.storySoFar ? `【故事梗概至今】\n${ctx.storySoFar}` : "",
      ctx?.deadRoster ? `【已故人物（勿写成活人）】\n${ctx.deadRoster}` : "",
      ctx?.propLedger ? `【关键道具账本】\n${ctx.propLedger}` : "",
      ctx?.achievements ? `【已发生·勿重复】\n${ctx.achievements}` : "",
      ctx?.previousChapterTail
        ? `【上一章结尾（仅供无缝承接语气与时点，切勿照抄或复述其内容）】\n${ctx.previousChapterTail}`
        : "",
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
