import type { LLMClient } from "../core/llm/client.ts";
import { extractJsonObject, str, strArray } from "../core/json.ts";
import type { Scene, Beat } from "../drama/scene.ts";
import { renderCast, renderTranscript } from "../drama/scene.ts";
import {
  upsertCharacter,
  mergeThreads,
  mergeCapped,
  reconcileProps,
  renderOpenThreads,
  renderPropLedger,
} from "./memory.ts";
import type {
  StoryMemory,
  CodexCharacter,
  ThreadItem,
  PropItem,
  WorldBible,
  GenreSpec,
} from "./types.ts";
import { DEFAULT_GENRE } from "./genre.ts";

/**
 * 档案官：每章写完后更新故事记忆。
 *
 * 混合式，兼顾可靠与省钱：
 * - 【确定性】人物内核（性格/说话风格/身份/秘密）直接取自本章导演生成的角色定义，
 *   不靠 LLM 二次抽取，避免走样；voiceSample 取该角色首句台词。
 * - 【LLM 一次】只抽取"演变"信息：本章大事、伏笔开/收、人物现状/当前目标/关系/弧线、
 *   世界观新增设定，并重写有界的故事梗概。
 * - 只处理本章登场者；缺席者冻结，回归者的补账由 LLM 写进其 arcNotes。
 */

/** 本章记录（喂给档案官）。 */
export interface ChapterRecord {
  chapterNo: number;
  goal: string;
  scene: Scene;
  transcript: Beat[];
  prose: string;
}

interface CharacterUpdate {
  name: string;
  aliases?: string[];
  status?: string;
  currentGoal?: string;
  arcNotes?: string;
  relationships?: { who: string; relation: string }[];
  secretRevealed?: boolean;
}

/** LLM 抽取出的道具持有权更新。 */
interface PropUpdate {
  name: string;
  holder: string;
  location: string;
  status: string;
}

/** LLM 抽取出的结构化更新（纯数据）。 */
export interface MemoryUpdate {
  event: string;
  rollingSummary: string;
  /** 本章故事推进到的地点/局面锚点。 */
  currentLocation: string;
  worldAdditions: Partial<Pick<WorldBible, "locations" | "factions" | "powerSystem" | "items" | "lore">>;
  threads: { id: string; description: string; status: "open" | "resolved" }[];
  props: PropUpdate[];
  characterUpdates: CharacterUpdate[];
}

function parseRelationships(v: unknown): { who: string; relation: string }[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const rels = v
    .map((r) => {
      if (!r || typeof r !== "object") return null;
      const o = r as Record<string, unknown>;
      const who = str(o.who);
      const relation = str(o.relation);
      return who && relation ? { who, relation } : null;
    })
    .filter((x): x is { who: string; relation: string } => x !== null);
  return rels.length ? rels : undefined;
}

/** 从 LLM 文本解析记忆更新（纯函数，供测试/兜底）。 */
export function parseMemoryUpdate(text: string): MemoryUpdate {
  const o = extractJsonObject(text) ?? {};
  const wa = (o.worldAdditions && typeof o.worldAdditions === "object"
    ? o.worldAdditions
    : {}) as Record<string, unknown>;

  const threads = Array.isArray(o.threads)
    ? o.threads
        .map((t) => {
          if (!t || typeof t !== "object") return null;
          const x = t as Record<string, unknown>;
          const description = str(x.description);
          if (!description) return null;
          const status = str(x.status) === "resolved" ? "resolved" : "open";
          const id = str(x.id) || description.slice(0, 12);
          return { id, description, status } as {
            id: string;
            description: string;
            status: "open" | "resolved";
          };
        })
        .filter((x): x is { id: string; description: string; status: "open" | "resolved" } => x !== null)
    : [];

  const characterUpdates = Array.isArray(o.characterUpdates)
    ? o.characterUpdates
        .map((c) => {
          if (!c || typeof c !== "object") return null;
          const x = c as Record<string, unknown>;
          const name = str(x.name);
          if (!name) return null;
          const u: CharacterUpdate = { name };
          const aliases = strArray(x.aliases);
          if (aliases.length) u.aliases = aliases;
          if (str(x.status)) u.status = str(x.status);
          if (str(x.currentGoal)) u.currentGoal = str(x.currentGoal);
          if (str(x.arcNotes)) u.arcNotes = str(x.arcNotes);
          const rels = parseRelationships(x.relationships);
          if (rels) u.relationships = rels;
          if (typeof x.secretRevealed === "boolean") u.secretRevealed = x.secretRevealed;
          return u;
        })
        .filter((x): x is CharacterUpdate => x !== null)
    : [];

  const props = Array.isArray(o.props)
    ? o.props
        .map((p) => {
          if (!p || typeof p !== "object") return null;
          const x = p as Record<string, unknown>;
          const name = str(x.name);
          if (!name) return null;
          return {
            name,
            holder: str(x.holder),
            location: str(x.location),
            status: str(x.status),
          } as PropUpdate;
        })
        .filter((x): x is PropUpdate => x !== null)
    : [];

  return {
    event: str(o.event),
    rollingSummary: str(o.rollingSummary),
    currentLocation: str(o.currentLocation),
    worldAdditions: {
      locations: strArray(wa.locations),
      factions: strArray(wa.factions),
      powerSystem: strArray(wa.powerSystem),
      items: strArray(wa.items),
      lore: strArray(wa.lore),
    },
    threads,
    props,
    characterUpdates,
  };
}

/** 首句台词作为口吻样本。 */
function firstLineOf(name: string, transcript: Beat[]): string | undefined {
  const beat = transcript.find((b) => b.kind === "act" && b.actor === name);
  if (!beat) return undefined;
  const line = beat.content.replace(/^（[^）]*）/, "").trim();
  return line.slice(0, 40) || undefined;
}

export class Archivist {
  constructor(private readonly client: LLMClient) {}

  async updateMemory(
    memory: StoryMemory,
    chapter: ChapterRecord,
    genre: GenreSpec = DEFAULT_GENRE,
  ): Promise<StoryMemory> {
    const update = await this.extract(memory, chapter, genre);

    // 1) 世界观圣经：并集去重 + 近义合并 + 容量封顶，防止长篇里膨胀成噪声。
    const wb: WorldBible = {
      ...memory.worldBible,
      locations: mergeCapped(memory.worldBible.locations, update.worldAdditions.locations ?? []),
      factions: mergeCapped(memory.worldBible.factions, update.worldAdditions.factions ?? []),
      powerSystem: mergeCapped(memory.worldBible.powerSystem, update.worldAdditions.powerSystem ?? []),
      items: mergeCapped(memory.worldBible.items, update.worldAdditions.items ?? []),
      lore: mergeCapped(memory.worldBible.lore, update.worldAdditions.lore ?? []),
    };

    // 2) 人物：以本章登场角色定义为准（内核确定性），叠加 LLM 抽取的演变。
    let characters: CodexCharacter[] = memory.characters;
    const updById = new Map(update.characterUpdates.map((u) => [u.name, u]));
    for (const c of chapter.scene.characters) {
      const u = updById.get(c.name);
      // 累计登场章数：找现有档案（含别名）的 appearances + 1。
      const prev = characters.find((x) => x.name === c.name || (x.aliases ?? []).includes(c.name));
      const base: CodexCharacter = {
        name: c.name,
        aliases: u?.aliases,
        identity: c.identity,
        personality: c.personality,
        style: c.style,
        longTermGoal: c.goal,
        currentGoal: u?.currentGoal,
        relationships: u?.relationships,
        secret: c.secret,
        secretRevealed: u?.secretRevealed,
        status: u?.status || "在世",
        arcNotes: u?.arcNotes,
        voiceSample: firstLineOf(c.name, chapter.transcript),
        firstChapter: chapter.chapterNo,
        lastChapter: chapter.chapterNo,
        appearances: (prev?.appearances ?? 0) + 1,
      };
      characters = upsertCharacter(characters, base);
    }
    // 兼容：LLM 提到但不在本章 cast 里的人物更新（如回归者补账），也 upsert 现状（不加 appearances）。
    for (const u of update.characterUpdates) {
      if (chapter.scene.characters.some((c) => c.name === u.name)) continue;
      const existing = characters.find(
        (c) => c.name === u.name || (c.aliases ?? []).includes(u.name),
      );
      if (!existing) continue;
      characters = upsertCharacter(characters, {
        ...existing,
        aliases: u.aliases ?? existing.aliases,
        currentGoal: u.currentGoal ?? existing.currentGoal,
        arcNotes: u.arcNotes ?? existing.arcNotes,
        relationships: u.relationships ?? existing.relationships,
        secretRevealed: u.secretRevealed ?? existing.secretRevealed,
        status: u.status || existing.status,
        lastChapter: existing.lastChapter,
      });
    }

    // 3) 事件、伏笔、道具账本、梗概。
    const events = update.event
      ? [...memory.events, { chapter: chapter.chapterNo, summary: update.event }]
      : memory.events;

    const incomingThreads: ThreadItem[] = update.threads.map((t) => ({
      id: t.id,
      description: t.description,
      status: t.status,
      introducedChapter: chapter.chapterNo,
      resolvedChapter: t.status === "resolved" ? chapter.chapterNo : undefined,
    }));
    const threads = mergeThreads(memory.threads, incomingThreads);

    const incomingProps: PropItem[] = update.props.map((p) => ({
      name: p.name,
      holder: p.holder,
      location: p.location,
      status: p.status,
      lastChapter: chapter.chapterNo,
    }));
    const props = reconcileProps(memory.props ?? [], incomingProps);

    return {
      worldBible: wb,
      characters,
      events,
      threads,
      props,
      currentLocation: update.currentLocation || memory.currentLocation || "",
      rollingSummary: update.rollingSummary || memory.rollingSummary,
    };
  }

  /** 单次 LLM 抽取演变信息。 */
  private async extract(
    memory: StoryMemory,
    chapter: ChapterRecord,
    genre: GenreSpec = DEFAULT_GENRE,
  ): Promise<MemoryUpdate> {
    const system = [
      `你是这部${genre.persona}长篇的档案官。读完本章后，抽取需要写入'故事记忆'的结构化信息，用于保证后续章节连贯。`,
      "要求：",
      "- event：用一句话概括本章发生的关键大事。",
      "- currentLocation：本章结束时故事推进到的地点/局面（供下一章承接，避免原地打转），如'断魂渡渡口，四方僵持已破，众人转赴青崖'。",
      "- characterUpdates：仅针对本章登场人物，给出其【现状 status】（在世/受伤/身亡/失踪/下落）、【当前目标 currentGoal】、【关系 relationships】变化、【弧线笔记 arcNotes】、秘密是否已被揭露 secretRevealed；若该人物有【别名/化名/尊称】（如'左腿瘸人''师叔'其实就是'封沉岳'），务必在 aliases 里列出，以便与既有档案归并为同一人。",
      "- 生死铁律：已判定身亡的人物不得改回在世；如本章有人死亡，status 明确写'身亡'。",
      "- props：本章涉及的关键道具/信物，给出其【当前唯一持有者 holder】【所在位置 location】【状态 status】。同一件道具只能有一个当前持有者/位置——若易主则写新的持有者，不要新增'又一个藏处'。",
      "- threads：本章新埋下或已回收的伏笔/悬念；status 用 open 或 resolved；给每条一个稳定的短 id（同一伏笔历章须用同一 id/同一描述）。",
      "- worldAdditions：本章新出现且值得记入设定的地点/势力/武功规则/信物/其它设定（只列真正新增，不要重复已知设定）。",
      "- rollingSummary：重写'故事梗概至今'，涵盖到本章为止的主干，控制在 300 字以内，供后续章节参考。",
      "只输出一个 JSON 对象：",
      '{"event":"","currentLocation":"","rollingSummary":"","worldAdditions":{"locations":[],"factions":[],"powerSystem":[],"items":[],"lore":[]},"props":[{"name":"","holder":"","location":"","status":""}],"threads":[{"id":"","description":"","status":"open"}],"characterUpdates":[{"name":"","aliases":[],"status":"","currentGoal":"","relationships":[{"who":"","relation":""}],"arcNotes":"","secretRevealed":false}]}',
      "不要输出 JSON 以外的任何文字。",
    ].join("\n");

    const user = [
      `【本章目标】${chapter.goal}`,
      `【背景】${chapter.scene.background}`,
      `【本章登场人物】\n${renderCast(chapter.scene)}`,
      `【本章场面记录】\n${renderTranscript(chapter.transcript, 100)}`,
      `【本章成文】\n${chapter.prose}`,
      `【已知未回收伏笔】\n${renderOpenThreads(memory.threads)}`,
      memory.props?.length ? `【已知道具账本（在此基础上更新持有权，勿新增藏处）】\n${renderPropLedger(memory.props)}` : "",
      `【上一版故事梗概】\n${memory.rollingSummary || "（无）"}`,
      "请输出记忆更新 JSON。",
    ]
      .filter(Boolean)
      .join("\n\n");

    const { message } = await this.client.chat({
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0.4,
    });
    return parseMemoryUpdate(message.content ?? "");
  }
}
