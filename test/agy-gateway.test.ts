import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createGatewayHandler, isAgyResponsesWebSocket } from "../src/gateway.ts";
import { agyEnabled, safeAgyUpstreamError, validateAgyConfig } from "../src/agy/index.ts";
import type { AgyDependencies } from "../src/agy/index.ts";
import type { AgyCredentials } from "../src/agy/credentials.ts";
import type { GatewayConfig } from "../src/types.ts";

type Json = Record<string, any>;
const TIMEOUT = { timeout: 60_000 };
const MODEL = "agy/gemini-3.8-flash";

function credential(expired = false): AgyCredentials {
  return {
    accessToken: "ya29.fake-agy-token",
    expiryMs: expired ? Date.now() - 60_000 : Date.now() + 3_600_000,
    identity: "identity-test",
    authMethod: "consumer",
  };
}

function catalogData(): Json {
  return { models: {
    "gemini-3.8-flash": { displayName: "Gemini 3.8 Flash", supportsThinking: true, maxTokens: 1_000_000 },
  }, deprecatedModelIds: { "gemini-3.5-flash": { newModelId: "gemini-3.8-flash" } } };
}

function tieredCatalogData(): Json {
  return { models: {
    "gemini-3.8-flash-high": { displayName: "Gemini 3.8 Flash (High)", supportsThinking: true, maxTokens: 1_000_000 },
    "gemini-3.8-flash-medium": { displayName: "Gemini 3.8 Flash (Medium)", supportsThinking: true, maxTokens: 1_000_000 },
    "gemini-3.8-flash-low": { displayName: "Gemini 3.8 Flash (Low)", supportsThinking: true, maxTokens: 1_000_000 },
  }, tieredModelIds: {
    high: "gemini-3.8-flash-high", medium: "gemini-3.8-flash-medium", low: "gemini-3.8-flash-low",
  } };
}

function upstream(text = "TIME_WAIT 是主动关闭方等待 2MSL 的状态", parts: Json[] = [{ text }]): Response {
  const frames = [
    { response: { candidates: [{ content: { role: "model", parts } }] } },
    { response: { candidates: [{ content: { role: "model", parts: [] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 42, candidatesTokenCount: 7, totalTokenCount: 49 } } },
  ];
  return new Response(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(""), {
    status: 200, headers: { "content-type": "text/event-stream" },
  });
}

interface Fixture {
  directory: string;
  config: GatewayConfig;
  create: (overrides?: Partial<GatewayConfig>, dependencies?: Partial<AgyDependencies>) => ReturnType<typeof createGatewayHandler>;
  inferBodies: Json[];
  inferCredentials: Array<AgyCredentials | null>;
}

async function fixture(run: (fixture: Fixture) => Promise<void>, upstreamResponse: () => Response = upstream): Promise<void> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agy-gateway-"));
  const config: GatewayConfig = {
    host: "127.0.0.1", port: 8327, mountPath: "/v1", prefix: "cliproxy/", zcode: false, codebuddy: false, qoder: false, agy: true,
    officialBaseUrl: "https://official.invalid/v1", upstreamBaseUrl: "https://cpa.invalid/v1",
    catalogPath: path.join(directory, "catalog.json"), logDir: path.join(directory, "logs"),
  };
  fs.writeFileSync(config.catalogPath, JSON.stringify({ models: [{ slug: "test-cpa", priority: 0 }] }));
  const handlers: Array<ReturnType<typeof createGatewayHandler>> = [];
  const originalFetch = globalThis.fetch;
  const inferBodies: Json[] = [];
  const inferCredentials: Array<AgyCredentials | null> = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    if (String(input).includes("/models")) return Response.json({ models: [{ slug: "gpt-native", priority: 0 }] });
    throw new Error("测试禁止未模拟的网络请求");
  }) as typeof fetch;
  try {
    await run({
      directory, config, inferBodies, inferCredentials,
      create(overrides = {}, dependencies = {}) {
        const defaultFetch = async (url: string, init?: RequestInit): Promise<Response> => {
          const target = String(url);
          if (target.includes(":fetchAvailableModels")) {
            const authorization = new Headers(init?.headers).get("authorization") ?? "";
            assert.equal(authorization.startsWith("Bearer "), true);
            return Response.json(catalogData());
          }
          if (target.includes(":streamGenerateContent")) {
            inferBodies.push(JSON.parse(String(init?.body)));
            assert.ok(target.includes("alt=sse"), "流式推理必须带 alt=sse");
            return upstreamResponse();
          }
          throw new Error(`未模拟的 agy 上游调用：${target}`);
        };
        const handler = createGatewayHandler({ ...config, ...overrides }, "fake-cpa-key", "invalid",
          new Set<string>(), new Set<string>(), path.join(directory, "models-cache.json"), undefined,
          { file: path.join(directory, "gateway.log"), maxBytes: 100_000 }, undefined, undefined,
          {
            cacheDirectory: directory,
            refreshCatalogOnStart: false,
            ...dependencies,
            fetch: dependencies.fetch ?? defaultFetch,
            credentials: dependencies.credentials ?? (async () => credential()),
          });
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

function request(model = MODEL, extra: Json = {}): Request {
  return new Request("http://127.0.0.1:8327/v1/responses", {
    method: "POST", headers: { "content-type": "application/json", authorization: "Bearer inbound-oauth" },
    body: JSON.stringify({ model, input: "解释 TCP TIME_WAIT 状态的成因与排查方法", ...extra }),
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

test("agy 上游错误只输出预定义分类，不回显错误正文", () => {
  const cases = [
    [401, "SECRET invalid token", "agy_authentication_error"],
    [429, "SECRET quota", "agy_rate_or_quota_limit"],
    [400, "SECRET context length exceeded", "agy_context_limit"],
    [500, "SECRET internal", "agy_upstream_error"],
  ] as const;
  for (const [status, body, code] of cases) {
    const safe = safeAgyUpstreamError(status, body);
    assert.equal(safe.code, code);
    assert.ok(!JSON.stringify(safe).includes("SECRET"));
  }
});

test("agy 配置校验：类型、环回监听与前缀保留", () => {
  const base: GatewayConfig = {
    host: "127.0.0.1", port: 8327, mountPath: "/v1", prefix: "cliproxy/",
    officialBaseUrl: "https://official.invalid/v1", upstreamBaseUrl: "https://cpa.invalid/v1", catalogPath: "/tmp/catalog.json",
  };
  assert.equal(agyEnabled({ ...base }), false);
  assert.equal(agyEnabled({ ...base, agy: true }), true);
  assert.throws(() => validateAgyConfig({ ...base, agy: 1 as unknown as boolean }), /agy 必须为 boolean/);
  assert.throws(() => validateAgyConfig({ ...base, host: "0.0.0.0", agy: true }), /环回/);
  assert.throws(() => validateAgyConfig({ ...base, prefix: "agy/", agy: true }), /前缀保留/);
  assert.throws(() => validateAgyConfig({ ...base, prefix: "ag", agy: true }), /前缀保留/);
  // upstream-only 按禁用处理，不施加额外约束。
  validateAgyConfig({ ...base, host: "0.0.0.0", agy: true, upstreamOnly: true });
});

test("agy 动态目录合并进 OpenAI 与 Codex 模型列表", TIMEOUT, async () => {
  await fixture(async ({ create }) => {
    const handler = create();
    const basic = await handler(new Request("http://127.0.0.1:8327/v1/models"));
    const data = (await basic.json() as Json).data as Json[];
    const entry = data.find((item) => item.id === MODEL);
    assert.ok(entry);
    assert.equal(entry.owned_by, "agy");
    const codex = await handler(new Request("http://127.0.0.1:8327/v1/models?client_version=1.0.0"));
    const models = (await codex.json() as Json).models as Json[];
    const flash = models.find((item) => item.slug === MODEL);
    assert.ok(flash);
    assert.equal(flash.display_name, "AGN/Gemini 3.8 Flash");
    assert.equal(flash.prefer_websockets, false);
    assert.equal(flash.context_window, 1_000_000);
  });
});

test("agy Responses 流式与非流式一致，转换走 streamGenerateContent?alt=sse", TIMEOUT, async () => {
  await fixture(async ({ create, inferBodies }) => {
    const handler = create();
    for (const stream of [false, true]) {
      const response = await handler(request(MODEL, { stream }));
      assert.equal(response.status, 200);
      const payload = await decode(response);
      assert.equal(payload.status, "completed");
      assert.equal(payload.model, MODEL);
      const message = payload.output.find((item: Json) => item.type === "message");
      assert.match(message.content[0].text, /TIME_WAIT/);
    }
    assert.equal(inferBodies.length, 2);
    assert.equal(inferBodies[0].model, "gemini-3.8-flash");
    assert.equal(inferBodies[0].project, "aicode-consumers");
    const contents = inferBodies[0].request.contents;
    assert.equal(contents[0].role, "user");
    assert.match(contents[0].parts[0].text, /TIME_WAIT/);
  });
});

test("agy 目录内已废弃模型按 deprecatedModelIds 重定向到新模型", TIMEOUT, async () => {
  await fixture(async ({ create, inferBodies }) => {
    const handler = create();
    await handler(new Request("http://127.0.0.1:8327/v1/models"));
    const response = await handler(request("agy/gemini-3.5-flash"));
    assert.equal(response.status, 200);
    assert.equal(inferBodies[0].model, "gemini-3.8-flash");
  });
});

test("agy 目录外模型返回 404，不透传上游", TIMEOUT, async () => {
  await fixture(async ({ create, inferBodies }) => {
    const handler = create();
    await handler(new Request("http://127.0.0.1:8327/v1/models"));
    const response = await handler(request("agy/not-in-catalog"));
    assert.equal(response.status, 404);
    assert.match(JSON.stringify(await response.json()), /当前账号目录/);
    assert.equal(inferBodies.length, 0);
  });
});

test("agy 过期令牌快速失败并给出刷新指引，绝不调用上游", TIMEOUT, async () => {
  await fixture(async ({ create, inferBodies }) => {
    const handler = create(undefined, { credentials: async () => credential(true) });
    await handler(new Request("http://127.0.0.1:8327/v1/models"));
    const response = await handler(request(MODEL));
    assert.equal(response.status, 401);
    const payload = await response.json() as Json;
    assert.match(payload.error.message, /有效期 1 小时/);
    assert.equal(inferBodies.length, 0);
  });
});

test("agy 未登录返回 401 且带 agy 登录指引", TIMEOUT, async () => {
  await fixture(async ({ create }) => {
    const handler = create(undefined, { credentials: async () => null });
    await handler(new Request("http://127.0.0.1:8327/v1/models"));
    const response = await handler(request(MODEL));
    assert.equal(response.status, 401);
    assert.match(JSON.stringify(await response.json()), /agy/);
  });
});

test("agy WebSocket 升级一律本地 426", TIMEOUT, async () => {
  await fixture(async ({ config, create }) => {
    const upgrade = new Request("http://127.0.0.1:8327/v1/responses", {
      headers: { upgrade: "websocket", "x-codex-routing-hint": `model=${MODEL}` },
    });
    assert.equal(isAgyResponsesWebSocket(upgrade, config), true);
    assert.equal(isAgyResponsesWebSocket(new Request("http://127.0.0.1:8327/v1/responses", { headers: { upgrade: "websocket" } }), config), false);
    // handler 层同样必须拒绝：agy 上游不是 Responses WebSocket 端点，绝不桥接。
    const response = await create()(upgrade);
    assert.equal(response.status, 426);
    assert.equal(response.headers.get("x-codex-cliproxy-gateway"), "agy-http-only");
  });
});

test("agy 合并条目按 reasoning effort 选择档位，显式档位 slug 兼容直连", TIMEOUT, async () => {
  await fixture(async ({ create, inferBodies }) => {
    const handler = create(undefined, {
      fetch: async (url, init) => {
        const target = String(url);
        if (target.includes(":fetchAvailableModels")) return Response.json(tieredCatalogData());
        if (target.includes(":streamGenerateContent")) {
          inferBodies.push(JSON.parse(String(init?.body)));
          return upstream();
        }
        throw new Error(`未模拟调用 ${target}`);
      },
    });
    const codex = await handler(new Request("http://127.0.0.1:8327/v1/models?client_version=1.0.0"));
    const models = ((await codex.json() as Json).models) as Json[];
    const agySlugs = models.filter((item) => String(item.slug).startsWith("agy/")).map((item) => item.slug);
    // 三档在目录中只暴露一个合并条目，不重复列出各档位变体。
    assert.deepEqual(agySlugs, ["agy/gemini-3.8-flash"]);
    const flashEntry = models.find((item) => item.slug === "agy/gemini-3.8-flash")!;
    assert.equal(flashEntry.display_name, "AGN/Gemini 3.8 Flash");
    // 客户端可见的档位只有实际上游变体：low/medium/high，不得暴露 xhigh/minimal。
    assert.deepEqual(
      (flashEntry.supported_reasoning_levels as Json[]).map((level) => level.effort),
      ["low", "medium", "high"],
    );
    assert.equal(flashEntry.default_reasoning_level, "medium");

    // 无 effort：解析到 medium 变体，且不带 thinkingLevel（交给服务端默认）。
    await handler(request(MODEL));
    assert.equal(inferBodies.at(-1)!.model, "gemini-3.8-flash-medium");
    assert.equal(inferBodies.at(-1)!.request.generationConfig.thinkingConfig.thinkingLevel, undefined);
    // effort high：解析到 -high 变体并带匹配 thinkingLevel。
    await handler(request(MODEL, { reasoning: { effort: "high" } }));
    assert.equal(inferBodies.at(-1)!.model, "gemini-3.8-flash-high");
    assert.equal(inferBodies.at(-1)!.request.generationConfig.thinkingConfig.thinkingLevel, "high");
    // effort minimal：解析到 -low 变体。
    await handler(request(MODEL, { reasoning: { effort: "minimal" } }));
    assert.equal(inferBodies.at(-1)!.model, "gemini-3.8-flash-low");
    // 显式档位 slug 不在目录中列出，但仍按成员 id 直连（向后兼容）。
    const explicit = await handler(request("agy/gemini-3.8-flash-high", { reasoning: { effort: "low" } }));
    assert.equal(explicit.status, 200);
    assert.equal(inferBodies.at(-1)!.model, "gemini-3.8-flash-high");
  });
});

test("agy 前缀大小写不敏感：AGY/x 归一后命中目录", TIMEOUT, async () => {
  await fixture(async ({ create, inferBodies }) => {
    const handler = create();
    await handler(new Request("http://127.0.0.1:8327/v1/models"));
    const response = await handler(request("AGY/gemini-3.8-flash"));
    assert.equal(response.status, 200);
    assert.equal(inferBodies.at(-1)!.model, "gemini-3.8-flash");
  });
});

test("agy compaction 触发时走压缩请求路径并返回摘要", TIMEOUT, async () => {
  await fixture(async ({ create }) => {
    const handler = create(undefined, {
      fetch: async (url, init) => {
        const target = String(url);
        if (target.includes(":fetchAvailableModels")) return Response.json(catalogData());
        if (target.includes(":streamGenerateContent")) {
          return upstream("旧会话要点：用户在调试 TCP 连接问题，已排除防火墙与 MTU，剩余嫌疑是 TIME_WAIT 端口耗尽。");
        }
        throw new Error(`未模拟调用 ${target}`);
      },
    });
    const response = await handler(request(MODEL, {
      input: [{ type: "compaction_trigger" }, { type: "message", role: "user", content: "压缩以上历史" }],
      stream: true,
    }));
    assert.equal(response.status, 200);
    const payload = await decode(response);
    assert.equal(payload.status, "completed");
    const item = payload.output.find((entry: Json) => entry.type === "compaction");
    assert.ok(item, "必须合成 compaction 条目");
    // 摘要按 ocx1 信封加密回传；解码验证内容确实来自上游摘要。
    assert.match(String(item.encrypted_content), /^ocx1:/);
    const decrypted = Buffer.from(String(item.encrypted_content).slice(5), "base64").toString("utf8");
    assert.match(decrypted, /TIME_WAIT/);
  });
});

test("agy 工具调用往返：Responses 工具声明映射并还原 function_call 事件", TIMEOUT, async () => {
  await fixture(async ({ create, inferBodies }) => {
    const handler = create(undefined, {
      fetch: async (url, init) => {
        const target = String(url);
        if (target.includes(":fetchAvailableModels")) return Response.json(catalogData());
        if (target.includes(":streamGenerateContent")) {
          inferBodies.push(JSON.parse(String(init?.body)));
          return upstream(undefined, [{ functionCall: { name: "shell", args: { command: "ss -tan" } } }]);
        }
        throw new Error(`未模拟调用 ${target}`);
      },
    });
    const response = await handler(request(MODEL, {
      tools: [{ type: "function", name: "shell", parameters: { type: "object", properties: { command: { type: "string" } } } }],
    }));
    const payload = await decode(response);
    const call = payload.output.find((item: Json) => item.type === "function_call");
    assert.ok(call, "必须还原 function_call 条目");
    assert.equal(call.name, "shell");
    assert.equal(call.arguments, "{\"command\":\"ss -tan\"}");
    const declarations = inferBodies.at(-1)!.request.tools[0].functionDeclarations;
    assert.equal(declarations[0].name, "shell");
  });
});
