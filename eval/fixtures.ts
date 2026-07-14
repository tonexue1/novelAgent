/**
 * 文笔评测用的交互 fixture 加载与校验。
 * `validateFixture` 是纯函数(可单测)；`loadFixture`/`listFixtures` 是读盘薄封装。
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ProseFixture } from "./rubric.ts";

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

/** 列出内置 fixtures 目录里的所有 fixture（id → ProseFixture）。 */
export function listFixtures(): ProseFixture[] {
  const dir = fixturesDir();
  if (!existsSync(dir)) return [];
  const out: ProseFixture[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    const path = join(dir, name);
    try {
      out.push(coerceFixture(JSON.parse(readFileSync(path, "utf8")), name));
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
