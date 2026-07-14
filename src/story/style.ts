import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { StyleCard, StyleIntensity } from "./types.ts";

/**
 * 写作风味目录与渲染。把「作者笔法」抽象成可注入执笔/旁白提示词的 {@link StyleCard}，
 * 与题材(GenreSpec)正交：题材管「写什么世界」，风味管「怎么写这段字」。
 *
 * 【skill 式可插拔】风味卡不再写死在代码里，而是外置成一个目录，每张卡 = 一个文件夹：
 *
 *   styles/<id>/card.json     一张风味卡（StyleCard 的字段）
 *
 * 加载器扫描 styles/ 下所有子目录、读取各自的 card.json，丢一个文件夹进去即多一张卡，
 * 无需改代码。以后卡文件夹里还能放范文样本等资产，向真正的「skill 单元」演进。
 *
 * 目录来源（后者按 id 覆盖前者，便于用户覆写内置卡）：
 *   1) 内置目录：随仓库发布的 <repo>/styles/（相对源码定位，与 cwd 无关）。
 *   2) 用户目录：环境变量 STYLE_DIR 指定的外部目录（可选）。
 *
 * 渲染部分（resolve/render）仍是纯函数，可单测。
 *
 * 设计约束：
 * - 只作用于【叙述层】（执笔成文 + 导演旁白），不覆盖人物各自的说话腔调。
 * - 卡内容是「抽象笔法」而非原文样本，绝不含任何作品的专有名词/人物/情节。
 * - 带强度旋钮（淡/中/浓），并对「名场面」做分场景处理（高潮才上强度）。
 */

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/** 把一份 card.json 归一化成 StyleCard；缺 id 用文件夹名兜底；缺 label/tagline 视为无效卡。 */
function normalizeCard(raw: unknown, fallbackId: string): StyleCard | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const id = str(o.id) || fallbackId;
  const label = str(o.label);
  const tagline = str(o.tagline);
  if (!id || !label || !tagline) return null;
  const dirRaw = o.direction && typeof o.direction === "object" ? (o.direction as Record<string, unknown>) : null;
  const scene = dirRaw ? str(dirRaw.scene) : "";
  const opening = dirRaw ? str(dirRaw.opening) : "";
  return {
    id,
    label,
    tagline,
    rhythm: str(o.rhythm),
    lexicon: str(o.lexicon),
    voice: str(o.voice),
    setpiece: str(o.setpiece),
    hook: str(o.hook),
    avoid: str(o.avoid),
    ...(scene || opening ? { direction: { ...(scene ? { scene } : {}), ...(opening ? { opening } : {}) } } : {}),
  };
}

/** 待扫描的风味目录：内置目录 +（可选）STYLE_DIR 外部目录。 */
function styleDirs(): string[] {
  const dirs = [join(import.meta.dir, "..", "..", "styles")];
  const ext = process.env.STYLE_DIR?.trim();
  if (ext) dirs.push(ext);
  return dirs;
}

/** 扫描单个目录下的 <id>/card.json，损坏/缺字段的卡跳过。 */
function loadCardsFromDir(dir: string): StyleCard[] {
  if (!existsSync(dir)) return [];
  const out: StyleCard[] = [];
  for (const name of readdirSync(dir)) {
    const sub = join(dir, name);
    try {
      if (!statSync(sub).isDirectory()) continue;
    } catch {
      continue;
    }
    const cardPath = join(sub, "card.json");
    if (!existsSync(cardPath)) continue;
    try {
      const card = normalizeCard(JSON.parse(readFileSync(cardPath, "utf8")), name);
      if (card) out.push(card);
    } catch {
      // 跳过损坏的卡文件
    }
  }
  return out;
}

/**
 * 从磁盘加载全部风味卡（内置 + 用户目录，后者按 id 覆盖前者）。
 * 每次调用都重新读盘，便于编辑卡文件后即时生效（无需重启进程）。纯读，无副作用。
 */
export function loadStyleCards(): StyleCard[] {
  const byId = new Map<string, StyleCard>();
  for (const dir of styleDirs()) {
    for (const card of loadCardsFromDir(dir)) byId.set(card.id, card);
  }
  return [...byId.values()];
}

/** 风味卡目录（进程启动时读盘一次的快照；如需即时热更用 {@link loadStyleCards}）。 */
export const STYLE_CARDS: StyleCard[] = loadStyleCards();

/** 默认风味强度。 */
export const DEFAULT_STYLE_INTENSITY: StyleIntensity = "medium";

/**
 * 把用户输入解析成 {@link StyleCard} 或不启用（undefined）。
 * - 空 / "none" / "off" / "无" → undefined（不启用风味，回落题材默认腔调）。
 * - 命中预设 id/label → 返回预设。
 * - 其它非空 → 构造一张极简自定义卡（把输入当作 voice 提示），供快速试味。
 */
export function resolveStyleCard(input?: string | null): StyleCard | undefined {
  const v = (input ?? "").trim();
  if (!v) return undefined;
  const lower = v.toLowerCase();
  if (["none", "off", "无", "默认", "default"].includes(lower)) return undefined;
  const hit = loadStyleCards().find((s) => s.id === lower || s.label === v);
  if (hit) return hit;
  return {
    id: "custom",
    label: v,
    tagline: `自定义风味：${v}`,
    rhythm: "",
    lexicon: "",
    voice: `整体笔法/腔调：${v}`,
    setpiece: "",
    hook: "",
    avoid: "",
  };
}

/** 解析强度输入，非法/空则回落默认。 */
export function resolveIntensity(input?: string | null): StyleIntensity {
  const v = (input ?? "").trim().toLowerCase();
  if (v === "light" || v === "淡" || v === "淡入") return "light";
  if (v === "strong" || v === "浓" || v === "浓墨") return "strong";
  if (v === "medium" || v === "中" || v === "适中") return "medium";
  return DEFAULT_STYLE_INTENSITY;
}

const INTENSITY_LABEL: Record<StyleIntensity, string> = {
  light: "淡入",
  medium: "适中",
  strong: "浓墨",
};

const INTENSITY_DIRECTIVE: Record<StyleIntensity, string> = {
  light: "以自然流畅、故事本身为先，风味只作淡淡底色、点到为止，宁欠勿过。",
  medium: "在保证好读的前提下稳定呈现这种笔法，风味鲜明但不喧宾夺主。",
  strong: "浓墨呈现这种笔法，让文字辨识度拉满；但仍须服务剧情，避免空洞堆砌。",
};

/**
 * 把风味卡渲染成注入【执笔成文】的提示词块（强注入）。带强度调节与分场景说明。
 * 返回空串表示不启用。纯函数。
 */
export function renderStyleCard(
  card: StyleCard | undefined,
  intensity: StyleIntensity = DEFAULT_STYLE_INTENSITY,
): string {
  if (!card) return "";
  const lines = [
    `【叙述风味：${card.label}】（强度：${INTENSITY_LABEL[intensity]}）`,
    card.tagline ? `定位：${card.tagline}` : "",
    card.rhythm ? `- 句式节奏：${card.rhythm}` : "",
    card.lexicon ? `- 标志词库/意象：${card.lexicon}` : "",
    card.voice ? `- 叙事语气：${card.voice}` : "",
    card.setpiece ? `- 名场面/战斗：${card.setpiece}` : "",
    card.hook ? `- 章末收束：${card.hook}` : "",
    card.avoid ? `- 忌讳：${card.avoid}` : "",
    `- 强度要求：${INTENSITY_DIRECTIVE[intensity]}`,
    "- 边界：这是「怎么写」的笔法层，只影响叙述与旁白，不改变各人物固有的说话腔调；" +
      "且绝不可引入任何其它作品的专有名词、人物或情节。",
  ];
  return lines.filter(Boolean).join("\n");
}

/**
 * 渲染注入【导演旁白/开场】的精简风味提示（弱注入）——只取语气与句式的一句话，
 * 避免旁白过度承载作者味而盖过人物。返回空串表示不启用。纯函数。
 */
export function renderStyleBrief(card: StyleCard | undefined): string {
  if (!card) return "";
  const bits = [card.tagline, card.rhythm].filter(Boolean).join(" ");
  return bits ? `叙述风味（${card.label}）：${bits}` : "";
}

/**
 * 把风味卡的【导演段】渲染成注入【导演层（开场/运镜）】的提示词块。纯函数。
 *
 * 与 {@link renderStyleCard}（执笔层）对称，但吃的是 `card.direction`：
 * - `scene`（场面调度）：恒常注入，指导每一幕如何搭建、扎根世界、拉开格局。
 * - `opening`（开篇起势）：仅第 1 章（chapterNo === 1）注入。
 *
 * 卡未配 `direction`、或该场景无对应字段时返回空串（导演回落到通用底线，不受影响）。
 */
export function renderDirectorCard(card: StyleCard | undefined, chapterNo = 0): string {
  const dir = card?.direction;
  if (!dir) return "";
  const lines = [
    `【导演运镜风味：${card!.label}】`,
    dir.scene ? `- 场面调度：${dir.scene}` : "",
    chapterNo === 1 && dir.opening ? `- 开篇起势（仅本书第 1 章）：${dir.opening}` : "",
    "- 边界：这是「怎么搭场面/起势」的运镜层，服务剧情张力与世界质感；不要为堆场面而空转，也不改变各人物固有的说话腔调。",
  ].filter(Boolean);
  // 只有边界一行（scene/opening 都为空）时视为无有效内容。
  return lines.length > 2 ? lines.join("\n") : "";
}
