/**
 * 一幕戏在演出过程中对外广播的结构化事件。
 *
 * CLI 端不关心这些事件（照旧走 logger 打终端）；Web 端则把它们经 SSE
 * 实时推给浏览器，从而"一拍一拍"地看戏。事件与传输方式解耦：agent 只负责
 * emit，谁来消费、怎么消费由调用方决定。
 */

import type { Character } from "./scene.ts";

/** 供前端展示的公开人物信息（刻意不含 secret，保留悬念）。 */
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
  /** 关闭执笔人时，导演的简短收场白。 */
  | { type: "epilogue"; content: string }
  /** 执笔人成文的最终小说体正文。 */
  | { type: "prose"; content: string }
  /** 整幕结束。 */
  | { type: "done" }
  /** 出错（一般由服务端包裹后发出）。 */
  | { type: "error"; message: string };

export type DramaEventSink = (event: DramaEvent) => void;
