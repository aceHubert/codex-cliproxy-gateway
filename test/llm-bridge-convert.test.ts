import assert from "node:assert/strict";
import test from "node:test";
import {
  BridgeConversionError,
  convertRequest,
} from "@agent-proxy/llm-bridge";

type Json = Record<string, unknown>;
type AnyArray = Array<Record<string, unknown>>;

function messagesOf(body: Json): AnyArray {
  return (body.messages ?? []) as AnyArray;
}
function inputOf(body: Json): AnyArray {
  return (body.input ?? []) as AnyArray;
}
function index(list: AnyArray, position: number): Json {
  return (list[position] ?? {}) as Json;
}

test("L1 修复：Responses 字符串 input 保留 instructions/tools/token/stream/parallel", async () => {
  const { body, notes } = await convertRequest("chat-completions", "responses", {
    model: "m",
    input: "hello",
    instructions: "be nice",
    tools: [{ type: "function", name: "f", description: "d", parameters: { type: "object" }, strict: true }],
    max_output_tokens: 100,
    stream: true,
    parallel_tool_calls: true,
  });
  // 库 2.0.1 反例：字符串 input 只剩 user 消息与 model，其余字段全部丢失。
  assert.equal(index(messagesOf(body), 0)?.role, "system");
  assert.equal(index(messagesOf(body), 0)?.content, "be nice");
  assert.equal(index(messagesOf(body), 1)?.role, "user");
  assert.equal(index(messagesOf(body), 1)?.content, "hello");
  assert.equal(body.max_tokens, 100);
  assert.equal(body.stream, true);
  assert.equal(body.parallel_tool_calls, true);
  const tools = body.tools as AnyArray;
  const declaration = index(tools, 0).function as Json | undefined;
  assert.equal(declaration?.name, "f");
  assert.equal(declaration?.strict, true);
  assert.deepEqual(notes, []);
});

test("L2 修复：function_call + output 历史重建为 assistant.tool_calls 与 tool 消息", async () => {
  const { body } = await convertRequest("chat-completions", "responses", {
    model: "m",
    instructions: "sys",
    parallel_tool_calls: true,
    input: [
      { type: "message", role: "user", content: "hi" },
      { type: "function_call", call_id: "call_1", name: "f", arguments: '{"a":1}' },
      { type: "function_call_output", call_id: "call_1", output: "ok" },
    ],
  });
  // 库 2.0.1 反例：call 变成空 user 消息，output 成为孤立 tool 消息，instructions/parallel 丢失。
  const messages = messagesOf(body);
  assert.equal(messages[0]?.content, "sys");
  // gemini parts 是数组内容：chat 目标按保形合同保持内容块数组。
  assert.equal(messages[1]?.content, "hi");
  const assistant = messages[2]!;
  assert.equal(assistant.role, "assistant");
  const calls = (assistant.tool_calls ?? []) as AnyArray;
  assert.equal((index(calls, 0).function as Json | undefined)?.name, "f");
  assert.equal((index(calls, 0).function as Json | undefined)?.arguments, '{"a":1}');
  // 工具调用独占的 assistant 消息 content 置 null（chat 标准形状）。
  assert.equal(assistant.content, null);
  const tool = messages[3]!;
  assert.equal(tool.role, "tool");
  assert.equal(tool.tool_call_id, "call_1");
  assert.equal(tool.content, "ok");
  assert.equal(body.parallel_tool_calls, true);
});

test("L3 修复：Chat assistant.tool_calls → Responses 产出成对 function_call 与输出", async () => {
  const { body } = await convertRequest("responses", "chat-completions", {
    model: "m",
    max_completion_tokens: 50,
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "f", arguments: '{"a":1}' } }] },
      { role: "tool", tool_call_id: "call_1", content: "ok" },
    ],
  });
  // 库 2.0.1 反例：只剩 function_call_output，没有 function_call；max_completion_tokens 丢失。
  const input = inputOf(body);
  assert.equal(input[0]?.role, "user");
  assert.equal(input[1]?.type, "function_call");
  assert.equal(input[1]?.call_id, "call_1");
  assert.equal(input[1]?.name, "f");
  assert.equal(input[1]?.arguments, '{"a":1}');
  assert.equal(input[2]?.type, "function_call_output");
  assert.equal(input[2]?.output, "ok");
  assert.equal(body.max_output_tokens, 50);
});

test("L4 修复：named tool_choice 双向形状正确", async () => {
  const responsesChoice = (await convertRequest("chat-completions", "responses", {
    model: "m",
    input: "hi",
    tools: [{ type: "function", name: "f", parameters: { type: "object" } }],
    tool_choice: { type: "function", name: "f" },
  })).body.tool_choice;
  // 库 2.0.1 反例：Responses named choice 在 chat 目标被整体丢弃。
  assert.deepEqual(responsesChoice, { type: "function", function: { name: "f" } });

  const chatChoice = (await convertRequest("responses", "chat-completions", {
    model: "m",
    messages: [{ role: "user", content: "hi" }],
    tools: [{ type: "function", function: { name: "f", parameters: {} } }],
    tool_choice: { type: "function", function: { name: "f" } },
  })).body.tool_choice;
  // 库 2.0.1 反例：chat named choice 原样透传到 responses（错误形状）。
  assert.deepEqual(chatChoice, { type: "function", name: "f" });
});

test("L5 修复：Chat custom 工具不再崩溃并按可逆 {input:string} 降级", async () => {
  // 库 2.0.1 反例：tool.function.description 上直接 TypeError。
  const { body, tools } = await convertRequest("anthropic", "chat-completions", {
    model: "m",
    messages: [{ role: "user", content: "hi" }],
    tools: [{ type: "custom", name: "c", description: "d" }],
  });
  const anthropicTools = body.tools as AnyArray;
  assert.equal(index(anthropicTools, 0).name, "c");
  const schema = index(anthropicTools, 0).input_schema as Json;
  const properties = schema.properties as Json | undefined;
  const inputSchema = properties?.input as Json | undefined;
  assert.equal(inputSchema?.type, "string");
  assert.equal(tools.get("c")?.custom, true);
});

test("L6 修复：同协议直通不经过库的原始重建，删除的工具不会复活", async () => {
  const { body } = await convertRequest("chat-completions", "chat-completions", {
    model: "m",
    messages: [{ role: "user", content: "hi" }],
  });
  // 库 2.0.1 反例：universal 中删除 tools 后 fromUniversal 仍返回带 tools 的 _original.raw。
  assert.equal(body.tools, undefined);
  assert.deepEqual(body.messages, [{ role: "user", content: "hi" }]);
});

test("C1 修复：只有 instructions 时生成 system 消息", async () => {
  const { body } = await convertRequest("chat-completions", "responses", {
    model: "m",
    input: "hello",
    instructions: "be nice",
  });
  const messages = messagesOf(body);
  assert.equal(messages[0]?.role, "system");
  assert.equal(messages[0]?.content, "be nice");
});

test("C2 修复：Responses function strict 保留到 chat 目标", async () => {
  const { body } = await convertRequest("chat-completions", "responses", {
    model: "m",
    input: "hi",
    tools: [{ type: "function", name: "f", strict: true, parameters: { type: "object" } }],
  });
  const tools = body.tools as AnyArray;
  assert.equal((index(tools, 0).function as Json | undefined)?.strict, true);
});

test("namespace 工具展平且声明/历史/choice 共用身份映射", async () => {
  const { body, tools } = await convertRequest("anthropic","responses", {
    model: "m",
    max_output_tokens: 100,
    tools: [{ type: "namespace", name: "ns", tools: [{ type: "custom", name: "bad name!", description: "d" }] }],
    input: [
      { type: "message", role: "user", content: "hi" },
      { type: "custom_tool_call", call_id: "c1", name: "bad name!", namespace: "ns", input: "txt" },
      { type: "custom_tool_call_output", call_id: "c1", output: "ok" },
    ],
    tool_choice: { type: "custom", name: "bad name!", namespace: "ns" },
  });
  const mappedName = (body.tools as AnyArray)[0]?.name as string;
  assert.match(mappedName, /^tool_/);
  const identity = tools.get(mappedName);
  assert.equal(identity?.name, "bad name!");
  assert.equal(identity?.namespace, "ns");
  assert.equal(identity?.custom, true);
  const choice = body.tool_choice as Json;
  assert.equal(choice.type, "tool");
  assert.equal(choice.name, mappedName);
  const messages = messagesOf(body);
  const toolUse = (messages[1]?.content as AnyArray)[0] as Json;
  assert.equal(toolUse.name, mappedName);
  assert.deepEqual(toolUse.input, { input: "txt" });
});

test("Anthropic 源 → Chat：tool_use/tool_result 配对与 system 投影", async () => {
  const { body } = await convertRequest("chat-completions", "anthropic", {
    model: "m",
    max_tokens: 10,
    system: "s",
    messages: [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "f", input: { a: 1 } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
    ],
  });
  const messages = messagesOf(body);
  assert.equal(messages[0]?.content, "s");
  const assistant = messages[2]!;
  assert.equal(assistant.role, "assistant");
  const calls = (assistant.tool_calls ?? []) as AnyArray;
  assert.equal(index(calls, 0).id, "t1");
  const tool = messages[3]!;
  assert.equal(tool.role, "tool");
  assert.equal(tool.tool_call_id, "t1");
  assert.equal(tool.content, "ok");
});

test("Anthropic 源 tool_choice any/disable_parallel 正确归一", async () => {
  const { body } = await convertRequest("chat-completions", "anthropic", {
    model: "m",
    max_tokens: 10,
    messages: [{ role: "user", content: "hi" }],
    tool_choice: { type: "any", disable_parallel_tool_use: true },
  });
  assert.equal(body.tool_choice, "required");
});

test("Responses → Anthropic：system/instructions、token 上限与 stop 映射", async () => {
  const { body } = await convertRequest("anthropic","responses", {
    model: "m",
    instructions: "sys",
    max_output_tokens: 100,
    input: [{ type: "message", role: "user", content: "hi" }],
  });
  assert.equal(body.system, "sys");
  assert.equal(body.max_tokens, 100);
  const messages = messagesOf(body);
  assert.equal(messages[0]?.role, "user");
});

test("Chat stop → Anthropic stop_sequences，→ Responses 明确丢弃并记录", async () => {
  const chatToAnthropic = await convertRequest("anthropic", "chat-completions", {
    model: "m",
    messages: [{ role: "user", content: "hi" }],
    stop: ["END"],
  });
  assert.deepEqual(chatToAnthropic.body.stop_sequences, ["END"]);

  const chatToResponses = await convertRequest("responses", "chat-completions", {
    model: "m",
    messages: [{ role: "user", content: "hi" }],
    stop: ["END"],
  });
  assert.equal(chatToResponses.body.stop, undefined);
  assert.ok(chatToResponses.notes.some((note) => note.includes("stop")));
});

test("孤立 function_call_output 明确报错而不是静默配错", async () => {
  await assert.rejects(
    () => convertRequest("chat-completions", "responses", {
      model: "m",
      input: [{ type: "function_call_output", call_id: "orphan", output: "x" }],
    }),
    BridgeConversionError,
  );
});

test("重复工具调用 ID 与重复输出 ID 报错", async () => {
  await assert.rejects(
    () => convertRequest("chat-completions", "responses", {
      model: "m",
      input: [
        { type: "function_call", call_id: "dup", name: "f", arguments: "{}" },
        { type: "function_call", call_id: "dup", name: "f", arguments: "{}" },
      ],
    }),
    BridgeConversionError,
  );
  await assert.rejects(
    () => convertRequest("chat-completions", "responses", {
      model: "m",
      input: [
        { type: "function_call", call_id: "c1", name: "f", arguments: "{}" },
        { type: "function_call_output", call_id: "c1", output: "a" },
        { type: "function_call_output", call_id: "c1", output: "b" },
      ],
    }),
    BridgeConversionError,
  );
});

test("多条 system 消息合并且 developer 消息保留", async () => {
  const { body } = await convertRequest("anthropic", "chat-completions", {
    model: "m",
    messages: [
      { role: "system", content: "first" },
      { role: "system", content: "second" },
      { role: "user", content: "hi" },
    ],
  });
  assert.equal(body.system, "first\n\nsecond");
});

test("reasoning.effort 保留语义但不自动启用 anthropic thinking", async () => {
  const { body } = await convertRequest("anthropic","responses", {
    model: "m",
    max_output_tokens: 100,
    reasoning: { effort: "high" },
    input: [{ type: "message", role: "user", content: "hi" }],
  });
  assert.equal(body.thinking, undefined);
  const chatTarget = await convertRequest("chat-completions", "responses", {
    model: "m",
    reasoning: { effort: "high" },
    input: "hi",
  });
  assert.equal(chatTarget.body.reasoning_effort, "high");
});

test("图片内容：Responses input_image → Chat image_url / Anthropic base64", async () => {
  const chat = (await convertRequest("chat-completions", "responses", {
    model: "m",
    input: [{
      type: "message",
      role: "user",
      content: [
        { type: "input_text", text: "look" },
        { type: "input_image", image_url: "https://example.com/a.png" },
      ],
    }],
  })).body;
  const parts = index(messagesOf(chat), 0)?.content as AnyArray;
  assert.equal(parts[1]?.type, "image_url");
  assert.equal((parts[1]?.image_url as Json).url, "https://example.com/a.png");

  const anthropic = (await convertRequest("anthropic","responses", {
    model: "m",
    max_output_tokens: 10,
    input: [{
      type: "message",
      role: "user",
      content: [{ type: "input_image", image_url: "data:image/png;base64,QUJD" }],
    }],
  })).body;
  const image = (index(messagesOf(anthropic), 0)?.content as AnyArray)[0] as Json;
  assert.equal(image.type, "image");
  assert.deepEqual(image.source, { type: "base64", media_type: "image/png", data: "QUJD" });
});

test("anthropic 源跨协议不可表达的 thinking/cache_control 显式记录", async () => {
  const { notes } = await convertRequest("chat-completions", "anthropic", {
    model: "m",
    max_tokens: 10,
    system: [{ type: "text", text: "s", cache_control: { type: "ephemeral" } }],
    messages: [
      { role: "user", content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }] },
      { role: "assistant", content: [{ type: "thinking", thinking: "内部", signature: "sig1" }, { type: "redacted_thinking", data: "x" }] },
      { role: "user", content: [{ type: "text", text: "继续" }] },
    ],
  });
  assert.ok(notes.some((note) => note.includes("thinking 块跨协议目标不可表达，已丢弃 2 个块")), JSON.stringify(notes));
  assert.ok(notes.some((note) => note.includes("signature")), JSON.stringify(notes));
  assert.ok(notes.some((note) => note.includes("cache_control") && note.includes("2 处")), JSON.stringify(notes));
});

test("responses 目标安全名时声明/历史/choice 三处统一映射名", async () => {
  // 跨协议方向才走转换（同协议直通原样保留）；chat 源命名工具在 responses 目标
  // 的声明、调用历史与 named choice 必须三处同用映射名。
  const { body, tools } = await convertRequest("responses", "chat-completions", {
    model: "m",
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "fs read!", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "call_1", content: "ok" },
    ],
    tools: [{ type: "function", function: { name: "fs read!", parameters: { type: "object" } } }],
    tool_choice: { type: "function", function: { name: "fs read!" } },
  });
  const mappedName = ((body.tools as AnyArray)[0] as Json).name as string;
  assert.notEqual(mappedName, "fs read!", "非法名必须映射为安全名");
  assert.match(mappedName, /^[A-Za-z0-9_-]{1,64}$/);
  const historyCall = inputOf(body).find((entry) => entry.type === "function_call") as Json | undefined;
  assert.equal(historyCall?.name, mappedName, "历史项必须与声明同用映射名");
  const choice = body.tool_choice as Json;
  assert.equal(choice.name, mappedName);
  assert.equal(tools.get(mappedName)?.name, "fs read!");
});

test("mapToolName 选项允许插件应用服务安全名策略", async () => {
  const { body, tools } = await convertRequest("chat-completions", "responses", {
    model: "m",
    input: "hi",
    tools: [{ type: "function", name: "原始名", parameters: { type: "object" } }],
  }, {
    mapToolName: ({ name }) => `svc_${name}`,
  });
  const tool = (body.tools as AnyArray)[0] as Json;
  assert.equal((tool.function as Json).name, "svc_原始名");
  assert.equal(tools.get("svc_原始名")?.name, "原始名");
});

test("同协议直通保留全部字段与扩展结构", async () => {
  const source = {
    model: "m",
    instructions: "keep",
    tools: [{ type: "namespace", name: "ns", tools: [{ type: "custom", name: "c", description: "d" }] }],
    input: [{ type: "message", role: "user", content: "hi" }],
    unknownExtension: { keep: true },
  };
  const { body, tools } = await convertRequest("responses","responses", source);
  assert.deepEqual(body, source);
  assert.equal(tools.size, 1);
  const identity = [...tools.values()][0]!;
  assert.equal(identity.custom, true);
  assert.equal(identity.namespace, "ns");
});

test("gemini 是合法客户端来源；缺少 contents 明确报错", async () => {
  await assert.rejects(
    () => convertRequest("chat-completions", "gemini", { contents: "not-array" }),
    /contents 必须是数组/,
  );
});

test("gemini → chat：systemInstruction/文本/工具轮/toolConfig 完整投影", async () => {
  const { body, tools } = await convertRequest("chat-completions", "gemini", {
    contents: [
      { role: "user", parts: [{ text: "hi" }] },
      { role: "model", parts: [{ text: "读取" }, { functionCall: { name: "read_file", args: { path: "a" } } }] },
      { role: "user", parts: [{ functionResponse: { name: "read_file", response: { ok: true } } }] },
    ],
    systemInstruction: { parts: [{ text: "be nice" }] },
    tools: [{ functionDeclarations: [{ name: "read_file", description: "d", parametersJsonSchema: { type: "object", properties: { path: { type: "string" } } } }] }],
    toolConfig: { functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["read_file"] } },
    generationConfig: { maxOutputTokens: 64, temperature: 0.2, topP: 0.9, stopSequences: ["END"] },
  }, { model: "svc-model" });
  const messages = messagesOf(body);
  assert.equal(messages[0]?.role, "system");
  assert.equal(messages[0]?.content, "be nice");
  // gemini parts 是数组内容：chat 目标按保形合同保持内容块数组。
  assert.deepEqual(messages[1]?.content, [{ type: "text", text: "hi" }]);
  const assistant = messages[2]!;
  const calls = (assistant.tool_calls ?? []) as AnyArray;
  assert.equal((index(calls, 0).function as Json)?.name, "read_file");
  const tool = messages[3]!;
  assert.equal(tool.role, "tool");
  assert.deepEqual(JSON.parse(String(tool.content)), { ok: true });
  assert.deepEqual(body.tool_choice, { type: "function", function: { name: "read_file" } });
  assert.equal(body.model, "svc-model");
  assert.equal(body.max_tokens, 64);
  assert.deepEqual(body.stop, ["END"]);
  assert.equal(tools.size, 1);
});

test("gemini → anthropic：思考块剥离记录并保留工具轮", async () => {
  const { body, notes } = await convertRequest("anthropic","gemini", {
    contents: [
      { role: "user", parts: [{ text: "hi" }] },
      { role: "model", parts: [{ text: "内部推理", thought: true }, { functionCall: { name: "f", args: {} } }] },
      { role: "user", parts: [{ functionResponse: { name: "f", response: { ok: 1 } } }] },
    ],
    tools: [{ functionDeclarations: [{ name: "f", parametersJsonSchema: { type: "object" } }] }],
  }, { model: "m" });
  const messages = messagesOf(body);
  const assistant = messages[1]!;
  const blocks = assistant.content as AnyArray;
  assert.equal(blocks.filter((block) => block.type === "tool_use").length, 1);
  assert.ok(notes.some((note) => note.includes("thought 思考块")), JSON.stringify(notes));
  assert.equal(body.max_tokens, 1024); // 无 generationConfig.maxOutputTokens 时占位
});

test("gemini 无 id 的调用按最近同名未应答配对；孤立响应报错", async () => {
  const ok = await convertRequest("chat-completions", "gemini", {
    contents: [
      { role: "user", parts: [{ text: "go" }] },
      { role: "model", parts: [{ functionCall: { name: "f", args: {} } }] },
      { role: "user", parts: [{ functionResponse: { name: "f", response: "done" } }] },
    ],
  }, { model: "m" });
  const tool = messagesOf(ok.body)[2]!;
  assert.equal(tool.role, "tool");
  await assert.rejects(
    () => convertRequest("chat-completions", "gemini", {
      contents: [{ role: "user", parts: [{ functionResponse: { name: "ghost", response: "x" } }] }],
    }, { model: "m" }),
    /无法按名称.*配对|未应答/,
  );
});

test("gemini 同协议直通保留原始体与工具声明身份", async () => {
  const source = {
    contents: [{ role: "user", parts: [{ text: "hi" }] }],
    systemInstruction: "sys",
    tools: [{ functionDeclarations: [{ name: "f", parametersJsonSchema: { type: "object" } }] }],
    unknownExtension: true,
  };
  const { body, tools } = await convertRequest("gemini","gemini", source);
  assert.deepEqual(body, source);
  assert.equal(tools.size, 1);
});

test("gemini 目标拒绝 URL 图片（引擎需下载，违反离线边界）", async () => {
  await assert.rejects(
    () => convertRequest("gemini","responses", {
      model: "m",
      input: [{ type: "message", role: "user", content: [{ type: "input_image", image_url: "https://example.com/a.png" }] }],
    }),
    /不能保留图片 URL/,
  );
});

test("Chat 源 n>1 跨协议报错，n=1 正常", async () => {
  await assert.rejects(
    () => convertRequest("responses", "chat-completions", { model: "m", messages: [{ role: "user", content: "hi" }], n: 2 }),
    BridgeConversionError,
  );
  const ok = await convertRequest("responses", "chat-completions", { model: "m", messages: [{ role: "user", content: "hi" }], n: 1 });
  assert.equal(ok.body.n, undefined);
});

test("response_format json_schema 跨协议保留为 text.format", async () => {
  const { body } = await convertRequest("responses", "chat-completions", {
    model: "m",
    messages: [{ role: "user", content: "hi" }],
    response_format: { type: "json_schema", json_schema: { name: "out", strict: true, schema: { type: "object" } } },
  });
  const text = body.text as Json;
  const format = text.format as Json;
  assert.equal(format.type, "json_schema");
  assert.equal(format.name, "out");
  assert.equal(format.strict, true);
});


/* ============================ R4 请求调用收敛合同 ============================ */

test("同协议直通的身份表使用原名，不生成请求体未使用的映射名", async () => {
  const source = {
    model: "m",
    instructions: "sys",
    tools: [{ type: "custom", name: "原始 非法名!", parameters: { type: "object" } }],
    input: [{ type: "message", role: "user", content: "hi" }],
  };
  const { body, tools } = await convertRequest("responses","responses", source, { model: "svc" });
  // body 未改名：身份表 key 必须与 body 中的实际工具名一致（原名）。
  assert.deepEqual((body.tools as AnyArray)[0]?.name, "原始 非法名!");
  assert.ok(tools.has("原始 非法名!"), "身份表必须以原名为 key");
  assert.equal(tools.get("原始 非法名!")!.custom, true);
  assert.equal(body.model, "svc");
});

test("跨协议转换不修改调用方原始请求对象", async () => {
  const source = {
    model: "m",
    instructions: "sys",
    generationConfig: undefined,
    tools: [{ type: "function", name: "f", parameters: { type: "object" } }],
    input: [
      { type: "message", role: "user", content: "hi" },
      { type: "function_call", call_id: "c1", name: "f", arguments: "{}" },
      { type: "function_call_output", call_id: "c1", output: "ok" },
    ],
  };
  const snapshot = structuredClone(source);
  await convertRequest("chat-completions", "responses", source);
  assert.deepEqual(source, snapshot, "调用方原始请求必须保持不变");
});

test("gemini 源同协议直通保留 generationConfig 且不回填 model 字段", async () => {
  const source = { contents: [{ role: "user", parts: [{ text: "hi" }] }], generationConfig: { temperature: 0.5, maxOutputTokens: 64 } };
  const { body, tools } = await convertRequest("gemini","gemini", source);
  assert.deepEqual(body, source);
  assert.equal(tools.size, 0);
});


/* ============================ strippedTools 结构化合同 ============================ */

test("strippedTools：跨协议剥离的服务器工具结构化返回且 notes 同步", async () => {
  // chat 源携带目标协议不可表达的内置工具声明 → anthropic 目标。
  const { body, notes, strippedTools } = await convertRequest("anthropic", "chat-completions", {
    model: "m",
    messages: [{ role: "user", content: "hi" }],
    tools: [
      { type: "function", function: { name: "f", parameters: { type: "object" } } },
      { type: "web_search" },
      { type: "code_interpreter" },
    ],
  });
  assert.deepEqual(strippedTools, ["web_search", "code_interpreter"]);
  assert.ok(notes.some((note) => note.includes("web_search")), "notes 同步记录剥离");
  // anthropic 目标的声明形状为顶层 name（无 function 包装）。
  const kept = (body.tools as AnyArray).map((tool) => tool.name);
  assert.deepEqual(kept, ["f"]);
});

test("strippedTools：同协议直通为空数组（无剥离发生）", async () => {
  const { strippedTools } = await convertRequest("responses", "responses", {
    model: "m",
    tools: [{ type: "function", name: "f", parameters: { type: "object" } }],
    input: [{ type: "message", role: "user", content: "hi" }],
  });
  assert.deepEqual(strippedTools, []);
});
