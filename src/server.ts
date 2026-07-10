import { join, normalize } from "node:path";
import { LLMClient } from "./core/llm/client.ts";
import { WuxiaDramaAgent } from "./drama/agent.ts";
import type { DramaEvent } from "./drama/events.ts";
import type { Scene, Beat } from "./drama/scene.ts";
import { NovelEngine } from "./story/engine.ts";
import {
  listProjects,
  loadProject,
  projectExists,
  loadChapterProse,
} from "./story/project.ts";

/**
 * 武侠剧场 Web 服务端：Bun 原生 HTTP，零第三方依赖。
 *
 * 单幕即兴（首页 index.html）：
 *   - GET  /               静态首页
 *   - GET  /<asset>        web/ 目录下的静态资源（css/js 等）
 *   - GET  /api/play       SSE：只演戏（导演+角色即兴），把每一拍实时推给左侧聊天区
 *   - POST /api/novelize   按需成文：拿前端回传的整幕记录，交执笔人写成小说体（右侧）
 *
 * 多章小说（novel.html）：
 *   - GET  /novel                多章界面
 *   - GET  /api/novels           列出所有小说项目
 *   - POST /api/novels           新建小说（规划大纲），返回项目
 *   - GET  /api/novels/:slug     项目详情（元数据/大纲/记忆）
 *   - GET  /api/novels/:slug/next  SSE：生成下一章，流式推送演出/成文/记忆事件
 *
 * "演出"与"成文"拆成两步：先看戏，再点生成。两端复用同一套 WuxiaDramaAgent，
 * 无状态——整幕 transcript 由前端持有并在成文时回传，服务端不存会话。
 */

const PORT = Number(process.env.PORT ?? 5173);
const WEB_DIR = join(import.meta.dir, "..", "web");

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

function contentTypeFor(path: string): string {
  const dot = path.lastIndexOf(".");
  const ext = dot >= 0 ? path.slice(dot).toLowerCase() : "";
  return CONTENT_TYPES[ext] ?? "application/octet-stream";
}

/** 提供 web/ 下的静态文件；阻止越权访问上级目录。 */
async function serveStatic(pathname: string): Promise<Response> {
  const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  // normalize 后若仍含 ".." 说明想跳出 web/ 目录，直接拒绝。
  const safeRel = normalize(rel);
  if (safeRel.startsWith("..") || safeRel.includes(`..${"/"}`) || safeRel.includes(`..\\`)) {
    return new Response("Forbidden", { status: 403 });
  }
  const file = Bun.file(join(WEB_DIR, safeRel));
  if (!(await file.exists())) {
    return new Response("Not Found", { status: 404 });
  }
  return new Response(file, {
    headers: {
      "Content-Type": contentTypeFor(safeRel),
      // 开发用：禁用缓存，避免浏览器拿到旧版 app.js/style.css 造成前后端不匹配。
      "Cache-Control": "no-cache, no-store, must-revalidate",
    },
  });
}

/**
 * 把一个"边跑边发事件"的任务包成 SSE 响应：自带心跳、错误包裹与收尾关闭。
 * run 拿到 send 回调，任意时刻推 {@link DramaEvent}；抛错会被转成 error 事件。
 */
function sseResponse(run: (send: (e: DramaEvent) => void) => Promise<void>): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (event: DramaEvent) => {
        if (closed) return;
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };
      // 心跳：一拍戏可能要等好几秒的 LLM 调用，期间连接会"空闲"。定时发一条
      // SSE 注释行，既重置底层 socket 的 idle 计时，又能穿过中间代理不被掐断。
      const heartbeat = setInterval(() => {
        if (!closed) controller.enqueue(encoder.encode(`: keepalive\n\n`));
      }, 5000);
      try {
        await run(send);
      } catch (err) {
        send({ type: "error", message: err instanceof Error ? err.message : String(err) });
      } finally {
        closed = true;
        clearInterval(heartbeat);
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}

/** 只演一幕戏（导演+角色，不收尾），用 SSE 把演出过程逐条推给浏览器。 */
function handlePlay(url: URL): Response {
  const seed = url.searchParams.get("seed") ?? "";
  return sseResponse(async (send) => {
    const agent = new WuxiaDramaAgent({ client: new LLMClient(), onEvent: send });
    await agent.playScene(seed);
  });
}

interface CreateNovelBody {
  seed?: string;
  chapterHint?: string;
}

/** 列出所有小说项目。 */
function handleListNovels(): Response {
  return Response.json({ novels: listProjects() });
}

/** 新建小说：规划大纲 + 世界观圣经，返回项目。 */
async function handleCreateNovel(req: Request): Promise<Response> {
  let body: CreateNovelBody;
  try {
    body = (await req.json()) as CreateNovelBody;
  } catch {
    return Response.json({ error: "请求体不是合法 JSON。" }, { status: 400 });
  }
  const seed = (body.seed ?? "").trim();
  if (!seed) return Response.json({ error: "缺少 seed（一句前提）。" }, { status: 400 });

  try {
    const engine = new NovelEngine({ client: new LLMClient() });
    const project = await engine.startNovel(seed, body.chapterHint);
    return Response.json({ project });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

/** 项目详情（元数据/大纲/记忆）。 */
function handleNovelDetail(slug: string): Response {
  if (!projectExists(slug)) return Response.json({ error: "项目不存在。" }, { status: 404 });
  try {
    return Response.json({ project: loadProject(slug) });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

/** 读取某一章成文（markdown）。 */
function handleChapterProse(slug: string, n: number): Response {
  if (!projectExists(slug)) return Response.json({ error: "项目不存在。" }, { status: 404 });
  const md = loadChapterProse(slug, n);
  if (md === null) return Response.json({ error: "该章尚未生成。" }, { status: 404 });
  return Response.json({ n, markdown: md });
}

/** SSE：生成下一章，流式推送演出/成文/记忆事件。 */
function handleGenerateNext(slug: string): Response {
  if (!projectExists(slug)) return Response.json({ error: "项目不存在。" }, { status: 404 });
  return sseResponse(async (send) => {
    const engine = new NovelEngine({ client: new LLMClient(), onEvent: send });
    await engine.generateNextChapter(slug);
    send({ type: "done" });
  });
}

interface NovelizeBody {
  seed?: string;
  scene?: Scene;
  transcript?: Beat[];
}

/** 按需成文：拿前端回传的整幕记录，交执笔人写成小说体，返回 JSON。 */
async function handleNovelize(req: Request): Promise<Response> {
  let body: NovelizeBody;
  try {
    body = (await req.json()) as NovelizeBody;
  } catch {
    return Response.json({ error: "请求体不是合法 JSON。" }, { status: 400 });
  }

  const scene = body.scene;
  const transcript = body.transcript;
  if (!scene?.characters?.length || !Array.isArray(transcript) || transcript.length === 0) {
    return Response.json({ error: "缺少可成文的场景或场面记录。" }, { status: 400 });
  }

  try {
    const agent = new WuxiaDramaAgent({ client: new LLMClient() });
    const prose = await agent.novelizeScene(scene, transcript, body.seed);
    return Response.json({ prose });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: message }, { status: 500 });
  }
}

const server = Bun.serve({
  port: PORT,
  // SSE 长连接：一幕戏可能跑几分钟，关掉默认 10s 空闲超时（配合上面的心跳双保险）。
  idleTimeout: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const { pathname } = url;

    // 单幕即兴。
    if (pathname === "/api/play" && req.method === "GET") return handlePlay(url);
    if (pathname === "/api/novelize" && req.method === "POST") return handleNovelize(req);

    // 多章小说。
    if (pathname === "/api/novels" && req.method === "GET") return handleListNovels();
    if (pathname === "/api/novels" && req.method === "POST") return handleCreateNovel(req);
    const nextMatch = pathname.match(/^\/api\/novels\/([^/]+)\/next$/);
    if (nextMatch && req.method === "GET") return handleGenerateNext(decodeURIComponent(nextMatch[1]!));
    const proseMatch = pathname.match(/^\/api\/novels\/([^/]+)\/chapters\/(\d+)$/);
    if (proseMatch && req.method === "GET") {
      return handleChapterProse(decodeURIComponent(proseMatch[1]!), Number(proseMatch[2]));
    }
    const detailMatch = pathname.match(/^\/api\/novels\/([^/]+)$/);
    if (detailMatch && req.method === "GET") return handleNovelDetail(decodeURIComponent(detailMatch[1]!));

    if (req.method !== "GET") return new Response("Method Not Allowed", { status: 405 });
    // /novel 走多章界面。
    if (pathname === "/novel") return serveStatic("/novel.html");
    return serveStatic(pathname);
  },
});

console.log(`\x1b[35m武侠剧场\x1b[0m 已启动 → \x1b[36mhttp://localhost:${server.port}\x1b[0m`);
console.log("\x1b[2m单幕即兴：/ ；多章小说：/novel 。Ctrl+C 退出。\x1b[0m");
