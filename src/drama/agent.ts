import { LLMClient } from "../core/llm/client.ts";
import { logger } from "../core/logger.ts";
import {
  type Scene,
  type Beat,
  type DramaContext,
  renderCast,
  castNames,
} from "./scene.ts";
import { CharacterActor } from "./character.ts";
import { Director } from "./director.ts";
import { Novelist } from "./novelist.ts";
import { Reviewer } from "./reviewer.ts";
import { reflectReview } from "./reflect.ts";
import {
  type DramaEvent,
  type DramaEventSink,
  toPublicCharacter,
} from "./events.ts";

export interface WuxiaDramaOptions {
  client: LLMClient;
  /** 一幕最多演多少拍，防止太长/成本过高。 */
  maxBeats?: number;
  /**
   * 可选：演出过程中的结构化事件回调。NovelEngine 接上它即可把每一拍逐条
   * 推给上层（CLI 打印）。不影响原有的终端日志。
   */
  onEvent?: DramaEventSink;
  /** 是否在成文后加一道【审校修订】（默认开）。多几次 LLM 调用换自洽性。 */
  review?: boolean;
  /**
   * 反射循环最多几轮 critique ⇄ revise（默认 2）。每一轮=评审挑刺一次 + 若有硬伤则执笔人
   * 定向修订一次。无硬伤会提前收；轮数越多越自洽、但 LLM 调用也越多。
   */
  reviewRounds?: number;
}

const DEFAULT_SEED = "暴雨夜，一个蒙面人踹开了荒野客栈的门。";

/**
 * 一幕演到半途、某一拍的 LLM 调用失败（如上游超时且重试仍不成）时：只要已攒够这么多次
 * 【角色发言】，就当场收场、拿已有记录成文，而不是让整章（乃至整批续写）跟着崩。低于此数才向上抛。
 */
const MIN_SALVAGE_ACTS = 3;

/** 已攒够可成文的角色发言数吗？纯函数，便于单测。 */
export function canSalvageScene(transcript: Beat[], minActs = MIN_SALVAGE_ACTS): boolean {
  return transcript.filter((b) => b.kind === "act").length >= minActs;
}

/**
 * 武侠剧场：Multi-Agent（导演调度 + 执笔人成文）。
 *
 * 没有硬规则约束"谁何时行动"——于是"下一个谁登场"本身成了难题。解法（业界成熟
 * 模式）：用一个【导演/说书人】agent 做调度者（对标 AutoGen 的 GroupChatManager）。
 * 它根据剧情张力、谁被点名、人物动机，逐拍决定谁行动、是否注入环境事件、何时收场；
 * 人物与背景由导演按章节上下文【动态生成】。
 *
 * 收尾交给【执笔人】(Novelist) 单 agent：把整幕即兴记录用全局视角改写成小说体。
 * 情节的意外感来自多 agent 涌现，文笔的连贯感来自单 agent 执笔。
 *
 * NovelEngine 按章调用 {@link playScene}（演一章）+ {@link novelizeScene}（成文）。
 */
export class WuxiaDramaAgent {
  private readonly director: Director;
  private readonly novelist: Novelist;
  private readonly reviewer: Reviewer;
  /** 角色扮演专用客户端（可用 OPENAI_MODEL_CHARACTER 指定更擅长演戏的模型）。 */
  private readonly characterClient: LLMClient;
  private readonly maxBeats: number;
  private readonly reviewEnabled: boolean;
  private readonly reviewRounds: number;
  private readonly onEvent?: DramaEventSink;

  constructor(opts: WuxiaDramaOptions) {
    // 按角色分模型：导演/角色/执笔人/审校各取所长（未配置则回落到 OPENAI_MODEL）。
    this.director = new Director(opts.client.withRole("director"));
    this.novelist = new Novelist(opts.client.withRole("novelist"));
    this.reviewer = new Reviewer(opts.client.withRole("reviewer"));
    this.characterClient = opts.client.withRole("character");
    this.maxBeats = opts.maxBeats ?? 14;
    this.reviewEnabled = opts.review ?? true;
    this.reviewRounds = opts.reviewRounds ?? 2;
    this.onEvent = opts.onEvent;
  }

  /** 广播一个演出事件（无监听者时静默）。 */
  private emit(event: DramaEvent): void {
    this.onEvent?.(event);
  }

  /**
   * 生成开场。多章模式【绝不回退】到任何内置示例——固定角色一旦灌进连载正史就会
   * 污染 canon。先重试一次，仍失败则抛错，交由上层重试整章。
   */
  private async openScene(seed: string, ctx: DramaContext): Promise<Scene> {
    const first = await this.director.openScene(seed, ctx);
    if (first) return first;
    const retry = await this.director.openScene(seed, ctx);
    if (retry) return retry;
    throw new Error("导演两次都未能生成合法的开场场景（多章模式不回退到内置示例场景，以免污染正史）。");
  }

  /**
   * 演一章：导演造人 + 角色逐拍即兴演出，不做收尾。返回整幕的 scene 与 transcript，
   * 之后交给 {@link novelizeScene} 成文。
   */
  async playScene(
    input: string,
    ctx: DramaContext,
  ): Promise<{ scene: Scene; transcript: Beat[]; seed: string }> {
    const seed = input.trim() || DEFAULT_SEED;
    this.emit({ type: "seed", seed });
    const playStartedAt = Date.now();

    logger.step(1, "开场（导演生成人物与背景）");
    logger.info(`开场引子：${seed}`);
    this.emit({ type: "step", n: 1, title: "开场（导演生成人物与背景）" });
    const scene: Scene = await this.openScene(seed, ctx);

    logger.info(`【背景】${scene.background}`);
    logger.info(`【登场人物】\n${renderCast(scene)}`);
    this.emit({
      type: "scene",
      background: scene.background,
      characters: scene.characters.map(toPublicCharacter),
    });

    const actors = new Map<string, CharacterActor>(
      scene.characters.map((c) => [
        c.name,
        // 每个角色单独打上人物名标签，便于计时日志与提示词追踪逐拍分辨是谁在说话。
        new CharacterActor(this.characterClient.withLabel(`角色·${c.name}`), c),
      ]),
    );
    const names = castNames(scene);
    const transcript: Beat[] = [];

    logger.step(2, "开演");
    this.emit({ type: "step", n: 2, title: "开演" });
    for (let beatNo = 1; beatNo <= this.maxBeats; beatNo++) {
      // 单拍容错：一次 LLM 调用抖动（如超时且重试仍不成）不该拖垮整章——已攒够戏份就当场收场、
      // 拿已有记录成文；戏太少（救不回来）才向上抛，交由上层决定是否重试/停下。
      let decision;
      try {
        decision = await this.director.nextBeat(scene, transcript, beatNo, this.maxBeats, ctx);
      } catch (err) {
        if (this.salvageOrThrow(err, transcript, `导演第 ${beatNo} 拍调度`)) break;
        throw err;
      }

      if (decision.stage) {
        transcript.push({ actor: "旁白", kind: "narration", content: decision.stage });
        logger.info(`【旁白】${decision.stage}`);
        this.emit({ type: "narration", content: decision.stage });
      }

      if (decision.action === "end") {
        logger.info(`（导演示意收场${decision.reason ? `：${decision.reason}` : ""}）`);
        this.emit({ type: "director-end", reason: decision.reason });
        break;
      }

      const name = decision.actor ?? this.pickFallbackActor(names, transcript);
      const actor = actors.get(name);
      if (!actor) continue;

      let content: string;
      try {
        content = await actor.act(scene, transcript, undefined, ctx?.genrePersona);
      } catch (err) {
        if (this.salvageOrThrow(err, transcript, `角色「${name}」第 ${beatNo} 拍表演`)) break;
        throw err;
      }
      transcript.push({ actor: name, kind: "act", content });
      logger.info(`${name}：${content}`);
      this.emit({ type: "beat", actor: name, content });
    }

    const actCount = transcript.filter((b) => b.kind === "act").length;
    console.log(
      `\x1b[36m[计时·对话] 共 ${transcript.length} 拍（${actCount} 次角色发言），` +
        `耗时 ${((Date.now() - playStartedAt) / 1000).toFixed(1)}s\x1b[0m`,
    );
    this.emit({ type: "play-complete" });
    return { scene, transcript, seed };
  }

  /** 执笔人成文（单独触发）：把整幕即兴记录改写成小说体正文。 */
  async novelizeScene(
    scene: Scene,
    transcript: Beat[],
    seed?: string,
    ctx?: DramaContext,
  ): Promise<string> {
    logger.step(3, "成文（执笔人代笔）");
    this.emit({ type: "step", n: 3, title: "成文（执笔人代笔）" });
    const proseStartedAt = Date.now();
    const prose = await this.novelist.write(scene, transcript, seed, ctx);
    console.log(
      `\x1b[36m[计时·成文] 生成 ${prose.length} 字，` +
        `耗时 ${((Date.now() - proseStartedAt) / 1000).toFixed(1)}s\x1b[0m`,
    );
    this.emit({ type: "prose", content: prose });
    this.emit({ type: "done" });
    return prose;
  }

  /**
   * 审校反射（成文后的一道兜底网）：评审【只挑刺】列出硬伤清单，执笔人【定向修订】只改被点名处，
   * 改完再复审，直到无硬伤（pass）或用满轮数。逻辑/常识/时间线/人设/既有事实矛盾都在此拦截。
   * 【best-effort】：审校只是加固，绝不能反而成为新的崩溃点或吞掉正文——任何异常（内容审核、
   * 超时、解析等）一律回落到当前最好的一版；截断/骤缩的修订稿由防截断护栏挡掉（见 reflect.ts）。
   * 未开启审校时直接原样返回。
   */
  async reviewScene(
    prose: string,
    scene: Scene,
    transcript: Beat[],
    ctx?: DramaContext,
  ): Promise<string> {
    if (!this.reviewEnabled) return prose;
    const startedAt = Date.now();
    try {
      const result = await reflectReview(
        this.reviewer,
        this.novelist,
        prose,
        scene,
        transcript,
        ctx,
        {
          maxRounds: this.reviewRounds,
          onRound: (r) => {
            const verdict = r.error
              ? `本轮中断（${r.error}），保留当前稿`
              : r.issueCount === 0
                ? (r.parsed ? "无硬伤，通过" : "评审未能解析，暂当通过")
                : r.revised
                  ? `挑出 ${r.issueCount} 处硬伤，已定向修订`
                  : `挑出 ${r.issueCount} 处硬伤，但修订稿未通过护栏、沿用上一版`;
            console.log(`\x1b[36m[审校·第 ${r.round} 轮] ${verdict}\x1b[0m`);
          },
        },
      );
      const changed = result.prose.trim() !== prose.trim();
      console.log(
        `\x1b[36m[计时·审校] ${result.passed ? "收尾无硬伤" : "用满轮数仍有存疑"}，` +
          `${changed ? "已修订" : "原样"} ${result.prose.length}字，` +
          `${result.rounds.length} 轮，耗时 ${((Date.now() - startedAt) / 1000).toFixed(1)}s\x1b[0m`,
      );
      return result.prose;
    } catch (err) {
      console.error(
        `\x1b[33m[审校] 失败，沿用原文（不影响成文）：` +
          `${err instanceof Error ? err.message.split("\n")[0] : String(err)}\x1b[0m`,
      );
      return prose;
    }
  }

  /**
   * 单拍失败时的处置：已攒够戏份就【就地收场】（返回 true，让调用处 break、拿已有记录成文），
   * 否则返回 false（让调用处把错误抛给上层）。把"救不救得回"的判断和日志集中在此。
   */
  private salvageOrThrow(err: unknown, transcript: Beat[], where: string): boolean {
    const reason = err instanceof Error ? err.message.split("\n")[0] : String(err);
    if (canSalvageScene(transcript)) {
      const acts = transcript.filter((b) => b.kind === "act").length;
      console.error(
        `\x1b[33m[演出] ${where}失败，已有 ${acts} 次发言，就此收场、拿已有记录成文（不拖垮整章）：${reason}\x1b[0m`,
      );
      this.emit({ type: "director-end", reason: `生成中断（${where}失败），提前收场` });
      return true;
    }
    console.error(
      `\x1b[31m[演出] ${where}失败，且戏份不足（不足 ${MIN_SALVAGE_ACTS} 次发言）无法成文，交由上层处理：${reason}\x1b[0m`,
    );
    return false;
  }

  /** 导演没指定行动者时的兜底：挑登场最少的人，保证轮转、避免冷场。 */
  private pickFallbackActor(names: string[], transcript: Beat[]): string {
    const counts = new Map<string, number>(names.map((n) => [n, 0]));
    for (const b of transcript) {
      if (b.kind === "act" && counts.has(b.actor)) {
        counts.set(b.actor, counts.get(b.actor)! + 1);
      }
    }
    let best = names[0]!;
    let min = Infinity;
    for (const n of names) {
      const c = counts.get(n)!;
      if (c < min) {
        min = c;
        best = n;
      }
    }
    return best;
  }
}
