import type { LLMClient } from "../core/llm/client.ts";
import {
  type Scene,
  type Beat,
  type DramaContext,
  renderCast,
  renderTranscript,
} from "./scene.ts";
import { SELF_CONSISTENCY_STANDARD } from "./rules.ts";
import type { ReviewIssue } from "./reviewer.ts";

/** 把评审开出的硬伤清单渲染成可读的编辑批注，喂给定向修订。 */
function renderIssues(issues: ReviewIssue[]): string {
  return issues
    .map((it, i) => {
      const lines = [`${i + 1}. 原句：${it.quote || "（未给出原句，按'为何'定位）"}`];
      if (it.why) lines.push(`   问题：${it.why}`);
      if (it.fix) lines.push(`   改法方向：${it.fix}`);
      return lines.join("\n");
    })
    .join("\n");
}

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
      `- 【细节自洽铁律】${SELF_CONSISTENCY_STANDARD}判断人物能力/生理状态时，一律以其【身份·性格·说话风格设定】为准，不要仅凭名字或诨号臆断（名号带「哑」但设定是健谈，他就是会说话的人）。`,
      "- 一旦设定写明某项生理限制（哑/盲/聋/重伤/昏迷），就贯彻到底、不同章推翻：真哑/失声者不写出成句台词，改以手势、书写、眼神、喉间呜咽或动作表意，也不要一边旁白说他不能说话、一边又给他写对白。",
      "- 你可以并且应该补充：心理活动、环境细节、动作神态、场景过渡、必要的铺垫与呼应回收，让它读起来是一篇完整小说，而非台词堆叠。",
      "- 用第三人称叙述，叙述 / 对白 / 动作 / 心理描写自然交织，不要写成“旁白 + 台词”的剧本格式。",
      "- 节奏要有张弛：先铺垫、再推进、后爆发，结尾留一句余韵，切忌全程满格。",
      "- 保持每个人物鲜明的说话风格与性格差异，贴合其原本的腔调。",
      "",
      "输出格式：第一行是一个有味道的章节标题——只写一个短语（约 3-8 字），必须【紧扣本章特有的情节、人物或意象】、每章各不相同；不要加“标题：”之类前缀，也不要带“第X章”“第一回”之类编号。切忌套用任何通用套路词或与前文雷同的字眼，也【不要】直接借用本提示里出现过的任何示范词。空一行后是正文。只输出这一章正文，不要任何解释或点评。",
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

  /**
   * 按评审开出的硬伤清单，对已成文正文做【定向修订】——把点名的硬伤逐条改掉，别的一律不碰。
   * 执笔人是文字的主人，改硬伤的落笔比评审更稳、更贴原文风。
   *
   * 输出【整章正文】（而非补丁）：本项目实测里，让模型只吐"查找→替换补丁"时，它无法可靠地
   * 逐字照抄原句作 find（会改写），导致补丁对不上、硬伤修不掉；重出整章反而能稳稳修好硬伤。
   * 为把"重出整章"的副作用（顺手润色/重排/删台词/搬锚点道具）压到最小，用下述补丁纪律约束。
   *
   * 补丁纪律：
   *   ①【硬伤必须改掉】——首要目标，清单每条都要落实，漏改比多改更糟；
   *   ②【只动被点名处】——除清单点名处外一字不改：不润色、不加戏、不删原句、不改文风与标题；
   *   ③【保次序】——绝不重排段落/句子/场景先后，不把旁白并进对白、不合并拆分段落；
   *   ④【替换而非删除】——如"新郎官"→对等的"新娘子"，而不是删掉整句；
   *   ⑤【锚点只判对错、不抄入正文】——梗概/上一章结尾/道具账本里有、正文没有的东西，绝不写进来。
   */
  async revise(
    prose: string,
    issues: ReviewIssue[],
    _scene: Scene,
    _transcript: Beat[],
    ctx?: DramaContext,
  ): Promise<string> {
    if (issues.length === 0) return prose;

    const system = [
      "你是这一章的执笔人，现在做一次【定向修订】：责任编辑挑出了若干【硬伤】（自洽/常识/设定矛盾），你要把它们逐条改掉，别的一律不动。",
      `判断硬伤的标准：${SELF_CONSISTENCY_STANDARD}`,
      "",
      "【补丁纪律】——这次你是打补丁的人，不是重写的人：",
      "① 硬伤必须改掉：清单里每一条都要落实到正文里；漏改一条硬伤，比多改十个字还糟。同一类硬伤散落多句（如一个错误人称散在整章），要逐句都改到。",
      "② 只动被点名处：除清单点名的地方外，一字不改——不润色、不加新情节新对白、不删原有的句子与段落、不改文风、不改标题。",
      "③ 改动幅度就低不就高：能改一个字（如“他”→“她”、“上品木灵根”→“黄品下等”）就绝不重写整句；只在硬伤所在的那句最小范围内落笔。",
      "④ 保次序：【绝不重排段落/句子/场景推进的先后】、不把旁白并进对白、不合并或拆分段落——除非某处顺序本身就是清单点名的硬伤。原稿怎么排，改完还怎么排。",
      "⑤ 替换而非删除：如“新郎官”这类要换成对等的“新娘子”，而不是把整句删空。",
      "⑥ 锚点只判对错、不抄入正文：梗概/上一章结尾/道具账本只用来判断“正确答案是什么”，其中提到、但正文原本没写的道具/称呼/情节，一律【不得】写进正文。",
      "",
      "【交稿前双向自检】回读一遍再收笔：a) 清单每一条是否都真的改掉了、且改后与锚点/常识自洽？b) 有没有手滑动到没被点名的地方（尤其段落顺序、旁白与对白的分合、有没有多写了原文没有的东西）？两头都干净才算过关。",
      "",
      "输出：只输出修订后的完整正文（含原标题那一行，标题不要改），从头到尾一字不落、段落顺序与原稿完全一致，不要任何解释、不要保留批注、不要标注改了哪里。",
    ].join("\n");

    // 刻意【不喂原始 transcript】：喂了剧本会诱使执笔人把正文往剧本次序上"对齐"而重排、越改越多。
    // 锚点也都标注为"判对错用、勿抄入正文"，防止把梗概里的道具/称呼搬进正文（伤最小改动）。
    const user = [
      ctx?.goal ? `【本章目标】${ctx.goal}` : "",
      ctx?.storySoFar ? `【故事梗概至今（判对错用，勿抄入正文）】\n${ctx.storySoFar}` : "",
      ctx?.deadRoster ? `【已故人物（判对错用，勿抄入正文）】\n${ctx.deadRoster}` : "",
      ctx?.propLedger ? `【关键道具账本（判对错用，勿抄入正文）】\n${ctx.propLedger}` : "",
      ctx?.previousChapterTail
        ? `【上一章结尾（判对错用，勿抄入正文）】\n${ctx.previousChapterTail}`
        : "",
      `【责任编辑挑出的硬伤清单（逐条改掉，别的不碰）】\n${renderIssues(issues)}`,
      `【待修订的本章正文】\n${prose}`,
      "请按补丁纪律做定点修订：只改清单点名处，保持段落顺序与文风不变，只输出修订后的完整正文。",
    ]
      .filter(Boolean)
      .join("\n\n");

    const { message } = await this.client.chat({
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0.3,
    });
    return message.content?.trim() || prose;
  }
}
