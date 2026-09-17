import assert from "node:assert/strict";
import test from "node:test";
import { translateZcodeRequest, ZcodeRequestError } from "../src/zcode/request.ts";
import { createZcodeResponse } from "../src/zcode/response.ts";
import { encodeZcodeThinking } from "../src/zcode/wire.ts";

const clientModel = "z.ai/GLM-5.3";
function translate(body: Record<string, unknown>) { return translateZcodeRequest({ model: clientModel, ...body }, "glm-5.3"); }

test("完整保留 function 与 freeform 历史，并按 Anthropic 结构合并同轮调用", () => {
  const result = translate({
    instructions: "遵守项目约束",
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "开始" }] },
      { type: "function_call", call_id: "call_fn", name: "fs.read", arguments: '{"path":"a.ts"}' },
      { type: "custom_tool_call", call_id: "call_shell", name: "shell", input: "ls -la" },
      { type: "function_call_output", call_id: "call_fn", output: "文件内容" },
      { type: "custom_tool_call_output", call_id: "call_shell", output: "a.ts" },
    ],
    tools: [
      { type: "function", name: "fs.read", description: "读取", parameters: { type: "object", properties: { path: { type: "string" } } } },
      { type: "custom", name: "shell", description: "运行" },
    ],
  });
  const body = result.body;
  assert.equal(body.stream, true);
  assert.equal(body.system, "遵守项目约束");
  const messages = body.messages as Array<{ content: Array<Record<string, unknown>> }>;
  assert.equal(messages.length, 3);
  assert.deepEqual(messages[1].content.map((block) => block.type), ["tool_use", "tool_use"]);
  assert.deepEqual(messages[2].content.map((block) => block.tool_use_id), ["call_fn", "call_shell"]);
  const tools = body.tools as Array<Record<string, unknown>>;
  assert.match(tools[0].name as string, /^fs_read_/);
  assert.deepEqual(tools[1].input_schema, { type: "object", properties: { input: { type: "string" } }, required: ["input"], additionalProperties: false });
  assert.deepEqual(result.tools.get(tools[0].name as string), { name: "fs.read", custom: false });
});

test("保留图片、system 与 developer 内容", () => {
  const result = translate({ input: [
    { type: "message", role: "system", content: "系统规则" },
    { type: "message", role: "developer", content: "开发规则" },
    { type: "message", role: "user", content: [{ type: "input_text", text: "看图片" }, { type: "input_image", image_url: "data:image/png;base64,aGVsbG8=" }] },
  ] });
  assert.match(result.body.system as string, /^系统规则\n\n开发规则\n\n/);
  const image = ((result.body.messages as Array<Record<string, unknown>>)[0].content as Array<Record<string, unknown>>)[1];
  assert.deepEqual(image, { type: "image", source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" } });
});

test("含图片请求声明网关代执行的 analyze_image 并注入适配说明", () => {
  const result = translate({ input: [
    { type: "message", role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,aGVsbG8=" }] },
  ] });
  assert.equal(result.vision, true);
  assert.equal(result.images.length, 1);
  assert.equal(result.images[0].data, "aGVsbG8=");
  const tools = result.body.tools as Array<Record<string, unknown>>;
  const declaration = tools.find((tool) => tool.name === "analyze_image") as Record<string, unknown>;
  assert.equal(declaration.description, "Analyze an image using advanced AI vision models with comprehensive understanding capabilities. Only supports remote URL.");
  assert.deepEqual((declaration.input_schema as Record<string, unknown>).required, ["imageSource", "prompt"]);
  assert.match(result.body.system as string, /图片识别适配/);
  assert.deepEqual(result.tools.get("analyze_image"), { name: "analyze_image", custom: false, gateway: "analyze_image" });
});

test("无图片或客户端已声明同名工具时不注入 analyze_image", () => {
  const textOnly = translate({ input: "纯文本" });
  assert.equal(textOnly.vision, false);
  assert.deepEqual(textOnly.images, []);
  assert.equal(textOnly.body.tools, undefined);
  const conflicted = translate({
    input: [{ type: "message", role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,aGVsbG8=" }] }],
    tools: [{ type: "function", name: "analyze_image", parameters: { type: "object" } }],
  });
  assert.equal(conflicted.vision, false);
  const names = (conflicted.body.tools as Array<Record<string, unknown>>).map((tool) => tool.name);
  assert.equal(names.filter((name) => name === "analyze_image").length, 1);
  assert.equal(conflicted.tools.get("analyze_image")!.gateway, undefined);
});

test("拒绝不支持状态、内置工具与未知 history", () => {
  for (const body of [
    { input: "x", previous_response_id: "resp_1" }, { input: "x", conversation: "conv_1" }, { input: "x", background: true },
    { input: [{ type: "unknown_thing" }] },
    { input: [{ type: "function_call_output", call_id: "missing", output: "x" }] },
  ]) assert.throws(() => translate(body), ZcodeRequestError);
});

test("web_search 原生映射为 z.ai 服务端工具并透传过滤配置", () => {
  const result = translate({
    input: "查一下",
    tools: [
      { type: "function", name: "fs.read", parameters: { type: "object" } },
      { type: "web_search", external_web_access: true, max_uses: 3, filters: { allowed_domains: ["z.ai"] } },
    ],
  });
  const tools = result.body.tools as Array<Record<string, unknown>>;
  assert.match(tools[0].name as string, /^fs_read_/);
  assert.deepEqual(tools[1], { type: "web_search_20250305", name: "web_search", max_uses: 3, allowed_domains: ["z.ai"] });
  assert.deepEqual(result.dropped, []);
});

test("显式禁用或未知内置工具被剥离并注入降级说明", () => {
  const result = translate({
    input: "查一下",
    tools: [{ type: "web_search", external_web_access: false }, { type: "image_generation" }],
  });
  assert.equal(result.body.tools, undefined);
  assert.deepEqual(result.dropped, ["web_search", "image_generation"]);
  assert.match(result.body.system as string, /web_search、image_generation/);
  assert.match(result.body.system as string, /请勿声称已使用这些工具/);
});

test("web_search_call 历史在启用原生映射时还原为服务端块对", () => {
  const result = translate({
    tools: [{ type: "web_search" }],
    input: [
      { type: "web_search_call", id: "ws_call_abc123", status: "completed", action: { type: "search", query: "最新 GLM" }, results: [{ title: "Z.ai", url: "https://z.ai", text: "发布说明" }] },
    ],
  });
  const messages = result.body.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>;
  assert.equal(messages.length, 1);
  assert.equal(messages[0].role, "assistant");
  assert.deepEqual(messages[0].content[0], { type: "server_tool_use", id: "call_abc123", name: "web_search_prime", input: { search_query: "最新 GLM" } });
  assert.deepEqual(messages[0].content[1], { type: "tool_result", tool_use_id: "call_abc123", content: [{ type: "text", text: "Z.ai\nhttps://z.ai\n发布说明" }] });
});

test("未启用原生映射时 web_search_call 历史降级为文本摘要", () => {
  const result = translate({ input: [{ type: "web_search_call", id: "ws_x", status: "completed", action: { type: "search", query: "天气" } }] });
  const messages = result.body.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>;
  assert.equal(messages.length, 1);
  assert.equal(messages[0].role, "assistant");
  assert.match(messages[0].content[0].text as string, /web_search_call/);
  assert.match(messages[0].content[0].text as string, /天气/);
});

test("其余服务端调用历史降级为文本摘要而不是拒绝", () => {
  const result = translate({ input: [
    { type: "file_search_call", id: "fs_1", status: "completed" },
    { type: "mcp_list_tools", id: "mcp_1" },
  ] });
  const messages = result.body.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>;
  assert.equal(messages.length, 1);
  assert.equal(messages[0].role, "assistant");
  assert.match(messages[0].content[0].text as string, /file_search_call/);
  assert.match(messages[0].content[1].text as string, /mcp_list_tools/);
});

test("tool_choice 指向内置工具时省略选择", () => {
  assert.equal(translate({ input: "x", tools: [{ type: "web_search" }], tool_choice: { type: "web_search" } }).body.tool_choice, undefined);
  assert.equal(translate({ input: "x", tool_choice: { type: "web_search" } }).body.tool_choice, undefined);
});

test("按请求努力等级配置 thinking，并限制预算和工具选择", () => {
  const result = translate({ input: "x", max_output_tokens: 3000, reasoning: { effort: "high" }, parallel_tool_calls: false,
    tool_choice: { type: "function", name: "run.code" }, tools: [{ type: "function", name: "run.code", parameters: { type: "object" } }] });
  assert.deepEqual(result.body.thinking, { type: "enabled", budget_tokens: 2999 });
  assert.deepEqual(result.body.tool_choice, { type: "tool", name: (result.body.tools as Array<Record<string, unknown>>)[0].name, disable_parallel_tool_use: true });
  assert.throws(() => translate({ input: "x", max_output_tokens: 1024, reasoning: { effort: "minimal" } }), /至少需要/);
  assert.deepEqual(translate({ input: "x", reasoning: { effort: "none" } }).body.thinking, { type: "disabled" });
  assert.equal(translate({ input: "x", reasoning: {} }).body.thinking, undefined);
});

test("只恢复由本地响应转换器签发且模型匹配的加密思考载荷", () => {
  const encrypted = encodeZcodeThinking(clientModel, [{ type: "thinking", thinking: "已分析", signature: "sig" }]);
  const result = translate({ input: [{ type: "reasoning", encrypted_content: encrypted }] });
  assert.deepEqual(result.body.messages, [{ role: "assistant", content: [{ type: "thinking", thinking: "已分析", signature: "sig" }] }]);
  assert.deepEqual(translate({ input: [{ type: "reasoning", encrypted_content: "official-opaque" }] }).body.messages, []);
});

test("普通字符串通过 llm-bridge 基线转换，并强制上游模型与 stream", () => {
  const result = translateZcodeRequest({ input: "你好", max_output_tokens: 77, stream: false, temperature: 0.2, top_p: 0.9 }, "zai-model");
  assert.equal(result.body.model, "zai-model"); assert.equal(result.body.stream, true); assert.equal(result.body.max_tokens, 77);
  assert.deepEqual(result.body.messages, [{ role: "user", content: [{ type: "text", text: "你好" }] }]);
  assert.equal(result.body.temperature, 0.2); assert.equal(result.body.top_p, 0.9);
});


function upstream(frames: Record<string, unknown>[]): Response {
  return new Response(frames.map((frame) => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join(""));
}

test("真实响应的完整客户端模型 thinking 载荷能在下一轮请求准确还原", async () => {
  const response = await createZcodeResponse(upstream([
    { type: "message_start", message: { id: "m1", model: "glm-5.3" } },
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "继续分析" } },
    { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "roundtrip-sig" } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "text", text: "回答" } },
    { type: "content_block_stop", index: 1 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } },
    { type: "message_stop" },
  ]), { model: clientModel, tools: new Map(), stream: false });
  const responseBody = await response.json() as { output: Record<string, unknown>[] };
  const request = translate({ input: [{ role: "user", content: "问题" }, ...responseBody.output, { role: "user", content: "继续" }] });
  assert.equal(request.body.model, "glm-5.3");
  assert.deepEqual(request.body.messages, [
    { role: "user", content: [{ type: "text", text: "问题" }] },
    { role: "assistant", content: [{ type: "thinking", thinking: "继续分析", signature: "roundtrip-sig" }, { type: "text", text: "回答" }] },
    { role: "user", content: [{ type: "text", text: "继续" }] },
  ]);
});

test("compaction 去掉当前工具声明后仍可转换完整 function 与 custom 历史", () => {
  const input = [
    { type: "function_call", name: "read", namespace: "fs", call_id: "fn", arguments: '{"path":"x"}' },
    { type: "custom_tool_call", name: "run", namespace: "shell", call_id: "custom", input: "pwd" },
    { type: "function_call_output", call_id: "fn", output: "内容" },
    { type: "custom_tool_call_output", call_id: "custom", output: "目录" },
  ];
  const oldTools = [
    { type: "namespace", name: "fs", tools: [{ type: "function", name: "read", parameters: { type: "object" } }] },
    { type: "namespace", name: "shell", tools: [{ type: "custom", name: "run" }] },
  ];
  const declared = translate({ input, tools: oldTools });
  const compacted = translate({ input });
  assert.deepEqual(compacted.body.messages, declared.body.messages);
  assert.equal(compacted.body.tools, undefined);
  assert.equal(compacted.tools.size, 0);
  const changed = translate({ input, tools: [{ type: "namespace", name: "shell", tools: [{ type: "function", name: "run", parameters: { type: "object" } }] }] });
  assert.deepEqual(changed.body.messages, declared.body.messages);
  assert.equal(changed.tools.size, 1);
  assert.equal([...changed.tools.values()][0].custom, false);
});

test("namespace 中 function 与 custom 稳定扁平化且响应保留独立 namespace 字段", async () => {
  const definitions = [
    { type: "namespace", name: "files", description: "文件操作", tools: [
      { type: "function", name: "read", parameters: { type: "object" }, description: "读取文件" },
      { type: "custom", name: "patch" },
    ] },
    { type: "namespace", name: "network", tools: [{ type: "function", name: "read", parameters: { type: "object" } }] },
    { type: "function", name: "files.read", parameters: { type: "object" } },
  ];
  const request = translate({ input: "开始", tools: definitions, tool_choice: { type: "function", namespace: "files", name: "read" } });
  const mapped = [...request.tools.entries()];
  assert.equal(new Set(mapped.map(([name]) => name)).size, 4);
  for (const [name] of mapped) assert.match(name, /^[A-Za-z0-9_-]{1,128}$/);
  assert.deepEqual(mapped[0][1], { name: "read", namespace: "files", custom: false });
  assert.deepEqual(mapped[1][1], { name: "patch", namespace: "files", custom: true });
  assert.deepEqual(request.body.tool_choice, { type: "tool", name: mapped[0][0] });
  assert.equal((request.body.tools as Record<string, unknown>[])[0].description, "文件操作\n\n读取文件");
  assert.deepEqual([...translate({ input: "再次", tools: [...definitions].reverse() }).tools.keys()].sort(), mapped.map(([name]) => name).sort());
  const response = await createZcodeResponse(upstream([
    { type: "message_start", message: { id: "m2", model: "glm-5.3" } },
    { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "f1", name: mapped[0][0], input: { path: "a" } } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "c1", name: mapped[1][0], input: { input: "patch text" } } },
    { type: "content_block_stop", index: 1 },
    { type: "message_delta", delta: { stop_reason: "tool_use" } },
    { type: "message_stop" },
  ]), { model: clientModel, tools: request.tools, stream: false });
  const body = await response.json() as { output: Record<string, unknown>[] };
  assert.deepEqual(body.output.map((item) => [item.type, item.namespace, item.name, item.call_id]), [["function_call", "files", "read", "f1"], ["custom_tool_call", "files", "patch", "c1"]]);
  const next = translate({ input: [...body.output, { type: "function_call_output", call_id: "f1", output: "ok" }, { type: "custom_tool_call_output", call_id: "c1", output: "ok" }] });
  const calls = (next.body.messages as { content: Record<string, unknown>[] }[])[0].content;
  assert.deepEqual(calls.map((call) => call.name), [mapped[0][0], mapped[1][0]]);
  assert.deepEqual(calls[1].input, { input: "patch text" });
});

test("普通 text.format 放行且结构化输出继续明确拒绝", () => {
  const normal = translate({ input: "文本", text: { format: { type: "text" } }, reasoning: { effort: "none" } });
  assert.deepEqual(normal.body.thinking, { type: "disabled" });
  assert.deepEqual(normal.body.messages, [{ role: "user", content: [{ type: "text", text: "文本" }] }]);
  assert.throws(() => translate({ input: "x", text: { format: { type: "json_schema", schema: {} } } }), /结构化输出/);
  assert.throws(() => translate({ input: "x", response_format: { type: "json_object" } }), /结构化输出/);
});

test("历史 custom input 必须是字符串且不得由 arguments 字段代替", () => {
  for (const input of [{ x: 1 }, 1, null, undefined]) {
    assert.throws(() => translate({ input: [{ type: "custom_tool_call", call_id: "c", name: "run", input }] }), /custom_tool_call.input 必须是字符串/);
  }
  assert.throws(() => translate({ input: [{ type: "custom_tool_call", call_id: "c", name: "run", arguments: "pwd" }] }), /custom_tool_call.input/);
});

test("重复工具输出明确拒绝而不同调用输出保持顺序", () => {
  for (const type of ["function", "custom_tool"]) {
    const call = type === "function" ? { type: "function_call", name: "run", call_id: "c", arguments: "{}" } : { type: "custom_tool_call", name: "run", call_id: "c", input: "pwd" };
    const output = { type: `${type}_call_output`, call_id: "c", output: "ok" };
    assert.throws(() => translate({ input: [call, output, output] }), /重复的工具输出/);
  }
});

test("忽略外部损坏及不同模型 reasoning 私有项并保留普通历史", () => {
  const invalid = ["official-opaque", "zcode-thinking-v1:broken", undefined, encodeZcodeThinking("z.ai/other", [{ type: "thinking", thinking: "不可传", signature: "secret" }])];
  for (const encrypted_content of invalid) {
    const result = translate({ input: [{ type: "reasoning", encrypted_content, summary: [{ type: "summary_text", text: "也不转发" }] }, { role: "user", content: "继续" }] });
    assert.deepEqual(result.body.messages, [{ role: "user", content: [{ type: "text", text: "继续" }] }]);
    assert.ok(!JSON.stringify(result.body).includes("secret"));
  }
});


test("function 与 custom 工具结果保留截图图片并继续对话", () => {
  for (const custom of [false, true]) {
    const call = custom
      ? { type: "custom_tool_call", name: "screenshot", call_id: "call-image", input: "screen" }
      : { type: "function_call", name: "screenshot", call_id: "call-image", arguments: "{}" };
    const output = { type: custom ? "custom_tool_call_output" : "function_call_output", call_id: "call-image", output: [
      { type: "input_text", text: "截图" },
      { type: "input_image", image_url: "data:image/png;base64,AA==" },
    ] };
    const result = translateZcodeRequest({ input: [call, output] }, "GLM-5.3");
    const messages = result.body.messages as Array<{ content: Array<Record<string, unknown>> }>;
    assert.deepEqual(messages[1].content[0].content, [
      { type: "text", text: "截图" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AA==" } },
    ]);
  }
});
