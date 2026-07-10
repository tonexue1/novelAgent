// 武侠剧场前端（两栏）：
//   左侧 = 聊天式看戏（SSE 实时流），底部输入框 + 开演；
//   右侧 = 执笔成文，看完一幕后点「执笔成文」按需生成。
// 演出与成文拆成两步，整幕记录由前端持有，成文时回传给后端（服务端无状态）。

const $ = (s) => document.querySelector(s);

const seedEl = $("#seed");
const playBtn = $("#play");
const composer = $("#composer");
const chatEl = $("#chat");
const emptyEl = $("#empty");
const statusEl = $("#status");
const statusText = statusEl.querySelector(".status-text");
const writeBtn = $("#write");
const novelEl = $("#novel");

let source = null;
let playing = false;
let generating = false;

// 前端累积的整幕记录，成文时回传。
let currentSeed = "";
let currentScene = null; // { background, characters:[...] }
let transcript = []; // [{ actor, kind, content }]

// 角色配色
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

function escapeHtml(s) {
  return String(s).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function setStatus(kind, text) {
  statusEl.hidden = false;
  statusEl.className = `status ${kind}`;
  statusText.textContent = text;
}

function scrollChat() {
  chatEl.scrollTop = chatEl.scrollHeight;
}

// ── 聊天区渲染 ─────────────────────────────────
function renderScene(ev) {
  currentScene = { background: ev.background, characters: ev.characters };

  const card = document.createElement("div");
  card.className = "scene-card";
  const cast = ev.characters
    .map((c) => {
      const color = colorFor(c.name);
      return `<span class="cast-chip" title="${escapeHtml(c.identity)}｜目标：${escapeHtml(c.goal)}">
        <span class="dot" style="background:${color}">${escapeHtml(firstChar(c.name))}</span>
        <span class="cname">${escapeHtml(c.name)}</span>
      </span>`;
    })
    .join("");
  card.innerHTML = `
    <div class="scene-label">幕启 · 此地此景</div>
    <p class="scene-bg">${escapeHtml(ev.background)}</p>
    <div class="cast">${cast}</div>`;
  chatEl.appendChild(card);
  scrollChat();
}

function renderBeat(ev) {
  transcript.push({ actor: ev.actor, kind: "act", content: ev.content });
  const color = colorFor(ev.actor);
  const el = document.createElement("div");
  el.className = "msg";
  el.innerHTML = `
    <div class="msg-avatar" style="background:${color}">${escapeHtml(firstChar(ev.actor))}</div>
    <div class="msg-body">
      <div class="msg-name" style="color:${color}">${escapeHtml(ev.actor)}</div>
      <div class="msg-bubble">${escapeHtml(ev.content)}</div>
    </div>`;
  chatEl.appendChild(el);
  scrollChat();
}

function renderNarration(ev) {
  transcript.push({ actor: "旁白", kind: "narration", content: ev.content });
  const el = document.createElement("div");
  el.className = "sys-line";
  el.textContent = ev.content;
  chatEl.appendChild(el);
  scrollChat();
}

function renderDirectorEnd(ev) {
  const el = document.createElement("div");
  el.className = "sys-line end";
  el.textContent = ev.reason ? `导演示意收场：${ev.reason}` : "导演示意收场";
  chatEl.appendChild(el);
  scrollChat();
}

// 某位角色"正在斟酌"的输入提示
let typingEl = null;
function showTyping() {
  clearTyping();
  typingEl = document.createElement("div");
  typingEl.className = "typing";
  typingEl.innerHTML = `台上正酝酿 <span class="dots"><span></span><span></span><span></span></span>`;
  chatEl.appendChild(typingEl);
  scrollChat();
}
function clearTyping() {
  if (typingEl) { typingEl.remove(); typingEl = null; }
}

// ── SSE 事件分发 ───────────────────────────────
function handleEvent(ev) {
  switch (ev.type) {
    case "seed":
      currentSeed = ev.seed;
      break;
    case "step":
      if (ev.n === 1) setStatus("busy", "导演落笔，勾勒人物与背景…");
      else if (ev.n === 2) { setStatus("busy", "群侠登场，好戏开演…"); showTyping(); }
      break;
    case "scene":
      renderScene(ev);
      break;
    case "narration":
      showTyping();
      renderNarration(ev);
      break;
    case "beat":
      renderBeat(ev);
      showTyping();
      break;
    case "director-end":
      renderDirectorEnd(ev);
      break;
    case "play-complete":
      clearTyping();
      finishPlay("done", "此幕演毕，可执笔成文。");
      break;
    case "error":
      clearTyping();
      finishPlay("error", "演出中断：" + ev.message);
      break;
  }
}

function finishPlay(kind, text) {
  playing = false;
  playBtn.disabled = false;
  setStatus(kind, text);
  if (source) { source.close(); source = null; }
  // 有可成文的内容才放开右侧按钮
  if (kind === "done" && currentScene && transcript.length > 0) {
    writeBtn.disabled = false;
  }
}

// ── 开演 ───────────────────────────────────────
function startPlay() {
  if (playing) return;
  const seed = seedEl.value.trim();

  playing = true;
  playBtn.disabled = true;
  writeBtn.disabled = true;
  actorColor.clear();
  transcript = [];
  currentScene = null;
  currentSeed = seed;
  clearTyping();
  if (emptyEl) emptyEl.remove();
  chatEl.innerHTML = "";
  resetNovelPane();
  setStatus("busy", "正在接通后台…");

  const params = new URLSearchParams();
  if (seed) params.set("seed", seed);

  source = new EventSource(`/api/play?${params.toString()}`);
  source.onmessage = (e) => {
    try { handleEvent(JSON.parse(e.data)); } catch { /* 心跳等忽略 */ }
  };
  source.onerror = () => {
    if (playing) finishPlay("error", "连接中断，请重试。");
  };
}

// ── 执笔成文（按需） ───────────────────────────
function resetNovelPane() {
  novelEl.innerHTML = `
    <div class="empty">
      <p class="empty-title">此处留白，静待成文</p>
      <p class="empty-sub">左侧演完一幕后，点右上角「执笔成文」——执笔人会用全局视角把整幕即兴记录改写成一章小说正文。</p>
    </div>`;
}

async function generateNovel() {
  if (generating || !currentScene || transcript.length === 0) return;
  generating = true;
  writeBtn.disabled = true;
  writeBtn.textContent = "挥毫中…";

  novelEl.innerHTML = `
    <div class="typing" style="padding:8px 2px">执笔人挥毫成文
      <span class="dots"><span></span><span></span><span></span></span>
    </div>`;

  try {
    const res = await fetch("/api/novelize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ seed: currentSeed, scene: currentScene, transcript }),
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
    renderProse(data.prose);
  } catch (err) {
    novelEl.innerHTML = `<div class="novel-error">成文失败：${escapeHtml(err.message)}<br>请检查 .env 里的 LLM 配置后重试。</div>`;
  } finally {
    generating = false;
    writeBtn.disabled = false;
    writeBtn.textContent = "重新成文";
  }
}

function renderProse(content) {
  const lines = content.split("\n").map((s) => s.trim()).filter(Boolean);
  const title = lines.length ? lines[0] : "无题";
  const paras = lines.slice(1);

  const wrap = document.createElement("div");
  wrap.className = "prose-body";
  const h = document.createElement("div");
  h.className = "prose-title";
  h.textContent = title;
  wrap.appendChild(h);
  for (const p of paras) {
    const el = document.createElement("p");
    el.textContent = p;
    wrap.appendChild(el);
  }

  const actions = document.createElement("div");
  actions.className = "prose-actions";

  const copyBtn = document.createElement("button");
  copyBtn.className = "mini-btn";
  copyBtn.textContent = "复制全文";
  copyBtn.onclick = async () => {
    await navigator.clipboard.writeText(content);
    copyBtn.textContent = "已复制 ✓";
    setTimeout(() => (copyBtn.textContent = "复制全文"), 1600);
  };

  const dlBtn = document.createElement("button");
  dlBtn.className = "mini-btn";
  dlBtn.textContent = "下载 .md";
  dlBtn.onclick = () => {
    const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `wuxia-${Date.now()}.md`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  actions.append(copyBtn, dlBtn);
  wrap.appendChild(actions);

  novelEl.innerHTML = "";
  novelEl.appendChild(wrap);
}

// ── 交互绑定 ───────────────────────────────────
composer.addEventListener("submit", (e) => {
  e.preventDefault();
  startPlay();
});

// 回车开演，Shift+Enter 换行；输入框随内容自适应高度。
seedEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    startPlay();
  }
});
seedEl.addEventListener("input", () => {
  seedEl.style.height = "auto";
  seedEl.style.height = Math.min(seedEl.scrollHeight, 140) + "px";
});

writeBtn.addEventListener("click", generateNovel);

document.addEventListener("click", (e) => {
  const chip = e.target.closest(".chip");
  if (chip) {
    seedEl.value = chip.textContent.trim();
    seedEl.focus();
  }
});
