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
}

const DEFAULT_SEED = "暴雨夜，一个蒙面人踹开了荒野客栈的门。";

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
  /** 角色扮演专用客户端（可用 OPENAI_MODEL_CHARACTER 指定更擅长演戏的模型）。 */
  private readonly characterClient: LLMClient;
  private readonly maxBeats: number;
  private readonly onEvent?: DramaEventSink;

  constructor(opts: WuxiaDramaOptions) {
    // 按角色分模型：导演/角色/执笔人各取所长（未配置则回落到 OPENAI_MODEL）。
    this.director = new Director(opts.client.withRole("director"));
    this.novelist = new Novelist(opts.client.withRole("novelist"));
    this.characterClient = opts.client.withRole("character");
    this.maxBeats = opts.maxBeats ?? 14;
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
      const decision = await this.director.nextBeat(scene, transcript, beatNo, this.maxBeats, ctx);

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

      const content = await actor.act(scene, transcript, undefined, ctx?.genrePersona);
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
