import assert from "node:assert/strict";
import test from "./host-test.ts";
import {
  OPENCODE_ZEN_AGENT_SYSTEM_PROMPT,
  OPENCODE_ZEN_CLIENT_TOOLS,
  OPENCODE_ZEN_CLIENT_USER_AGENT,
  OPENCODE_ZEN_TITLE_SYSTEM_PROMPT,
  buildOpencodeZenUpstreamHeaders,
  createOpencodeZenProjectId,
  injectOpencodeZenFingerprintBody,
  mergeOpencodeZenGateTools,
  normalizeOpencodeZenEffort,
} from "@agent-proxy/opencode-zen/fingerprint";
import { OPENCODE_SESSION_PATTERN, createOpenCodeSessionId } from "@agent-proxy/opencode-zen/session";

const SESSION = createOpenCodeSessionId(1_000_000, "test-session");

test("UA 与标头集：官方四段式 UA、会话四回填（含 session-id 硬性头）、稳定项目 id 与 W3C 追踪头", () => {
  assert.equal(OPENCODE_ZEN_CLIENT_USER_AGENT, "opencode/latest/2.0.29/cli");
  assert.match(createOpencodeZenProjectId("host-a"), /^[0-9a-f]{40}$/);
  assert.equal(createOpencodeZenProjectId("host-a"), createOpencodeZenProjectId("host-a"));
  assert.notEqual(createOpencodeZenProjectId("host-a"), createOpencodeZenProjectId("host-b"));
  const headers = buildOpencodeZenUpstreamHeaders(SESSION, "public", createOpencodeZenProjectId("host-a"));
  assert.equal(headers["user-agent"], OPENCODE_ZEN_CLIENT_USER_AGENT);
  assert.equal(headers.authorization, "Bearer public");
  assert.equal(headers["x-opencode-client"], "cli");
  assert.equal(headers["x-opencode-session"], SESSION);
  assert.equal(headers["x-opencode-session-id"], SESSION, "2026-10-15 起门禁硬性要求，缺失即 403");
  assert.equal(headers["x-session-affinity"], SESSION);
  assert.equal(headers["x-session-id"], SESSION);
  assert.match(headers["x-opencode-project"], /^[0-9a-f]{40}$/);
  assert.match(headers.traceparent, /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
  assert.match(headers.b3, /^[0-9a-f]{32}-[0-9a-f]{16}-1$/);
  assert.equal(headers["content-type"], "application/json");
  assert.equal(headers.accept, "text/event-stream");
});

test("注入无工具请求：消息原样透传、合并官方 read 定义、强制流式", () => {
  const input = {
    model: "exo-free",
    messages: [{ role: "user", content: "hi" }],
    stream: false,
  };
  const { body, aggregateForClient } = injectOpencodeZenFingerprintBody(input, SESSION);
  assert.equal(aggregateForClient, true, "非流式客户端需要网关聚合");
  assert.equal(body.stream, true, "上游必须强制流式（非流式一律 403）");
  assert.deepEqual(body.stream_options, { include_usage: true });
  assert.equal(body.prompt_cache_key, SESSION);
  const messages = body.messages as Array<{ role: string; content: string }>;
  assert.equal(messages.length, 1, "system 内容不检查，不注入任何模板");
  assert.equal(messages[0].role, "user");
  assert.equal(messages[0].content, "hi");
  const tools = body.tools as Array<{ function: { name: string } }>;
  assert.deepEqual(tools.map((tool) => tool.function.name), ["read"], "无 tools 的请求只有官方标题模板才放行，一律合并官方 read 定义");
  // 输入对象不被改写。
  assert.equal(input.stream, false);
  assert.equal(input.messages.length, 1);
});

test("注入带客户端 system 与工具的请求：system 不动、客户端同名定义优先", () => {
  const clientRead = { type: "function", function: { name: "read", description: "client read", parameters: { type: "object", properties: { path: { type: "string" } } } } };
  const clientShell = { type: "function", function: { name: "shell", description: "client shell", parameters: { type: "object", properties: { cmd: { type: "string" } } } } };
  const lookup = { type: "function", function: { name: "lookup_issue", description: "issue lookup", parameters: { type: "object", properties: {} } } };
  const { body } = injectOpencodeZenFingerprintBody({
    messages: [{ role: "system", content: "You are a coding agent." }, { role: "user", content: "hi" }],
    tools: [clientRead, clientShell, lookup],
    stream: true,
  }, SESSION);
  const messages = body.messages as Array<{ role: string; content: string }>;
  assert.equal(messages[0].content, "You are a coding agent.", "客户端 system 原样保留（门禁不检查内容）");
  const tools = body.tools as Array<{ function: { name: string; description?: string } }>;
  const names = tools.map((tool) => tool.function.name);
  assert.deepEqual(names, ["read", "shell", "lookup_issue"], "read 已在场时不重复合并");
  assert.equal(tools[0].function.description, "client read", "客户端同名定义优先，官方定义不覆盖");
  assert.equal(tools.length, 3, "read 在场时不追加任何官方定义（最小合并面，客户端 shell/read 原样保留）");
});

test("合并规则：缺 read 补官方定义；畸形输入按空列表合并；官方定义带非空 schema", () => {
  const name = (tools: unknown[]) => (tools as Array<{ function: { name: string } }>).map((tool) => tool.function.name);
  const bashOnly = [{ type: "function", function: { name: "bash", parameters: { type: "object", properties: { cmd: { type: "string" } } } } }];
  const shellOnly = [{ type: "function", function: { name: "shell", parameters: { type: "object", properties: { cmd: { type: "string" } } } } }];
  const readPlusCustom = [{ type: "function", function: { name: "read", parameters: { type: "object", properties: { path: {} } } } }, { type: "function", function: { name: "exec_command", parameters: {} } }];
  assert.deepEqual(name(mergeOpencodeZenGateTools(bashOnly)), ["bash", "read"], "bash 不替代 read：缺 read 仍要补");
  assert.deepEqual(name(mergeOpencodeZenGateTools(shellOnly)), ["shell", "read"], "shell 不替代 read");
  assert.deepEqual(name(mergeOpencodeZenGateTools(readPlusCustom)), ["read", "exec_command"], "read 已在场（最小非空 schema 亦可）不再补");
  assert.deepEqual(name(mergeOpencodeZenGateTools(undefined)), ["read"], "undefined 按空列表合并");
  assert.deepEqual(name(mergeOpencodeZenGateTools("nope")), ["read"], "非数组输入按空列表合并");
  const merged = mergeOpencodeZenGateTools([]) as Array<{ function: { name: string; parameters: Record<string, unknown>; description: string } }>;
  const official = (n: string) => (OPENCODE_ZEN_CLIENT_TOOLS as typeof merged).find((tool) => tool.function.name === n);
  for (const tool of merged) {
    assert.equal(tool, official(tool.function.name), "合并的是 fingerprint-data.json 的官方定义原文");
    assert.ok(Object.keys((tool.function.parameters as { properties?: object }).properties ?? {}).length > 0, `官方定义 ${tool.function.name} 必须带非空 schema（空 properties 已被门禁拒绝）`);
    assert.ok(!/cannot execute it/.test(tool.function.description), "不得残留占位描述");
  }
});

test("回退材料自检：官方模板与工具定义完整、会话 id 合规", () => {
  assert.ok(OPENCODE_ZEN_AGENT_SYSTEM_PROMPT.startsWith("You are an AI agent running in OpenCode"), "agent 模板应为 GA 官方提示词");
  assert.ok(OPENCODE_ZEN_AGENT_SYSTEM_PROMPT.includes("Prefer dedicated tools over shell commands"), "带工具模板应已渲染工具指引");
  assert.ok(!OPENCODE_ZEN_AGENT_SYSTEM_PROMPT.includes("${OPENCODE_TOOL_GUIDANCE}"), "模板占位符必须已替换");
  assert.ok(OPENCODE_ZEN_TITLE_SYSTEM_PROMPT.startsWith("You are a title generator"));
  assert.ok((OPENCODE_ZEN_CLIENT_TOOLS as unknown[]).length >= 10);
  assert.match(SESSION, OPENCODE_SESSION_PATTERN);
});

test("effort 归一化：值域内放行、off/越界省略、无值域透传", () => {
  const deepseek = ["low", "high", "max"];
  const northMini = ["none", "high"];
  // 值域内取值原样放行（大小写归一）。
  assert.equal(normalizeOpencodeZenEffort(deepseek, "high"), "high");
  assert.equal(normalizeOpencodeZenEffort(deepseek, "MAX"), "max");
  assert.equal(normalizeOpencodeZenEffort(northMini, "none"), "none");
  // off / 空 / 非字符串：省略字段（上游用默认值）。
  assert.equal(normalizeOpencodeZenEffort(deepseek, "off"), undefined);
  assert.equal(normalizeOpencodeZenEffort(deepseek, "  "), undefined);
  assert.equal(normalizeOpencodeZenEffort(deepseek, 42), undefined);
  assert.equal(normalizeOpencodeZenEffort(deepseek, undefined), undefined);
  // 越界取值（不在该模型值域）省略，避免上游 400（实测非法 effort 必拒）。
  assert.equal(normalizeOpencodeZenEffort(deepseek, "medium"), undefined);
  assert.equal(normalizeOpencodeZenEffort(northMini, "low"), undefined);
  // 无档位声明（值域为空）透传：上游实测接受合法 effort 字符串（nemotron high/low 均 200），
  // 只有声明了值域的模型才按值域裁剪。
  assert.equal(normalizeOpencodeZenEffort([], "high"), "high");
  // Responses 形状 reasoning.effort 同样识别。
  assert.equal(normalizeOpencodeZenEffort(deepseek, undefined, { effort: "low" }), "low");
  assert.equal(normalizeOpencodeZenEffort(deepseek, undefined, { effort: "off" }), undefined);
});

test("注入请求体：reasoning_effort 按调用方传入的实时档位裁决", () => {
  const deepseekLevels = ["low", "high", "max"];
  // chat 形状：值域内 effort 进入上游请求体。
  const chat = injectOpencodeZenFingerprintBody({
    model: "deepseek-v4-flash-free",
    messages: [{ role: "user", content: "hi" }],
    stream: true,
    reasoning_effort: "high",
  }, SESSION, deepseekLevels);
  assert.equal(chat.body.reasoning_effort, "high");

  // Responses 形状 reasoning.effort 转成 reasoning_effort，原始 reasoning 对象不透传。
  const fromResponses = injectOpencodeZenFingerprintBody({
    model: "deepseek-v4-flash-free",
    messages: [{ role: "user", content: "hi" }],
    stream: true,
    reasoning: { effort: "low", summary: "auto" },
  }, SESSION, deepseekLevels);
  assert.equal(fromResponses.body.reasoning_effort, "low");
  assert.equal("reasoning" in fromResponses.body, false, "Responses 形状对象不得进入 chat 请求体");

  // 越界 effort 省略该字段（不发给上游）。
  const outOfRange = injectOpencodeZenFingerprintBody({
    model: "deepseek-v4-flash-free",
    messages: [{ role: "user", content: "hi" }],
    stream: true,
    reasoning_effort: "medium",
  }, SESSION, deepseekLevels);
  assert.equal("reasoning_effort" in outOfRange.body, false);

  // 未传档位（元数据缺失）时透传客户端 effort，由上游判定。
  const noLevels = injectOpencodeZenFingerprintBody({
    model: "nemotron-3.5-lightning-free",
    messages: [{ role: "user", content: "hi" }],
    stream: true,
    reasoning_effort: "high",
  }, SESSION);
  assert.equal(noLevels.body.reasoning_effort, "high");
});
