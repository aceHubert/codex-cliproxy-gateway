import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createGatewayHandler, isQoderResponsesWebSocket } from "../src/gateway.ts";
import { createQoderAdapter, qoderEnabled, safeQoderUpstreamError, validateQoderConfig } from "../src/qoder/index.ts";
import type { QoderDependencies } from "../src/qoder/index.ts";
import { QoderCredentialError } from "../src/qoder/credentials.ts";
import type { QoderCredentials } from "../src/qoder/credentials.ts";
import { decodeQoderBody, QODER_AGENT_SYSTEM_PROMPT } from "../src/qoder/transport.ts";
import type { QoderInferPayload } from "../src/qoder/transport.ts";
import { checkFrameRouting } from "../src/realtime.ts";
import type { GatewayConfig } from "../src/types.ts";

type Json = Record<string, any>;
const TIMEOUT = { timeout: 60_000 };

test("Qoder 上游错误按安全分类区分原因，不回显错误中的凭据或请求正文", () => {
  const cases = [
    [{ upstream_error: { status: 401, message: "SECRET" } }, "qoder_authentication_error"],
    [{ upstream_error: { message: "context_length_exceeded SECRET" } }, "qoder_context_limit"],
    [{ upstream_error: { status: 429, message: "SECRET" } }, "qoder_rate_or_quota_limit"],
    [{ upstream_error: { message: "invalid tool_call_id SECRET" } }, "qoder_tool_history_error"],
    [{ code: "upstream_protocol_error", message: "Qoder SSE 缺少 finish 结束事件 SECRET" }, "qoder_incomplete_stream"],
    [{ code: "upstream_protocol_error", message: "无效 JSON SECRET" }, "qoder_invalid_stream"],
  ] as const;
  for (const [raw, code] of cases) {
    const safe = safeQoderUpstreamError(raw);
    assert.equal(safe.code, code);
    assert.ok(!JSON.stringify(safe).includes("SECRET"));
    assert.equal(safe.upstream_error, undefined);
  }
});
const MODEL = "qoder-intl/qfmodel";
const INBOUND_OAUTH = "fake-chatgpt-oauth-qoder-test";
const TOKEN = "fake-qoder-access-token";
const SIGNING_KEY = "fake-qoder-signing-key";

function credential(): QoderCredentials {
  return { region: "intl", clientProfile: "cli", accountUid: "account-test", authDirectory: "/fake/.qoder/.auth",
    identity: "identity-test", machineId: "00000000-0000-4000-8000-000000000000",
    organizationId: "", organizationTags: [], dataPolicyAgreed: true,
    accessToken: TOKEN, expireTime: Math.floor(Date.now() / 1000) + 3600,
    encryptUserInfo: "fake-encrypted-user", key: SIGNING_KEY };
}

function catalogData(key = "qfmodel"): Json {
  return { chat: [
    { key, display_name: "Qwen3.8-Flash", enable: true, format: "openai", source: "system", is_vl: false, is_reasoning: true, max_input_tokens: 128_000, price_factor: 0,
      thinking_config: { enabled: { is_default: true, efforts: { xhigh: {}, low: {}, medium: { is_default: true } } }, disabled: {} } },
    { key: "auto", enable: true }, { key: "disabled-model", enable: false },
  ] };
}

function envelope(value: Json, status = 200): string {
  return `data: ${JSON.stringify({ statusCodeValue: status, body: JSON.stringify(value) })}\n\n`;
}

function upstream(delta: Json = { content: "测试答案" }, reason = "stop"): Response {
  return new Response(envelope({ choices: [{ index: 0, delta, finish_reason: reason }] })
    + envelope({ usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5, billable: false } })
    + "event: finish\ndata: {}\n\n", { headers: { "content-type": "text/event-stream" } });
}

function request(model = MODEL, extra: Json = {}, pathname = "/v1/responses"): Request {
  return new Request(`http://127.0.0.1:8320${pathname}`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${INBOUND_OAUTH}`, "chatgpt-account-id": "private-account" },
    body: JSON.stringify({ model, input: "你好", ...extra }),
  });
}

async function decode(response: Response): Promise<Json> {
  if (!response.headers.get("content-type")?.includes("text/event-stream")) return await response.json() as Json;
  const events: Json[] = (await response.text()).split("\n\n").flatMap((frame) => {
    const raw = frame.split("\n").find((line) => line.startsWith("data: "))?.slice(6);
    return raw && raw !== "[DONE]" ? [JSON.parse(raw)] : [];
  });
  assert.deepEqual(events.map((event) => event.sequence_number), events.map((_, index) => index));
  const final = events.findLast((event) => event.type === "response.completed");
  assert.ok(final, "SSE 必须包含完成事件");
  return final.response;
}

interface Fixture {
  directory: string;
  config: GatewayConfig;
  calls: QoderInferPayload[];
  fetched: () => number;
  create: (config?: Partial<GatewayConfig>, dependencies?: QoderDependencies) => ReturnType<typeof createGatewayHandler>;
}

async function fixture(run: (context: Fixture) => Promise<void>): Promise<void> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "qoder-gateway-"));
  const config: GatewayConfig = {
    host: "127.0.0.1", port: 8320, mountPath: "/v1", prefix: "cliproxy/", zcode: false, codebuddy: false, qoder: true,
    officialBaseUrl: "https://official.invalid/v1", upstreamBaseUrl: "https://cpa.invalid/v1",
    catalogPath: path.join(directory, "catalog.json"), logDir: path.join(directory, "logs"),
  };
  fs.writeFileSync(config.catalogPath, JSON.stringify({ models: [{ slug: "test-cpa", priority: 0 }] }));
  const handlers: ReturnType<typeof createGatewayHandler>[] = [];
  const originalFetch = globalThis.fetch;
  // 通用网关目录也必须在本地模拟，测试禁止任何真实网络请求。
  globalThis.fetch = (async (input: string | URL | Request) => {
    if (String(input).includes("/models")) return Response.json({ models: [{ slug: "gpt-native", priority: 0 }] });
    throw new Error("测试禁止未模拟的网络请求");
  }) as typeof fetch;
  const calls: QoderInferPayload[] = [];
  let fetches = 0;
  try {
    await run({ directory, config, calls, fetched: () => fetches,
      create(overrides = {}, dependencies = {}) {
        const handler = createGatewayHandler({ ...config, ...overrides }, "fake-cpa-key", "invalid",
          new Set<string>(), new Set<string>(), path.join(directory, "models-cache.json"), undefined,
          { file: path.join(directory, "gateway.log"), maxBytes: 100_000 }, undefined,
          { credentials: async () => credential(), cacheDirectory: directory, refreshCatalogOnStart: false,
            transport: {
              fetchCatalog: async () => { fetches++; return catalogData(); },
              infer: async (_credential, payload) => { calls.push(payload); return upstream(); },
            }, ...dependencies });
        handlers.push(handler);
        return handler;
      },
    });
  } finally {
    handlers.forEach((handler) => handler.close());
    globalThis.fetch = originalFetch;
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test("Qoder 当前账号动态目录同时合并到 OpenAI 与 Codex 模型列表", TIMEOUT, async () => {
  await fixture(async ({ create, fetched }) => {
    const handler = create();
    const basic = await handler(new Request("http://127.0.0.1:8320/v1/models"));
    assert.equal(basic.status, 200);
    assert.ok((await basic.json() as Json).data.some((entry: Json) => entry.id === MODEL));
    const codex = await handler(new Request("http://127.0.0.1:8320/v1/models?client_version=1.0.0"));
    const models = (await codex.json() as Json).models as Json[];
    const flash = models.find((entry) => entry.slug === MODEL);
    assert.ok(flash);
    assert.equal(flash.display_name, "Qoder-INTL/Qwen3.8-Flash (free)");
    assert.deepEqual(flash.supported_reasoning_levels.map((level: Json) => level.effort), ["low", "medium", "xhigh"]);
    assert.equal(flash.default_reasoning_level, "medium");
    assert.equal(flash.prefer_websockets, false);
    assert.equal(flash.context_window, 128_000);
    assert.ok(!models.some((entry) => /qoder-intl\/(auto|disabled-model)/.test(entry.slug)));
    assert.equal(fetched(), 1, "目录在新鲜窗口内复用");
  });
});

test("Qoder HTTP Responses 与 SSE 正文及计费字段一致", TIMEOUT, async () => {
  await fixture(async ({ create, calls }) => {
    const handler = create();
    for (const stream of [false, true]) {
      const response = await handler(request(MODEL, { stream }));
      assert.equal(response.status, 200);
      const payload = await decode(response);
      assert.equal(payload.model, MODEL);
      assert.equal(payload.status, "completed");
      assert.equal(payload.output[0].content[0].text, "测试答案");
      assert.equal(payload.usage.billable, false);
    }
    assert.equal(calls.length, 2);
    assert.equal(calls[0]!.modelKey, "qfmodel");
    assert.equal(calls[0]!.modelSource, "system");
    assert.equal(calls[0]!.modelConfig?.max_input_tokens, 128_000);
  });
});

test("Qoder 网关传递低中超高档位，并在推理前拒绝目录未声明的档位", TIMEOUT, async () => {
  await fixture(async ({ create, calls }) => {
    const handler = create();
    for (const effort of ["low", "medium", "xhigh"]) {
      const response = await handler(request(MODEL, { reasoning: { effort } }));
      assert.equal(response.status, 200);
      await response.text();
      assert.equal((calls.at(-1)!.body.parameters as Json).reasoning_effort, effort);
    }
    const response = await handler(request(MODEL, { reasoning: { effort: "high" } }));
    assert.equal(response.status, 400);
    assert.equal(calls.length, 3);
  });
});

test("Qoder 完整上下文档位传给上游参数，不改写默认输入限制", TIMEOUT, async () => {
  await fixture(async ({ create }) => {
    let sent: QoderInferPayload | undefined;
    const handler = create({}, { transport: {
      fetchCatalog: async () => ({ chat: [{ ...catalogData().chat[0], max_input_tokens: 180_000,
        context_config: { "200K": { token_count: 200_000, is_default: true }, "1M": { token_count: 1_000_000 } } }] }),
      infer: async (_credential, payload) => { sent = payload; return upstream(); },
    } });
    const response = await handler(request());
    assert.equal(response.status, 200);
    await response.text();
    assert.equal((sent!.body.parameters as Json).context_length, 1_000_000);
    assert.equal(sent!.modelConfig!.max_input_tokens, 180_000);
  });
});

test("Qoder 网关工具调用与结果回传保持 call_id", TIMEOUT, async () => {
  await fixture(async ({ create }) => {
    const calls: QoderInferPayload[] = [];
    const handler = create({}, { transport: {
      fetchCatalog: async () => catalogData(),
      infer: async (_credential, payload) => {
        calls.push(payload);
        return calls.length === 1 ? upstream({ tool_calls: [{ index: 0, id: "call_read", type: "function", function: { name: "read_file", arguments: "{\"path\":\"a\"}" } }] }, "tool_calls") : upstream({ content: "工具结果已收到" });
      },
    } });
    const tools = [{ type: "function", name: "read_file", parameters: { type: "object", properties: { path: { type: "string" } } } }];
    const initial = await decode(await handler(request(MODEL, { tools })));
    assert.equal(initial.output[0].type, "function_call");
    assert.equal(initial.output[0].call_id, "call_read");
    const resumed = await decode(await handler(request(MODEL, { tools, input: [
      { role: "user", content: "读取文件" }, ...initial.output,
      { type: "function_call_output", call_id: "call_read", output: "文件内容" },
    ] })));
    assert.equal(resumed.output[0].content[0].text, "工具结果已收到");
    const messages = calls[1]!.body.messages as Json[];
    assert.ok(messages.some((entry) => entry.role === "tool" && entry.tool_call_id === "call_read" && entry.content === "文件内容"));
  });
});

test("Qoder compact 端点与压缩触发器生成可重放摘要", TIMEOUT, async () => {
  await fixture(async ({ create, calls }) => {
    const handler = create();
    const compact = await handler(request(MODEL, { input: [{ role: "user", content: "旧上下文" }] }, "/v1/responses/compact"));
    assert.equal(compact.status, 200);
    const compactOutput = (await compact.json() as Json).output as Json[];
    assert.equal(compactOutput[0]!.content[0].text, "旧上下文");
    assert.ok(compactOutput.at(-1)!.content[0].text.includes("测试答案"));
    const trigger = await handler(request(MODEL, { stream: true, input: [{ role: "user", content: "旧上下文" }, { type: "compaction_trigger" }] }));
    assert.equal(trigger.status, 200);
    const item = (await decode(trigger)).output.find((entry: Json) => entry.type === "compaction");
    assert.ok(item?.encrypted_content);
    const replay = await handler(request(MODEL, { input: [item, { role: "user", content: "继续" }] }));
    assert.equal(replay.status, 200);
    await replay.json();
    assert.equal(calls.length, 3);
    assert.ok(JSON.stringify(calls[2]!.body).includes("测试答案"));
    assert.ok(!JSON.stringify(calls).includes("compaction_trigger"), "私有触发器不能直接送到 Qoder");
  });
});

test("Qoder 未知模型、auto 与旧前缀本地拒绝；国内版未登录时给出登录指引", TIMEOUT, async () => {
  await fixture(async ({ create, calls }) => {
    const handler = create(undefined, { cn: { credentials: async () => null } });
    for (const model of ["qoder-intl/missing", "qoder-intl/auto", "qoder-intl/disabled-model"]) {
      const response = await handler(request(model));
      assert.equal(response.status, 404, model);
    }
    // qoder-cn/ 是合法区域：登录缺失时 401，而不是像旧前缀一样 400。
    const cnResponse = await handler(request("qoder-cn/qfmodel"));
    assert.equal(cnResponse.status, 401);
    assert.match((await cnResponse.json() as Json).error.message, /国内版/);
    for (const model of ["qoder/qfmodel", "qoder-intl/", "qoder-cn/", "qoder-intl/a/b"]) {
      const response = await handler(request(model));
      assert.equal(response.status, 400, model);
    }
    assert.equal(calls.length, 0);
    const malformed = new Request("http://127.0.0.1:8320/v1/responses", { method: "POST",
      headers: { "content-type": "application/json", "x-codex-routing-hint": `model=${MODEL}` }, body: "{broken" });
    assert.equal((await handler(malformed)).status, 400);
  });
});

test("Qoder 国内版使用独立授权与端点生成 Qoder-CN 目录并完成推理", TIMEOUT, async () => {
  await fixture(async ({ create, calls }) => {
    const handler = create(undefined, {
      cn: {
        credentials: async () => ({ ...credential(), region: "cn" as const, identity: "identity-cn" }),
        transport: {
          fetchCatalog: async () => catalogData(),
          infer: async (_credential, payload) => { calls.push(payload); return upstream(); },
        },
      },
    });
    const models = await handler(new Request("http://127.0.0.1:8320/v1/models?client_version=1.0.0"));
    const entries = ((await models.json() as Json).models) as Json[];
    const cnFlash = entries.find((entry) => entry.slug === "qoder-cn/qfmodel");
    const intlFlash = entries.find((entry) => entry.slug === MODEL);
    assert.ok(cnFlash, "国内版模型进入目录");
    assert.equal(cnFlash.display_name, "Qoder-CN/Qwen3.8-Flash (free)");
    assert.ok(intlFlash, "国际版目录保持并存");
    assert.equal(cnFlash.base_instructions, QODER_AGENT_SYSTEM_PROMPT, "Codex 按 base_instructions 发送系统提示词");
    assert.equal(intlFlash.base_instructions, QODER_AGENT_SYSTEM_PROMPT);
    // 客户端优先按 model_messages.instructions_template 渲染系统提示词：模板必须一并替换。
    const messages = cnFlash.model_messages as { instructions_template?: string } | undefined;
    assert.equal(messages?.instructions_template, QODER_AGENT_SYSTEM_PROMPT, "instructions_template 必须替换，否则客户端仍发官方提示词");
    const response = await handler(request("qoder-cn/qfmodel", { stream: false }));
    assert.equal(response.status, 200);
    const payload = await response.json() as Json;
    assert.equal(payload.model, "qoder-cn/qfmodel");
    assert.equal(payload.usage.billable, false);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.modelKey, "qfmodel");
  });
});

test("Qoder 禁用与 upstreamOnly 不读授权、不拉目录、不注册定时刷新", TIMEOUT, async () => {
  await fixture(async ({ config, directory }) => {
    for (const overrides of [{ qoder: false }, { qoder: true, upstreamOnly: true }]) {
      let operations = 0;
      const current = { ...config, ...overrides };
      const adapter = createQoderAdapter(current, {
        cacheDirectory: directory,
        credentials: async () => { operations++; return credential(); },
        transport: { fetchCatalog: async () => { operations++; return catalogData(); }, infer: async () => { operations++; return upstream(); } },
        setInterval: (() => { operations++; throw new Error("禁用适配器不应启动 timer"); }) as typeof setInterval,
      });
      assert.equal(qoderEnabled(current), false);
      assert.deepEqual(await adapter.catalog(), { models: [] });
      assert.equal((await adapter.forward(request(), { model: MODEL, input: "你好" })).status, 404);
      adapter.close();
      assert.equal(operations, 0);
    }
  });
});

test("Qoder 网关禁用及纯转发模式不会混入本地目录", TIMEOUT, async () => {
  await fixture(async ({ create, fetched, calls }) => {
    for (const config of [{ qoder: false }, { upstreamOnly: true, prefix: "" }]) {
      const handler = create(config);
      const response = await handler(new Request("http://127.0.0.1:8320/v1/models"));
      assert.ok(!(await response.text()).includes("qoder-intl/"));
    }
    assert.equal(fetched(), 0);
    assert.equal(calls.length, 0);
  });
});

test("Qoder 目录启动刷新及两分钟定时刷新可更新模型并随 close 清理", TIMEOUT, async () => {
  await fixture(async ({ config, directory }) => {
    let callback: (() => void) | undefined;
    let fetches = 0;
    let cleared = 0;
    let interval = 0;
    const timer = { unref() {} } as unknown as ReturnType<typeof setInterval>;
    const adapter = createQoderAdapter(config, { cacheDirectory: directory, credentials: async () => credential(),
      setInterval: ((fn: () => void, delay: number) => { callback = fn; interval = delay; return timer; }) as typeof setInterval,
      clearInterval: ((value: unknown) => { assert.equal(value, timer); cleared++; }) as typeof clearInterval,
      transport: { fetchCatalog: async () => catalogData(++fetches === 1 ? "qfmodel" : "new-flash"), infer: async () => upstream() },
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(fetches, 1);
      assert.equal(interval, 120_000);
      assert.equal((await adapter.catalog()).models[0]!.slug, MODEL);
      callback!();
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(fetches, 2);
      assert.equal((await adapter.catalog()).models[0]!.slug, "qoder-intl/new-flash");
      adapter.close();
      adapter.close();
      assert.equal(cleared, 1);
      callback!();
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(fetches, 2);
      assert.deepEqual(await adapter.catalog(), { models: [] });
    } finally { adapter.close(); }
  });
});

test("Qoder 自有签名请求不携带入站 OAuth 或 ChatGPT 账号头", TIMEOUT, async () => {
  await fixture(async ({ create }) => {
    const observed: { url: string; headers: Headers; body: string }[] = [];
    const handler = create({}, { transport: undefined, fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      observed.push({ url: String(input), headers: new Headers(init?.headers), body: String(init?.body ?? "") });
      return String(input).includes("/model/list") ? Response.json(catalogData()) : upstream();
    }) as typeof fetch });
    assert.equal((await decode(await handler(request()))).status, "completed");
    assert.equal(observed.length, 2);
    for (const call of observed) {
      assert.equal(new URL(call.url).hostname, "api2.qoder.sh");
      assert.match(call.headers.get("authorization") ?? "", /^Bearer COSY\./);
      assert.equal(call.headers.get("chatgpt-account-id"), null);
      call.headers.forEach((value, name) => assert.ok(!value.includes(INBOUND_OAUTH), `入站 OAuth 不得透传：${name}`));
      assert.ok(!call.body.includes(INBOUND_OAUTH));
    }
    assert.equal(observed[1]!.headers.get("x-model-key"), "qfmodel");
    const decoded = JSON.parse(decodeQoderBody(observed[1]!.body)) as Json;
    assert.equal(decoded.model_config.key, "qfmodel");
    assert.ok(!JSON.stringify(decoded).includes(INBOUND_OAUTH));
  });
});

test("Qoder 未登录与过期登录返回 401 并阻止推理", TIMEOUT, async () => {
  await fixture(async ({ create, calls }) => {
    for (const credentials of [async () => null, async () => { throw new QoderCredentialError("Qoder 登录已过期；请运行 qoder login"); }]) {
      const response = await create({}, { credentials })(request());
      assert.equal(response.status, 401);
      const payload = await response.json() as Json;
      assert.equal(payload.error.type, "authentication_error");
      assert.match(payload.error.message, /qoder login/);
    }
    assert.equal(calls.length, 0);
  });
});

test("Qoder 目录拉取时账号变化禁止用旧账号授权推理", TIMEOUT, async () => {
  await fixture(async ({ create }) => {
    let current = credential();
    let inference = 0;
    const handler = create({}, { credentials: async () => current, transport: {
      fetchCatalog: async () => {
        current = { ...credential(), accountUid: "different-account", identity: "different-identity" };
        return catalogData();
      },
      infer: async () => { inference++; return upstream(); },
    } });
    const response = await handler(request());
    assert.ok(response.status === 409 || response.status === 502, "目录和授权身份不一致必须拒绝");
    assert.equal(inference, 0);
  });
});

test("Qoder 网关 close 中止正在执行的推理且重复关闭安全", TIMEOUT, async () => {
  await fixture(async ({ create }) => {
    let entered: (() => void) | undefined;
    const inferenceStarted = new Promise<void>((resolve) => { entered = resolve; });
    let aborted = false;
    const handler = create({}, { transport: {
      fetchCatalog: async () => catalogData(),
      infer: async (_credential, _payload, signal) => {
        assert.ok(signal);
        entered!();
        return await new Promise<Response>((_resolve, reject) => {
          signal.addEventListener("abort", () => { aborted = true; reject(signal.reason); }, { once: true });
        });
      },
    } });
    const pending = handler(request());
    await inferenceStarted;
    handler.close();
    handler.close();
    assert.equal((await pending).status, 499);
    assert.equal(aborted, true);
  });
});

test("Qoder 上游认证失败和错误信封不回显凭据且日志不记录模型正文", TIMEOUT, async () => {
  await fixture(async ({ create, directory }) => {
    const secret = `${TOKEN} ${SIGNING_KEY} ${INBOUND_OAUTH}`;
    for (const envelopeFailure of [false, true]) {
      const handler = create({ requestLogging: true }, { transport: undefined, fetch: (async (input: string | URL | Request) => {
        if (String(input).includes("/model/list")) return Response.json(catalogData());
        return envelopeFailure ? new Response(envelope({ message: secret }, 401), { headers: { "content-type": "text/event-stream" } })
          : new Response(secret, { status: 401 });
      }) as typeof fetch });
      const response = await handler(request(MODEL, { input: "不应记录的私密提示" }, "/v1/responses?token=private-query"));
      assert.equal(response.status, envelopeFailure ? 502 : 401);
      const body = await response.text();
      for (const token of [TOKEN, SIGNING_KEY, INBOUND_OAUTH]) assert.ok(!body.includes(token));
    }
    const logs = fs.existsSync(path.join(directory, "logs")) ? fs.readdirSync(path.join(directory, "logs")) : [];
    assert.ok(logs.length > 0, "Qoder 请求须写入专属安全摘要日志");
    for (const name of logs) {
      assert.match(name, /^qoder-v1-responses-http-\d{14}\.log$/);
      const content = fs.readFileSync(path.join(directory, "logs", name), "utf8");
      assert.ok(content.includes(MODEL));
      for (const secret of [TOKEN, SIGNING_KEY, INBOUND_OAUTH, "不应记录的私密提示", "private-query", "private-account"]) {
        assert.ok(!content.includes(secret), "Qoder 请求日志不能记录提示词、认证或查询参数");
      }
    }
    const processLog = fs.readFileSync(path.join(directory, "gateway.log"), "utf8");
    assert.match(processLog, /POST \/v1\/responses -> (401|502)/);
    for (const secret of [TOKEN, SIGNING_KEY, INBOUND_OAUTH, "不应记录的私密提示", "private-query"]) assert.ok(!processLog.includes(secret));
  });
});

test("Qoder 成功请求日志使用专属文件名且清理上游不会将成功抢先记录为 499", TIMEOUT, async () => {
  await fixture(async ({ create, directory }) => {
    const handler = create({ requestLogging: true });
    const response = await handler(request(MODEL, { stream: true, input: "私有请求内容" }));
    assert.equal((await decode(response)).status, "completed");
    const processLog = fs.readFileSync(path.join(directory, "gateway.log"), "utf8");
    assert.equal(processLog.split("\n").filter((line) => line.includes("POST /v1/responses ->")).length, 1);
    assert.match(processLog, /POST \/v1\/responses -> 200/);
    assert.ok(!processLog.includes("-> 499"));
    const files = fs.readdirSync(path.join(directory, "logs"));
    assert.equal(files.length, 1);
    assert.match(files[0]!, /^qoder-v1-responses-http-\d{14}\.log$/);
    const content = fs.readFileSync(path.join(directory, "logs", files[0]!), "utf8");
    assert.match(content, /response status: 200/);
    assert.match(content, /"billable":false/);
    for (const secret of ["私有请求内容", "测试答案", TOKEN, SIGNING_KEY, INBOUND_OAUTH, "private-account"]) {
      assert.ok(!content.includes(secret));
    }
  });
});

test("Qoder 持续字节和心跳重置无数据超时，输出总时长可超过空闲阈值", TIMEOUT, async () => {
  await fixture(async ({ create }) => {
    const idleTimeoutMs = 120;
    const encoder = new TextEncoder();
    const handler = create({}, { idleTimeoutMs, transport: {
      fetchCatalog: async () => catalogData(),
      infer: async () => {
        let index = 0;
        const pieces = [
          ": keep-alive\n\n", ": keep-alive\n\n",
          "event: heartbeat\ndata: {}\n\n", "event: heartbeat\ndata: {}\n\n",
          envelope({ choices: [{ index: 0, delta: { content: "持续输出" }, finish_reason: "stop" }] }),
          "event: finish\ndata: {}\n\n",
        ];
        return new Response(new ReadableStream<Uint8Array>({
          async pull(controller) {
            await new Promise((resolve) => setTimeout(resolve, 40));
            controller.enqueue(encoder.encode(pieces[index++]!));
            if (index === pieces.length) controller.close();
          },
        }), { headers: { "content-type": "text/event-stream" } });
      },
    } });
    const started = Date.now();
    const response = await handler(request(MODEL, { stream: true }));
    const payload = await decode(response);
    assert.ok(Date.now() - started > idleTimeoutMs);
    assert.equal(payload.status, "completed");
    assert.equal(payload.output[0].content[0].text, "持续输出");
  });
});

test("Qoder 等待上游响应头期间无数据超时返回 504 并中止推理", TIMEOUT, async () => {
  await fixture(async ({ create, directory }) => {
    let aborted = false;
    const handler = create({ requestLogging: true }, { idleTimeoutMs: 40, transport: {
      fetchCatalog: async () => catalogData(),
      infer: async (_credential, _payload, signal) => {
        assert.ok(signal);
        return await new Promise<Response>((_resolve, reject) => {
          signal.addEventListener("abort", () => { aborted = true; reject(signal.reason); }, { once: true });
        });
      },
    } });
    const response = await handler(request());
    assert.equal(response.status, 504);
    assert.match((await response.json() as Json).error.message, /连续无数据超时/);
    assert.equal(aborted, true);
    const processLog = fs.readFileSync(path.join(directory, "gateway.log"), "utf8");
    assert.match(processLog, /POST \/v1\/responses -> 504/);
    assert.ok(!processLog.includes("-> 499"));
  });
});

test("Qoder 流式响应停顿产生超时失败事件并在专属日志中记录 504", TIMEOUT, async () => {
  await fixture(async ({ create, directory }) => {
    const encoder = new TextEncoder();
    const handler = create({ requestLogging: true }, { idleTimeoutMs: 40, transport: {
      fetchCatalog: async () => catalogData(),
      infer: async () => new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(envelope({ choices: [{ index: 0, delta: { content: "部分输出" }, finish_reason: null }] })));
        },
      }), { headers: { "content-type": "text/event-stream" } }),
    } });
    const response = await handler(request(MODEL, { stream: true }));
    assert.equal(response.status, 200, "流式头已发送后用终态事件报告失败");
    const body = await response.text();
    assert.match(body, /event: response.failed/);
    assert.match(body, /"code":"qoder_upstream_timeout"/);
    assert.ok(!body.includes("event: response.completed"));
    const files = fs.readdirSync(path.join(directory, "logs"));
    assert.equal(files.length, 1);
    assert.match(files[0]!, /^qoder-v1-responses-http-\d{14}\.log$/);
    const content = fs.readFileSync(path.join(directory, "logs", files[0]!), "utf8");
    assert.match(content, /response status: 504/);
    assert.match(content, /"timedOut":true/);
    assert.match(content, /"status":"failed"/);
    assert.ok(!content.includes("部分输出"));
    const processLog = fs.readFileSync(path.join(directory, "gateway.log"), "utf8");
    assert.match(processLog, /POST \/v1\/responses -> 504/);
  });
});

test("Qoder 路由提示的畸形 JSON 不进入通用正文日志", TIMEOUT, async () => {
  await fixture(async ({ create, directory, calls }) => {
    const sentinel = "qoder-private-malformed-body-sentinel";
    const handler = create({ requestLogging: true });
    for (const pathname of ["/v1/responses", "/v1/responses/compact"]) {
      const response = await handler(new Request(`http://127.0.0.1:8320${pathname}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-codex-routing-hint": `model=${MODEL}`, authorization: `Bearer ${INBOUND_OAUTH}` },
        body: `{"input":"${sentinel}",`,
      }));
      assert.equal(response.status, 400);
      await response.text();
    }
    // 通用日志通过微任务写入，等待其结束再核验全部磁盘输出。
    await new Promise((resolve) => setTimeout(resolve, 0));
    const logsDirectory = path.join(directory, "logs");
    const files = fs.existsSync(logsDirectory) ? fs.readdirSync(logsDirectory) : [];
    assert.deepEqual(files, [], "带 Qoder 路由提示的解码错误也只能走安全摘要");
    for (const file of files) assert.ok(!fs.readFileSync(path.join(logsDirectory, file), "utf8").includes(sentinel));
    const processLog = path.join(directory, "gateway.log");
    if (fs.existsSync(processLog)) {
      const content = fs.readFileSync(processLog, "utf8");
      assert.ok(!content.includes(sentinel));
      assert.ok(!content.includes(INBOUND_OAUTH));
    }
    assert.equal(calls.length, 0);
  });
});

test("Qoder WebSocket 握手与所有地域帧均拒绝进入上游桥", TIMEOUT, async () => {
  await fixture(async ({ create, config, calls }) => {
    const handler = create();
    for (const model of [MODEL, "qoder-cn/qfmodel", "qoder/qfmodel"]) {
      const upgrade = new Request("http://127.0.0.1:8320/v1/responses", { headers: { upgrade: "websocket", "x-codex-routing-hint": `model=${model}` } });
      assert.equal(isQoderResponsesWebSocket(upgrade, config), true);
      const response = await handler(upgrade);
      assert.equal(response.status, 426);
      assert.equal(response.headers.get("x-codex-cliproxy-gateway"), "qoder-http-only");
      for (const route of ["official", "cliproxy"] as const) {
        for (const prefix of ["cliproxy/", ""]) assert.deepEqual(checkFrameRouting(JSON.stringify({ type: "response.create", model }), route, prefix), { kind: "reject", model, family: "qoder" });
      }
    }
    assert.equal(calls.length, 0);
  });
});

test("Qoder 启用时仅允许环回监听并保留各地域模型前缀", TIMEOUT, async () => {
  await fixture(async ({ config }) => {
    for (const host of ["localhost", "::1", "[::1]", "127.0.0.2"]) validateQoderConfig({ ...config, host });
    assert.throws(() => validateQoderConfig({ ...config, host: "0.0.0.0" }), /环回/);
    for (const prefix of ["qoder/", "qoder-intl/", "qoder-cn/"]) assert.throws(() => validateQoderConfig({ ...config, prefix }), /前缀保留/);
    validateQoderConfig({ ...config, host: "0.0.0.0", upstreamOnly: true });
  });
});

test("Qoder WebSocket 降级协商日志使用 Qoder 命名空间", TIMEOUT, async () => {
  await fixture(async ({ create, directory }) => {
    const handler = create({ requestLogging: true });
    const response = await handler(new Request("http://127.0.0.1:8320/v1/responses", {
      headers: { upgrade: "websocket", "x-codex-routing-hint": `model=${MODEL}` },
    }));
    assert.equal(response.status, 426);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const names = fs.readdirSync(path.join(directory, "logs"));
    assert.ok(names.some((name) => /^qoder-v1-responses-http-\d{14}\.log$/.test(name)));
    assert.ok(!names.some((name) => name.startsWith("cliproxy-")));
  });
});
