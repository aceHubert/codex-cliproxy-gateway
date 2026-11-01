import assert from "node:assert/strict";
import test from "./host-test.ts";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  createStartPlanFetch,
  dressZcodeStartPlanBody,
  startPlanUpstreamUrl,
  zcodeStartPlanRefusalHint,
  zcodeStartPlanSystemBlocks,
} from "@agent-proxy/zcode/start-plan-request";
import fingerprintData from "@agent-proxy/zcode/fingerprint-data.json";

const promptTexts = fingerprintData.startPlanPrompt;
import { ZCODE_AGENT_SYSTEM_PROMPT, buildZcodeModelHeaders, readZcodeIdentity } from "@agent-proxy/zcode/request-context";
import type { ZcodeIdentity } from "@agent-proxy/zcode/request-context";

const identity: ZcodeIdentity = {
  appVersion: "3.17.1", language: "zh-CN", timezone: "Asia/Shanghai",
  platform: "darwin", arch: "arm64", osVersion: "24.0.0", deviceId: "device-mid-fixture",
};
const context = { requestId: "req", traceId: "trace", queryId: "query", sessionId: "session", sessionType: "main" as const };

test("start-plan 官方提示词文本与 3.17.1 提取校验值逐字节一致", () => {
  const sha8 = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 16);
  // cli_prefix 与 agentSystemPrompt 是同一官方文本，单一来源（fingerprint-data.json）。
  assert.equal(sha8(fingerprintData.agentSystemPrompt), "7779642ea44a4696");
  assert.equal(sha8(promptTexts.identity), "aac4ba4cc7b555b3");
  assert.equal(sha8(promptTexts.desktopContext), "86e0396775d5ed0e");
  assert.equal(sha8(promptTexts.dynamicBehavior), "7d843753f3adae93");
  assert.equal(sha8(promptTexts.contextManagement), "406a0480d88086cd");
});

test("start-plan system 重组为官方 3.17.1 三段块，网关旁白并入第三段末尾", () => {
  const blocks = zcodeStartPlanSystemBlocks({ family: "zai", upstreamModel: "GLM-5.3-Flash", identity },
    `${ZCODE_AGENT_SYSTEM_PROMPT}\n\n本通道无法执行以下服务器内置工具`);
  assert.equal(blocks.length, 3);
  assert.equal(blocks[0]!.text, fingerprintData.agentSystemPrompt);
  // 官方 assembleSystemMessages：cli_prefix 段不带 cache_control，stable/dynamic 段带。
  assert.equal(blocks[0]!.cache_control, undefined);
  assert.equal(blocks[1]!.text, `${promptTexts.identity}\n\n${promptTexts.desktopContext}`);
  assert.equal(blocks[1]!.cache_control!.type, "ephemeral");
  assert.ok(blocks[2]!.text.startsWith(`\n\n${promptTexts.dynamicBehavior}`));
  assert.ok(blocks[2]!.text.includes(promptTexts.contextManagement));
  assert.ok(blocks[2]!.text.endsWith("本通道无法执行以下服务器内置工具"), "网关旁白必须在第三段末尾，第四段会被中继拒绝");
  assert.equal(blocks[2]!.cache_control!.type, "ephemeral");
  // 无旁白时第三段仍以官方 Context Management 收尾。
  const bare = zcodeStartPlanSystemBlocks({ family: "bigmodel", upstreamModel: "GLM-5.2", identity }, ZCODE_AGENT_SYSTEM_PROMPT);
  assert.ok(bare[2]!.text.endsWith(promptTexts.contextManagement));
});

test("start-plan 正文重整：官方 meta_user 环境turn 前置、三段块与设备归因", () => {
  const now = new Date(2026, 10 - 1, 29, 23, 30);
  const body = dressZcodeStartPlanBody({
    model: "GLM-5.3-Flash", stream: true,
    system: `${ZCODE_AGENT_SYSTEM_PROMPT}\n\n旁白`,
    messages: [{ role: "user", content: [{ type: "text", text: "你好", cache_control: { type: "ephemeral" } }] }],
    metadata: { user_id: "{\"account_uuid\":\"\",\"session_id\":\"old\"}" },
  }, { family: "zai", upstreamModel: "GLM-5.3-Flash", identity, context, now: () => now });
  const system = body.system as { type: string; text: string; cache_control?: { type: string } }[];
  assert.equal(system.length, 3);
  assert.equal(system[0]!.cache_control, undefined);
  assert.equal(system[1]!.cache_control!.type, "ephemeral");
  assert.equal(system[2]!.cache_control!.type, "ephemeral");
  const messages = body.messages as { role: string; content: { type: string; text: string }[] }[];
  assert.equal(messages.length, 2);
  assert.equal(messages[0]!.role, "user");
  const contextText = messages[0]!.content[0]!.text;
  assert.ok(contextText.startsWith("# Environment\n"));
  assert.ok(contextText.includes("You are powered by the model named zai-api/GLM-5.3-Flash."));
  assert.ok(contextText.includes("Today's date is 2026-10-29."));
  const metadata = body.metadata as { user_id: string };
  assert.deepEqual(JSON.parse(metadata.user_id), {
    device_id: "device-mid-fixture", account_uuid: "", session_id: "session",
  });
  // 设备 ID 缺失时保持既有形状，不发送空字段。
  const noDevice = dressZcodeStartPlanBody({ messages: [] }, {
    family: "zai", upstreamModel: "GLM-5.3-Flash",
    identity: { ...identity, deviceId: undefined }, context,
  });
  assert.deepEqual(JSON.parse((noDevice.metadata as { user_id: string }).user_id), { account_uuid: "", session_id: "session" });
});

test("start-plan 上游 URL 剥离 query，无 query 时原样返回", () => {
  assert.equal(startPlanUpstreamUrl("https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages?beta=true"),
    "https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages");
  assert.equal(startPlanUpstreamUrl("https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages"),
    "https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages");
});

test("start-plan 拒答分类区分账号封禁与边缘 IP 封锁，其余错误不误判", () => {
  const account = zcodeStartPlanRefusalHint(405, "{\"code\":\"3012\",\"msg\":\"request has been blocked due to unusual activity\"}");
  assert.ok(account?.includes("3012"));
  assert.equal(zcodeStartPlanRefusalHint(200, "{\"code\":\"3012\"}"), undefined, "2xx 不是拒答");
  const edge = zcodeStartPlanRefusalHint(405, "<html>errors.aliyun.com</html>");
  assert.ok(edge?.includes("网络地址"));
  assert.ok(zcodeStartPlanRefusalHint(429, "{\"error\":{\"code\":\"1113\"}}") === undefined, "配额错误维持透传");
  assert.equal(zcodeStartPlanRefusalHint(500, "internal"), undefined);
});

test("start-plan 模型请求头携带官方归因头与 ai-sdk UA，不携带 x-api-key", () => {
  const headers = buildZcodeModelHeaders(identity, context, "start-plan", "jwt-token");
  assert.equal(headers.get("x-zcode-query-source"), "main_turn");
  assert.equal(headers.get("authorization"), "Bearer jwt-token");
  assert.equal(headers.get("x-api-key"), null);
  assert.equal(headers.get("accept"), null);
  assert.equal(headers.get("x-query-id"), null);
  assert.equal(headers.get("user-agent"), "ZCode/3.17.1 ai-sdk/anthropic/3.0.81");
  const coding = buildZcodeModelHeaders(identity, context, "coding-plan", "business-key");
  assert.equal(coding.get("x-zcode-query-source"), null);
  assert.equal(coding.get("x-api-key"), "business-key");
  assert.equal(coding.get("accept"), "text/event-stream");
  assert.equal(coding.get("x-query-id"), "query");
});

test("身份探测从本机 telemetry-state.json 读取设备 ID（home 与 v2 布局）", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-zcode-device-"));
  try {
    assert.equal(readZcodeIdentity(directory).deviceId, undefined);
    fs.writeFileSync(path.join(directory, "telemetry-state.json"), JSON.stringify({ deviceMid: "home-layout-mid", lastDailyActiveDate: "" }));
    assert.equal(readZcodeIdentity(directory).deviceId, "home-layout-mid");
    fs.rmSync(path.join(directory, "telemetry-state.json"));
    fs.mkdirSync(path.join(directory, "v2"));
    fs.writeFileSync(path.join(directory, "v2", "telemetry-state.json"), JSON.stringify({ deviceMid: "v2-layout-mid" }));
    assert.equal(readZcodeIdentity(directory).deviceId, "v2-layout-mid");
    fs.writeFileSync(path.join(directory, "v2", "telemetry-state.json"), JSON.stringify({ deviceMid: "带空白\n注入" }));
    assert.equal(readZcodeIdentity(directory).deviceId, undefined, "非法字符的设备 ID 拒绝采信");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("start-plan HTTP/1.1 传输器转发请求并流式回读响应，abort 时取消", async () => {
  const seen: { method?: string; headers: Record<string, string>; body: string; version: string }[] = [];
  const server = http.createServer((incoming, res) => {
    let body = "";
    incoming.on("data", (chunk) => { body += chunk; });
    incoming.on("end", () => {
      const headers = Object.fromEntries(Object.entries(incoming.headers).map(([name, value]) => [name, Array.isArray(value) ? value.join(",") : String(value)]));
      seen.push({ method: incoming.method, headers, body, version: incoming.httpVersion });
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: hello\n\n");
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const send = createStartPlanFetch();
  try {
    const response = await send(`http://127.0.0.1:${port}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test" },
      body: JSON.stringify({ model: "GLM-5.3-Flash" }),
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "text/event-stream");
    assert.equal(await response.text(), "data: hello\n\n");
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.method, "POST");
    assert.equal(seen[0]!.headers["authorization"], "Bearer test");
    assert.equal(seen[0]!.headers["content-type"], "application/json");
    assert.equal(seen[0]!.body, "{\"model\":\"GLM-5.3-Flash\"}");
    // abort 在发送前已触发时直接取消，不出网。
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(send(`http://127.0.0.1:${port}/gone`, { method: "POST", signal: controller.signal }));
    assert.equal(seen.length, 1);
  } finally {
    server.close();
  }
});
