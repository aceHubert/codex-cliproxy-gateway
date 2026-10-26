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
  mergeOpencodeZenGateSystem,
  mergeOpencodeZenGateTools,
  mergeOpencodeZenGateToolsResponses,
  normalizeOpencodeZenEffort,
} from "@agent-proxy/opencode-zen/fingerprint";
import { OPENCODE_SESSION_PATTERN, createOpenCodeSessionId } from "@agent-proxy/opencode-zen/session";

const SESSION = createOpenCodeSessionId(1_000_000, "test-session");

test("UA 与标头集：官方四段式 UA、会话四回填、稳定项目 id 与 W3C 追踪头", () => {
  assert.equal(OPENCODE_ZEN_CLIENT_USER_AGENT, "opencode/latest/2.1.4/cli");
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

test("注入无工具请求：system 前插官方模板、合并官方 read 定义、强制流式", () => {
  const input = {
    model: "exo-free",
    messages: [{ role: "user", content: "hi" }],
    stream: false,
  };
  const { body, aggregateForClient } = injectOpencodeZenFingerprintBody(input, SESSION);
  assert.equal(aggregateForClient, true, "非流式客户端需要网关聚合");
  assert.equal(body.stream, true, "上游必须强制流式（非流式一律被拒）");
  assert.deepEqual(body.stream_options, { include_usage: true });
  assert.equal(body.prompt_cache_key, SESSION, "prompt_cache_key 与会话标头四值同配");
  const messages = body.messages as Array<{ role: string; content: string }>;
  assert.equal(messages.length, 2, "无 system 时前插纯官方模板 system（门禁包含校验）");
  assert.equal(messages[0].role, "system");
  assert.equal(messages[0].content, OPENCODE_ZEN_AGENT_SYSTEM_PROMPT);
  assert.equal(messages[1].role, "user");
  assert.equal(messages[1].content, "hi");
  const tools = body.tools as Array<{ function: { name: string } }>;
  assert.deepEqual(tools.map((tool) => tool.function.name), ["read"], "空工具列表合并官方 read 定义（保险项）");
  // 输入对象不被改写。
  assert.equal(input.stream, false);
  assert.equal(input.messages.length, 1);
});

test("注入带客户端 system 与工具的请求：system 包裹官方模板、客户端同名定义优先", () => {
  const clientRead = { type: "function", function: { name: "read", description: "client read", parameters: { type: "object", properties: { path: { type: "string" } } } } };
  const clientShell = { type: "function", function: { name: "shell", description: "client shell", parameters: { type: "object", properties: { cmd: { type: "string" } } } } };
  const lookup = { type: "function", function: { name: "lookup_issue", description: "issue lookup", parameters: { type: "object", properties: {} } } };
  const { body } = injectOpencodeZenFingerprintBody({
    messages: [{ role: "system", content: "You are a coding agent." }, { role: "user", content: "hi" }],
    tools: [clientRead, clientShell, lookup],
    stream: true,
  }, SESSION);
  const messages = body.messages as Array<{ role: string; content: string }>;
  // 门禁包含关系校验（2026-10-26 实测）：模板在前、客户端指令追加在后过闸。
  assert.equal(messages[0].content, `${OPENCODE_ZEN_AGENT_SYSTEM_PROMPT}\n\n# Client Instructions\nYou are a coding agent.`, "客户端 system 包裹进官方模板");
  assert.equal(messages.length, 2, "包裹不增删消息条目");
  const tools = body.tools as Array<{ function: { name: string; description?: string } }>;
  const names = tools.map((tool) => tool.function.name);
  assert.deepEqual(names, ["read", "shell", "lookup_issue"], "read 已在场时不重复合并");
  assert.equal(tools[0].function.description, "client read", "客户端同名定义优先，官方定义不覆盖");
  assert.equal(tools.length, 3, "read 在场时不追加任何官方定义（最小合并面，客户端 shell/read 原样保留）");
});

test("system 包裹边界：非字符串内容前插模板、无消息体原样返回", () => {
  // 多部件 system（数组内容）：不动原消息，前插纯模板 system。
  const parted = mergeOpencodeZenGateSystem([
    { role: "system", content: [{ type: "text", text: "parted" }] },
    { role: "user", content: "hi" },
  ]) as Array<{ role: string; content: unknown }>;
  assert.equal(parted.length, 3);
  assert.equal(parted[0].role, "system");
  assert.equal(parted[0].content, OPENCODE_ZEN_AGENT_SYSTEM_PROMPT);
  assert.deepEqual(parted[1].content, [{ type: "text", text: "parted" }], "原 system 消息原样保留");
  // 只包裹首个字符串 system；其余 system（多 system 少见）原样保留。
  const dual = mergeOpencodeZenGateSystem([
    { role: "system", content: "first" },
    { role: "system", content: "second" },
    { role: "user", content: "hi" },
  ]) as Array<{ role: string; content: string }>;
  assert.ok(dual[0].content.startsWith(OPENCODE_ZEN_AGENT_SYSTEM_PROMPT));
  assert.ok(dual[0].content.endsWith("# Client Instructions\nfirst"));
  assert.equal(dual[1].content, "second");
  // 非数组输入不抛错、原样返回。
  assert.deepEqual(mergeOpencodeZenGateSystem(undefined), []);
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

test("tools 上限截断：超出 128 时截断且垫补的 read 存活（chat 与 Responses 同规则）", () => {
  // 上游 400 "maximum number of items is 128"（2026-10-26 实测，重载 MCP 客户端触发）。
  const many = (n: number, prefix: string) => Array.from({ length: n }, (_, index) => ({
    type: "function",
    function: { name: `${prefix}_${index}`, description: `tool ${index}`, parameters: { type: "object", properties: { a: { type: "string" } } } },
  }));
  // 客户端 130 个陌生工具：截为 127 客户端 + 官方 read 垫底。
  const capped = mergeOpencodeZenGateTools(many(130, "mcp")) as Array<{ function: { name: string } }>;
  assert.equal(capped.length, 128, "总数收敛到上游上限");
  assert.equal(capped[127].function.name, "read", "截断后垫补的官方 read 必须存活");
  assert.equal(capped[0].function.name, "mcp_0", "客户端工具保持原序在前");
  // 客户端自带 read 且总数超限：read 在客户端序列内，直接按上限截断。
  const withRead = [{ type: "function", function: { name: "read", description: "client read", parameters: { type: "object", properties: { path: {} } } } }, ...many(130, "x")];
  const cappedOwn = mergeOpencodeZenGateTools(withRead) as Array<{ function: { name: string } }>;
  assert.equal(cappedOwn.length, 128);
  assert.equal(cappedOwn[0].function.name, "read");
  // 恰好 128：不截断。
  assert.equal(mergeOpencodeZenGateTools(many(127, "fit")).length, 128, "127 客户端 + read = 128 恰好不截");
  // Responses 扁平形状同规则。
  const flatMany = many(130, "flat").map((tool) => ({ type: "function", name: tool.function.name, description: "d", parameters: { type: "object", properties: { a: {} } } }));
  const flatCapped = mergeOpencodeZenGateToolsResponses(flatMany) as Array<{ name: string }>;
  assert.equal(flatCapped.length, 128);
  assert.equal(flatCapped[127].name, "read");
  assert.equal((flatCapped[127] as { description?: string; strict?: boolean }).description !== undefined && (flatCapped[127] as { strict?: boolean }).strict === false, true, "Responses 垫补保持扁平形状");
});

test("快照自检：官方模板与工具定义完整、当前代 GA 长模板、会话 id 合规", () => {
  assert.ok(OPENCODE_ZEN_AGENT_SYSTEM_PROMPT.startsWith("You are an AI agent running in OpenCode"), "agent 模板应为 GA 官方提示词");
  assert.ok(OPENCODE_ZEN_AGENT_SYSTEM_PROMPT.length > 10_000, "当前代（GA 2.1.4）模板为 21010 字长模板，骤降即换代过期");
  assert.ok(OPENCODE_ZEN_AGENT_SYSTEM_PROMPT.includes("Prefer dedicated tools over shell commands"), "带工具模板应已渲染工具指引");
  assert.ok(!OPENCODE_ZEN_AGENT_SYSTEM_PROMPT.includes("${OPENCODE_TOOL_GUIDANCE}"), "模板占位符必须已替换");
  assert.ok(OPENCODE_ZEN_TITLE_SYSTEM_PROMPT.startsWith("You name conversations"), "GA 标题模板（不在门禁白名单，仅留档）");
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
