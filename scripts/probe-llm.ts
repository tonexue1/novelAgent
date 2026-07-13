import { LLMClient } from "../src/core/llm/client.ts";

// 直连当前 .env 配的模型，模拟一次"执笔成文"式的长文写作请求，
// 打印耗时、返回长度或错误，用来定位成文失败/卡住的原因。
const client = new LLMClient();
console.log("model =", client.model);

const t0 = Date.now();
try {
  const { message, finishReason } = await client.chat({
    messages: [
      {
        role: "system",
        content:
          "你是一位武侠小说家。把下面的场景扩写成一章约 1500 字的小说正文，第三人称，叙述与对白交织。第一行给一个章节标题短语，空一行后是正文。只输出正文。",
      },
      {
        role: "user",
        content:
          "背景：暴雨夜的荒野客栈，独臂刀客沈孤鸿与几路人马为一张藏宝图残卷僵持。有人拔刀，有人冷笑，最后灯灭刀出。",
      },
    ],
    temperature: 0.8,
  });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`OK in ${secs}s, finishReason=${finishReason}, length=${message.content?.length ?? 0}`);
  console.log("---- 开头 200 字 ----");
  console.log((message.content ?? "").slice(0, 200));
} catch (err) {
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.error(`FAILED in ${secs}s:`);
  console.error(err instanceof Error ? err.message : String(err));
}
