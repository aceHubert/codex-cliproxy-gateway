import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createGatewayHandler, isZcodeResponsesWebSocket, responsesWebSocketTarget } from "../src/gateway.ts";
import { ZcodeConfigError, type ZcodeProviderSnapshot, type ZcodeFamily } from "../src/zcode/config.ts";
import { ZcodeEndpointRouting } from "../src/zcode/endpoint-routing.ts";
import type { ZcodeIdentity } from "../src/zcode/request-context.ts";
import type { GatewayConfig } from "../src/types.ts";

type Json = Record<string, any>;
type Snapshot = ZcodeProviderSnapshot & { modelIds: readonly string[] };
const FAKE_KEY = "fake-zcode-secret-for-test";
const FAKE_OAUTH = "fake-chatgpt-oauth-for-test";
function snapshot(family: ZcodeFamily = "zai"): Snapshot {
  return { family, providerID: `${family}-test`, apiKey: FAKE_KEY,
    baseURL: family === "zai" ? "https://api.z.ai/api/anthropic" : "https://open.bigmodel.cn/api/anthropic",
    modelIds: ["GLM-5.3", "glm-5.3-flash"] };
}
function upstream(text = "测试答案", tool?: string): Response {
  const frames: Json[] = [
    { type: "message_start", message: { id: "msg_fixture", usage: { input_tokens: 7, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text } },
    { type: "content_block_stop", index: 0 },
  ];
  if (tool) frames.push(
    { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "call_fixture", name: tool, input: { path: "中文.txt" } } },
    { type: "content_block_stop", index: 1 },
  );
  frames.push({ type: "message_delta", delta: { stop_reason: tool ? "tool_use" : "end_turn" }, usage: { output_tokens: 4 } }, { type: "message_stop" });
  return new Response(frames.map((item) => `event: ${item.type}\ndata: ${JSON.stringify(item)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
}
function request(model: string, extra: Json = {}, pathname = "/v1/responses", headers: Record<string, string> = {}): Request {
  return new Request(`http://127.0.0.1:8320${pathname}`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${FAKE_OAUTH}`, "chatgpt-account-id": "private-account", "x-api-key": "incoming-key", ...headers },
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
async function fixture(run: (context: {
  config: GatewayConfig; directory: string; cacheFile: string;
  create: (options?: { current?: () => Promise<Snapshot>; fetch?: (url: string, init: RequestInit) => Promise<Response>; sticky?: boolean; onClose?: () => void; codexModelsCacheFile?: string; endpointRouting?: ZcodeEndpointRouting | null }) => ReturnType<typeof createGatewayHandler>;
}) => Promise<void>): Promise<void> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-zcode-gateway-"));
  const config: GatewayConfig = {
    host: "127.0.0.1", port: 8320, mountPath: "/v1", prefix: "cliproxy/", zcode: true, upstreamOnly: false,
    officialBaseUrl: "https://official.invalid/v1", upstreamBaseUrl: "https://cpa.invalid/v1",
    catalogPath: path.join(directory, "catalog.json"), logDir: path.join(directory, "logs"),
  };
  fs.writeFileSync(config.catalogPath, JSON.stringify({ models: [{ slug: "test-cpa", priority: 0 }] }));
  const cacheFile = path.join(directory, "models-cache.json");
  const handlers: ReturnType<typeof createGatewayHandler>[] = [];
  const originalFetch = globalThis.fetch;
  // 官方 /models 刷新是目录合成的正常依赖；其余未模拟的网络请求仍然拒绝。
  globalThis.fetch = (async (input: string | URL | Request) => {
    if (String(input).includes("/models")) return Response.json({ models: [{ slug: "gpt-native", priority: 0 }] });
    throw new Error("测试禁止未模拟的网络请求");
  }) as unknown as typeof fetch;
  try {
    await run({ config, directory, cacheFile, create(options = {}) {
      const handler = createGatewayHandler(config, "fake-cpa-key", "invalid", new Set(options.sticky ? ["sticky-thread"] : []), new Set<string>(), cacheFile, {
        configCache: { get: options.current ?? (async () => snapshot()), close: options.onClose ?? (() => {}) },
        fetch: options.fetch ?? (async () => upstream()),
        ...(options.codexModelsCacheFile ? { codexModelsCacheFile: options.codexModelsCacheFile } : {}),
        // 默认禁用端点重映射：既有用例断言上游 URL 与调用次数，重映射行为由专属用例覆盖。
        endpointRouting: options.endpointRouting ?? null,
      });
      handlers.push(handler);
      return handler;
    } });
  } finally {
    globalThis.fetch = originalFetch;
    handlers.forEach((handler) => handler.close());
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

for (const family of ["zai", "bigmodel"] as const) {
  for (const mode of ["split", "CPA 粘性"] as const) {
    test(`ZCode ${family} 在 ${mode} 模式优先路由并完成文本与工具请求`, async () => {
      await fixture(async ({ create }) => {
        const selected = snapshot(family);
        const calls: { url: string; init: RequestInit; body: Json }[] = [];
        const handler = create({ current: async () => selected, sticky: mode === "CPA 粘性", fetch: async (url, init) => {
          const body = JSON.parse(String(init.body));
          calls.push({ url, init, body });
          return upstream("成功", body.tools?.[0]?.name);
        } });
        const model = "zcode/glm-5.3";
        for (const stream of [false, true]) {
          const response = await handler(request(model, { stream, tools: [{ type: "function", name: "read.file", parameters: { type: "object", properties: { path: { type: "string" } } } }] }, "/v1/responses", { "thread-id": "sticky-thread" }));
          assert.equal(response.status, 200);
          const result = await decoded(response);
          assert.equal(result.model, model);
          assert.equal(result.output[0].content[0].text, "成功");
          assert.equal(result.output[1].name, "read.file");
          assert.equal(result.output[1].call_id, "call_fixture");
          assert.deepEqual(JSON.parse(result.output[1].arguments), { path: "中文.txt" });
        }
        assert.equal(calls.length, 2);
        for (const call of calls) {
          assert.equal(call.url, `${selected.baseURL}/v1/messages`);
          assert.equal(call.body.model, "GLM-5.3");
          assert.equal(call.body.stream, true);
          const headers = new Headers(call.init.headers);
          assert.equal(headers.get("authorization"), `Bearer ${FAKE_KEY}`);
          assert.equal(headers.get("x-api-key"), FAKE_KEY);
          assert.equal(headers.get("chatgpt-account-id"), null);
          headers.forEach((value) => assert.ok(!value.includes(FAKE_OAUTH)));
          assert.equal(call.init.redirect, "manual");
        }
      });
    });
  }
}

test("端点重映射命中时上游请求改发 ultra 地址，配置拉取走独立通道", async () => {
  await fixture(async ({ create }) => {
    const identity: ZcodeIdentity = { appVersion: "3.11.2", language: "en-US", timezone: "Asia/Shanghai", platform: "darwin", arch: "arm64", osVersion: "25.6.0" };
    let configCalls = 0;
    const routing = new ZcodeEndpointRouting({ identity, fetch: async (url) => {
      configCalls++;
      assert.equal(url, "https://zcode.z.ai/api/v1/agent/configs");
      return Response.json({ code: 0, data: { proxyEndpoint: { mapping: [
        { from: "https://api.z.ai/api/anthropic/v1/messages", to: "https://zcode.z.ai/api/v1/ultra-zai/anthropic/v1/messages" },
      ] } } });
    } });
    const upstreamUrls: string[] = [];
    const handler = create({ current: async () => snapshot("zai"), endpointRouting: routing, fetch: async (url) => {
      upstreamUrls.push(url);
      return upstream();
    } });
    for (const stream of [false, true]) {
      const response = await handler(request("zcode/glm-5.3", { stream }));
      assert.equal(response.status, 200);
      assert.equal((await decoded(response)).status, "completed");
    }
    assert.equal(configCalls, 1, "TTL 内只拉取一次映射表");
    assert.deepEqual(upstreamUrls, Array(2).fill("https://zcode.z.ai/api/v1/ultra-zai/anthropic/v1/messages"));
  });
});

test("upstream-only 下 ZCode 按禁用处理：保留上游裸条目并直通第三方上游", async () => {
  const originalFetch = globalThis.fetch;
  try {
    await fixture(async ({ config, create, directory }) => {
      config.upstreamOnly = true;
      // 上游目录是裸 slug，upstream-only 直接对外暴露它们。
      fs.writeFileSync(config.catalogPath, JSON.stringify({ models: [
        { slug: "test-cpa", priority: 0 }, { slug: "z.ai/glm-5.3", priority: 1 },
      ] }));
      const passthrough: string[] = [];
      globalThis.fetch = (async (input: string | URL | Request) => {
        passthrough.push(String(input));
        return new Response("", { status: 200 });
      }) as unknown as typeof fetch;
      let reads = 0;
      let zcodeCalls = 0;
      const handler = create({
        current: async () => { reads++; return snapshot(); },
        fetch: async () => { zcodeCalls++; return upstream(); },
      });

      // 坏配置也不影响目录：上游的裸 z.ai 条目既不被剥离也不被替换成 ZCode 目录。
      const list = await (await handler(new Request("http://127.0.0.1:8320/v1/models"))).json() as Json;
      const zai = list.data.filter((item: Json) => item.id === "z.ai/glm-5.3");
      assert.equal(zai.length, 1);
      assert.equal(zai[0].owned_by, "cliproxy");
      assert.ok(list.data.some((item: Json) => item.id === "test-cpa"));

      // 请求交给 upstream-only 直通，不落到 ZCode 的 Anthropic 适配器。
      const response = await handler(request("z.ai/glm-5.3"));
      assert.equal(response.status, 200);
      assert.equal(zcodeCalls, 0);
      assert.equal(passthrough.length, 1);
      assert.match(passthrough[0]!, /^https:\/\/cpa\.invalid\/v1\/responses/);

      // 禁用意味着不建凭证缓存、也不写厂商目录文件。
      assert.equal(reads, 0);
      assert.equal(fs.existsSync(path.join(directory, "zcode-catalog.json")), false);
    });
  } finally { globalThis.fetch = originalFetch; }
});

test("upstream-only 下 ZCode 的环回监听与保留前缀约束不再生效", async () => {
  await fixture(async ({ config, create }) => {
    config.upstreamOnly = true;
    config.host = "0.0.0.0";
    config.prefix = "zcode/";
    assert.doesNotThrow(() => create());
  });
});

test("ZCode 两种 Anthropic 基址均只追加一个 v1", async () => {
  await fixture(async ({ create }) => {
    for (const suffix of ["", "/v1"]) {
      const selected = { ...snapshot(), baseURL: `https://api.z.ai/api/anthropic${suffix}` };
      let target = "";
      const handler = create({ current: async () => selected, fetch: async (url) => { target = url; return upstream(); } });
      assert.equal((await handler(request("zcode/glm-5.3"))).status, 200);
      assert.equal(target, "https://api.z.ai/api/anthropic/v1/messages");
    }
  });
});

test("ZCode 目录按套餐与厂商交集忽略大小写，套餐变化立即改变授权", async () => {
  await fixture(async ({ create }) => {
    let selected = { ...snapshot(), modelIds: ["GLM-5.3", "unknown-model"] };
    let calls = 0;
    const handler = create({ current: async () => selected, fetch: async (_url, init) => {
      calls++;
      assert.equal(JSON.parse(String(init.body)).model, selected.modelIds[0]);
      return upstream();
    } });
    const list = async () => (await (await handler(new Request("http://127.0.0.1:8320/v1/models?client_version=0.145.0"))).json() as Json).models as Json[];
    assert.deepEqual((await list()).filter((item) => item.slug.startsWith("zcode/")).map((item) => item.slug), ["zcode/glm-5.3"]);
    assert.equal((await handler(request("zcode/glm-5.3-flash"))).status, 404);
    assert.equal((await handler(request("zcode/unknown-model"))).status, 404);
    // 旧厂商前缀不再属于 ZCode 命名空间：请求不会进入 ZCode 适配器。
    assert.notEqual((await handler(request("z.ai/glm-5.3"))).status, 200);
    assert.equal(calls, 0);
    selected = { ...selected, modelIds: ["gLm-5.3-FlAsH"] };
    assert.deepEqual((await list()).filter((item) => item.slug.startsWith("zcode/")).map((item) => item.slug), ["zcode/glm-5.3-flash"]);
    assert.equal((await handler(request("zcode/glm-5.3"))).status, 404);
    assert.equal(calls, 0);
    assert.equal((await handler(request("zcode/glm-5.3-flash"))).status, 200);
    assert.equal(calls, 1);
  });
});

test("ZCode 基础模型列表统一 zcode/ 前缀并标记 owned_by zcode", async () => {
  await fixture(async ({ create }) => {
    for (const family of ["zai", "bigmodel"] as const) {
      const handler = create({ current: async () => snapshot(family) });
      const list = await (await handler(new Request("http://127.0.0.1:8320/v1/models"))).json() as Json;
      const models = list.data.filter((item: Json) => item.id.startsWith("zcode/"));
      assert.equal(models.length, 2);
      assert.ok(models.every((item: Json) => item.owned_by === "zcode"));
    }
  });
});

test("ZCode 关闭或配置失效时不注入模型，失效请求不触发上游", async () => {
  await fixture(async ({ config, create }) => {
    let reads = 0;
    let calls = 0;
    config.zcode = false;
    const disabled = create({ current: async () => { reads++; return snapshot(); } });
    const disabledModels = await (await disabled(new Request("http://127.0.0.1:8320/v1/models"))).json() as Json;
    assert.ok(disabledModels.data.every((item: Json) => !item.id.startsWith("zcode/")));
    assert.equal(reads, 0);
    config.zcode = true;
    const invalid = create({ current: async () => { throw new ZcodeConfigError("测试配置无效"); }, fetch: async () => { calls++; return upstream(); } });
    const models = await (await invalid(new Request("http://127.0.0.1:8320/v1/models"))).json() as Json;
    assert.ok(models.data.every((item: Json) => !item.id.startsWith("zcode/")));
    assert.equal((await invalid(request("zcode/glm-5.3"))).status, 503);
    assert.equal(calls, 0);
  });
});

test("ZCode 目录不污染官方 last-good 缓存且官方失败仍叠加当前套餐", async () => {
  const originalFetch = globalThis.fetch;
  try {
    let failed = false;
    await fixture(async ({ config, create, cacheFile }) => {
      globalThis.fetch = (async () => { if (failed) throw new Error("离线"); return Response.json({ models: [{ slug: "gpt-native", priority: 0 }] }); }) as unknown as typeof fetch;
      config.upstreamOnly = false;
      let selected = snapshot();
      const handler = create({ current: async () => selected });
      const list = async () => await (await handler(new Request("http://127.0.0.1:8320/v1/models?client_version=0.145.0"))).json() as Json;
      const first = await list();
      assert.ok(first.models.some((item: Json) => item.slug === "zcode/glm-5.3"));
      assert.deepEqual(JSON.parse(fs.readFileSync(cacheFile, "utf8")).models.map((item: Json) => item.slug), ["gpt-native"]);
      failed = true;
      selected = { ...selected, modelIds: ["glm-5.3-flash"] };
      const second = await list();
      assert.ok(second.models.some((item: Json) => item.slug === "gpt-native"));
      assert.ok(!second.models.some((item: Json) => item.slug === "zcode/glm-5.3"));
      assert.deepEqual(JSON.parse(fs.readFileSync(cacheFile, "utf8")).models.map((item: Json) => item.slug), ["gpt-native"]);
    });
  } finally { globalThis.fetch = originalFetch; }
});

test("ZCode 拒绝 WebSocket 并移除旧 zai 路径，均不访问上游", async () => {
  await fixture(async ({ create }) => {
    let calls = 0;
    const handler = create({ fetch: async () => { calls++; return upstream(); } });
    const response = await handler(new Request("http://127.0.0.1:8320/v1/responses", { headers: { upgrade: "websocket", "x-codex-model": "zcode/glm-5.3" } }));
    assert.equal(response.status, 426);
    for (const pathname of ["/zai", "/zai/v1/messages", "/zai/v1/messages/count_tokens"]) {
      assert.equal((await handler(request("zcode/glm-5.3", {}, pathname))).status, 404);
    }
    assert.equal(calls, 0);
  });
});

test("ZCode HTTP 错误脱敏且两渠道日志独立并隐藏所有凭据", async () => {
  await fixture(async ({ config, create }) => {
    config.requestLogging = true;
    for (const family of ["zai", "bigmodel"] as const) {
      const handler = create({ current: async () => snapshot(family), fetch: async () => Response.json({ error: { message: `denied ${FAKE_KEY}` } }, { status: 429 }) });
      const response = await handler(request("zcode/glm-5.3"));
      assert.equal(response.status, 429);
      assert.ok(!(await response.text()).includes(FAKE_KEY));
    }
    const names = fs.readdirSync(config.logDir!);
    assert.ok(names.some((name) => name.startsWith("zai-")));
    assert.ok(names.some((name) => name.startsWith("bigmodel-")));
    const logs = names.map((name) => fs.readFileSync(path.join(config.logDir!, name), "utf8")).join("\n");
    for (const value of [FAKE_KEY, FAKE_OAUTH, "incoming-key"]) assert.ok(!logs.includes(value));
    assert.ok(!names.some((name) => name.startsWith("codex-")));
  });
});

test("ZCode v1 与 trigger 压缩通过 Anthropic adapter 并生成可回放摘要", async () => {
  await fixture(async ({ create }) => {
    const calls: Json[] = [];
    const handler = create({ fetch: async (url, init) => { assert.match(url, /\/anthropic\/v1\/messages$/); calls.push(JSON.parse(String(init.body))); return upstream("压缩后的摘要"); } });
    const input = [{ type: "message", role: "user", content: [{ type: "input_text", text: "保留的问题" }] }];
    const v1 = await handler(request("zcode/glm-5.3", { input }, "/v1/responses/compact"));
    assert.equal(v1.status, 200);
    const v1Result = await v1.json() as Json;
    assert.equal(v1Result.output[0].content[0].text, "保留的问题");
    assert.match(JSON.stringify(v1Result.output), /压缩后的摘要/);
    const v2 = await handler(request("zcode/glm-5.3", { input: [...input, { type: "compaction_trigger" }], stream: true }));
    const v2Result = await decoded(v2);
    assert.equal(v2Result.output[0].type, "compaction");
    assert.equal(Buffer.from(v2Result.output[0].encrypted_content.slice(5), "base64").toString("utf8"), "压缩后的摘要");
    const replay = await handler(request("zcode/glm-5.3", { input: v2Result.output }));
    assert.equal(replay.status, 200);
    assert.match(JSON.stringify(calls.at(-1)!.messages), /压缩后的摘要/);
    assert.ok(calls.every((body) => body.stream === true && body.model === "GLM-5.3"));
  });
});

test("ZCode 消费端取消和 handler.close 均终止上游并只释放一次缓存", async () => {
  await fixture(async ({ create }) => {
    let closed = 0;
    let canceled = 0;
    const signals: AbortSignal[] = [];
    const handler = create({ onClose: () => { closed++; }, fetch: async (_url, init) => {
      signals.push(init.signal!);
      return new Response(new ReadableStream<Uint8Array>({ pull() {}, cancel() { canceled++; } }, { highWaterMark: 0 }), { headers: { "content-type": "text/event-stream" } });
    } });
    const first = await handler(request("zcode/glm-5.3", { stream: true }));
    await first.body!.cancel();
    assert.equal(signals[0]!.aborted, true);
    const second = await handler(request("zcode/glm-5.3", { stream: true }));
    const reader = second.body!.getReader();
    await reader.read();
    await reader.read();
    const pending = reader.read();
    handler.close();
    assert.equal((await pending).done, true);
    assert.equal(signals[1]!.aborted, true);
    handler.close();
    assert.equal(closed, 1);
    assert.equal(canceled, 2);
  });
});

test("ZCode 下一次请求使用更新后的当前 provider 密钥", async () => {
  await fixture(async ({ create }) => {
    let selected = snapshot();
    const keys: (string | null)[] = [];
    const handler = create({ current: async () => selected, fetch: async (_url, init) => {
      keys.push(new Headers(init.headers).get("x-api-key"));
      return upstream();
    } });
    assert.equal((await handler(request("zcode/glm-5.3"))).status, 200);
    selected = { ...selected, providerID: "replacement", apiKey: "fake-rotated-key" };
    assert.equal((await handler(request("zcode/glm-5.3"))).status, 200);
    assert.deepEqual(keys, [FAKE_KEY, "fake-rotated-key"]);
  });
});

test("ZCode 客户端 AbortSignal 可中断等待中的流读取", async () => {
  await fixture(async ({ create }) => {
    const abort = new AbortController();
    let upstreamSignal: AbortSignal | undefined;
    let canceled = 0;
    const handler = create({ fetch: async (_url, init) => {
      upstreamSignal = init.signal!;
      return new Response(new ReadableStream<Uint8Array>({ pull() {}, cancel() { canceled++; } }, { highWaterMark: 0 }));
    } });
    const incoming = request("zcode/glm-5.3", { stream: true });
    const response = await handler(new Request(incoming, { signal: abort.signal }));
    const reader = response.body!.getReader();
    await reader.read();
    await reader.read();
    const pending = reader.read();
    abort.abort();
    assert.equal((await pending).done, true);
    assert.equal(upstreamSignal!.aborted, true);
    assert.equal(canceled, 1);
  });
});

test("ZCode 启动生成共享裸 ID 缓存，套餐或渠道变化不重写磁盘目录", async () => {
  await fixture(async ({ config, directory, create }) => {
    let selected = snapshot();
    const handler = create({ current: async () => selected });
    const cache = path.join(directory, "zcode-catalog.json");
    const contents = fs.readFileSync(cache, "utf8");
    const cached = JSON.parse(contents) as Json;
    assert.ok(cached.models.length > 0);
    assert.ok(cached.models.every((item: Json) => !item.slug.includes("/") && item.slug === item.slug.toLowerCase()));
    assert.ok(!contents.includes(FAKE_KEY));
    assert.ok(!contents.includes(selected.providerID));
    // 固定旧时间戳，可识别写入相同内容的无谓重建。
    const oldTime = new Date("2000-01-01T00:00:00Z");
    fs.utimesSync(cache, oldTime, oldTime);
    const before = fs.statSync(cache).mtimeMs;
    for (const next of [
      { ...selected, modelIds: ["GLM-5.3"] },
      { ...snapshot("bigmodel"), modelIds: ["glm-5.3-flash"] },
    ]) {
      selected = next;
      const response = await handler(new Request("http://127.0.0.1:8320/v1/models"));
      assert.equal(response.status, 200);
      const data = await response.json() as Json;
      assert.equal(data.data.filter((item: Json) => item.id.startsWith("zcode/")).length, 1);
      assert.equal(fs.readFileSync(cache, "utf8"), contents);
      assert.equal(fs.statSync(cache).mtimeMs, before);
    }
    const second = create({ current: async () => selected });
    assert.equal(fs.statSync(cache).mtimeMs, before);
    assert.equal((await second(new Request("http://127.0.0.1:8320/v1/models"))).status, 200);
    assert.equal(path.dirname(config.catalogPath), path.dirname(cache));
  });
});

function assertSecretAbsent(value: unknown, secret: string): void {
  if (typeof value === "string") {
    assert.ok(!value.includes(secret), "输出包含原始密钥");
    assert.ok(!value.includes(JSON.stringify(secret).slice(1, -1)), "输出包含 JSON 转义密钥");
    // 错误对象可能被二次 JSON 序列化，解码后仍须保持脱敏。
    try { const parsed: unknown = JSON.parse(value); if (parsed !== value) assertSecretAbsent(parsed, secret); }
    catch (error) { if (error instanceof assert.AssertionError) throw error; }
  } else if (Array.isArray(value)) {
    value.forEach((item) => assertSecretAbsent(item, secret));
  } else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      assertSecretAbsent(key, secret);
      assertSecretAbsent(item, secret);
    }
  }
}

test("ZCode SSE 上游错误中的普通及含引号密钥在客户端和最终失败日志中均脱敏", async () => {
  for (const apiKey of [FAKE_KEY, 'fake-key-"quoted"-\\-suffix']) {
    await fixture(async ({ config, create }) => {
      config.requestLogging = true;
      const handler = create({ current: async () => ({ ...snapshot(), apiKey }), fetch: async () => {
        const frames = [
          { type: "message_start", message: { id: "msg_error", usage: { input_tokens: 1, output_tokens: 0 } } },
          { type: "error", error: { type: "authentication_error", message: `denied ${apiKey}`, details: { credential: apiKey, nested: JSON.stringify({ key: apiKey }) } } },
        ];
        return new Response(frames.map((frame) => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
      } });
      const response = await handler(request("zcode/glm-5.3", { stream: true }));
      assert.equal(response.status, 200);
      const text = await response.text();
      assertSecretAbsent(text, apiKey);
      const events: Json[] = text.split("\n\n").flatMap((frame) => {
        const data = frame.split("\n").find((line) => line.startsWith("data: "))?.slice(6);
        return data ? [JSON.parse(data)] : [];
      });
      assertSecretAbsent(events, apiKey);
      assert.equal(events.at(-1)!.type, "response.failed");
      const logs = fs.readdirSync(config.logDir!).map((name) => fs.readFileSync(path.join(config.logDir!, name), "utf8")).join("\n");
      assertSecretAbsent(logs, apiKey);
      assert.match(logs, /"status":"failed"/);
      assert.match(logs, /authentication_error/);
      assert.ok(!logs.includes(FAKE_OAUTH));
    });
  }
});

test("ZCode 历史 function 与 custom 调用在压缩移除 tools 后仍可生成摘要", async () => {
  await fixture(async ({ config, create }) => {
    config.requestLogging = true;
    const captured: Json[] = [];
    const handler = create({ fetch: async (_url, init) => { captured.push(JSON.parse(String(init.body))); return upstream("工具历史压缩摘要"); } });
    const history = [
      { type: "message", role: "user", content: "处理文件" },
      { type: "function_call", call_id: "function_history", name: "read.file", arguments: '{"path":"a.txt"}' },
      { type: "function_call_output", call_id: "function_history", output: "旧文件内容" },
      { type: "custom_tool_call", call_id: "custom_history", name: "apply_patch", input: "*** Begin Patch\n*** End Patch" },
      { type: "custom_tool_call_output", call_id: "custom_history", output: "补丁已应用" },
    ];
    const tools = [
      { type: "function", name: "read.file", parameters: { type: "object", properties: { path: { type: "string" } } } },
      { type: "custom", name: "apply_patch" },
    ];
    const v1 = await handler(request("zcode/glm-5.3", { input: history, tools }, "/v1/responses/compact"));
    assert.equal(v1.status, 200);
    assert.match(JSON.stringify(await v1.json()), /工具历史压缩摘要/);
    const v2 = await handler(request("zcode/glm-5.3", { input: [...history, { type: "compaction_trigger" }], tools, stream: true }));
    assert.equal(v2.status, 200);
    const result = await decoded(v2);
    assert.equal(result.output[0].type, "compaction");
    assert.equal(Buffer.from(result.output[0].encrypted_content.slice(5), "base64").toString("utf8"), "工具历史压缩摘要");
    assert.equal(captured.length, 2);
    for (const body of captured) {
      assert.ok(!body.tools || body.tools.length === 0, "摘要请求不得附带可执行工具");
      assert.match(JSON.stringify(body.messages), /旧文件内容/);
      assert.match(JSON.stringify(body.messages), /补丁已应用/);
    }
    const normal = await handler(request("zcode/glm-5.3", { stream: true }));
    await decoded(normal);
    const logs = fs.readdirSync(config.logDir!).map((name) => fs.readFileSync(path.join(config.logDir!, name), "utf8")).join("\n");
    assert.match(logs, /response\.completed/);
    assert.match(logs, /工具历史压缩摘要/);
  });
});


test("ZCode WebSocket 降级仅作用于明确模型的 Responses，不影响 Realtime 或无提示旧路由", async () => {
  await fixture(async ({ config }) => {
    // 先按 upstream-only 校验无提示请求仍然直通第三方上游。
    config.upstreamOnly = true;
    for (const route of ["/v1/live/rtc_fixture", "/v1/realtime?model=gpt-live"]) {
      for (const hint of [undefined, "model=zcode/glm-5.3"]) {
        const headers = new Headers({ upgrade: "websocket" });
        if (hint) headers.set("x-codex-routing-hint", hint);
        assert.equal(isZcodeResponsesWebSocket(new Request(`http://localhost${route}`, { headers }), config), false);
      }
    }
    const bare = new Request("http://localhost/v1/responses", { headers: { upgrade: "websocket" } });
    assert.equal(isZcodeResponsesWebSocket(bare, config), false);
    assert.equal(responsesWebSocketTarget(bare, config, "test-key")?.routeKind, "cliproxy");
    config.upstreamOnly = false;
    assert.equal(responsesWebSocketTarget(bare, config, "test-key")?.routeKind, "official");
    const known = new Request("http://localhost/v1/responses", {
      headers: { upgrade: "websocket", "x-codex-routing-hint": "model=zcode/glm-5.3" },
    });
    assert.equal(isZcodeResponsesWebSocket(known, config), true);
    assert.equal(responsesWebSocketTarget(known, config, "test-key"), null);
  });
});

test("ZCode 请求日志沿用缺省日志目录", async () => {
  await fixture(async ({ config, directory, create }) => {
    config.requestLogging = true;
    delete config.logDir;
    const handler = create();
    await (await handler(request("zcode/glm-5.3"))).text();
    const files = fs.readdirSync(path.join(directory, "logs"));
    assert.ok(files.some((name) => /^zai-v1-responses-http-\d{14}\.log$/.test(name)));
  });
});


for (const family of ["zai", "bigmodel"] as const) {
  for (const plan of ["coding-plan", "start-plan", "api-key"] as const) {
    test(`ZCode ${family}/${plan} 仅发送模型 API，鉴权、归因和正文缓存相互一致`, async () => {
      await fixture(async ({ config, directory, create }) => {
        config.requestLogging = true;
        const selected = snapshot(family);
        selected.providerID = plan === "api-key" ? `custom:${family}` : `builtin:${family}-${plan}`;
        selected.apiKey = plan === "start-plan" ? "fake-plan-jwt" : "fake-business-key";
        if (plan === "start-plan") selected.baseURL = "https://zcode.z.ai/api/v1/zcode-plan/anthropic";
        const calls: { url: string; headers: Headers; body: Json }[] = [];
        const handler = create({ current: async () => selected, fetch: async (url, init) => {
          calls.push({ url, headers: new Headers(init.headers), body: JSON.parse(String(init.body)) });
          return upstream();
        } });
        const clientModel = "zcode/glm-5.3";
        const forged = {
          "thread-id": "codex-thread-fixed", "x-codex-parent-thread-id": "codex-parent-fixed",
          "x-session-id": "caller-session", "x-zcode-trace-id": "caller-trace",
          "x-zcode-agent": "caller-agent", "x-title": "caller-title",
          "x-client-sig": "caller-signature", "x-device-mid": "caller-device",
          "anthropic-beta": "interleaved-thinking-2025-05-14", "openai-beta": "caller-openai-beta",
        };
        for (const stream of [false, true]) await (await handler(request(clientModel, { stream }, "/v1/responses", forged))).text();
        assert.equal(calls.length, 2, "每个客户端请求仅对应一个模型 API 调用");
        for (const call of calls) {
          assert.equal(call.url, `${selected.baseURL}/v1/messages`);
          assert.equal(call.headers.get("authorization"), `Bearer ${selected.apiKey}`);
          assert.equal(call.headers.get("x-api-key"), plan === "start-plan" ? null : selected.apiKey);
          assert.match(call.headers.get("user-agent")!, /^ZCode\/\S+ ai-sdk\/anthropic\/3\.0\.81$/);
          assert.equal(call.headers.get("http-referer"), "https://zcode.z.ai");
          assert.equal(call.headers.get("x-title"), "Z Code@cli");
          assert.equal(call.headers.get("x-zcode-agent"), "glm");
          assert.equal(call.headers.get("x-zcode-session-type"), "subagent");
          assert.equal(call.headers.get("x-client-sig"), null);
          assert.equal(call.headers.get("x-device-mid"), null);
          assert.equal(call.headers.get("chatgpt-account-id"), null);
          assert.equal(call.headers.get("anthropic-beta"), "interleaved-thinking-2025-05-14");
          assert.equal(call.headers.get("openai-beta"), null);
          assert.notEqual(call.headers.get("x-session-id"), "caller-session");
          assert.notEqual(call.headers.get("x-zcode-trace-id"), "caller-trace");
          const metadata = JSON.parse(call.body.metadata.user_id);
          assert.deepEqual(metadata, { account_uuid: "", session_id: call.headers.get("x-session-id") });
          const markers = call.body.messages.flatMap((message: Json) => message.content).filter((block: Json) => block.cache_control);
          assert.equal(markers.length, 1);
          assert.deepEqual(call.body.messages.at(-1).content.at(-1).cache_control, { type: "ephemeral" });
        }
        assert.equal(calls[0].headers.get("x-session-id"), calls[1].headers.get("x-session-id"));
        assert.notEqual(calls[0].headers.get("x-request-id"), calls[1].headers.get("x-request-id"));
        assert.notEqual(calls[0].headers.get("x-query-id"), calls[1].headers.get("x-query-id"));
        const logText = fs.readdirSync(path.join(directory, "logs"))
          .map((name) => fs.readFileSync(path.join(directory, "logs", name), "utf8")).join("\n");
        assert.match(logText, /--- upstream request headers ---/);
        assert.match(logText, /x-title: Z Code@cli/);
        // 转换后真正发往上游的正文也要落在同一个渠道日志里，便于核对翻译结果。
        assert.match(logText, /--- upstream request payload ---/);
        const upstreamPayloads = [...logText.matchAll(/--- upstream request payload ---\n {2}(.+)/g)].map((match) => JSON.parse(match[1]!));
        assert.equal(upstreamPayloads.length, calls.length);
        assert.deepEqual(upstreamPayloads.map((body: Json) => body.model), ["GLM-5.3", "GLM-5.3"]);
        assert.equal(upstreamPayloads[0].max_tokens, calls[0].body.max_tokens);
        assert.deepEqual(upstreamPayloads[0].messages, calls[0].body.messages);
        assert.equal(logText.includes(selected.apiKey), false);
        assert.equal(logText.includes(FAKE_OAUTH), false);
      });
    });
  }
}

test("ZCode 厂商目录重建时过期 Codex 目录缓存，复用目录时保持原样", async () => {
  await fixture(async ({ config, create }) => {
    const codexCache = path.join(path.dirname(config.catalogPath), "codex-models-cache.json");
    const read = () => JSON.parse(fs.readFileSync(codexCache, "utf8"));
    fs.writeFileSync(codexCache, JSON.stringify({
      fetched_at: "2026-09-12T09:37:23Z", client_version: "0.154.0", models: [{ slug: "gpt-test" }],
    }));
    // 首次启动没有 zcode-catalog.json，重建会改变 Codex 能看到的目录。
    create({ codexModelsCacheFile: codexCache }).close();
    assert.equal(read().fetched_at, "2000-01-01T00:00:00Z");
    assert.equal(read().client_version, "0.0.0");
    assert.deepEqual(read().models, [{ slug: "gpt-test" }]);

    fs.writeFileSync(codexCache, JSON.stringify({ fetched_at: "2026-09-12T10:00:00Z", client_version: "0.154.0" }));
    create({ codexModelsCacheFile: codexCache }).close();
    assert.equal(read().fetched_at, "2026-09-12T10:00:00Z");
  });
});

test("analyze_image 执行失败的降级旁白先脱敏再发给客户端", async () => {
  await fixture(async ({ create }) => {
    // 主腿返回 analyze_image 工具调用；执行信封拿到回显 API key 的 401 正文；
    // 续跑腿正常收尾。降级旁白（响应仍为 completed）必须遮蔽 key，不能带进响应。
    const failureBody = `{"error":{"message":"invalid api key ${FAKE_KEY}"}}`;
    let call = 0;
    const handler = create({ fetch: async () => {
      call += 1;
      if (call === 1) return upstream("先看图", "analyze_image");
      if (call <= 4) return new Response(failureBody, { status: 401 });
      return upstream("改用文字回答");
    } });
    const response = await handler(request("zcode/glm-5.3", {
      input: [{ type: "message", role: "user", content: [
        { type: "input_text", text: "看图片" },
        { type: "input_image", image_url: "data:image/png;base64,aGVsbG8=" },
      ] }],
    }));
    assert.equal(response.status, 200);
    const text = JSON.stringify(await decoded(response));
    assert.match(text, /analyze_image 执行失败/);
    assert.equal(text.includes(FAKE_KEY), false);
    assert.ok(text.includes("***"));
  });
});

test("analyze_image 降级旁白对跨截断边界的 key 同样脱敏", async () => {
  await fixture(async ({ create }) => {
    // key 恰好跨过错误正文的 200 字符截断边界：先截断再脱敏会留下可还原的
    // key 前缀片段（本次 review 复现的第二个绕过），必须先对完整正文脱敏。
    const failureBody = `${"x".repeat(190)}${FAKE_KEY}${"y".repeat(50)}`;
    let call = 0;
    const handler = create({ fetch: async () => {
      call += 1;
      if (call === 1) return upstream("先看图", "analyze_image");
      if (call <= 4) return new Response(failureBody, { status: 401 });
      return upstream("改用文字回答");
    } });
    const response = await handler(request("zcode/glm-5.3", {
      input: [{ type: "message", role: "user", content: [
        { type: "input_text", text: "看图片" },
        { type: "input_image", image_url: "data:image/png;base64,aGVsbG8=" },
      ] }],
    }));
    assert.equal(response.status, 200);
    const text = JSON.stringify(await decoded(response));
    assert.match(text, /analyze_image 执行失败/);
    assert.equal(text.includes(FAKE_KEY.slice(0, 10)), false, "截断边界前的 key 前缀不得泄漏");
    assert.equal(text.includes(FAKE_KEY), false);
  });
});

test("analyze_image 降级旁白遮蔽 JSON 转义形式的 key", async () => {
  await fixture(async ({ create }) => {
    // 合法 JSON 正文以 \\/ 与 \\u002f 转义回显 key：客户端反序列化即可还原完整
    // 密钥（本次 review 复现的第一个绕过），脱敏必须按转义形式匹配。
    const escapedKey = "fake-zcode-secret/with/slashes";
    const failureBody = '{"error":{"message":"invalid api key fake-zcode-secret\\\\/with\\\\u002fslashes"}}';
    let call = 0;
    const handler = create({
      current: async () => ({ ...snapshot(), apiKey: escapedKey }),
      fetch: async () => {
        call += 1;
        if (call === 1) return upstream("先看图", "analyze_image");
        if (call <= 4) return new Response(failureBody, { status: 401 });
        return upstream("改用文字回答");
      },
    });
    const response = await handler(request("zcode/glm-5.3", {
      input: [{ type: "message", role: "user", content: [
        { type: "input_text", text: "看图片" },
        { type: "input_image", image_url: "data:image/png;base64,aGVsbG8=" },
      ] }],
    }));
    assert.equal(response.status, 200);
    const text = JSON.stringify(await decoded(response));
    assert.match(text, /analyze_image 执行失败/);
    assert.equal(text.includes("fake-zcode-secret"), false, "转义形式的 key 不得残留可还原片段");
    assert.ok(text.includes("***"));
  });
});
