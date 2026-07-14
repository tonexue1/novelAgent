/**
 * 一章生成过程中对外广播的结构化事件。
 *
 * 事件与消费方式解耦：agent/engine 只负责 emit，谁来消费、怎么消费由调用方决定。
 * CLI（src/novel.ts）把它们逐条打到终端，实时展现"演章 → 成文 → 更新记忆"的推进。
 */

import type { Character } from "./scene.ts";

/** 公开人物信息（刻意不含 secret，保留悬念）。 */
export interface PublicCharacter {
  name: string;
  identity: string;
  personality: string;
  goal: string;
  style: string;
}

export function toPublicCharacter(c: Character): PublicCharacter {
  return {
    name: c.name,
    identity: c.identity,
    personality: c.personality,
    goal: c.goal,
    style: c.style,
  };
}

export type DramaEvent =
  /** 开场：导演给出的引子（原样回显）。 */
  | { type: "seed"; seed: string }
  /** 分幕步骤标题，对应 CLI 里的 Step。 */
  | { type: "step"; n: number; title: string }
  /** 场景就绪：背景 + 登场人物。 */
  | { type: "scene"; background: string; characters: PublicCharacter[] }
  /** 旁白 / 环境事件。 */
  | { type: "narration"; content: string }
  /** 某角色的一次表演。 */
  | { type: "beat"; actor: string; content: string }
  /** 导演示意收场。 */
  | { type: "director-end"; reason?: string }
  /** 演出（导演+角色）阶段结束，可以交给执笔人成文了。 */
  | { type: "play-complete" }
  /** 执笔人成文的最终小说体正文。 */
  | { type: "prose"; content: string }
  /** 整幕结束。 */
  | { type: "done" }
  /** 出错（一般由服务端包裹后发出）。 */
  | { type: "error"; message: string }
  // ── 多章小说层事件 ──────────────────────────────
  /** 整书大纲就绪（建项目或修订后）。 */
  | {
      type: "outline";
      title: string;
      premise: string;
      logline: string;
      chapters: { n: number; title: string; goal: string; status: string }[];
      /** 规划模式（"whole" | "rolling"）。 */
      mode?: string;
      /** 分卷路线图（仅 rolling 模式）。 */
      arcs?: { n: number; title: string; summary: string; chapters: number; status: string }[];
      /** 当前活跃卷号（仅 rolling 模式）。 */
      currentArc?: number;
      /** 目标总章数（仅 rolling 模式）。 */
      targetChapters?: number;
    }
  /** 开始展开新的一卷（仅 rolling 模式）。 */
  | { type: "arc-start"; n: number; title: string; summary: string }
  /** 开始生成某一章。 */
  | { type: "chapter-start"; n: number; title: string; goal: string }
  /** 某一章成文完成。 */
  | { type: "chapter-prose"; n: number; title: string; content: string }
  /** 本章记忆已更新（供前端刷新记忆面板）。 */
  | { type: "memory-updated"; summary: string; openThreads: string[]; latestEvent?: string }
  /** 整书完成（无更多待写章节）。 */
  | { type: "novel-complete"; chaptersWritten: number };

export type DramaEventSink = (event: DramaEvent) => void;
