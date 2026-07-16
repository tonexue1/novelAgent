/**
 * 文笔评测用的交互 fixture 加载与校验。
 * `validateFixture` 是纯函数(可单测)；`loadFixture`/`listFixtures` 是读盘薄封装。
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ProseFixture, ReviewFixture } from "./rubric.ts";

/** 审校 fixture 的文件名前缀：与文笔 fixture 同放 fixtures/，靠前缀区分、互不干扰。 */
const REVIEW_PREFIX = "review-";

/** fixtures 目录（随体系一起入库）。 */
export function fixturesDir(): string {
  return join(import.meta.dir, "fixtures");
}

/** 校验一份 fixture 的最小形状；返回错误列表（空数组=合法）。纯函数。 */
export function validateFixture(raw: unknown): string[] {
  const errs: string[] = [];
  if (!raw || typeof raw !== "object") return ["不是对象"];
  const o = raw as Record<string, unknown>;
  if (typeof o.id !== "string" || !o.id.trim()) errs.push("缺 id");
  if (typeof o.goal !== "string" || !o.goal.trim()) errs.push("缺 goal");
  const scene = o.scene as Record<string, unknown> | undefined;
  if (!scene || typeof scene !== "object") {
    errs.push("缺 scene");
  } else {
    if (typeof scene.background !== "string" || !scene.background.trim()) errs.push("scene 缺 background");
    if (!Array.isArray(scene.characters) || scene.characters.length < 1) errs.push("scene.characters 至少 1 人");
  }
  if (!Array.isArray(o.transcript) || o.transcript.length < 1) {
    errs.push("transcript 至少 1 条");
  } else {
    for (const [i, b] of (o.transcript as unknown[]).entries()) {
      const beat = b as Record<string, unknown>;
      if (!beat || typeof beat.content !== "string" || !beat.content.trim()) {
        errs.push(`transcript[${i}] 缺 content`);
      }
    }
  }
  return errs;
}

/** 解析并校验一份 fixture；非法则抛错。 */
export function coerceFixture(raw: unknown, source: string): ProseFixture {
  const errs = validateFixture(raw);
  if (errs.length) throw new Error(`fixture 非法（${source}）：${errs.join("；")}`);
  return raw as ProseFixture;
}

/** 列出内置文笔 fixtures（id → ProseFixture）；跳过审校 fixture（review-*.json）。 */
export function listFixtures(): ProseFixture[] {
  const dir = fixturesDir();
  if (!existsSync(dir)) return [];
  const out: ProseFixture[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json") || name.startsWith(REVIEW_PREFIX)) continue;
    const path = join(dir, name);
    try {
      out.push(coerceFixture(JSON.parse(readFileSync(path, "utf8")), name));
    } catch {
      // 跳过损坏/非法的 fixture 文件
    }
  }
  return out;
}

/** 校验一份审校 fixture 的最小形状；返回错误列表（空数组=合法）。纯函数。 */
export function validateReviewFixture(raw: unknown): string[] {
  const errs: string[] = [];
  if (!raw || typeof raw !== "object") return ["不是对象"];
  const o = raw as Record<string, unknown>;
  if (typeof o.id !== "string" || !o.id.trim()) errs.push("缺 id");
  if (typeof o.goal !== "string" || !o.goal.trim()) errs.push("缺 goal");
  if (typeof o.draft !== "string" || !o.draft.trim()) errs.push("缺 draft（待审校草稿）");
  const scene = o.scene as Record<string, unknown> | undefined;
  if (!scene || typeof scene !== "object") {
    errs.push("缺 scene");
  } else {
    if (typeof scene.background !== "string" || !scene.background.trim()) errs.push("scene 缺 background");
    if (!Array.isArray(scene.characters) || scene.characters.length < 1) errs.push("scene.characters 至少 1 人");
  }
  if (!Array.isArray(o.transcript) || o.transcript.length < 1) errs.push("transcript 至少 1 条");
  if (!Array.isArray(o.plantedBugs) || o.plantedBugs.length < 1) errs.push("plantedBugs 至少 1 条（植入的已知硬伤）");
  if (!Array.isArray(o.invariants) || o.invariants.length < 1) errs.push("invariants 至少 1 条（须保留的故事要素）");
  return errs;
}

/** 解析并校验一份审校 fixture；非法则抛错。 */
export function coerceReviewFixture(raw: unknown, source: string): ReviewFixture {
  const errs = validateReviewFixture(raw);
  if (errs.length) throw new Error(`审校 fixture 非法（${source}）：${errs.join("；")}`);
  return raw as ReviewFixture;
}

/**
 * 按 id 或文件路径加载一份审校 fixture。
 * - 先当作内置 id：eval/fixtures/review-<id>.json（也兼容已带前缀/带 .json 的写法）；
 * - 否则当作直接文件路径读取。
 */
export function loadReviewFixture(idOrPath: string): ReviewFixture {
  const bare = idOrPath.replace(/\.json$/, "");
  const withPrefix = bare.startsWith(REVIEW_PREFIX) ? bare : `${REVIEW_PREFIX}${bare}`;
  const asId = join(fixturesDir(), `${withPrefix}.json`);
  const path = existsSync(asId) ? asId : idOrPath;
  if (!existsSync(path)) {
    throw new Error(`找不到审校 fixture：${idOrPath}（既非内置 id，也非存在的文件路径）`);
  }
  return coerceReviewFixture(JSON.parse(readFileSync(path, "utf8")), path);
}

/** 列出内置审校 fixtures（review-*.json）。 */
export function listReviewFixtures(): ReviewFixture[] {
  const dir = fixturesDir();
  if (!existsSync(dir)) return [];
  const out: ReviewFixture[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json") || !name.startsWith(REVIEW_PREFIX)) continue;
    try {
      out.push(coerceReviewFixture(JSON.parse(readFileSync(join(dir, name), "utf8")), name));
    } catch {
      // 跳过损坏/非法的 fixture 文件
    }
  }
  return out;
}

/**
 * 按 id 或文件路径加载一份 fixture。
 * - 先当作内置 id（eval/fixtures/<id>.json）；
 * - 否则当作直接文件路径读取。
 */
export function loadFixture(idOrPath: string): ProseFixture {
  const asId = join(fixturesDir(), `${idOrPath}.json`);
  const path = existsSync(asId) ? asId : idOrPath;
  if (!existsSync(path)) {
    throw new Error(`找不到 fixture：${idOrPath}（既非内置 id，也非存在的文件路径）`);
  }
  return coerceFixture(JSON.parse(readFileSync(path, "utf8")), path);
}
