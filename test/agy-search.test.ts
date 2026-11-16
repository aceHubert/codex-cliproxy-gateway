import assert from "node:assert/strict";
import {
  AgySearchError,
  buildAgySearchRequest,
  executeAgySearch,
  planAgySearchQueries,
  translateAgySearchResponse,
} from "@agent-proxy/agy/search";
import test from "./host-test.ts";

const TIMEOUT = { timeout: 30_000 };
type Json = Record<string, any>;

function nativeResponse(options: {
  text?: string;
  thought?: string;
  finishReason?: string;
  uris?: string[];
  supports?: Array<{ endIndex: number; text: string; indices: number[]; partIndex?: number }>;
} = {}): Json {
  const parts: Json[] = [];
  if (options.thought) parts.push({ thought: true, text: options.thought });
  parts.push({ text: options.text ?? "搜索摘要" });
  return {
    response: {
      candidates: [{
        finishReason: options.finishReason ?? "STOP",
        content: { role: "model", parts },
        groundingMetadata: {
          groundingChunks: (options.uris ?? ["https://example.com/article?token=private#section"]).map((uri, index) => ({
            web: { uri, title: `来源 ${index + 1}` },
          })),
          groundingSupports: (options.supports ?? []).map((support) => ({
            segment: {
              endIndex: support.endIndex,
              text: support.text,
              ...(support.partIndex !== undefined ? { partIndex: support.partIndex } : {}),
            },
            groundingChunkIndices: support.indices,
          })),
        },
      }],
    },
  };
}

test("AGY 搜索规划保留查询、域名筛选、recency 与天气语义", TIMEOUT, () => {
  const planned = planAgySearchQueries({
    commands: {
      search_query: [{ q: "杭州明天天气", recency: 7, domains: ["weather.gov", "example.com"] }],
      weather: [{ location: "China, Zhejiang, Hangzhou", start: "2026-11-17", duration: 3 }],
    },
    settings: { filters: { allowed_domains: ["example.com"], blocked_domains: ["ads.example"] } },
  }, new Date("2026-11-16T12:00:00Z"));

  assert.deepEqual(planned, [
    { query: "杭州明天天气 (site:example.com) -site:ads.example after:2026-11-09", weather: false },
    { query: "China, Zhejiang, Hangzhou 天气预报 2026-11-17 起连续 3 天 温度 降水 气象部门 (site:example.com) -site:ads.example", weather: true },
  ]);
});

test("AGY 搜索规划拒绝无效域名和非法 recency", TIMEOUT, () => {
  assert.throws(() => planAgySearchQueries({ commands: { search_query: [{ q: "x", domains: ["https://example.com"] }] } }),
    (error) => error instanceof AgySearchError && error.status === 400);
  assert.throws(() => planAgySearchQueries({ commands: { search_query: [{ q: "x", recency: -1 }] } }),
    (error) => error instanceof AgySearchError && error.status === 400);
  assert.throws(() => planAgySearchQueries({ commands: { search_query: [{ q: "x", recency: 36501 }] } }),
    (error) => error instanceof AgySearchError && error.status === 400);
});

test("AGY 搜索规划不静默丢弃未支持的 Codex 命令", TIMEOUT, () => {
  for (const command of ["open", "click", "find", "screenshot", "finance", "sports", "time"]) {
    assert.throws(() => planAgySearchQueries({ commands: { [command]: [{}] } }),
      (error) => error instanceof AgySearchError && error.status === 501 && error.message.includes(command));
  }
});

test("AGY 搜索规划需要一到四条查询，并尊重禁用外部访问", TIMEOUT, () => {
  assert.throws(() => planAgySearchQueries({ commands: { search_query: [] } }),
    (error) => error instanceof AgySearchError && error.status === 400);
  assert.throws(() => planAgySearchQueries({ commands: { search_query: Array.from({ length: 5 }, (_, i) => ({ q: `query ${i}` })) } }),
    (error) => error instanceof AgySearchError && error.status === 400);
  assert.throws(() => planAgySearchQueries({ commands: { search_query: [{ q: "x" }] }, settings: { external_web_access: false } }),
    (error) => error instanceof AgySearchError && error.status === 403);
  assert.throws(() => planAgySearchQueries({ commands: { search_query: [{ q: "x" }] }, settings: { external_web_access: "cached" } }),
    (error) => error instanceof AgySearchError && error.status === 403);
});

test("AGY 原生搜索请求使用独立 web_search GenerateContent 配置", TIMEOUT, () => {
  const request = buildAgySearchRequest("gemini-4-hydrogen-search", "杭州天气 site:example.com");
  const inner = request.request as Json;
  assert.equal(request.model, "gemini-4-hydrogen-search");
  assert.equal(request.requestType, "web_search");
  assert.equal(request.userAgent, "antigravity");
  assert.equal(inner.generationConfig.candidateCount, 1);
  assert.deepEqual(inner.tools, [{ googleSearch: { enhancedContent: { imageSearch: { maxResultCount: 5 } } } }]);
  assert.equal(inner.contents[0].parts[0].text, "杭州天气 site:example.com");
});

test("AGY 搜索将近似位置、上下文和摘要长度作为原生检索提示，并按用户时区确定天气日期", TIMEOUT, async () => {
  let request: Json | undefined;
  const settings = { user_location: { type: "approximate", city: "杭州", timezone: "Asia/Shanghai" }, search_context_size: "high" };
  await executeAgySearch({ settings, commands: { search_query: [{ q: "天气" }], response_length: "short" } }, "search-model", async (body) => {
    request = body;
    return nativeResponse();
  }, new AbortController().signal);
  assert.match(request!.request.systemInstruction.parts[0].text, /杭州/);
  assert.match(request!.request.systemInstruction.parts[0].text, /high/);
  assert.match(request!.request.systemInstruction.parts[0].text, /short/);
  assert.match(planAgySearchQueries({ settings, commands: { weather: [{ location: "杭州" }] } }, new Date("2026-11-16T18:00:00Z"))[0]!.query, /2026-11-17/);
  for (const external_web_access of [{ mode: "cached" }, ["live"]]) {
    assert.throws(() => planAgySearchQueries({ settings: { external_web_access }, commands: { search_query: [{ q: "x" }] } }), AgySearchError);
  }
});

test("AGY 原生搜索转换引用并剥离来源 URL 中的 query/hash，跳过 thought", TIMEOUT, () => {
  const text = "杭州天气晴朗";
  const citeEnd = Buffer.byteLength("杭州", "utf8");
  const response = translateAgySearchResponse(nativeResponse({
    thought: "内部思考不应显示",
    text,
    supports: [{ endIndex: citeEnd, text: "杭州", indices: [0], partIndex: 1 }],
  }), "turn-test-");

  assert.equal(response.encrypted_output, null);
  assert.match(response.output, /^杭州citeturn-test-search0天气晴朗/);
  assert.doesNotMatch(response.output, /内部思考/);
  assert.equal(response.results.length, 1);
  assert.deepEqual(response.results[0], {
    type: "text_result",
    ref_id: "turn-test-search0",
    title: "来源 1",
    url: "https://example.com/article",
    domain: "example.com",
    snippet: "杭州",
  });
  assert.match(response.output, /来源：\n【turn-test-search0】 来源 1\nhttps:\/\/example.com\/article$/);
});

test("AGY 搜索只接受公开 HTTP(S) 来源并丢弃带用户凭据的 URL", TIMEOUT, () => {
  const response = translateAgySearchResponse(nativeResponse({
    text: "安全检索完成",
    uris: [
      "javascript:alert(1)",
      "https://user:password@example.com/private",
      "https://safe.example/path?token=private#frag",
    ],
  }), "turn-safe-");

  assert.equal(response.results.length, 1);
  assert.equal(response.results[0]!.ref_id, "turn-safe-search0");
  assert.equal(response.results[0]!.url, "https://safe.example/path");
  assert.doesNotMatch(response.output, /password|token=private|#frag|javascript:/);
});

test("AGY 搜索转换拒绝非成功终态、无摘要和空候选", TIMEOUT, () => {
  assert.throws(() => translateAgySearchResponse(nativeResponse({ finishReason: "MAX_TOKENS" }), "turn-x-"),
    (error) => error instanceof AgySearchError && error.status === 502);
  assert.throws(() => translateAgySearchResponse(nativeResponse({ text: "", thought: "仅有 thought" }), "turn-x-"),
    (error) => error instanceof AgySearchError && error.status === 502);
  assert.throws(() => translateAgySearchResponse({ response: { candidates: [] } }, "turn-x-"),
    (error) => error instanceof AgySearchError && error.status === 502);
});

test("AGY 多查询逐条执行并生成互不碰撞的引用 ID，天气结果明确标注为网页检索", TIMEOUT, async () => {
  const requests: Json[] = [];
  const response = await executeAgySearch({
    commands: {
      search_query: [{ q: "杭州展览" }, { q: "杭州天气" }],
      weather: [{ location: "杭州", start: "2026-11-17", duration: 1 }],
    },
  }, "search-model", async (request) => {
    requests.push(request);
    return nativeResponse({
      text: `搜索摘要 ${requests.length}`,
      uris: [`https://example.com/${requests.length}`],
      supports: [{ endIndex: Buffer.byteLength(`搜索摘要 ${requests.length}`), text: `搜索摘要 ${requests.length}`, indices: [0] }],
    });
  }, new AbortController().signal);

  assert.equal(requests.length, 3);
  assert.ok(requests.every((request) => request.model === "search-model" && request.requestType === "web_search"));
  const refs = response.results.map((result) => result.ref_id);
  assert.equal(new Set(refs).size, 3);
  assert.ok(refs.every((ref) => /^turn\d+[0-2]search0$/.test(ref)));
  assert.match(response.output, /以下为 Google 网页检索的天气信息，不是专用气象数据接口/);
  assert.ok(response.results.every((result) => result.type === "text_result"));
});

test("取消的 AGY 搜索不调用 GenerateContent", TIMEOUT, async () => {
  const controller = new AbortController();
  controller.abort(new Error("用户取消"));
  let calls = 0;
  await assert.rejects(executeAgySearch({ commands: { search_query: [{ q: "取消测试" }] } }, "search-model", async () => {
    calls++;
    return nativeResponse();
  }, controller.signal), /用户取消/);
  assert.equal(calls, 0);
});
