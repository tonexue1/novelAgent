import type { Reviewer } from "./reviewer.ts";
import { isPass } from "./reviewer.ts";
import type { Novelist } from "./novelist.ts";
import type { Scene, Beat, DramaContext } from "./scene.ts";

/**
 * 反射循环（critique ⇄ revise）的编排：评审只挑刺，执笔人定向改，改完再审，直到无硬伤（pass）
 * 或用满轮数。抽成共享模块，让正式产出（agent.ts）与看护评测（eval/run.ts）跑的是同一套逻辑，
 * eval 才真正看得住线上行为。
 */

/** 反射循环里每一轮的记录，供日志/事件/eval 观测。 */
export interface ReflectRound {
  /** 第几轮（1-based）。 */
  round: number;
  /** 本轮评审挑出的硬伤数。 */
  issueCount: number;
  /** 评审产出是否成功解析（false=审不出，按通过兜底）。 */
  parsed: boolean;
  /** 本轮是否真的采纳了修订稿（通过防截断判定并替换）。 */
  revised: boolean;
  /** 本轮因异常（超时/内容审核/网络等）中断时的一行原因；正常轮为空。 */
  error?: string;
}

/** 一次反射循环的结果。 */
export interface ReflectResult {
  /** 最终稿。 */
  prose: string;
  /** 逐轮记录。 */
  rounds: ReflectRound[];
  /** 是否以"评审无硬伤"收尾（用满轮数仍有硬伤则为 false）。 */
  passed: boolean;
}

/** 反射循环参数。 */
export interface ReflectOptions {
  /** 最多几轮 critique-revise。<=0 视为不做反射，原样返回。 */
  maxRounds: number;
  /** 每轮结束回调（打日志/发事件）。 */
  onRound?: (r: ReflectRound) => void;
  /** 防截断阈值，默认 0.5。 */
  minKeepRatio?: number;
}

/**
 * 防截断护栏：判断一份定向修订稿能否采纳。纯函数、可单测。
 *
 * 定向修订本应与原文长度相当。若修订稿为空、与原文一字不差、或相比原文骤缩到不足
 * minKeepRatio，多半是模型截断/答非所问/误删大段——宁可弃用、保留上一版，也不让烂稿
 * 盖掉好稿（best-effort）。返回 true 才替换。
 */
export function acceptRevision(prev: string, next: string, minKeepRatio = 0.5): boolean {
  const p = prev.trim();
  const n = next.trim();
  if (!n) return false;
  if (n === p) return false;
  if (p.length === 0) return true;
  return n.length >= p.length * minKeepRatio;
}

/**
 * 跑一轮或多轮"评审挑刺 → 执笔人定向修订"反射循环。
 *
 * - 评审无硬伤（含审不出、按通过兜底）→ 记一轮并早退，passed=true；
 * - 有硬伤 → 执笔人定向修订，过了防截断护栏才替换，然后进入下一轮复审；
 * - 修订稿没通过护栏（截断/没变化）→ 无法安全改进，保留当前稿并退出（best-effort）；
 * - 用满 maxRounds 仍有硬伤 → 返回目前最好的一版，passed=false。
 *
 * 【best-effort 内建】任一轮里评审或修订抛异常（超时/内容审核/网络抖动等），不外抛、不崩：
 * 记一条带 error 的轮次、就此收手，返回【目前最好的一版】（已采纳的修订都保留）。这样正式管线
 * 与 eval 都拿这份兜底逻辑，一次超时不会拖垮整章成文，也不会让 eval 直接退出。
 */
export async function reflectReview(
  reviewer: Reviewer,
  novelist: Novelist,
  prose: string,
  scene: Scene,
  transcript: Beat[],
  ctx: DramaContext | undefined,
  opts: ReflectOptions,
): Promise<ReflectResult> {
  const rounds: ReflectRound[] = [];
  const minKeepRatio = opts.minKeepRatio ?? 0.5;
  let current = prose;

  if (opts.maxRounds <= 0) return { prose: current, rounds, passed: true };

  const oneLine = (err: unknown): string =>
    err instanceof Error ? err.message.split("\n")[0]! : String(err);

  for (let round = 1; round <= opts.maxRounds; round++) {
    let critique;
    try {
      critique = await reviewer.critique(current, scene, transcript, ctx);
    } catch (err) {
      const rec: ReflectRound = { round, issueCount: 0, parsed: false, revised: false, error: oneLine(err) };
      rounds.push(rec);
      opts.onRound?.(rec);
      break; // 评审都跑不动：保留当前稿收手
    }

    if (isPass(critique)) {
      const rec: ReflectRound = { round, issueCount: 0, parsed: critique.parsed, revised: false };
      rounds.push(rec);
      opts.onRound?.(rec);
      return { prose: current, rounds, passed: true };
    }

    let candidate;
    try {
      candidate = await novelist.revise(current, critique.issues, scene, transcript, ctx);
    } catch (err) {
      const rec: ReflectRound = {
        round,
        issueCount: critique.issues.length,
        parsed: critique.parsed,
        revised: false,
        error: oneLine(err),
      };
      rounds.push(rec);
      opts.onRound?.(rec);
      break; // 修订跑不动：保留当前（含此前已采纳的修订）收手
    }

    const accepted = acceptRevision(current, candidate, minKeepRatio);
    const rec: ReflectRound = {
      round,
      issueCount: critique.issues.length,
      parsed: critique.parsed,
      revised: accepted,
    };
    rounds.push(rec);
    opts.onRound?.(rec);

    if (!accepted) break;
    current = candidate;
  }

  return { prose: current, rounds, passed: false };
}
