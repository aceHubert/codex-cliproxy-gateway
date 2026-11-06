import assert from "node:assert/strict";
import test from "./host-test.ts";
import {
  analysisFromExecutorText,
  ANALYZE_IMAGE_TOOL_NAME,
  collectZcodeImages,
  executeZcodeAnalyzeImage,
  gatewayToolCallNarration,
  gatewayToolResultNarration,
  imageIdentifier,
  matchZcodeAnalyzeImage,
  serverToolResultFailed,
  ZcodeVisionError,
  type ZcodeRequestImage,
} from "@agent-proxy/zcode/vision";

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

const MCP_FAILURE_TEXT = "[{\"text\": \"MCP error 400: 400 Bad Request: \\\"{\\\"error\\\""
  + ":{\\\"code\\\":\\\"1210\\\",\\\"message\\\":\\\"图片输入格式/解析错误\\\"}}\\\"\", \"type\": \"text\"}]";

function executorFrames(resultText: string): Array<Record<string, unknown>> {
  return [
    { type: "message_start" },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_start", index: 1, content_block: { type: "server_tool_use", id: "call_1", name: ANALYZE_IMAGE_TOOL_NAME, input: {} } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: `公告 Output: analyze_image_result_summary: ${resultText}` } },
    { type: "content_block_stop", index: 1 },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" } },
    { type: "message_stop" },
  ];
}

test("serverToolResultFailed 识别服务端 MCP 错误结果，不误伤普通识别内容", () => {
  assert.ok(serverToolResultFailed(MCP_FAILURE_TEXT));
  assert.ok(serverToolResultFailed(`普通说明 analyze_image_result_summary: ${MCP_FAILURE_TEXT}`));
  const lateMention = `${"识别成功：这是一张终端管理软件的截图，包含侧边栏与主区域。".repeat(8)}后文才提到 MCP error 400 报错文案`;
  assert.ok(lateMention.indexOf("MCP error") > 200, "测试文本的 MCP 字样必须落在检测窗口之外");
  assert.equal(serverToolResultFailed(lateMention), false);
  assert.equal(serverToolResultFailed("识别结果：表格内容"), false);
});

test("executeZcodeAnalyzeImage 服务端 MCP 错误结果触发重试并在成功后返回", async () => {
  const image = imageOf(Buffer.from("a").toString("base64"));
  const headers = () => new Headers();
  const attempts: unknown[] = [];
  let calls = 0;
  const summaries: string[] = [];
  const result = await executeZcodeAnalyzeImage({
    url: "https://zcode.example/messages", model: "GLM-5.3", image, prompt: "识别", headers,
    fetchImpl: (_url, init) => {
      calls++;
      attempts.push(JSON.parse(String(init.body)));
      return Promise.resolve(sse(executorFrames(calls === 1 ? MCP_FAILURE_TEXT : "识别成功的内容")));
    },
    maxAttempts: 3,
    onAttempt: (summary) => { summaries.push(`${summary.attempt}:${summary.ok ? "ok" : "failed"}`); },
  });
  assert.equal(result, "识别成功的内容");
  assert.equal(calls, 2, "首次服务端失败后应重试");
  assert.deepEqual(summaries, ["1:failed", "2:ok"]);
});

test("executeZcodeAnalyzeImage 全部尝试均为 MCP 错误结果时以服务端失败告终", async () => {
  const image = imageOf(Buffer.from("a").toString("base64"));
  const headers = () => new Headers();
  let calls = 0;
  await assert.rejects(
    executeZcodeAnalyzeImage({
      url: "https://zcode.example/messages", model: "GLM-5.3", image, prompt: "识别", headers,
      fetchImpl: () => { calls++; return Promise.resolve(sse(executorFrames(MCP_FAILURE_TEXT))); },
      maxAttempts: 2,
    }),
    (error: unknown) => error instanceof ZcodeVisionError && /MCP error 400/.test(error.message) && /2 次尝试/.test(error.message),
  );
  assert.equal(calls, 2);
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
