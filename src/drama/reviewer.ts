import type { LLMClient } from "../core/llm/client.ts";
import {
  type Scene,
  type Beat,
  type DramaContext,
  renderCast,
  renderTranscript,
} from "./scene.ts";
import { SELF_CONSISTENCY_STANDARD } from "./rules.ts";
import { extractJsonObject, str } from "../core/json.ts";

/** 评审挑出的一处硬伤。 */
export interface ReviewIssue {
  /** 原句片段（逐字照抄原文，供修订方精确定位）。 */
  quote: string;
  /** 为何是硬伤（撞了哪条锚点 / 哪条常识）。 */
  why: string;
  /** 改法方向（只给方向，不重写整段）。 */
  fix: string;
}

/** 一次评审结果。 */
export interface CritiqueResult {
  /** 挑出的硬伤清单；空 = 通过（pass）。 */
  issues: ReviewIssue[];
  /**
   * 评审产出是否被成功解析。false 表示裁判文本没法解析成清单——
   * 上层应按"审不出、暂当通过"处理（best-effort），而不是崩、也不误判成有硬伤。
   */
  parsed: boolean;
}

/** 无硬伤即通过。 */
export function isPass(c: CritiqueResult): boolean {
  return c.issues.length === 0;
}

/**
 * 审校 / 责任编辑——成文之后的一道兜底网，在 critic/actor 反射循环里担任【评审】。
 *
 * 为什么这么分工：生成阶段（导演/角色/执笔人）无论堆多少提示只能【预防】自洽问题，
 * 且永远慢下一个没见过的破绽一步。评审这一步反过来【主动捕捉】一整类逻辑/常识/时间线/
 * 人设/既有事实矛盾——靠一条通用标准审整类错误，取代"每个 bug 追加一条例子化铁律"。
 *
 * 它【只挑刺、不改稿】：找硬伤是评审的强项，写文字是执笔人的强项。评审列出硬伤清单，
 * 交回执笔人（Novelist.revise）定向修订，再回来复审，直到无硬伤（pass）——见 reflect.ts。
 * 这样避免了"评审兼职改写、结果改得太多/伤了文风"的老毛病。
 *
 * 方法：先立时空/人物/事实三类锚点，再逐句拿每处细节比对锚点与常识，把硬伤找全。
 * 这是通用方法，覆盖整类自洽问题，而非针对某个具体破绽打补丁。
 */
export class Reviewer {
  constructor(private readonly client: LLMClient) {}

  /**
   * 审校一章正文，返回硬伤清单（只挑刺、不改稿）。无硬伤则清单为空（pass）。
   * 解析失败时返回 parsed:false + 空清单，由调用方按"审不出、暂当通过"兜底（见 reflect.ts）。
   */
  async critique(
    prose: string,
    scene: Scene,
    transcript: Beat[],
    ctx?: DramaContext,
  ): Promise<CritiqueResult> {
    const system = [
      "你是一位严格的责任编辑，为一章已成文的小说做【自洽审校】。你的职责只有一个：把硬伤【找全】、逐条列出来——你【只挑刺、不改稿】。",
      `审校标准（据此判定什么算硬伤）：${SELF_CONSISTENCY_STANDARD}`,
      "",
      "【方法：先立锚点，再逐句扫描】",
      "第一步·立锚点。先从设定与前文里立起三类基准：",
      "  ① 时空锚点：此刻何年月/季节/时辰/地点，距书中已发生之事（旅行/战斗/别离…）过去多久；",
      "  ② 人物锚点：每个人的身份、性别、性格、生理限制（哑/盲/聋/伤/病）、说话与行事风格；",
      "  ③ 事实锚点：已故者、关键道具的归属与来历、前文已确立的情节与设定。",
      "第二步·逐句扫描，把硬伤找全。把正文里每一处【具体细节】——痕迹、动作、指令、天气物候、身体状态、道具、称谓、性别、灵根/身份品阶、因果——逐一拎出来，追问：它与三类锚点冲突吗？合不合物理与生活常识？",
      "  特别警惕两类：①【错置的即时细节】——只有'刚刚发生'才成立的痕迹/状态，被安到了很久以前发生的事上（时间线一拉长就露馅）；②【跨章被悄悄改掉的既有设定】——前文/梗概里已钉死的事实（谁的性别、品阶、身份、生死、归属），本章被改成了另一个样。",
      "只报【确属硬伤】的自洽/常识/设定矛盾；文风、用词、润色一类主观好恶不归你管，不要报。",
      "",
      "【输出格式：先审后报，务必两步走】",
      "第一步·先写出你的【审查过程】（自然语言，别偷懒）：先把立好的三类锚点简述一遍，再【逐段】把正文里的可疑细节拎出来对照锚点与常识，逐条说清它到底成不成立。这一步是为了逼你真的去查——直接下结论'没问题'是被禁止的。",
      "第二步·在最末尾输出一个 JSON 对象，把上一步确认的硬伤汇总（审查过程里不要出现花括号 {}，以免干扰解析）：",
      '{"issues":[{"quote":"原句片段(逐字照抄原文)","why":"为何是硬伤(撞哪条锚点/哪条常识)","fix":"改法方向(只给方向，别重写整段)"}]}',
      '通篇确经逐段核对后仍无硬伤，才在末尾输出 {"issues":[]}。同一类硬伤散布全章（如一个称呼错了一整章）也要逐处列全，别只列一处。',
    ].join("\n");

    const user = [
      ctx?.goal ? `【本章目标】${ctx.goal}` : "",
      ctx?.storySoFar ? `【故事梗概至今】\n${ctx.storySoFar}` : "",
      ctx?.deadRoster ? `【已故人物（不得写成活人）】\n${ctx.deadRoster}` : "",
      ctx?.propLedger ? `【关键道具账本】\n${ctx.propLedger}` : "",
      ctx?.previousChapterTail
        ? `【上一章结尾（供时间线/承接核对）】\n${ctx.previousChapterTail}`
        : "",
      `【背景】${scene.background}`,
      `【登场人物】\n${renderCast(scene)}`,
      `【原始情节依据（谁说谁做以此为准）】\n${renderTranscript(transcript, 100)}`,
      `【待审校的本章正文】\n${prose}`,
      `请先写审查过程（立锚点 + 逐段核对可疑细节），最后再在末尾输出硬伤清单 JSON。`,
    ]
      .filter(Boolean)
      .join("\n\n");

    const { message } = await this.client.chat({
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0.2,
    });
    return parseCritique(message.content ?? "");
  }
}

/**
 * 从评审产出里解析硬伤清单。纯函数、可单测。
 * - 能解析出 {issues:[...]}：逐条取 quote/why/fix，过滤空对象；
 * - 解析不出（乱码/答非所问/无 issues 字段）：返回 parsed:false + 空清单，
 *   让上层按"审不出、暂当通过"兜底，而非崩或误判有硬伤。
 */
export function parseCritique(content: string): CritiqueResult {
  const obj = extractJsonObject(content ?? "");
  if (!obj || !Array.isArray(obj.issues)) {
    return { issues: [], parsed: false };
  }
  const issues: ReviewIssue[] = [];
  for (const raw of obj.issues) {
    if (!raw || typeof raw !== "object") continue;
    const o = raw as Record<string, unknown>;
    const quote = str(o.quote);
    const why = str(o.why);
    const fix = str(o.fix);
    // 至少要有 quote 或 why 才算一条有效硬伤，避免空对象污染清单。
    if (!quote && !why) continue;
    issues.push({ quote, why, fix });
  }
  return { issues, parsed: true };
}
