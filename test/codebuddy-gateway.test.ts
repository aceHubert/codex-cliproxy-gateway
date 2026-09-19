import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createGatewayHandler, isCodebuddyResponsesWebSocket } from "../src/gateway.ts";
import { codebuddyEnabled, createCodebuddyAdapter, validateCodebuddyConfig } from "../src/codebuddy/index.ts";
import { CodebuddyCredentialError } from "../src/codebuddy/credentials.ts";
import type { CodebuddyCredential } from "../src/codebuddy/credentials.ts";
import type { GatewayConfig } from "../src/types.ts";

type Json = Record<string, any>;

const ACCESS_TOKEN = "header.eyJpc3MiOiJodHRwczovL3d3dy5jb2RlYnVkZHkuYWkvYXV0aC9yZWFsbXMvY29waWxvdCJ9.sig";
const REFRESH_TOKEN = "header.eyJyZWZyZXNoIjp0cnVlfQ.sig2";
const INBOUND_OAUTH = "fake-chatgpt-oauth-for-test";

function credential(profile: CodebuddyCredential["profile"] = "intl-cli"): CodebuddyCredential {
  const endpoints: Record<CodebuddyCredential["profile"], string> = {
    "cn-cli": "https://copilot.tencent.com",
    "cn-work": "https://www.workbuddy.cn",
    "intl-cli": "https://www.codebuddy.ai",
    "intl-work": "https://www.workbuddy.ai",
  };
  return {
    profile,
    endpoint: endpoints[profile],
    accessToken: ACCESS_TOKEN,
    refreshToken: REFRESH_TOKEN,
    domain: "www.codebuddy.ai",
    accountUid: "uid-1",
    enterpriseId: "",
    expiresAt: Date.now() + 3_600_000,
  };
}

function chatUpstream(text = "测试答案"): Response {
  const frames: Json[] = [
    { id: "chatcmpl-fx", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] },
    { id: "chatcmpl-fx", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } },
  ];
  return new Response(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n", {
    headers: { "content-type": "text/event-stream" },
  });
}

function configData(): Json {
  const model = (id: string, name: string): Json => ({ id, name, supportsToolCall: true, supportsImages: true, credits: "x1 credits" });
  return {
    code: 0,
    msg: "OK",
    data: {
      models: [model("gpt-5.6-luna", "GPT-5.6-Luna"), model("default-model", "Auto")],
      agents: [{ name: "cli", models: ["default-model", "gpt-5.6-luna"] }],
    },
  };
}

function request(model: string, extra: Json = {}, pathname = "/v1/responses", headers: Record<string, string> = {}): Request {
  return new Request(`http://127.0.0.1:8320${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${INBOUND_OAUTH}`, "chatgpt-account-id": "private-account", ...headers },
    body: JSON.stringify({ model, input: "你好", ...extra }),
  });
}

async function decoded(response: Response): Promise<Json> {
  if (!response.headers.get("content-type")?.includes("text/event-stream")) return await response.json() as Json;
  const events = (await response.text()).split("\n\n").flatMap((chunk) => {
    const raw = chunk.split("\n").find((line) => line.startsWith("data: "))?.slice(6);
    return raw && raw !== "[DONE]" ? [JSON.parse(raw)] : [];
  });
  const final = events.findLast((item: Json) => item.type === "response.completed");
  assert.ok(final, "SSE 必须结束于完成事件");
  return final.response;
}

interface ChatCall {
  url: string;
  headers: Headers;
  body: Json;
}

interface FixtureOptions {
  config?: Partial<GatewayConfig>;
  profile?: CodebuddyCredential["profile"];
  chatResponse?: () => Response;
  catalogResponse?: () => Response;
}

interface FixtureContext {
  config: GatewayConfig;
  directory: string;
  chats: ChatCall[];
  catalogFetches: Headers[];
  create: (options?: FixtureOptions) => ReturnType<typeof createGatewayHandler>;
  primeCatalog: (handler: ReturnType<typeof createGatewayHandler>) => Promise<void>;
}

async function fixture(run: (context: FixtureContext) => Promise<void>): Promise<void> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cb-gateway-"));
  const config: GatewayConfig = {
    host: "127.0.0.1", port: 8320, mountPath: "/v1", prefix: "cliproxy/", zcode: false, codebuddy: true, upstreamOnly: false,
    officialBaseUrl: "https://official.invalid/v1", upstreamBaseUrl: "https://cpa.invalid/v1",
    catalogPath: path.join(directory, "catalog.json"), logDir: path.join(directory, "logs"),
  };
  fs.writeFileSync(config.catalogPath, JSON.stringify({ models: [{ slug: "test-cpa", priority: 0 }] }));
  const handlers: ReturnType<typeof createGatewayHandler>[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    if (String(input).includes("/models")) return Response.json({ models: [{ slug: "gpt-native", priority: 0 }] });
    throw new Error("测试禁止未模拟的网络请求");
  }) as unknown as typeof fetch;
  const chats: ChatCall[] = [];
  const catalogFetches: Headers[] = [];
  const primeCatalog = async (handler: ReturnType<typeof createGatewayHandler>): Promise<void> => {
    const models = await handler(new Request("http://127.0.0.1:8320/v1/models"));
    const catalog = await models.json() as Json;
    // 无 client_version 的请求返回 OpenAI list 形状。
    assert.ok(catalog.data.some((model: Json) => model.id === "codebuddy/gpt-5.6-luna"), "/v1/models 必须合并 codebuddy 目录");
  };
  try {
    await run({
      config, directory, chats, catalogFetches,
      create(options: FixtureOptions = {}) {
        const handler = createGatewayHandler(
          { ...config, ...options.config },
          "fake-cpa-key",
          "invalid",
          new Set<string>(), new Set<string>(),
          path.join(directory, "models-cache.json"),
          undefined,
          undefined,
          {
            credentialCache: {
              // 按前缀产品返回对应接口的凭据；活动地域跟随 options.profile。
              forProduct: async (product) => {
                const region = (options.profile ?? "intl-cli").startsWith("cn-") ? "cn" : "intl";
                return credential(`${region}-${product}` as CodebuddyCredential["profile"]);
              },
              close: () => {},
            },
            cacheDirectory: directory,
            fetch: async (url, init) => {
              if (url.endsWith("/v3/config")) {
                catalogFetches.push(new Headers(init.headers));
                return options.catalogResponse?.() ?? Response.json(configData());
              }
              if (url.endsWith("/v2/chat/completions")) {
                chats.push({ url, headers: new Headers(init.headers), body: JSON.parse(String(init.body)) });
                return options.chatResponse?.() ?? chatUpstream();
              }
              throw new Error(`测试未模拟的上游请求: ${url}`);
            },
          },
        );
        handlers.push(handler);
        return handler;
      },
      primeCatalog,
    });
  } finally {
    globalThis.fetch = originalFetch;
    handlers.forEach((handler) => handler.close());
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test("codebuddy/ 前缀在 /v1/responses 被拦截并转发官方 chat/completions", async () => {
  await fixture(async ({ create, primeCatalog }) => {
    const handler = create({});
    await primeCatalog(handler);
    for (const stream of [false, true]) {
      const response = await handler(request("codebuddy/gpt-5.6-luna", { stream }));
      assert.equal(response.status, 200);
      const result = await decoded(response);
      assert.equal(result.status, "completed");
      assert.equal(result.model, "codebuddy/gpt-5.6-luna");
      assert.equal(result.output[0].type, "message");
      assert.equal(result.output[0].content[0].text, "测试答案");
      assert.deepEqual(result.usage, { input_tokens: 3, output_tokens: 2, total_tokens: 5 });
    }
  });
});

test("DeepSeek 两腿工具调用完整回放 reasoning_content", async () => {
  await fixture(async ({ create, chats }) => {
    let leg = 0;
    const handler = create({
      chatResponse: () => {
        leg++;
        if (leg > 1) return chatUpstream("完成");
        const frames: Json[] = [
          { id: "chatcmpl-ds", choices: [{ index: 0, delta: { reasoning_content: "先读取文件。" }, finish_reason: null }] },
          { id: "chatcmpl-ds", choices: [{ index: 0, delta: { content: "我来读取。" }, finish_reason: null }] },
          { id: "chatcmpl-ds", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_a", type: "function", function: { name: "read_file", arguments: "{\"path\":\"a.txt\"}" } }] }, finish_reason: null }] },
          { id: "chatcmpl-ds", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
        ];
        return new Response(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n", {
          headers: { "content-type": "text/event-stream" },
        });
      },
    });
    const tools = [{ type: "function", name: "read_file", parameters: { type: "object" } }];
    const first = await handler(request("codebuddy/deepseek-v4.1-flash", { input: "读取文件", tools, stream: false }));
    assert.equal(first.status, 200);
    const firstPayload = await first.json() as Json;
    const call = firstPayload.output.find((item: Json) => item.type === "function_call");
    assert.ok(call, "第一腿必须返回工具调用");

    const secondInput = [
      ...firstPayload.output,
      { type: "function_call_output", call_id: call.call_id, output: "文件内容" },
      { type: "message", role: "user", content: "继续" },
    ];
    const second = await handler(request("codebuddy/deepseek-v4.1-flash", { input: secondInput, tools, stream: false }));
    assert.equal(second.status, 200);
    assert.equal(chats.length, 2);
    const replayed = (chats[1]!.body.messages as Json[]).find((message) => Array.isArray(message.tool_calls));
    assert.ok(replayed, "第二腿必须回放第一腿的 assistant 工具消息");
    assert.equal(replayed.reasoning_content, "先读取文件。");
    assert.deepEqual(replayed.content, [{ type: "text", text: "我来读取。" }]);
    assert.equal(replayed.tool_calls[0].id, "call_a");
  });
});

test("转发内容：上游 URL、model 前缀剥离与身份头；入站 OAuth 不透传", async () => {
  await fixture(async ({ create, primeCatalog, chats }) => {
    const handler = create({});
    await primeCatalog(handler);
    const response = await handler(request("codebuddy/gpt-5.6-luna", { stream: true }, "/v1/responses", { "thread-id": "thread-1" }));
    await decoded(response);
    assert.equal(chats.length, 1);
    const chat = chats[0]!;
    assert.equal(chat.url, "https://www.codebuddy.ai/v2/chat/completions");
    assert.equal(chat.body.model, "gpt-5.6-luna", "上游 model 必须剥离前缀、无档位展开");
    assert.equal(chat.body.stream, true);
    assert.equal(chat.headers.get("authorization"), `Bearer ${ACCESS_TOKEN}`);
    assert.equal(chat.headers.get("x-user-id"), "uid-1");
    assert.equal(chat.headers.get("x-domain"), "www.codebuddy.ai");
    assert.equal(chat.headers.get("x-product"), "SaaS");
    assert.equal(chat.headers.get("x-conversation-id"), chat.headers.get("x-conversation-id"));
    assert.ok(chat.headers.get("user-agent")?.startsWith("CLI/"));
    assert.equal(chat.headers.get("x-client-platform"), null, "chat 请求不得携带目录专属的平台头");
    assert.equal(chat.headers.get("chatgpt-account-id"), null);
    chat.headers.forEach((value, name) => assert.ok(!value.includes(INBOUND_OAUTH), `入站 OAuth 不得透传：${name}`));
  });
});

test("workbuddy/ 前缀路由到 WorkBuddy 端点", async () => {
  await fixture(async ({ create, chats }) => {
    const handler = create({ profile: "intl-work" });
    const models = await handler(new Request("http://127.0.0.1:8320/v1/models"));
    const catalog = await models.json() as Json;
    // 两族同裸 ID 时展示层只保留 cli 条目（去重规则），work 族重名条目不重复展示。
    assert.ok(catalog.data.some((model: Json) => model.id === "codebuddy/gpt-5.6-luna"), "同裸 ID 保留 cli 族条目");
    assert.ok(!catalog.data.some((model: Json) => model.id === "workbuddy/gpt-5.6-luna"), "work 族重名条目被去重");
    assert.ok(!catalog.data.some((model: Json) => model.id === "workbuddy/default-model"), "档位模型被目录过滤");
    // 去重只影响展示：workbuddy/ 前缀仍按产品路由到 WorkBuddy 端点。
    const response = await handler(request("workbuddy/gpt-5.6-luna", { stream: false }));
    assert.equal(response.status, 200);
    assert.equal((await response.json() as Json).model, "workbuddy/gpt-5.6-luna");
    assert.equal(chats[0]!.url, "https://www.workbuddy.ai/v2/chat/completions");
    assert.ok(chats[0]!.headers.get("user-agent")?.startsWith("WorkBuddy/"));
  });
});

test("目录请求头：cli 接口加 x-client-platform，work 接口严禁携带", async () => {
  await fixture(async ({ create, catalogFetches }) => {
    const handler = create({ profile: "intl-cli" });
    await handler(new Request("http://127.0.0.1:8320/v1/models"));
    // 同地域回退让 cli 登录也供 work 接口拉目录：两个产品接口各拉一次。
    assert.equal(catalogFetches.length, 2);
    const platforms = catalogFetches.map((headers) => headers.get("x-client-platform"));
    assert.equal(platforms.filter((value) => value === "cli").length, 1, "cli 目录请求必须带平台头");
    assert.equal(platforms.filter((value) => value === null).length, 1, "work 目录请求不得带 cli 平台头");
  });
});

test("错误码：未知模型 404、凭据失败 503、非法正文 400", async () => {
  await fixture(async ({ create, primeCatalog }) => {
    const handler = create({});
    await primeCatalog(handler);
    const missing = await handler(request("codebuddy/not-in-catalog", { stream: false }));
    assert.equal(missing.status, 404);
    assert.match(JSON.stringify(await missing.json()), /可服务目录/);

    const invalid = new Request("http://127.0.0.1:8320/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json", "x-codex-routing-hint": "model=codebuddy/gpt-5.6-luna" },
      body: "{broken json",
    });
    assert.equal((await handler(invalid)).status, 400);

    const broken = create({
      catalogResponse: () => new Response("denied", { status: 403 }),
      config: {},
    });
    // 目录拉取失败 + 无缓存 → 目录为空，knownModels 为空集合时透传（不再 404）。
    const fallback = await broken(request("codebuddy/anything", { stream: false }));
    assert.equal(fallback.status, 200, "空目录时透传由上游判定");
  });
});

test("凭据错误返回 503 configuration_error，带重新登录指引", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cb-gw-cred-"));
  try {
    const handler = createGatewayHandler(
      {
        host: "127.0.0.1", port: 8320, mountPath: "/v1", prefix: "cliproxy/", zcode: false, codebuddy: true, upstreamOnly: false,
        officialBaseUrl: "https://official.invalid/v1", upstreamBaseUrl: "https://cpa.invalid/v1",
        catalogPath: path.join(directory, "catalog.json"), logDir: path.join(directory, "logs"),
      },
      "fake-cpa-key", "invalid", new Set<string>(), new Set<string>(),
      path.join(directory, "models-cache.json"), undefined, undefined,
      {
        credentialCache: {
          forProduct: async () => { throw new CodebuddyCredentialError("CodeBuddy 凭据已过期；请在桌面端重新登录"); },
          close: () => {},
        },
        cacheDirectory: directory,
        fetch: async () => { throw new Error("不得发起上游请求"); },
      },
    );
    const response = await handler(request("codebuddy/gpt-5.6-luna", { stream: false }));
    assert.equal(response.status, 503);
    const payload = await response.json() as Json;
    assert.match(payload.error.message, /重新登录/);
    assert.equal(payload.error.type, "configuration_error");
    handler.close();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("上游错误正文回显 token 时被彻底遮蔽（含转义形式）", async () => {
  await fixture(async ({ create, primeCatalog }) => {
    const echo = JSON.stringify({
      error: { message: `auth failed for ${ACCESS_TOKEN} and \\u0022${ACCESS_TOKEN}\\u0022 and ${JSON.stringify(ACCESS_TOKEN)} refresh=${REFRESH_TOKEN}` },
    });
    const handler = create({ chatResponse: () => new Response(echo, { status: 401, headers: { "content-type": "application/json" } }) });
    await primeCatalog(handler);
    const response = await handler(request("codebuddy/gpt-5.6-luna", { stream: false }));
    assert.equal(response.status, 401);
    const body = await response.text();
    assert.ok(!body.includes(ACCESS_TOKEN), "accessToken 明文不得回显");
    assert.ok(!body.includes(JSON.stringify(ACCESS_TOKEN).slice(1, -1)), "JSON 转义形式不得回显");
    assert.ok(!body.includes(REFRESH_TOKEN), "refreshToken 不得回显");
    assert.match(body, /重新登录/);
  });
});

test("请求日志不落 token 明文", async () => {
  await fixture(async ({ create, directory }) => {
    const handler = create({ config: { requestLogging: true } });
    await handler(new Request("http://127.0.0.1:8320/v1/models"));
    const response = await handler(request("codebuddy/gpt-5.6-luna", { stream: false }));
    await response.json();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const files = fs.existsSync(path.join(directory, "logs")) ? fs.readdirSync(path.join(directory, "logs")) : [];
    const codebuddyLogs = files.filter((name) => name.startsWith("codebuddy-"));
    assert.ok(codebuddyLogs.length >= 1, "codebuddy 请求日志已写入");
    for (const name of codebuddyLogs) {
      const text = fs.readFileSync(path.join(directory, "logs", name), "utf8");
      assert.ok(!text.includes(ACCESS_TOKEN), `accessToken 不得出现在请求日志 ${name}`);
      assert.ok(!text.includes(REFRESH_TOKEN), `refreshToken 不得出现在请求日志 ${name}`);
      assert.ok(!text.includes(INBOUND_OAUTH), "入站 OAuth 不得出现在请求日志");
    }
  });
});

test("upstream-only 模式下 CodeBuddy 整体禁用：不拦截、不拉目录", async () => {
  await fixture(async ({ create }) => {
    let fetched = 0;
    const handler = create({
      config: { upstreamOnly: true, prefix: "" },
      chatResponse: () => chatUpstream(),
      catalogResponse: () => { fetched++; return Response.json(configData()); },
    });
    const models = await handler(new Request("http://127.0.0.1:8320/v1/models"));
    const catalog = await models.json() as Json;
    assert.ok(!JSON.stringify(catalog).includes("codebuddy/"), "upstream-only 不合并 codebuddy 目录");
    // 请求也不拦截：走纯转发路径（cpa.invalid 不可达）。
    const response = await handler(request("codebuddy/gpt-5.6-luna", { stream: false }));
    assert.equal(response.status, 502, "未拦截的请求走纯转发路径");
    assert.equal(fetched, 0, "未启用时绝不发起目录请求");
  });
});

test("WebSocket 升级按 codebuddy 前缀本地拒绝，不桥接上游", async () => {
  await fixture(async ({ create, config }) => {
    const handler = create({});
    const wsRequest = new Request("http://127.0.0.1:8320/v1/responses", {
      method: "GET",
      headers: { upgrade: "websocket", "x-codex-routing-hint": "model=codebuddy/gpt-5.6-luna" },
    });
    assert.ok(isCodebuddyResponsesWebSocket(wsRequest, config));
    const response = await handler(wsRequest);
    assert.equal(response.status, 426);
    assert.equal(response.headers.get("x-codex-cliproxy-gateway"), "codebuddy-http-only");
  });
});

test("compaction 触发时走压缩请求路径并返回摘要", async () => {
  await fixture(async ({ create, primeCatalog }) => {
    const handler = create({ chatResponse: () => chatUpstream("这是压缩摘要") });
    await primeCatalog(handler);
    const response = await handler(request("codebuddy/gpt-5.6-luna", {
      input: [{ type: "compaction_trigger" }, { type: "message", role: "user", content: "旧上下文" }],
      stream: false,
    }));
    assert.equal(response.status, 200);
    const result = await response.json() as Json;
    assert.equal(result.status, "completed");
    const item = result.output.find((entry: Json) => entry.type === "compaction");
    assert.ok(item, "compaction 触发时返回合成压缩条目");
    assert.ok(typeof item.encrypted_content === "string" && item.encrypted_content.length > 0);
  });
});

test("validateCodebuddyConfig：环回与保留前缀约束", () => {
  const base: GatewayConfig = {
    host: "127.0.0.1", port: 8320, mountPath: "/v1", prefix: "cliproxy/",
    officialBaseUrl: "https://official.invalid/v1", upstreamBaseUrl: "https://cpa.invalid/v1", catalogPath: "/tmp/catalog.json",
  };
  validateCodebuddyConfig({ ...base, codebuddy: true });
  validateCodebuddyConfig({ ...base, codebuddy: false, host: "0.0.0.0" });
  assert.throws(() => validateCodebuddyConfig({ ...base, codebuddy: true, host: "0.0.0.0" }), /环回/);
  for (const prefix of ["codebuddy/", "workbuddy/", "codebuddy", "workbuddy/gpt"]) {
    assert.throws(() => validateCodebuddyConfig({ ...base, codebuddy: true, prefix }), /前缀保留/, prefix);
  }
  assert.throws(() => validateCodebuddyConfig({ ...base, codebuddy: "on" } as unknown as GatewayConfig), /boolean/);
  // upstream-only 下不加约束。
  validateCodebuddyConfig({ ...base, codebuddy: true, host: "0.0.0.0", upstreamOnly: true });
});

test("适配器目录投影与未启用时的空目录", async () => {  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cb-adapter-"));
  try {
    const base: GatewayConfig = {
      host: "127.0.0.1", port: 8320, mountPath: "/v1", prefix: "cliproxy/",
      officialBaseUrl: "https://official.invalid/v1", upstreamBaseUrl: "https://cpa.invalid/v1", catalogPath: path.join(directory, "catalog.json"),
    };
    const enabled = createCodebuddyAdapter({ ...base, codebuddy: true }, {
      credentialCache: { forProduct: async () => credential(), close: () => {} },
      cacheDirectory: directory,
      refreshCatalogOnStart: false,
      fetch: async (url) => {
        if (url.endsWith("/v3/config")) return Response.json(configData());
        return chatUpstream("ok");
      },
    });
    const catalog = await enabled.catalog();
    assert.deepEqual(catalog.models.map((model) => model.slug).sort(), ["codebuddy/gpt-5.6-luna"]);
    enabled.close();
    const disabled = createCodebuddyAdapter({ ...base, codebuddy: false }, {});
    assert.deepEqual((await disabled.catalog()).models, []);
    disabled.close();
    assert.equal(codebuddyEnabled({ ...base, codebuddy: true, upstreamOnly: true }), false);
    assert.equal(codebuddyEnabled({ ...base, codebuddy: true }), true);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("适配器启动即刷新目录，并注册可回收的定时刷新", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cb-adapter-refresh-"));
  const scheduled: Array<() => void> = [];
  const delays: number[] = [];
  const cleared: unknown[] = [];
  let fetches = 0;
  try {
    const base: GatewayConfig = {
      host: "127.0.0.1", port: 8320, mountPath: "/v1", prefix: "cliproxy/",
      officialBaseUrl: "https://official.invalid/v1", upstreamBaseUrl: "https://cpa.invalid/v1",
      catalogPath: path.join(directory, "catalog.json"),
    };
    const adapter = createCodebuddyAdapter({ ...base, codebuddy: true }, {
      credentialCache: { forProduct: async () => credential(), close: () => {} },
      cacheDirectory: directory,
      setInterval: ((callback: () => void, delay: number) => {
        scheduled.push(callback);
        delays.push(delay);
        return { unref: () => {} } as unknown as ReturnType<typeof setInterval>;
      }) as typeof setInterval,
      clearInterval: ((timer: unknown) => { cleared.push(timer); }) as typeof clearInterval,
      fetch: async () => {
        fetches++;
        return Response.json(configData());
      },
    });
    // 启动刷新是 fire-and-forget：等待一轮微任务后应已落到磁盘缓存。
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(fetches, 1, "构造适配器时强制刷新一次");
    assert.ok(fs.existsSync(path.join(directory, "codebuddy-intl-catalog.json")));
    assert.equal(scheduled.length, 1, "注册 16 分钟定时刷新");
    assert.deepEqual(delays, [16 * 60 * 1000]);
    scheduled[0]!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(fetches, 2, "定时回调强制刷新");
    adapter.close();
    assert.equal(cleared.length, 1, "close 必须清理定时器");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("config --codebuddy 写入状态与审计；upstream-only 报告生效值", { skip: process.platform !== "darwin" }, async () => {
  const { runCli } = await import("../src/cli.ts");
  const { GATEWAY_CONFIG_SCHEMA_URL, GATEWAY_CONFIG_VERSION } = await import("../src/config.ts");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cb-cli-"));
  const oldHome = process.env.HOME;
  const oldCodexHome = process.env.CODEX_HOME;
  const oldLog = console.log;
  process.env.HOME = home;
  delete process.env.CODEX_HOME;
  const printed: string[] = [];
  console.log = (value?: unknown) => { printed.push(String(value)); };
  try {
    const runtimeHome = path.join(home, ".codex-cliproxy-gateway");
    fs.mkdirSync(runtimeHome, { recursive: true });
    const gatewayConfig = path.join(runtimeHome, "config.json");
    const stateFile = path.join(runtimeHome, "state.json");
    const config = {
      $schema: GATEWAY_CONFIG_SCHEMA_URL,
      configVersion: GATEWAY_CONFIG_VERSION,
      host: "127.0.0.1", port: 8320, mountPath: "/v1", prefix: "cliproxy/",
      officialBaseUrl: "https://official.example/codex", upstreamBaseUrl: "http://127.0.0.1:8317/v1",
      catalogPath: path.join(runtimeHome, "cliproxy-catalog.json"),
      selectedModels: [], requestLogging: false, maxRequestLogs: 0, maxGatewayLogBytes: 0,
      upstreamOnly: false, zcode: false, codebuddy: false, logDir: path.join(runtimeHome, "logs"),
    };
    fs.writeFileSync(gatewayConfig, `${JSON.stringify(config)}\n`);
    fs.writeFileSync(stateFile, `${JSON.stringify({ version: 4, config })}\n`);

    await runCli(["config", "--codebuddy", "on"]);
    assert.equal((JSON.parse(fs.readFileSync(gatewayConfig, "utf8")) as Json).codebuddy, true);
    assert.match(fs.readFileSync(path.join(runtimeHome, "gateway.log"), "utf8"), /codebuddy: false -> true/);

    printed.length = 0;
    await runCli(["config"]);
    let status = JSON.parse(printed.join("\n")) as Json;
    assert.equal(status.codebuddy, true);

    // upstream-only 下报告生效值 false，并单独报出原始配置。
    await runCli(["config", "--codebuddy", "on"]);
    const upstreamOnlyConfig = { ...JSON.parse(fs.readFileSync(gatewayConfig, "utf8")), upstreamOnly: true };
    fs.writeFileSync(gatewayConfig, JSON.stringify(upstreamOnlyConfig));
    printed.length = 0;
    await runCli(["config"]);
    status = JSON.parse(printed.join("\n")) as Json;
    assert.equal(status.codebuddy, false, "状态输出必须报告生效值");
    assert.equal(status.codebuddyConfigured, true, "原始开关与生效值不一致时单独报出");

    await assert.rejects(runCli(["config", "--codebuddy", "maybe"]), /on or off/);
  } finally {
    console.log = oldLog;
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    if (oldCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = oldCodexHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
