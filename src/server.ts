import { join, normalize } from "node:path";
import { LLMClient } from "./core/llm/client.ts";
import { WuxiaDramaAgent } from "./drama/agent.ts";
import type { DramaEvent } from "./drama/events.ts";
import type { Scene, Beat } from "./drama/scene.ts";

/**
 * 武侠剧场 Web 服务端：Bun 原生 HTTP，零第三方依赖。
 *
 *   - GET  /               静态首页（web/index.html）
 *   - GET  /<asset>        web/ 目录下的静态资源（css/js 等）
 *   - GET  /api/play       SSE：只演戏（导演+角色即兴），把每一拍实时推给左侧聊天区
 *   - POST /api/novelize   按需成文：拿前端回传的整幕记录，交执笔人写成小说体（右侧）
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

/** 只演一幕戏（导演+角色，不收尾），用 SSE 把演出过程逐条推给浏览器。 */
function handlePlay(url: URL): Response {
  const seed = url.searchParams.get("seed") ?? "";
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
        const agent = new WuxiaDramaAgent({ client: new LLMClient(), onEvent: send });
        await agent.playScene(seed);
      } catch (err) {
        send({
          type: "error",
          message: err instanceof Error ? err.message : String(err),
        });
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
    if (url.pathname === "/api/play" && req.method === "GET") return handlePlay(url);
    if (url.pathname === "/api/novelize" && req.method === "POST") return handleNovelize(req);
    if (req.method !== "GET") return new Response("Method Not Allowed", { status: 405 });
    return serveStatic(url.pathname);
  },
});

console.log(`\x1b[35m武侠剧场\x1b[0m 已启动 → \x1b[36mhttp://localhost:${server.port}\x1b[0m`);
console.log("\x1b[2m打开地址，左侧写开场看戏，看完点右侧「执笔成文」。Ctrl+C 退出。\x1b[0m");
