/**
 * 把 {@link Scorecard} 渲染成人类可读的 markdown 报告（纯函数）。
 * 供「监视」环节落盘成 novels/<slug>/verify-report.md，并作为我（agent）参与 5 轴评审的入口。
 */

import type { Scorecard } from "./graders.ts";

function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}

function bar(x: number, width = 20): string {
  const filled = Math.round(Math.max(0, Math.min(1, x)) * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

/** 渲染完整 markdown 报告。 */
export function renderReport(sc: Scorecard): string {
  const L: string[] = [];
  L.push(`# 验证报告：《${sc.title}》`);
  L.push("");
  L.push(
    `- slug：\`${sc.slug}\`　已写 ${sc.chaptersWritten} 章　风味：${sc.styleLabel}`,
  );
  L.push(`- 总分：**${pct(sc.overall)}**　\`${bar(sc.overall)}\``);
  L.push("");

  L.push("## 各轴得分（确定性启发式）");
  L.push("");
  L.push("| 维度 | 得分 | 说明 |");
  L.push("| --- | --- | --- |");
  L.push(
    `| 连续性 | ${pct(sc.continuity.score)} | 重复章 ${sc.continuity.duplicates.length} / 共 ${sc.continuity.totalChapters} 章 |`,
  );
  L.push(
    `| 世界观覆盖 | ${pct(sc.worldview.score)} | 正文引用到 ${sc.worldview.coverage.hit}/${sc.worldview.coverage.total} 个世界标志设定 |`,
  );
  L.push(
    `| 风味词覆盖 | ${pct(sc.style.score)} | 命中 ${sc.style.lexicon.hit}/${sc.style.lexicon.total} 个风味词；短句占比 ${pct(sc.style.shortSentenceRatio)}；象声词 ${sc.style.onomatopoeia} 处 |`,
  );
  L.push(
    `| 开场起势 | ${sc.opening.available ? pct(sc.opening.score) : "N/A"} | ${
      sc.opening.available
        ? `第1章开头引用 ${sc.opening.groundedTermsInLead} 个世界设定、${sc.opening.wideShot ? "有" : "无"}大尺度远景`
        : "缺第 1 章正文"
    } |`,
  );
  L.push(
    `| 去通用宅斗 | ${pct(sc.genericDrama.score)} | 负向词命中 ${sc.genericDrama.total} 处 |`,
  );
  L.push("");

  // 门槛判定
  L.push("## 门槛判定");
  L.push("");
  const gate = (ok: boolean, text: string) => `- ${ok ? "✅" : "❌"} ${text}`;
  L.push(gate(sc.continuity.duplicates.length === 0, "重复章 = 0（连续性硬指标）"));
  L.push(gate(sc.worldview.score >= 0.5, "世界观覆盖 ≥ 50%"));
  L.push(gate(sc.opening.available && sc.opening.score >= 0.5, "第 1 章开场起势达标"));
  L.push(gate(sc.genericDrama.total <= sc.continuity.totalChapters, "通用宅斗负向可控"));
  L.push("");

  if (sc.continuity.duplicates.length) {
    L.push("## 重复章明细（连续性硬伤）");
    L.push("");
    for (const d of sc.continuity.duplicates) {
      L.push(`- 第 ${d.n} 章《${d.title}》与第 ${d.dupOf} 章在【${d.by === "title" ? "标题" : "目标"}】上重复`);
    }
    L.push("");
  }

  if (sc.worldview.coverage.missed.length) {
    L.push("## 未在正文落地的世界设定（节选）");
    L.push("");
    for (const m of sc.worldview.coverage.missed.slice(0, 12)) L.push(`- ${m}`);
    L.push("");
  }

  if (sc.opening.available) {
    L.push("## 第 1 章开头取样（供人工评审）");
    L.push("");
    L.push("> " + sc.opening.sampleLead.replace(/\n+/g, " ").slice(0, 300));
    L.push("");
  }

  L.push("## 待人工（agent）参与的 5 轴评审");
  L.push("");
  L.push(
    "启发式只覆盖连续性/世界观/开场等可量化信号；**风格、可读性、逻辑**需读样章定性评审：",
  );
  L.push("");
  L.push("- 风格：辰东味（史诗尺度/说书人腔/短句鼓点）是否到位");
  L.push("- 可读性：叙述-对白-心理是否交织，节奏张弛");
  L.push("- 逻辑：时间线/因果/生死/道具是否自洽");
  L.push("");
  L.push(`抽样章路径：\`novels/${sc.slug}/chapters/ch01.md\`、\`ch02.md\`、\`ch03.md\``);
  L.push("");

  return L.join("\n");
}

/** 渲染一行紧凑总览（打印到终端）。 */
export function renderSummaryLine(sc: Scorecard): string {
  return (
    `《${sc.title}》总分 ${pct(sc.overall)}｜` +
    `连续性 ${pct(sc.continuity.score)}(重复${sc.continuity.duplicates.length})｜` +
    `世界观 ${pct(sc.worldview.score)}｜` +
    `风味 ${pct(sc.style.score)}｜` +
    `开场 ${sc.opening.available ? pct(sc.opening.score) : "N/A"}｜` +
    `宅斗负向 ${sc.genericDrama.total}`
  );
}
