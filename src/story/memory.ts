import type { Character } from "../drama/scene.ts";
import type {
  WorldBible,
  CodexCharacter,
  StoryMemory,
  ThreadItem,
  PropItem,
  StoryEvent,
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
/** 世界圣经每类设定的容量上限，防止长篇里无限膨胀成噪声。 */
export const WORLD_LIST_CAP = 40;

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
    props: [],
    currentLocation: "",
    rollingSummary: "",
    arcSummaries: [],
  };
}

/** 兜底旧存档：补齐后新增的字段（props/currentLocation/appearances/arcSummaries），避免读旧 memory.json 崩。 */
export function normalizeMemory(m: StoryMemory): StoryMemory {
  return {
    ...m,
    props: m.props ?? [],
    currentLocation: m.currentLocation ?? "",
    characters: (m.characters ?? []).map((c) => ({ ...c, appearances: c.appearances ?? 1 })),
    events: m.events ?? [],
    threads: m.threads ?? [],
    arcSummaries: m.arcSummaries ?? [],
  };
}

export function isDead(status: string): boolean {
  return /(亡|死|殒|殁|身故|阵亡|遇害|丧命)/.test(status);
}

/** 一个人物的所有称呼集合（正名 + 别名），用于跨章归并同一人。 */
function aliasSet(c: Pick<CodexCharacter, "name" | "aliases">): Set<string> {
  return new Set([c.name, ...(c.aliases ?? [])].map((s) => s.trim()).filter(Boolean));
}

/** 两个档案是否指同一人：正名相同，或称呼集合有交集。 */
function sameCharacter(
  a: Pick<CodexCharacter, "name" | "aliases">,
  b: Pick<CodexCharacter, "name" | "aliases">,
): boolean {
  if (a.name === b.name) return true;
  const sa = aliasSet(a);
  for (const x of aliasSet(b)) if (sa.has(x)) return true;
  return false;
}

function mergeAliases(prev: CodexCharacter, incoming: CodexCharacter): string[] | undefined {
  const set = aliasSet(prev);
  for (const x of aliasSet(incoming)) set.add(x);
  set.delete(prev.name); // 正名不放进 aliases
  const list = [...set];
  return list.length ? list : undefined;
}

/**
 * upsert 一个人物档案：按【正名或别名交集】匹配同一人（"封沉岳/左腿瘸人/师叔"归一）。
 * - 新角色：整份写入。
 * - 旧角色：【不可变内核】personality / style / identity / secret / firstChapter / voiceSample
 *   一经确立不被覆盖；只更新会演变的字段。别名并集累积。
 * - 【死亡不可逆】：已判定死亡的人物，状态不再被改回"在世"（防复活 bug）；
 *   如确需复活，incoming.status 里显式含"复活/诈死/假死"才允许。
 * 返回新的 characters 数组（不原地修改入参）。
 */
export function upsertCharacter(
  characters: CodexCharacter[],
  incoming: CodexCharacter,
): CodexCharacter[] {
  const idx = characters.findIndex((c) => sameCharacter(c, incoming));
  if (idx === -1) return [...characters, incoming];

  const prev = characters[idx]!;

  // 死亡不可逆：旧档已死且新状态想改回"活"，除非显式复活，否则保留死亡状态。
  const wantsResurrect = /(复活|诈死|假死|死而复生)/.test(incoming.status);
  const nextStatus =
    isDead(prev.status) && !isDead(incoming.status) && !wantsResurrect
      ? prev.status
      : incoming.status || prev.status;

  const merged: CodexCharacter = {
    ...prev,
    // 正名以先确立者为准；别名并集累积（把新出现的称呼收进来）。
    name: prev.name,
    aliases: mergeAliases(prev, incoming),
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
    appearance: incoming.appearance ?? prev.appearance,
    arcNotes: incoming.arcNotes ?? prev.arcNotes,
    secretRevealed: incoming.secretRevealed ?? prev.secretRevealed,
    status: nextStatus,
    lastChapter: Math.max(prev.lastChapter, incoming.lastChapter),
    appearances: incoming.appearances ?? prev.appearances,
  };
  const next = [...characters];
  next[idx] = merged;
  return next;
}

/** 归一化文本用于近义去重：去标点/空白、转小写。 */
function normKey(s: string): string {
  return s
    .toLowerCase()
    .replace(/[\s，。、；：:,.!！?？"'“”‘’（）()【】\[\]—\-~～]/g, "")
    .trim();
}

/**
 * 合并伏笔线程：按 id 或【归一化描述】匹配同一伏笔（避免"藏宝图下落"与"藏宝图的下落"重复）。
 * 已有则更新描述/状态；无则追加。
 */
export function mergeThreads(
  threads: ThreadItem[],
  incoming: ThreadItem[],
): ThreadItem[] {
  let result = [...threads];
  for (const t of incoming) {
    const tKey = normKey(t.description);
    const idx = result.findIndex(
      (x) => x.id === t.id || (tKey.length > 0 && normKey(x.description) === tKey),
    );
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

/**
 * 道具账本对账：按名字归并，每件道具【唯一当前持有者/位置】。
 * incoming 覆盖同名道具的持有权/位置/状态，而不是新增一个藏处（治"到处都藏着真本"）。
 */
export function reconcileProps(props: PropItem[], incoming: PropItem[]): PropItem[] {
  let result = [...props];
  for (const p of incoming) {
    if (!p.name.trim()) continue;
    const key = normKey(p.name);
    const idx = result.findIndex((x) => normKey(x.name) === key);
    if (idx === -1) {
      result = [...result, p];
    } else {
      const prev = result[idx]!;
      result[idx] = {
        name: prev.name,
        holder: p.holder || prev.holder,
        location: p.location || prev.location,
        status: p.status || prev.status,
        lastChapter: Math.max(prev.lastChapter, p.lastChapter),
      };
    }
  }
  return result;
}

/**
 * 史诗修辞前缀：这些形容词是文风调料，不该焊进实体专名。去重时一律剥掉，
 * 避免"万年私域偏殿暖阁"与"偏殿暖阁"被当成两个地点，也顺带遏制"万年"通胀。
 */
const EPIC_PREFIX_RE = /(亘古|太古|上古|三千年|万古|万载|万年|千年)/g;

/**
 * 从一条设定描述里取【实体主名】做去重 key：取首个分隔符（——/：/（ 等）之前的
 * 主名，剥掉史诗修辞前缀后再归一化。让"万年私域偏殿暖阁——…"与"偏殿暖阁：…"
 * 归并为同一实体，避免同一地点/势力换个措辞就被当成新条目无限堆积。
 */
export function entityKey(s: string): string {
  const head = s.split(/[—:：（(【\[、，。；;]/)[0] ?? s;
  return normKey(head.replace(EPIC_PREFIX_RE, ""));
}

/**
 * 并集去重 + 近义合并 + 容量封顶：世界圣经各类设定只增会膨胀成噪声，这里
 * 按【实体主名】去重（而非整串），同一实体只留一条最新表述，并保留最近活跃的
 * cap 条。这样"偏殿暖阁"不会被反复重述成几十条带"万年"的近义设定。
 */
export function mergeCapped(base: string[], add: string[], cap = WORLD_LIST_CAP): string[] {
  const seen = new Map<string, string>(); // entityKey -> 原文（后到覆盖并移到队尾：保留最新表述与最近活跃度）
  for (const s of [...base, ...add]) {
    const v = s.trim();
    if (!v) continue;
    const key = entityKey(v) || normKey(v);
    if (seen.has(key)) seen.delete(key); // 重设以刷新插入顺序，队尾=最近出现
    seen.set(key, v);
  }
  const list = [...seen.values()];
  return list.length > cap ? list.slice(list.length - cap) : list;
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

/** 本章目标/节拍里是否点到了该人物（含其所有别名与去称号本名）。 */
function mentionedIn(c: Pick<CodexCharacter, "name" | "aliases">, plan: ChapterPlan): boolean {
  const hay = `${plan.goal} ${(plan.keyBeats ?? []).join(" ")}`;
  for (const alias of aliasSet(c)) {
    if (hay.includes(alias)) return true;
    // 也匹配去掉称号后的本名末段，如"独臂刀客 沈孤鸿" → "沈孤鸿"。
    const parts = alias.split(/\s+/);
    const core = parts[parts.length - 1];
    if (core && core.length >= 2 && hay.includes(core)) return true;
  }
  return false;
}

/**
 * 识别主角：登场章数最多者（并列取最早登场）。需 appearances ≥ 2 才算"主角"，
 * 避免开局只有第 1 章数据时把随便一人当主角（也保证单测无 appearances 时不误判）。
 */
export function protagonistOf(memory: StoryMemory): CodexCharacter | undefined {
  let best: CodexCharacter | undefined;
  for (const c of memory.characters) {
    const a = c.appearances ?? 0;
    if (a < 2) continue;
    if (!best) {
      best = c;
      continue;
    }
    const ba = best.appearances ?? 0;
    if (a > ba || (a === ba && c.firstChapter < best.firstChapter)) best = c;
  }
  return best;
}

/**
 * 有界选取本章相关人物 + 生成回归者补账提示。
 * 优先级：主角（若在世且已确立）> 本章目标点名者 > 近期活跃者 > 其余在世者；去重后封顶。
 * returningNotes：入选者若已缺席 ≥1 整章（lastChapter ≤ chapterNo-2）则提示补账。
 */
export function selectRelevantCharacters(
  memory: StoryMemory,
  plan: ChapterPlan,
  chapterNo: number,
  cap = RELEVANT_CAP,
  protagonistName?: string,
): { characters: CodexCharacter[]; returningNotes?: string } {
  const all = memory.characters;
  const isProtagonist = (c: CodexCharacter) =>
    !!protagonistName && c.name === protagonistName && !isDead(c.status);

  const protagonist = all.filter(isProtagonist);
  // 被本章目标点名者可入选（含已故者：用于回忆/提及场景）。
  const mentioned = all.filter((c) => !isProtagonist(c) && mentionedIn(c, plan));
  // 近期活跃者：排除已故者，避免把刚死的人当活人重新搬上场。
  const recent = all.filter(
    (c) =>
      !isProtagonist(c) &&
      !mentioned.includes(c) &&
      !isDead(c.status) &&
      chapterNo - c.lastChapter <= RECENT_WINDOW,
  );
  const rest = all.filter(
    (c) =>
      !isProtagonist(c) &&
      !mentioned.includes(c) &&
      !recent.includes(c) &&
      !isDead(c.status),
  );

  const ordered = [...protagonist, ...mentioned, ...recent, ...rest];
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

/** 渲染"已故人物名单"，作为铁律喂给导演/执笔人：这些人不得以在世身份出现。 */
export function renderDeadRoster(characters: CodexCharacter[]): string {
  const dead = characters.filter((c) => isDead(c.status));
  if (!dead.length) return "";
  return dead
    .map((c) => `- ${c.name}（${c.status}${c.lastChapter ? `，第${c.lastChapter}章` : ""}）`)
    .join("\n");
}

/** 渲染道具账本：每件道具当前在谁手里/在哪，供导演/执笔人对账，勿另编藏处。 */
export function renderPropLedger(props: PropItem[]): string {
  if (!props?.length) return "";
  return props
    .map((p) => `- ${p.name}：现由「${p.holder || "无人"}」持有，位于「${p.location || "不明"}」（${p.status || "完好"}）`)
    .join("\n");
}

/** 渲染最近若干条大事记，作为"已发生、勿重复"的对账清单。 */
export function renderEventsRecap(events: StoryEvent[], limit = 10): string {
  if (!events?.length) return "";
  return events
    .slice(-limit)
    .map((e) => `- 第${e.chapter}章：${e.summary}`)
    .join("\n");
}

/** 取一段文本的结尾片段，用于章节承接。 */
export function tailOf(text: string, chars = 400): string {
  const t = text.trim();
  return t.length <= chars ? t : t.slice(-chars);
}

/**
 * 生成一卷的综述（纯函数，无 LLM）：取该卷章号区间内的大事记，压成一条卷综述。
 * 分卷滚动模式下每卷收尾归档一条，供规划下一卷时承接长期主干。
 */
export function buildArcRecap(
  events: StoryEvent[],
  arcNo: number,
  arcTitle: string,
  chapterStart: number,
  chapterEnd: number,
): string {
  const inArc = (events ?? []).filter(
    (e) => e.chapter >= chapterStart && e.chapter <= chapterEnd,
  );
  const body = inArc.length
    ? inArc.map((e) => e.summary).join("；")
    : "（本卷无大事记）";
  return `第${arcNo}卷《${arcTitle}》（第${chapterStart}-${chapterEnd}章）：${body}`;
}

/** 渲染各卷综述（有界，取最近若干卷），供规划下一卷时了解长期前情。 */
export function renderArcSummaries(summaries: string[] | undefined, limit = 8): string {
  if (!summaries?.length) return "";
  return summaries.slice(-limit).map((s) => `- ${s}`).join("\n");
}
