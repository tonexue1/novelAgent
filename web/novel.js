// 多章小说前端（三栏）：
//   左 = 书斋：选/建小说 + 大纲章节列表 + 生成下一章；
//   中 = 演武场：本章多 agent 演出（SSE 实时流）+ 执笔成文；
//   右 = 档案：故事梗概 / 未回收伏笔 / 人物档案，随每章更新。
// 状态落盘在服务端 novels/<slug>/；前端每写完一章从服务端拉取最新详情，保证一致。

const $ = (s) => document.querySelector(s);

const projectSelect = $("#project-select");
const createForm = $("#create-form");
const seedEl = $("#seed");
const genreSelect = $("#genre-select");
const genreCustom = $("#genre-custom");
const styleSelect = $("#style-select");
const styleCustom = $("#style-custom");
const styleIntensityEl = $("#style-intensity");
const chapterCountEl = $("#chapter-count");
const createBtn = $("#create-btn");
const samplesEl = $("#samples");
const outlineEl = $("#outline");
const outlineTitle = $("#outline-title");
const outlineLogline = $("#outline-logline");
const arcInfoEl = $("#arc-info");
const chapterListEl = $("#chapter-list");
const genBar = $("#gen-bar");
const genNextBtn = $("#gen-next");
const autoEl = $("#auto");
const stageEl = $("#stage");
const stageEmpty = $("#stage-empty");
const stageTitle = $("#stage-title");
const stageSub = $("#stage-sub");
const statusEl = $("#status");
const statusText = statusEl.querySelector(".status-text");
const memoryEl = $("#memory");

let currentSlug = "";
let source = null;
let generating = false;

// ── 小工具 ─────────────────────────────────────
function escapeHtml(s) {
  return String(s).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
function setStatus(kind, text) {
  statusEl.hidden = false;
  statusEl.className = `status ${kind}`;
  statusText.textContent = text;
}
function scrollStage() {
  stageEl.scrollTop = stageEl.scrollHeight;
}

const ACTOR_COLORS = [
  "#6b4f8a", "#2f6b5e", "#a8632d", "#3a5f8a",
  "#8a3a52", "#4a7a3a", "#8a6a2f", "#5a4a8a",
];
const actorColor = new Map();
function colorFor(name) {
  if (!actorColor.has(name)) {
    actorColor.set(name, ACTOR_COLORS[actorColor.size % ACTOR_COLORS.length]);
  }
  return actorColor.get(name);
}
function firstChar(name) {
  const m = name.match(/[\u4e00-\u9fa5]/g);
  return m ? m[m.length - 1] : name.slice(0, 1);
}

// ── 题材 ────────────────────────────────────────
// 每个题材给几条贴题材的示例前提；custom / 未知题材回落到通用。
const GENRE_SAMPLES = {
  wuxia: [
    "少年背负灭门血仇，下山寻仇，却卷入一桩夺谱惊局。",
    "女捕头查一桩连环命案，线索直指二十年前的江湖旧盟。",
  ],
  xianxia: [
    "凡根少年误吞一缕上古剑魂，被卷入九宗争夺的登仙之路。",
    "散修少女以一枚残破玉简，叩问长生，搅动三界棋局。",
  ],
  xuanhuan: [
    "废材少爷觉醒逆天血脉，从家族弃子走向大陆之巅。",
    "少年得远古神魔传承，在万族林立的大陆逆流而上。",
  ],
  urban: [
    "普通上班族一夜觉醒异能，被拽进都市异能者的暗战。",
    "退伍兵回城守护家园，却发现城市底下藏着修行世家。",
  ],
  scifi: [
    "星舰工程师发现一段禁忌代码，牵出人类文明的惊天谎言。",
    "末世幸存者靠一枚神秘芯片，在废土上重建希望。",
  ],
  fantasy: [
    "农家少年拔出封印的魔剑，被卷入王国与教会的千年之争。",
    "落魄法师带着会说话的龙蛋，踏上寻找失落神器的旅途。",
  ],
  _default: [
    "一个小人物意外卷入惊天阴谋，被迫踏上改变命运的旅程。",
    "宿敌两人被迫联手，共同面对一个更可怕的威胁。",
  ],
};

// 前端兜底题材（与后端 GENRES 对齐）：即便 /api/genres 拉取失败/旧服务端无该路由，
// 下拉也始终有值，不会空白。
const FALLBACK_GENRES = [
  { id: "wuxia", label: "武侠" },
  { id: "xianxia", label: "仙侠" },
  { id: "xuanhuan", label: "玄幻" },
  { id: "urban", label: "都市异能" },
  { id: "scifi", label: "科幻" },
  { id: "fantasy", label: "西方奇幻" },
];

function populateGenreSelect(genres) {
  genreSelect.innerHTML = "";
  for (const g of genres) {
    const opt = document.createElement("option");
    opt.value = g.id;
    opt.textContent = g.label;
    genreSelect.appendChild(opt);
  }
  const custom = document.createElement("option");
  custom.value = "__custom__";
  custom.textContent = "自定义…";
  genreSelect.appendChild(custom);
}

function currentGenreValue() {
  const v = genreSelect.value;
  if (v === "__custom__") return genreCustom.value.trim();
  return v;
}

function renderSamples() {
  const key = genreSelect.value === "__custom__" ? "_default" : genreSelect.value;
  const list = GENRE_SAMPLES[key] || GENRE_SAMPLES._default;
  samplesEl.hidden = false;
  samplesEl.innerHTML = list
    .map((s) => `<button class="chip" type="button">${escapeHtml(s)}</button>`)
    .join("");
}

function onGenreChange() {
  const isCustom = genreSelect.value === "__custom__";
  genreCustom.hidden = !isCustom;
  if (isCustom) genreCustom.focus();
  renderSamples();
}

// 前端兜底风味（与后端 STYLE_CARDS 对齐）：即便 /api/styles 拉取失败/旧服务端无该路由，
// 下拉也始终有值。首项"不启用"表示回落题材默认腔调。
const FALLBACK_STYLES = [
  { id: "chendong", label: "辰东式史诗" },
  { id: "gulong", label: "古龙式冷硬" },
  { id: "jinyong", label: "金庸式醇厚" },
];

function populateStyleSelect(styles) {
  styleSelect.innerHTML = "";
  const none = document.createElement("option");
  none.value = "none";
  none.textContent = "不启用（题材默认腔调）";
  styleSelect.appendChild(none);
  for (const s of styles) {
    const opt = document.createElement("option");
    opt.value = s.id;
    opt.textContent = s.label;
    if (s.tagline) opt.title = s.tagline;
    styleSelect.appendChild(opt);
  }
  const custom = document.createElement("option");
  custom.value = "__custom__";
  custom.textContent = "自定义…";
  styleSelect.appendChild(custom);
}

function currentStyleValue() {
  const v = styleSelect.value;
  if (v === "__custom__") return styleCustom.value.trim();
  return v;
}

function onStyleChange() {
  const isCustom = styleSelect.value === "__custom__";
  styleCustom.hidden = !isCustom;
  if (isCustom) styleCustom.focus();
}

async function loadStyles() {
  populateStyleSelect(FALLBACK_STYLES);
  try {
    const res = await fetch("/api/styles");
    if (res.ok) {
      const data = await res.json();
      const styles = data.styles || [];
      if (styles.length) populateStyleSelect(styles);
    }
  } catch {
    /* 拉取失败保留兜底列表 */
  }
}

async function loadGenres() {
  // 先用兜底列表铺满，保证下拉立即可用；再尝试用后端返回的列表覆盖。
  populateGenreSelect(FALLBACK_GENRES);
  try {
    const res = await fetch("/api/genres");
    if (res.ok) {
      const data = await res.json();
      const genres = data.genres || [];
      if (genres.length) populateGenreSelect(genres);
    }
  } catch {
    /* 拉取失败保留兜底列表 */
  }
  renderSamples();
}

// ── 项目列表 / 详情 ─────────────────────────────
async function loadProjects(selectSlug) {
  const res = await fetch("/api/novels");
  const data = await res.json();
  const novels = data.novels || [];
  projectSelect.innerHTML = '<option value="">— 选择已有小说 —</option>';
  for (const m of novels) {
    const opt = document.createElement("option");
    opt.value = m.slug;
    opt.textContent = `《${m.title}》· ${m.chaptersWritten}章`;
    projectSelect.appendChild(opt);
  }
  if (selectSlug) projectSelect.value = selectSlug;
}

async function loadDetail(slug) {
  const res = await fetch(`/api/novels/${encodeURIComponent(slug)}`);
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
  return data.project;
}

async function selectProject(slug) {
  currentSlug = slug;
  if (source) { source.close(); source = null; }
  if (!slug) {
    outlineEl.hidden = true;
    genBar.hidden = true;
    return;
  }
  const project = await loadDetail(slug);
  renderOutlineFromProject(project);
  renderMemory(project.memory);
  genBar.hidden = false;
  updateGenButton(project.outline);
  clearStage(`《${project.meta.title}》`, project.outline.logline);
}

// ── 大纲渲染 ────────────────────────────────────
function renderOutlineFromProject(project) {
  const o = project.outline;
  renderOutline(project.meta.title, o.logline, o.chapters, {
    mode: o.mode,
    arcs: o.arcs,
    currentArc: o.currentArc,
    targetChapters: o.targetChapters,
    chaptersWritten: project.meta.chaptersWritten,
  });
}

function renderArcInfo(info) {
  if (!info || info.mode !== "rolling" || !info.arcs || !info.arcs.length) {
    arcInfoEl.hidden = true;
    return;
  }
  const total = info.arcs.length;
  const cur = info.currentArc || 1;
  const curArc = info.arcs.find((a) => a.n === cur);
  const written = info.chaptersWritten ?? 0;
  const target = info.targetChapters ?? "";
  arcInfoEl.hidden = false;
  arcInfoEl.innerHTML =
    `<span class="arc-badge">分卷连载</span>` +
    `第 ${cur}/${total} 卷${curArc ? `《${escapeHtml(curArc.title)}》` : ""}` +
    ` · 已写 ${written}${target ? `/${target}` : ""} 章`;
}

function renderOutline(title, logline, chapters, arcInfo) {
  outlineEl.hidden = false;
  samplesEl.hidden = true;
  outlineTitle.textContent = `《${title}》`;
  outlineLogline.textContent = logline || "";
  renderArcInfo(arcInfo);
  chapterListEl.innerHTML = "";
  for (const c of chapters) {
    const li = document.createElement("li");
    li.className = `chapter-item ${c.status === "written" ? "written" : "planned"}`;
    li.innerHTML = `
      <span class="ch-no">${c.status === "written" ? "✓" : c.n}</span>
      <span class="ch-body">
        <span class="ch-title">${escapeHtml(c.title)}</span>
        <span class="ch-goal">${escapeHtml(c.goal)}</span>
      </span>`;
    if (c.status === "written") {
      li.title = "点击阅读本章";
      li.addEventListener("click", () => readChapter(c.n, c.title));
    }
    chapterListEl.appendChild(li);
  }
}

function updateGenButton(outline) {
  const hasPlanned = outline.chapters.some((c) => c.status !== "written");
  genNextBtn.disabled = generating || !hasPlanned;
  genNextBtn.textContent = hasPlanned ? "生成下一章" : "已完本";
}

// ── 记忆面板 ────────────────────────────────────
function renderMemory(memory) {
  const wb = memory.worldBible || {};
  const chips = (arr) =>
    (arr || []).map((s) => `<span class="mem-chip">${escapeHtml(s)}</span>`).join("");
  const openThreads = (memory.threads || []).filter((t) => t.status === "open");

  const chars = (memory.characters || [])
    .map(
      (c) => `
      <div class="mem-char">
        <div class="mem-char-head">
          <span class="mem-char-name">${escapeHtml(c.name)}</span>
          <span class="mem-char-status">${escapeHtml(c.status || "")}</span>
        </div>
        <div class="mem-char-id">${escapeHtml(c.identity || "")}</div>
        <div class="mem-char-note">目标：${escapeHtml(c.currentGoal || c.longTermGoal || "")}</div>
      </div>`,
    )
    .join("");

  memoryEl.innerHTML = `
    <section class="mem-block">
      <h4>故事梗概至今</h4>
      <p class="mem-summary">${escapeHtml(memory.rollingSummary || "（尚未开始）")}</p>
    </section>
    <section class="mem-block">
      <h4>未回收伏笔（${openThreads.length}）</h4>
      ${
        openThreads.length
          ? `<ul class="mem-threads">${openThreads
              .map((t) => `<li>${escapeHtml(t.description)}</li>`)
              .join("")}</ul>`
          : '<p class="mem-empty">暂无</p>'
      }
    </section>
    <section class="mem-block">
      <h4>世界设定</h4>
      <div class="mem-chips">
        ${chips(wb.factions)}${chips(wb.locations)}${chips(wb.items)}
      </div>
    </section>
    <section class="mem-block">
      <h4>人物档案（${(memory.characters || []).length}）</h4>
      ${chars || '<p class="mem-empty">暂无</p>'}
    </section>`;
}

// ── 演武场（本章演出流） ────────────────────────
function clearStage(title, sub) {
  stageEl.innerHTML = "";
  actorColor.clear();
  if (title) stageTitle.textContent = title;
  if (sub) stageSub.textContent = sub;
}

function renderScene(ev) {
  const cast = ev.characters
    .map((c) => {
      const color = colorFor(c.name);
      return `<span class="cast-chip" title="${escapeHtml(c.identity)}｜目标：${escapeHtml(c.goal)}">
        <span class="dot" style="background:${color}">${escapeHtml(firstChar(c.name))}</span>
        <span class="cname">${escapeHtml(c.name)}</span>
      </span>`;
    })
    .join("");
  const card = document.createElement("div");
  card.className = "scene-card";
  card.innerHTML = `
    <div class="scene-label">幕启 · 此地此景</div>
    <p class="scene-bg">${escapeHtml(ev.background)}</p>
    <div class="cast">${cast}</div>`;
  stageEl.appendChild(card);
  scrollStage();
}

function renderBeat(ev) {
  const color = colorFor(ev.actor);
  const el = document.createElement("div");
  el.className = "msg";
  el.innerHTML = `
    <div class="msg-avatar" style="background:${color}">${escapeHtml(firstChar(ev.actor))}</div>
    <div class="msg-body">
      <div class="msg-name" style="color:${color}">${escapeHtml(ev.actor)}</div>
      <div class="msg-bubble">${escapeHtml(ev.content)}</div>
    </div>`;
  stageEl.appendChild(el);
  scrollStage();
}

function renderNarration(ev) {
  const el = document.createElement("div");
  el.className = "sys-line";
  el.textContent = ev.content;
  stageEl.appendChild(el);
  scrollStage();
}

function renderChapterProse(title, content) {
  const wrap = document.createElement("div");
  wrap.className = "prose-body prose-card";
  const h = document.createElement("div");
  h.className = "prose-title";
  h.textContent = title;
  wrap.appendChild(h);
  for (const p of content.split("\n").map((s) => s.trim()).filter(Boolean)) {
    const el = document.createElement("p");
    el.textContent = p;
    wrap.appendChild(el);
  }
  stageEl.appendChild(wrap);
  scrollStage();
}

let typingEl = null;
function showTyping(text) {
  clearTyping();
  typingEl = document.createElement("div");
  typingEl.className = "typing";
  typingEl.innerHTML = `${escapeHtml(text || "台上正酝酿")} <span class="dots"><span></span><span></span><span></span></span>`;
  stageEl.appendChild(typingEl);
  scrollStage();
}
function clearTyping() {
  if (typingEl) { typingEl.remove(); typingEl = null; }
}

// ── 生成下一章（SSE） ───────────────────────────
function genNext() {
  if (generating || !currentSlug) return;
  generating = true;
  genNextBtn.disabled = true;
  if (stageEmpty && stageEmpty.parentNode) stageEmpty.remove();
  setStatus("busy", "接通后台，准备开写…");

  source = new EventSource(`/api/novels/${encodeURIComponent(currentSlug)}/next`);
  source.onmessage = (e) => {
    try { handleEvent(JSON.parse(e.data)); } catch { /* 心跳忽略 */ }
  };
  source.onerror = () => {
    // 传输层断开：EventSource 会自动重连，并带上 Last-Event-ID 让服务端从断点续传。
    // 所以这里不放弃、不 close（close 会阻止自动重连）；只有真正的失败会由服务端
    // 通过 error 事件告知。生成在后台独立进行，重连后会把剩余事件补齐直到 done。
    if (generating && source && source.readyState === EventSource.CONNECTING) {
      setStatus("busy", "连接中断，正在自动重连…（生成仍在后台进行）");
    }
  };
}

function handleEvent(ev) {
  switch (ev.type) {
    case "chapter-start":
      clearStage(`第 ${ev.n} 章 · ${ev.title}`, `本章目标：${ev.goal}`);
      setStatus("busy", `第 ${ev.n} 章开写…`);
      break;
    case "step":
      if (ev.n === 1) setStatus("busy", "导演落笔，勾勒人物与背景…");
      else if (ev.n === 2) { setStatus("busy", "群侠登场，好戏开演…"); showTyping(); }
      else if (ev.n === 3) { clearTyping(); setStatus("busy", "执笔人挥毫成文…"); showTyping("执笔人挥毫成文"); }
      break;
    case "scene":
      renderScene(ev);
      break;
    case "beat":
      renderBeat(ev);
      showTyping();
      break;
    case "narration":
      showTyping();
      renderNarration(ev);
      break;
    case "director-end":
      clearTyping();
      break;
    case "outline":
      renderOutline(ev.title, ev.logline, ev.chapters, {
        mode: ev.mode ?? (ev.arcs ? "rolling" : undefined),
        arcs: ev.arcs,
        currentArc: ev.currentArc,
        targetChapters: ev.targetChapters,
        chaptersWritten: ev.chapters.filter((c) => c.status === "written").length,
      });
      break;
    case "arc-start":
      setStatus("busy", `第 ${ev.n} 卷《${ev.title}》开卷，规划本卷章节…`);
      break;
    case "chapter-prose":
      clearTyping();
      renderChapterProse(ev.title, ev.content);
      break;
    case "memory-updated":
      setStatus("busy", "档案官记下前情…");
      break;
    case "novel-complete":
      finishGen("done", `全书完成，共 ${ev.chaptersWritten} 章。`);
      break;
    case "done":
      onChapterDone();
      break;
    case "error":
      finishGen("error", "生成中断：" + ev.message);
      break;
  }
}

// 一章的 SSE 结束（可能还有后续章节）。
async function onChapterDone() {
  if (source) { source.close(); source = null; }
  generating = false;
  clearTyping();
  // 从服务端拉最新详情，刷新大纲/记忆/项目列表。
  try {
    const project = await loadDetail(currentSlug);
    renderOutlineFromProject(project);
    renderMemory(project.memory);
    updateGenButton(project.outline);
    await loadProjects(currentSlug);
    const hasPlanned = project.outline.chapters.some((c) => c.status !== "written");
    if (!hasPlanned) {
      setStatus("done", "已完本。");
      return;
    }
    setStatus("done", "本章已成。");
    if (autoEl.checked) {
      genNext(); // 自动续写下一章
    }
  } catch (err) {
    setStatus("error", "刷新失败：" + err.message);
  }
}

function finishGen(kind, text) {
  generating = false;
  if (source) { source.close(); source = null; }
  clearTyping();
  setStatus(kind, text);
  loadDetail(currentSlug)
    .then((p) => { renderOutlineFromProject(p); renderMemory(p.memory); updateGenButton(p.outline); })
    .catch(() => {});
}

// ── 阅读已写章节 ────────────────────────────────
async function readChapter(n, title) {
  if (generating) return;
  try {
    const res = await fetch(`/api/novels/${encodeURIComponent(currentSlug)}/chapters/${n}`);
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
    clearStage(`第 ${n} 章 · ${title}`, "阅读已成章节");
    // markdown 去掉首行 # 标题，其余按段渲染。
    const body = String(data.markdown).replace(/^#.*\n+/, "");
    renderChapterProse(title, body);
  } catch (err) {
    setStatus("error", "读取失败：" + err.message);
  }
}

// ── 新建小说 ────────────────────────────────────
async function createNovel() {
  const seed = seedEl.value.trim();
  if (!seed || generating) return;
  // 章节数 → 提示词。留空/非法则不传，后端用默认区间。
  const n = parseInt(chapterCountEl.value, 10);
  const chapterHint = Number.isInteger(n) && n >= 3 ? `${n} 章（请严格规划为 ${n} 章）` : undefined;
  const genre = currentGenreValue();
  const style = currentStyleValue();
  const styleIntensity = styleIntensityEl ? styleIntensityEl.value : "medium";
  createBtn.disabled = true;
  createBtn.textContent = "立意谋篇中…";
  setStatus("busy", "规划师铺陈大纲与世界观…");
  try {
    const payload = { seed };
    if (chapterHint) payload.chapterHint = chapterHint;
    if (genre) payload.genre = genre;
    if (style && style !== "none") {
      payload.style = style;
      payload.styleIntensity = styleIntensity;
    }
    const res = await fetch("/api/novels", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
    const slug = data.project.meta.slug;
    await loadProjects(slug);
    await selectProject(slug);
    setStatus("done", "大纲已成，点「生成下一章」开写。");
    seedEl.value = "";
  } catch (err) {
    setStatus("error", "开书失败：" + err.message);
  } finally {
    createBtn.disabled = false;
    createBtn.textContent = "立意开书";
  }
}

// ── 交互绑定 ────────────────────────────────────
createForm.addEventListener("submit", (e) => { e.preventDefault(); createNovel(); });
seedEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); createNovel(); }
});
projectSelect.addEventListener("change", () => {
  if (!generating) selectProject(projectSelect.value).catch((err) => setStatus("error", err.message));
});
genNextBtn.addEventListener("click", genNext);
genreSelect.addEventListener("change", onGenreChange);
styleSelect.addEventListener("change", onStyleChange);
samplesEl.addEventListener("click", (e) => {
  const chip = e.target.closest(".chip");
  if (chip) { seedEl.value = chip.textContent.trim(); seedEl.focus(); }
});

loadGenres().catch(() => {});
loadStyles().catch(() => {});
loadProjects().catch(() => {});
