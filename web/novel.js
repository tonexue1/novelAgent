// 多章小说前端（三栏）：
//   左 = 书斋：选/建小说 + 大纲章节列表 + 生成下一章；
//   中 = 演武场：本章多 agent 演出（SSE 实时流）+ 执笔成文；
//   右 = 档案：故事梗概 / 未回收伏笔 / 人物档案，随每章更新。
// 状态落盘在服务端 novels/<slug>/；前端每写完一章从服务端拉取最新详情，保证一致。

const $ = (s) => document.querySelector(s);

const projectSelect = $("#project-select");
const createForm = $("#create-form");
const seedEl = $("#seed");
const createBtn = $("#create-btn");
const samplesEl = $("#samples");
const outlineEl = $("#outline");
const outlineTitle = $("#outline-title");
const outlineLogline = $("#outline-logline");
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
  renderOutline(project.meta.title, project.outline.logline, project.outline.chapters);
}

function renderOutline(title, logline, chapters) {
  outlineEl.hidden = false;
  samplesEl.hidden = true;
  outlineTitle.textContent = `《${title}》`;
  outlineLogline.textContent = logline || "";
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
    if (generating) finishGen("error", "连接中断，请重试。");
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
      renderOutline(ev.title, ev.logline, ev.chapters);
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
  createBtn.disabled = true;
  createBtn.textContent = "立意谋篇中…";
  setStatus("busy", "规划师铺陈大纲与世界观…");
  try {
    const res = await fetch("/api/novels", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ seed }),
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
samplesEl.addEventListener("click", (e) => {
  const chip = e.target.closest(".chip");
  if (chip) { seedEl.value = chip.textContent.trim(); seedEl.focus(); }
});

loadProjects().catch(() => {});
