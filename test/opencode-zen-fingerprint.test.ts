import assert from "node:assert/strict";
import test from "node:test";
import {
  OPENCODE_ZEN_AGENT_SYSTEM_PROMPT,
  OPENCODE_ZEN_CLIENT_TOOLS,
  OPENCODE_ZEN_CLIENT_USER_AGENT,
  OPENCODE_ZEN_TITLE_SYSTEM_PROMPT,
  buildOpencodeZenUpstreamHeaders,
  createOpencodeZenProjectId,
  injectOpencodeZenFingerprintBody,
  mergeOpencodeZenTools,
  normalizeOpencodeZenEffort,
} from "../src/opencode/fingerprint.ts";
import { OPENCODE_SESSION_PATTERN, createOpenCodeSessionId } from "../src/opencode/session.ts";

const SESSION = createOpenCodeSessionId(1_000_000, "test-session");

test("UA 与标头集：官方四段式 UA、会话三回填、稳定项目 id 与 W3C 追踪头", () => {
  assert.equal(OPENCODE_ZEN_CLIENT_USER_AGENT, "opencode/latest/2.0.26/cli");
  assert.match(createOpencodeZenProjectId("host-a"), /^[0-9a-f]{40}$/);
  assert.equal(createOpencodeZenProjectId("host-a"), createOpencodeZenProjectId("host-a"));
  assert.notEqual(createOpencodeZenProjectId("host-a"), createOpencodeZenProjectId("host-b"));
  const headers = buildOpencodeZenUpstreamHeaders(SESSION, "public", createOpencodeZenProjectId("host-a"));
  assert.equal(headers["user-agent"], OPENCODE_ZEN_CLIENT_USER_AGENT);
  assert.equal(headers.authorization, "Bearer public");
  assert.equal(headers["x-opencode-client"], "cli");
  assert.equal(headers["x-opencode-session"], SESSION);
  assert.equal(headers["x-session-affinity"], SESSION);
  assert.equal(headers["x-session-id"], SESSION);
  assert.match(headers["x-opencode-project"], /^[0-9a-f]{40}$/);
  assert.match(headers.traceparent, /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
  assert.match(headers.b3, /^[0-9a-f]{32}-[0-9a-f]{16}-1$/);
  assert.equal(headers["content-type"], "application/json");
  assert.equal(headers.accept, "text/event-stream");
});

test("注入无工具请求：强制流式、标题模板在前、中性行为覆盖在后", () => {
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
  assert.equal(messages.length, 2);
  assert.equal(messages[0].role, "system");
  assert.ok(messages[0].content.startsWith(OPENCODE_ZEN_TITLE_SYSTEM_PROMPT), "标题模板必须完整在最前");
  assert.match(messages[0].content, /title generation duty above[\s\S]*is void/);
  assert.equal(messages[1].content, "hi");
  // 输入对象不被改写。
  assert.equal(input.stream, false);
  assert.equal(input.messages.length, 1);
});

test("注入带客户端 system 的无工具请求：模板在前、客户端指令在后", () => {
  const { body } = injectOpencodeZenFingerprintBody({
    messages: [{ role: "system", content: "You are Claude Code." }, { role: "user", content: "hi" }],
    stream: true,
  }, SESSION);
  const system = (body.messages as Array<{ role: string; content: string }>)[0].content;
  assert.ok(system.startsWith(OPENCODE_ZEN_TITLE_SYSTEM_PROMPT));
  assert.ok(system.endsWith("You are Claude Code."), "客户端原始 system 必须保留在末尾（靠后指令主导行为）");
});

test("注入带工具请求：agent 模板 + 官方工具并入且客户端同名定义优先", () => {
  const clientTool = { type: "function", function: { name: "read", description: "client read", parameters: { type: "object", properties: {} } } };
  const lookup = { type: "function", function: { name: "lookup_issue", description: "issue lookup", parameters: { type: "object", properties: {} } } };
  const { body } = injectOpencodeZenFingerprintBody({
    messages: [{ role: "system", content: "You are a coding agent." }, { role: "user", content: "hi" }],
    tools: [clientTool, lookup],
    stream: true,
  }, SESSION);
  const system = (body.messages as Array<{ role: string; content: string }>)[0].content;
  assert.ok(system.startsWith(OPENCODE_ZEN_AGENT_SYSTEM_PROMPT), "带工具流量必须用 agent 模板");
  assert.ok(system.endsWith("You are a coding agent."));
  const tools = body.tools as Array<{ function: { name: string } }>;
  const names = tools.map((tool) => tool.function.name);
  assert.equal(names[0], "read");
  assert.equal(names[1], "lookup_issue");
  assert.equal(names.filter((name) => name === "read").length, 1, "客户端同名定义优先，官方同名定义不重复注入");
  for (const official of OPENCODE_ZEN_CLIENT_TOOLS as Array<{ function: { name: string } }>) {
    assert.ok(names.includes(official.function.name), `官方工具 ${official.function.name} 必须在场`);
  }
});

test("developer 角色首条消息同样可合并；非对象首条消息前插新 system", () => {
  const merged = injectOpencodeZenFingerprintBody({
    messages: [{ role: "developer", content: "dev instructions" }, { role: "user", content: "hi" }],
    stream: true,
  }, SESSION);
  assert.equal((merged.body.messages as Array<{ role: string }>)[0].role, "developer");
  const inserted = injectOpencodeZenFingerprintBody({
    messages: [{ role: "user", content: "hi" }],
    stream: true,
  }, SESSION);
  const messages = inserted.body.messages as Array<{ role: string }>;
  assert.equal(messages[0].role, "system");
  assert.equal(messages[1].role, "user");
});

test("mergeOpencodeZenTools：空与畸形输入不注入官方工具", () => {
  assert.deepEqual(mergeOpencodeZenTools([]), []);
  assert.deepEqual(mergeOpencodeZenTools(undefined), []);
  assert.deepEqual(mergeOpencodeZenTools("nope"), []);
});

test("模板与会话格式自检：指纹数据完整且会话 id 合规", () => {
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

test("首条 system 已含官方模板（base_instructions 下发）时不重复注入", () => {
  // 无工具：标题模板已在首位 → 原样保留，不追加优先级注记
  const plain = injectOpencodeZenFingerprintBody({
    model: "exo-free",
    messages: [{ role: "system", content: `${OPENCODE_ZEN_TITLE_SYSTEM_PROMPT}\n\nYou are Codex.` }, { role: "user", content: "hi" }],
    stream: true,
  }, SESSION, []);
  const system = (plain.body.messages as Array<{ role: string; content: string }>)[0].content;
  assert.equal(system, `${OPENCODE_ZEN_TITLE_SYSTEM_PROMPT}\n\nYou are Codex.`, "已含模板时原样保留");
  assert.equal(system.split(OPENCODE_ZEN_TITLE_SYSTEM_PROMPT).length - 1, 1, "模板只出现一次");

  // 带工具：agent 模板已在首位 → 不重复注入，但工具仍按门禁并集
  const tooled = injectOpencodeZenFingerprintBody({
    messages: [{ role: "system", content: `${OPENCODE_ZEN_AGENT_SYSTEM_PROMPT}\n\nYou are Codex.` }, { role: "user", content: "hi" }],
    tools: [{ type: "function", function: { name: "read", parameters: { type: "object", properties: {} } } }],
    stream: true,
  }, SESSION, []);
  const tooledSystem = (tooled.body.messages as Array<{ role: string; content: string }>)[0].content;
  assert.equal(tooledSystem.split(OPENCODE_ZEN_AGENT_SYSTEM_PROMPT).length - 1, 1, "agent 模板只出现一次");
  assert.ok(((tooled.body.tools ?? []) as unknown[]).length > 1, "工具仍并入官方定义");
});
