import type { Character } from "../drama/scene.ts";
import type {
  WorldBible,
  CodexCharacter,
  StoryMemory,
  ThreadItem,
  ChapterPlan,
} from "./types.ts";

/**
 * 故事记忆的纯函数：合并、渲染、有界选取。这里是"长篇不崩"的核心逻辑，
 * 不含 LLM 调用，可单测。
 */

/** 选取相关人物时的默认封顶。 */
export const RELEVANT_CAP = 6;
/** "近期活跃"的章数窗口。 */
export const RECENT_WINDOW = 2;

export function emptyWorldBible(): WorldBible {
  return {
    era: "",
    tone: "",
    locations: [],
    factions: [],
    powerSystem: [],
    items: [],
    lore: [],
  };
}

export function emptyMemory(worldBible: WorldBible): StoryMemory {
  return {
    worldBible,
    characters: [],
    events: [],
    threads: [],
    rollingSummary: "",
  };
}

/**
 * upsert 一个人物档案：按 name 匹配。
 * - 新角色：整份写入。
 * - 旧角色：【不可变内核】personality / style / identity / secret / firstChapter / voiceSample
 *   一经确立不被覆盖；只更新会演变的字段（status / currentGoal / relationships /
 *   arcNotes / aliases / appearance / secretRevealed / lastChapter）。
 * 返回新的 characters 数组（不原地修改入参）。
 */
export function upsertCharacter(
  characters: CodexCharacter[],
  incoming: CodexCharacter,
): CodexCharacter[] {
  const idx = characters.findIndex((c) => c.name === incoming.name);
  if (idx === -1) return [...characters, incoming];

  const prev = characters[idx]!;
  const merged: CodexCharacter = {
    ...prev,
    // 内核字段：保留旧值，仅在旧值为空时用新值补齐。
    personality: prev.personality || incoming.personality,
    style: prev.style || incoming.style,
    identity: prev.identity || incoming.identity,
    secret: prev.secret ?? incoming.secret,
    voiceSample: prev.voiceSample ?? incoming.voiceSample,
    firstChapter: prev.firstChapter,
    longTermGoal: prev.longTermGoal || incoming.longTermGoal,
    // 演变字段：新值优先（有则更新）。
    currentGoal: incoming.currentGoal ?? prev.currentGoal,
    relationships: incoming.relationships ?? prev.relationships,
    aliases: incoming.aliases ?? prev.aliases,
    appearance: incoming.appearance ?? prev.appearance,
    arcNotes: incoming.arcNotes ?? prev.arcNotes,
    secretRevealed: incoming.secretRevealed ?? prev.secretRevealed,
    status: incoming.status || prev.status,
    lastChapter: Math.max(prev.lastChapter, incoming.lastChapter),
  };
  const next = [...characters];
  next[idx] = merged;
  return next;
}

/** 合并伏笔线程：按 id upsert，已有则更新描述/状态。 */
export function mergeThreads(
  threads: ThreadItem[],
  incoming: ThreadItem[],
): ThreadItem[] {
  let result = [...threads];
  for (const t of incoming) {
    const idx = result.findIndex((x) => x.id === t.id);
    if (idx === -1) {
      result = [...result, t];
    } else {
      const prev = result[idx]!;
      result[idx] = {
        ...prev,
        description: t.description || prev.description,
        status: t.status,
        resolvedChapter:
          t.status === "resolved"
            ? (t.resolvedChapter ?? prev.resolvedChapter)
            : prev.resolvedChapter,
      };
    }
  }
  return result;
}

/** 把人物档案还原成 drama 层 Character，让 CharacterActor 原样重建。 */
export function codexToCharacter(c: CodexCharacter): Character {
  return {
    name: c.name,
    identity: c.identity,
    personality: c.personality,
    goal: c.currentGoal || c.longTermGoal,
    secret: c.secret,
    style: c.style,
  };
}

function isDead(status: string): boolean {
  return /(亡|死|殒|殁|身故|阵亡)/.test(status);
}

function mentionedIn(name: string, plan: ChapterPlan): boolean {
  const hay = `${plan.goal} ${(plan.keyBeats ?? []).join(" ")}`;
  if (hay.includes(name)) return true;
  // 也匹配名字里的"本名"末段（去掉称号），如"独臂刀客 沈孤鸿" → "沈孤鸿"。
  const parts = name.split(/\s+/);
  const core = parts[parts.length - 1];
  return !!core && core.length >= 2 && hay.includes(core);
}

/**
 * 有界选取本章相关人物 + 生成回归者补账提示。
 * 优先级：本章目标点名者 > 近期活跃者 > 其余在世者；去重后封顶 {@link RELEVANT_CAP}。
 * returningNotes：入选者若已缺席 ≥1 整章（lastChapter ≤ chapterNo-2）则提示补账。
 */
export function selectRelevantCharacters(
  memory: StoryMemory,
  plan: ChapterPlan,
  chapterNo: number,
  cap = RELEVANT_CAP,
): { characters: CodexCharacter[]; returningNotes?: string } {
  const all = memory.characters;
  const mentioned = all.filter((c) => mentionedIn(c.name, plan));
  const recent = all.filter(
    (c) => !mentioned.includes(c) && chapterNo - c.lastChapter <= RECENT_WINDOW,
  );
  const rest = all.filter(
    (c) => !mentioned.includes(c) && !recent.includes(c) && !isDead(c.status),
  );

  const ordered = [...mentioned, ...recent, ...rest];
  const chosen = ordered.slice(0, cap);

  const notes: string[] = [];
  for (const c of chosen) {
    if (c.lastChapter <= chapterNo - 2) {
      notes.push(
        `${c.name}（上次登场第 ${c.lastChapter} 章，缺席 ${c.lastChapter}→${chapterNo} 章）需交代其间去向，登场须与其上次状态自洽。`,
      );
    }
  }

  return {
    characters: chosen,
    returningNotes: notes.length ? notes.join("\n") : undefined,
  };
}

// ── 有界渲染（喂给 prompt） ─────────────────────────────

export function renderWorldBrief(wb: WorldBible): string {
  const lines: string[] = [];
  if (wb.era) lines.push(`时代：${wb.era}`);
  if (wb.tone) lines.push(`基调：${wb.tone}`);
  if (wb.locations.length) lines.push(`重要地点：${wb.locations.join("、")}`);
  if (wb.factions.length) lines.push(`门派势力：${wb.factions.join("、")}`);
  if (wb.powerSystem.length) lines.push(`武功/规则：${wb.powerSystem.join("；")}`);
  if (wb.items.length) lines.push(`关键信物：${wb.items.join("、")}`);
  if (wb.lore.length) lines.push(`其它设定：${wb.lore.join("；")}`);
  return lines.join("\n") || "（尚未建立世界设定）";
}

/** 渲染人物档案供导演参考（含内核与现状，供忠实复现）。 */
export function renderCharacterCard(c: CodexCharacter): string {
  const rel = c.relationships?.length
    ? `；关系：${c.relationships.map((r) => `${r.who}(${r.relation})`).join("、")}`
    : "";
  const secret = c.secret
    ? `；秘密：${c.secret}${c.secretRevealed ? "(已揭露)" : "(未揭露)"}`
    : "";
  const voice = c.voiceSample ? `；口吻例："${c.voiceSample}"` : "";
  return [
    `【${c.name}】${c.identity}`,
    `性格：${c.personality}`,
    `说话风格：${c.style}`,
    `目标：${c.currentGoal || c.longTermGoal}`,
    `现状：${c.status}${rel}${secret}${voice}`,
  ].join("\n");
}

export function renderOpenThreads(threads: ThreadItem[]): string {
  const open = threads.filter((t) => t.status === "open");
  if (!open.length) return "（暂无未回收伏笔）";
  return open.map((t) => `- ${t.description}`).join("\n");
}

/** 取一段文本的结尾片段，用于章节承接。 */
export function tailOf(text: string, chars = 400): string {
  const t = text.trim();
  return t.length <= chars ? t : t.slice(-chars);
}
