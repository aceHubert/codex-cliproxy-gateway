import assert from "node:assert/strict";
import test from "node:test";
import { translateAgyRequest, AgyRequestError } from "../src/agy/request.ts";
import { AGY_DEFAULT_PROJECT } from "../src/agy/transport.ts";

const TIMEOUT = { timeout: 30_000 };
type Json = Record<string, any>;

function translated(body: Json): { wrapper: Json; request: Json } {
  const result = translateAgyRequest(body, "gemini-3.8-flash");
  // 外层包装按 MITM 抓包的真实 CLI 形状断言。
  assert.equal(result.wrapper.project, AGY_DEFAULT_PROJECT);
  assert.equal(result.wrapper.model, "gemini-3.8-flash");
  assert.equal(result.wrapper.userAgent, "antigravity");
  assert.equal(result.wrapper.requestType, "checkpoint");
  assert.match(String(result.wrapper.requestId), /^checkpoint\//);
  const request = result.wrapper.request as Json;
  assert.match(String(request.sessionId), /^-\d+$/);
  return { wrapper: result.wrapper as Json, request };
}

test("agy 请求转换：instructions 与 system/developer 并入 systemInstruction", TIMEOUT, () => {
  const { request } = translated({
    instructions: "你是编码助手",
    input: [
      { type: "message", role: "system", content: "系统规则" },
      { type: "message", role: "user", content: "解释 TIME_WAIT" },
    ],
  });
  assert.equal(request.systemInstruction.role, "user");
  assert.deepEqual(request.systemInstruction.parts.map((part: Json) => part.text), ["你是编码助手", "系统规则"]);
  assert.deepEqual(request.contents, [{ role: "user", parts: [{ text: "解释 TIME_WAIT" }] }]);
});

test("agy 请求转换：assistant 历史映射 model 角色", TIMEOUT, () => {
  const { request } = translated({
    input: [
      { type: "message", role: "user", content: "第一问" },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "第一答" }] },
      { type: "message", role: "user", content: "第二问" },
    ],
  });
  assert.deepEqual(request.contents.map((content: Json) => content.role), ["user", "model", "user"]);
  assert.deepEqual(request.contents[1].parts, [{ text: "第一答" }]);
});

test("agy 请求转换：工具声明与 tool_choice 映射 functionDeclarations/toolConfig", TIMEOUT, () => {
  const { request } = translated({
    input: "查一下",
    tools: [
      { type: "function", name: "shell", parameters: { type: "object", properties: { command: { type: "string" } } } },
      { type: "custom", name: "apply_patch" },
      { type: "web_search" },
    ],
    tool_choice: { type: "function", name: "shell" },
  });
  const declarations = request.tools[0].functionDeclarations;
  assert.equal(declarations.length, 2);
  assert.equal(declarations[0].name, "shell");
  assert.deepEqual(declarations[1].parameters, { type: "object", properties: { input: { type: "string" } }, required: ["input"], additionalProperties: false });
  assert.deepEqual(request.toolConfig.functionCallingConfig, { mode: "ANY", allowedFunctionNames: ["shell"] });
});

test("agy 请求转换：function_call 历史与输出配对映射 functionCall/functionResponse", TIMEOUT, () => {
  const { request } = translated({
    input: [
      { type: "message", role: "user", content: "跑命令" },
      { type: "function_call", name: "shell", call_id: "call_1", arguments: "{\"command\":\"ls\"}" },
      { type: "function_call_output", call_id: "call_1", output: [{ type: "output_text", text: "file-a\nfile-b" }] },
    ],
    tools: [{ type: "function", name: "shell", parameters: { type: "object" } }],
  });
  assert.deepEqual(request.contents[1].parts[0].functionCall, { name: "shell", args: { command: "ls" } });
  assert.deepEqual(request.contents[2].parts[0].functionResponse, { name: "shell", response: { output: "file-a\nfile-b" } });
});

test("agy 请求转换：custom 工具调用信封与命名空间安全名", TIMEOUT, () => {
  const { request } = translated({
    input: [
      { type: "custom_tool_call", name: "apply patch!", namespace: "mcp.server", call_id: "call_c", input: "patch text" },
      { type: "custom_tool_call_output", call_id: "call_c", output: "done" },
    ],
    tools: [{ type: "custom", name: "apply patch!", namespace: "mcp.server" }],
  });
  const callPart = request.contents[0].parts[0];
  // 不安全字符会被替换成安全名；调用与响应必须使用与声明一致的同一个映射名。
  assert.match(callPart.functionCall.name, /^[A-Za-z0-9_-]{1,64}$/);
  assert.equal(callPart.functionCall.name, request.tools[0].functionDeclarations[0].name);
  assert.deepEqual(callPart.functionCall.args, { input: "patch text" });
  const responsePart = request.contents[1].parts[0];
  assert.equal(responsePart.functionResponse.name, callPart.functionCall.name);
  assert.deepEqual(responsePart.functionResponse.response, { output: "done" });
});

test("agy 请求转换：reasoning 档位映射 thinkingLevel，未知档位只带基础配置", TIMEOUT, () => {
  assert.deepEqual(translated({ input: "q", reasoning: { effort: "high" } }).request.generationConfig.thinkingConfig,
    { includeThoughts: true, thinkingBudget: -1, thinkingLevel: "high" });
  assert.deepEqual(translated({ input: "q", reasoning: { effort: "minimal" } }).request.generationConfig.thinkingConfig,
    { includeThoughts: true, thinkingBudget: -1, thinkingLevel: "low" });
  assert.equal(translated({ input: "q", reasoning: { effort: "none" } }).request.generationConfig.thinkingConfig.thinkingLevel, undefined);
});

test("agy 请求转换：默认 maxOutputTokens 与采样参数透传", TIMEOUT, () => {
  const config = translated({ input: "q", temperature: 0.2, top_p: 0.9 }).request.generationConfig;
  assert.equal(config.maxOutputTokens, 16384);
  assert.equal(config.temperature, 0.2);
  assert.equal(config.topP, 0.9);
  // thinkingConfig 始终按 CLI 形态携带 includeThoughts 与动态预算。
  assert.deepEqual(translated({ input: "q" }).request.generationConfig.thinkingConfig,
    { includeThoughts: true, thinkingBudget: -1 });
});

test("agy 请求转换：剥离的服务器工具写入系统旁白，reasoning 历史被跳过", TIMEOUT, () => {
  const { wrapper, dropped } = translateAgyRequest({
    input: [
      { type: "reasoning", id: "item_r", summary: [{ type: "summary_text", text: "秘密思考" }] },
      { type: "web_search_call", id: "item_ws", action: { query: "gemini docs" } },
      { type: "message", role: "user", content: "继续" },
    ],
    tools: [{ type: "web_search" }],
  }, "gemini-3.8-flash");
  const innerRequest = wrapper.request as Json;
  assert.deepEqual(dropped, ["web_search"]);
  assert.match(innerRequest.systemInstruction.parts[0].text, /web_search/);
  const text = JSON.stringify(innerRequest.contents);
  // reasoning 历史不进入 contents；服务器调用历史降级为占位摘要（含查询词）。
  assert.ok(!text.includes("秘密思考"));
  assert.ok(text.includes("web_search_call"));
});

test("agy 请求转换：不支持字段显式拒绝", TIMEOUT, () => {
  for (const body of [
    { input: "q", previous_response_id: "resp_1" },
    { input: "q", conversation: "c" },
    { input: "q", background: true },
    { input: "q", response_format: { type: "json_object" } },
    { input: 42 },
  ]) {
    assert.throws(() => translateAgyRequest(body, "gemini-3.8-flash"), AgyRequestError);
  }
});

test("agy 请求转换：工具 parameters 的本地 $ref 内联展开，$ 元字段剥除", TIMEOUT, () => {
  const { wrapper } = translateAgyRequest({
    input: "查天气",
    tools: [{
      type: "function",
      name: "mcp_tool",
      parameters: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        oneOf: [{ $ref: "#/$defs/modeA" }, { $ref: "#/$defs/modeB" }],
        $defs: {
          modeA: { type: "object", properties: { city: { type: "string" } }, required: ["city"], additionalProperties: false },
          modeB: { type: "object", properties: { lat: { type: "number" }, lon: { type: "number" } } },
        },
      },
    }],
  }, "gemini-3.8-flash");
  const declaration = (wrapper.request as Json).tools[0].functionDeclarations[0];
  const parameters = declaration.parameters;
  // oneOf 保留，$defs/$schema 剥除，$ref 全部内联为具体 schema。
  assert.deepEqual(parameters.oneOf, [
    { type: "object", properties: { city: { type: "string" } }, required: ["city"], additionalProperties: false },
    { type: "object", properties: { lat: { type: "number" }, lon: { type: "number" } } },
  ]);
  assert.equal(parameters.$defs, undefined);
  assert.equal(parameters.$schema, undefined);
  assert.ok(!JSON.stringify(parameters).includes("$ref"));
});

test("agy 请求转换：悬空/外部 $ref 与循环引用按宽松空 schema 兜底", TIMEOUT, () => {
  const { wrapper } = translateAgyRequest({
    input: "q",
    tools: [{
      type: "function",
      name: "t",
      parameters: {
        type: "object",
        properties: {
          external: { $ref: "https://example.com/schema.json" },
          dangling: { $ref: "#/$defs/missing" },
          loopA: { $ref: "#/$defs/loopA" },
          nested: { type: "array", items: { $ref: "#/$defs/node" } },
        },
        $defs: { node: { type: "object", properties: { child: { $ref: "#/$defs/node" } } } },
      },
    }],
  }, "gemini-3.8-flash");
  const properties = (wrapper.request as Json).tools[0].functionDeclarations[0].parameters.properties;
  assert.deepEqual(properties.external, {});
  assert.deepEqual(properties.dangling, {});
  assert.deepEqual(properties.loopA, {});
  // 非循环引用正常展开，循环子字段兜底为空 schema。
  assert.equal(properties.nested.items.type, "object");
  assert.deepEqual(properties.nested.items.properties.child, {});
  assert.ok(!JSON.stringify(properties).includes("$ref"));
});

test("agy 请求转换：enum 非字符串字面量转字符串，联合 type 数组拆解", TIMEOUT, () => {
  const { wrapper } = translateAgyRequest({
    input: "q",
    tools: [{
      type: "function",
      name: "mixed_schema_tool",
      parameters: {
        type: "object",
        properties: {
          flag: { type: ["string", "null"], enum: ["auto", true, 3] },
          pair: { type: ["string", "number"] },
          plain: { type: "string" },
        },
      },
    }],
  }, "gemini-3.8-flash");
  const properties = (wrapper.request as Json).tools[0].functionDeclarations[0].parameters.properties;
  // enum 全部转为字符串（proto 是 repeated string）。
  assert.deepEqual(properties.flag.enum, ["auto", "true", "3"]);
  // ["string","null"] -> 单值 type + nullable；["string","number"] -> anyOf。
  assert.equal(properties.flag.type, "string");
  assert.equal(properties.flag.nullable, true);
  assert.deepEqual(properties.pair.anyOf, [{ type: "string" }, { type: "number" }]);
  assert.equal(properties.pair.type, undefined);
  assert.equal(properties.plain.type, "string");
});

test("agy 请求转换：schema 白名单剥除非 Gemini 键，const/items 元组做形态转换", TIMEOUT, () => {
  const { wrapper } = translateAgyRequest({
    input: "q",
    tools: [{
      type: "function",
      name: "t",
      parameters: {
        type: "object",
        properties: {
          op: { const: "create" },
          tuple: { items: [{ type: "string" }, { type: "number" }] },
          legacy: { type: "string", deprecated: true, exclusiveMinimum: 3 },
          vendored: { type: "string", "x-openai-web-call-encoding": "base64" },
        },
      },
    }],
  }, "gemini-3.8-flash");
  const properties = (wrapper.request as Json).tools[0].functionDeclarations[0].parameters.properties;
  assert.deepEqual(properties.op.enum, ["create"]);
  assert.deepEqual(properties.tuple.items.anyOf, [{ type: "string" }, { type: "number" }]);
  assert.deepEqual(properties.legacy, { type: "string" });
  assert.deepEqual(properties.vendored, { type: "string" });
});

test("agy 请求转换：agn1 信封的 thought 签名挂回下一个函数调用", TIMEOUT, () => {
  const { wrapper } = translateAgyRequest({
    input: [
      { type: "message", role: "user", content: "查天气" },
      { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "agn1:SIGabc==" },
      { type: "function_call", id: "fc_1", call_id: "call_1", name: "shell", arguments: "{\"command\":\"curl wttr.in\"}" },
      { type: "function_call_output", id: "fo_1", call_id: "call_1", output: "sunny" },
      { type: "reasoning", id: "rs_2", summary: [], encrypted_content: "gAAAAA-official-blob" },
      { type: "message", role: "user", content: "总结结果" },
    ],
    tools: [{ type: "function", name: "shell", parameters: { type: "object", properties: { command: { type: "string" } } } }],
  }, "gemini-3.8-flash-medium");
  const contents = (wrapper.request as Json).contents;
  const modelTurn = contents.find((entry: Json) => entry.role === "model");
  const call = modelTurn.parts.find((part: Json) => part.functionCall !== undefined);
  // thoughtSignature 是 Part 级字段，与 functionCall 平级。
  assert.equal(call.thoughtSignature, "SIGabc==");
  assert.equal(call.functionCall.thoughtSignature, undefined);
  // 官方模型的加密内容（无 agn1: 前缀）不产生任何签名或内容。
  assert.ok(!JSON.stringify(contents).includes("gAAAAA-official-blob"));
  assert.ok(!JSON.stringify(contents).includes("agn1:"));
});
