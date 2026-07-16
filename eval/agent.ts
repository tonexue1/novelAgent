/**
 * 评测 agent（裁判，薄壳）：组 prompt、发请求，产出交纯函数 parse.* 解析。
 * 用 `client.withRole("eval")`，模型走 OPENAI_MODEL_EVAL（缺省回落 OPENAI_MODEL）。
 *
 * 本文件只负责「怎么问裁判」；打分口径在 rubric.ts、解析在 parse.ts（均纯函数、可单测）。
 */

import type { LLMClient } from "../src/core/llm/client.ts";
import { renderWorldBrief } from "../src/story/memory.ts";
import { renderStyleCard } from "../src/story/style.ts";
import { renderTranscript } from "../src/drama/scene.ts";
import type { Beat } from "../src/drama/scene.ts";
import type { Outline, WorldBible, StyleCard, StyleIntensity } from "../src/story/types.ts";
import {
  PLAN_RUBRIC,
  PROSE_RUBRIC,
  REVIEW_RUBRIC,
  renderRubricForPrompt,
  type EvalScore,
} from "./rubric.ts";
import { parsePlanScore, parseProseScore, parseReviewScore } from "./parse.ts";

/** 裁判统一的输出格式约定（严格 JSON）。 */
function outputContract(): string {
  return [
    "只输出一个 JSON 对象，形如：",
    '{"metrics":[{"id":"评测点id","score":1到5的整数,"comment":"简短评语"}],',
    '"overall":0到100的综合分,"strengths":["优点"],"issues":["问题"],"suggestions":["修改建议"]}',
    "metrics 必须逐项覆盖上面列出的每一个评测点 id；score 为 1-5 整数（越高越好）。",
    "评语要具体、可执行，指出证据；不要输出 JSON 以外的任何文字。",
  ].join("\n");
}

export class EvalAgent {
  private readonly client: LLMClient;

  constructor(client: LLMClient) {
    this.client = client.withRole("eval");
  }

  /** 评测章节规划（大纲）。 */
  async evalPlan(input: {
    seed: string;
    genre?: string;
    title: string;
    outline: Outline;
    worldBible?: WorldBible;
  }): Promise<EvalScore> {
    const { seed, genre, title, outline, worldBible } = input;
    const system = [
      "你是一位资深的类型小说主编，负责为一份【章节规划/大纲】按给定评测点严格打分。",
      "你只评规划质量（结构、主线、递进、无重复、题材贴合、世界观、收束等），不改写内容。",
      "",
      "评测点（逐项打分，1-5 分）：",
      renderRubricForPrompt(PLAN_RUBRIC),
      "",
      outputContract(),
    ].join("\n");

    const chaptersText = outline.chapters
      .map((c) => `${c.n}. 《${c.title}》：${c.goal}`)
      .join("\n");
    // 分卷滚动规划：只展开了第一卷，其余卷仍为卷级路线图。
    // 让裁判据【路线图（卷级结构/递进/收束）+ 第一卷分章样例（钩子/具体度）】综合评。
    const rolling = outline.mode === "rolling" && (outline.arcs?.length ?? 0) > 0;
    const roadmapText = rolling
      ? outline
          .arcs!.map((a) => `第${a.n}卷《${a.title}》（约${a.chapters}章）：${a.summary}`)
          .join("\n")
      : "";
    const rollingNote = rolling
      ? "注意：本规划为【分卷滚动】——只展开了第一卷的分章，其余卷仍是卷级路线图（这是长篇的正常形态，不应因'后续未细化到章'而扣结构/收束分）。" +
        `请据【分卷路线图】评全书的结构完整/主线贯穿/递进/无重复/收束/节奏，据【第一卷分章样例】评钩子与世界观具体度。目标总章数约 ${outline.targetChapters ?? outline.chapters.length} 章。`
      : "";

    const user = [
      `【题材】${genre ?? "（默认）"}`,
      `【前提】${seed}`,
      `【书名】${title}`,
      outline.logline ? `【一句话主线】${outline.logline}` : "",
      outline.throughline ? `【贯穿冲突】${outline.throughline}` : "",
      outline.ending ? `【结局方向】${outline.ending}` : "",
      worldBible ? `【世界观圣经】\n${renderWorldBrief(worldBible)}` : "",
      rollingNote,
      rolling ? `【分卷路线图（共 ${outline.arcs!.length} 卷）】\n${roadmapText}` : "",
      rolling
        ? `【第一卷已细化分章样例（共 ${outline.chapters.length} 章）】\n${chaptersText}`
        : `【分章大纲（共 ${outline.chapters.length} 章）】\n${chaptersText}`,
      "请按评测点打分，输出 JSON。",
    ]
      .filter(Boolean)
      .join("\n\n");

    const { message } = await this.client.chat({
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0.2,
      maxTokens: 3000,
    });
    return parsePlanScore(message.content ?? "");
  }

  /** 评测文笔风味：给定目标风味卡 + 交互记录 + 成文，评风味契合与文笔质量。 */
  async evalProse(input: {
    prose: string;
    goal: string;
    transcript: Beat[];
    styleCard?: StyleCard;
    styleIntensity?: StyleIntensity;
  }): Promise<EvalScore> {
    const { prose, goal, transcript, styleCard, styleIntensity } = input;
    const styleStandard = styleCard
      ? renderStyleCard(styleCard, styleIntensity ?? "medium")
      : "（未指定目标风味；风味契合项按‘是否有稳定统一的叙述质感’酌情评分）";

    const system = [
      "你是一位严格的文学编辑，负责为一段【小说正文】按给定评测点打分。",
      "重点判断：这段正文是否贴合【目标风味标准】，是否忠于【交互记录】里已发生的事实，以及文笔质量。",
      "",
      "【目标风味标准】（评‘风味契合’以此为准）：",
      styleStandard,
      "",
      "评测点（逐项打分，1-5 分）：",
      renderRubricForPrompt(PROSE_RUBRIC),
      "",
      outputContract(),
    ].join("\n");

    const user = [
      `【本章目标】${goal}`,
      `【交互记录（成文须忠于此，不得篡改/新增重大情节）】\n${renderTranscript(transcript, 100)}`,
      `【被评正文】\n${prose}`,
      "请按评测点打分，输出 JSON。",
    ].join("\n\n");

    const { message } = await this.client.chat({
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0.2,
      maxTokens: 3000,
    });
    return parseProseScore(message.content ?? "");
  }

  /**
   * 评测【审校】：给定原稿、审校后的修订稿、以及植入的已知硬伤与须保留的故事要素，
   * 核对审校是否【修掉了硬伤】且【没改变故事】。这是给 Reviewer 的"看护"评测。
   */
  async evalReview(input: {
    goal: string;
    draft: string;
    revised: string;
    plantedBugs: string[];
    invariants: string[];
  }): Promise<EvalScore> {
    const { goal, draft, revised, plantedBugs, invariants } = input;
    const system = [
      "你是一位严格的审校质检裁判。下面给你一段【原稿】、一段由审校 agent 产出的【修订稿】，",
      "以及【原稿里植入的已知硬伤】（审校应当修掉）和【须保留的故事要素】（审校绝不能改动）。",
      "你的判断重点：",
      "1) 逐条核对【已知硬伤】是否在修订稿里被真正修正（改没改到点子上）；漏改、没改干净都要扣分。",
      "2) 逐条核对【须保留的故事要素】是否原样保留——审校只该修硬伤，【不得改变情节、人物、结局、设定或文风】。",
      "3) 改动是否克制、有无引入新的矛盾/病句、标题与结构是否保留。",
      "",
      "评测点（逐项打分，1-5 分）：",
      renderRubricForPrompt(REVIEW_RUBRIC),
      "",
      outputContract(),
    ].join("\n");

    const user = [
      `【本章目标】${goal}`,
      `【原稿里植入的已知硬伤（修订稿应修正）】\n${plantedBugs.map((b, i) => `${i + 1}. ${b}`).join("\n")}`,
      `【须保留的故事要素（修订稿不得改动）】\n${invariants.map((v, i) => `${i + 1}. ${v}`).join("\n")}`,
      `【原稿】\n${draft}`,
      `【修订稿】\n${revised}`,
      "请按评测点打分，输出 JSON。",
    ].join("\n\n");

    const { message } = await this.client.chat({
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0.2,
      maxTokens: 3000,
    });
    return parseReviewScore(message.content ?? "");
  }
}
