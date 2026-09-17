import assert from "node:assert/strict";
import test from "node:test";
import {
  analysisFromExecutorText,
  ANALYZE_IMAGE_TOOL_NAME,
  collectZcodeImages,
  executeZcodeAnalyzeImage,
  gatewayToolCallNarration,
  gatewayToolResultNarration,
  imageIdentifier,
  matchZcodeAnalyzeImage,
  ZcodeVisionError,
  type ZcodeRequestImage,
} from "../src/zcode/vision.ts";

function imageOf(data: string): ZcodeRequestImage {
  return { identifier: imageIdentifier(data), media_type: "image/png", data };
}

test("collectZcodeImages 收集消息与工具结果中的图片并按标识去重", () => {
  const messages = [
    { role: "user", content: [
      { type: "text", text: "图" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: Buffer.from("a").toString("base64") } },
    ] },
    { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "view_image", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: [
      { type: "image", source: { type: "base64", media_type: "image/png", data: Buffer.from("a").toString("base64") } },
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: Buffer.from("b").toString("base64") } },
    ] }] },
  ];
  const images = collectZcodeImages(messages);
  assert.equal(images.length, 2);
  assert.equal(images[0].data, Buffer.from("a").toString("base64"));
  assert.equal(images[0].identifier.length, 32);
});

test("matchZcodeAnalyzeImage 单图兜底，多图按 URL 标识反查", () => {
  const first = imageOf(Buffer.from("a").toString("base64"));
  const second = imageOf(Buffer.from("b").toString("base64"));
  assert.equal(matchZcodeAnalyzeImage(undefined, [first]), first);
  assert.equal(matchZcodeAnalyzeImage("不是 URL", [first]), first);
  assert.equal(matchZcodeAnalyzeImage(`https://cdn.example.com/anthropic/sid/${second.identifier}.png?Signature=x`, [first, second]), second);
  assert.equal(matchZcodeAnalyzeImage("https://cdn.example.com/unknown.png", [first, second]), undefined);
  assert.equal(matchZcodeAnalyzeImage(undefined, []), undefined);
});

test("analysisFromExecutorText 提取 result_summary 之后的结果文本", () => {
  const full = "**Z.ai Built-in Tool: analyze_image** Input: {...} *Executing on server...* Output: **analyze_image_result_summary:** [{\"text\": \"表格内容\"}]";
  assert.equal(analysisFromExecutorText(full), "[{\"text\": \"表格内容\"}]");
  assert.equal(analysisFromExecutorText("没有标记的普通文本"), "没有标记的普通文本");
});

function sse(frames: Array<Record<string, unknown>>): Response {
  const body = frames.map((frame) => `event: ${String(frame.type)}\ndata: ${JSON.stringify(frame)}\n\n`).join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

test("executeZcodeAnalyzeImage 命中服务端执行并提取结果，未命中时重试后失败", async () => {
  const image = imageOf(Buffer.from("a").toString("base64"));
  const calls: Array<Record<string, unknown>> = [];
  const headers = () => new Headers({ "content-type": "application/json" });
  const hit = sse([
    { type: "message_start" },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_start", index: 1, content_block: { type: "server_tool_use", id: "call_1", name: ANALYZE_IMAGE_TOOL_NAME, input: {} } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "公告 " } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Output: analyze_image_result_summary: 识别结果" } },
    { type: "content_block_stop", index: 1 },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" } },
    { type: "message_stop" },
  ]);
  const miss = sse([
    { type: "message_start" },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "未触发" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" } },
    { type: "message_stop" },
  ]);
  const fetchImpl = (url: string, init: RequestInit) => {
    calls.push(JSON.parse(String(init.body)) as Record<string, unknown>);
    return Promise.resolve(calls.length === 1 ? Promise.resolve(miss) : Promise.resolve(hit));
  };
  const result = await executeZcodeAnalyzeImage({
    url: "https://zcode.example/messages", model: "GLM-5.3", image, prompt: "识别",
    headers, fetchImpl, maxAttempts: 2,
  });
  assert.equal(result, "识别结果");
  assert.equal(calls.length, 2);
  assert.equal(calls[0].model, "GLM-5.3");
  assert.ok(Array.isArray(calls[0].system));
  assert.ok(Array.isArray(calls[0].tools));
  const message = (calls[0].messages as Array<{ content: Array<Record<string, unknown>> }>)[0];
  assert.equal(message.content[0].type, "image");
  assert.match(String(message.content[1].text), /analyze_image/);

  await assert.rejects(
    executeZcodeAnalyzeImage({ url: "https://zcode.example/messages", model: "GLM-5.3", image, prompt: "识别", headers, fetchImpl: () => Promise.resolve(miss), maxAttempts: 2 }),
    (error: unknown) => error instanceof ZcodeVisionError && /2 次尝试/.test(error.message),
  );
});

test("executeZcodeAnalyzeImage 上游非 2xx 时按尝试次数失败", async () => {
  const image = imageOf(Buffer.from("a").toString("base64"));
  const headers = () => new Headers();
  let attempts = 0;
  await assert.rejects(
    executeZcodeAnalyzeImage({
      url: "https://zcode.example/messages", model: "GLM-5.3", image, prompt: "识别", headers,
      fetchImpl: () => { attempts++; return Promise.resolve(new Response("no auth", { status: 401 })); },
      maxAttempts: 2,
    }),
    ZcodeVisionError,
  );
  assert.equal(attempts, 2);
});

test("gatewayToolCallNarration 复刻 z.ai 内置工具的 Input 旁白形状", () => {
  const narration = gatewayToolCallNarration({ name: ANALYZE_IMAGE_TOOL_NAME, input: { imageSource: "https://cdn/x.png", prompt: "识别" } });
  assert.equal(
    narration,
    "**🌐 Z.ai Built-in Tool: analyze_image**\n\n**Input:**\n```json\n{\"imageSource\":\"https://cdn/x.png\",\"prompt\":\"识别\"}\n```\n*Executing on server...*\n",
  );
});

test("gatewayToolResultNarration 以 result_summary JSON 文本块呈现结果", () => {
  assert.equal(
    gatewayToolResultNarration(ANALYZE_IMAGE_TOOL_NAME, "识别结果"),
    "**Output:**\n**analyze_image_result_summary:** [{\"text\": \"识别结果\", \"type\": \"text\"}]",
  );
});
