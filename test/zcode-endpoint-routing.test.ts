import assert from "node:assert/strict";
import test from "node:test";
import { ZcodeEndpointRouting } from "../src/zcode/endpoint-routing.ts";

const identity = { appVersion: "3.11.2", language: "en-US", timezone: "Asia/Shanghai", platform: "darwin", arch: "arm64", osVersion: "25.6.0" };
const FROM = "https://api.z.ai/api/anthropic/v1/messages";
const TO = "https://zcode.z.ai/api/v1/ultra-zai/anthropic/v1/messages";

function mappingResponse(entries: unknown[]): Response {
  return Response.json({ code: 0, data: { proxyEndpoint: { mapping: entries } } });
}
function service(fetch: (url: string, init: RequestInit) => Promise<Response>, now?: () => number): ZcodeEndpointRouting {
  return new ZcodeEndpointRouting({ identity, fetch, ...(now ? { now } : {}) });
}

test("映射命中时按归一化键重写并保留查询串", async () => {
  const routing = service(async () => mappingResponse([{ from: FROM, to: TO }]));
  const rewritten = await routing.resolve(`${FROM}?beta=true`);
  assert.deepEqual(rewritten, { routed: true, url: `${TO}?beta=true` });
  assert.equal((await routing.resolve("https://api.z.ai:443/api/anthropic/v1/messages/")).url, TO);
  assert.equal((await routing.resolve("https://API.Z.AI/api/anthropic/v1/messages")).routed, true);
  assert.equal((await routing.resolve("https://api.z.ai/api/anthropic/v1/count_tokens")).routed, false);
  assert.equal((await routing.resolve("not-a-url")).routed, false);
  assert.ok(routing.hasSnapshot());
});

test("拉取失败、HTTP 错误、非零 code、坏形状与重复 from 均失败进入冷却并回退原 URL", async () => {
  const responses: Array<() => Promise<Response>> = [
    async () => { throw new Error("network down"); },
    async () => new Response("busy", { status: 503 }),
    async () => Response.json({ code: 1, data: null }),
    async () => Response.json({ code: 0, data: { proxyEndpoint: { mapping: "not-array" } } }),
    async () => Response.json({ code: 0, data: { proxyEndpoint: { mapping: [{ from: FROM, to: TO }, { from: FROM, to: TO }] } } }),
  ];
  // mapping 非数组按参考语义降级为空表快照（成功、无重写），其余场景不得建立快照。
  const expectSnapshot = [false, false, false, true, false];
  for (const [index, respond] of responses.entries()) {
    let calls = 0;
    const routing = service(async () => { calls++; return respond(); });
    assert.deepEqual(await routing.resolve(FROM), { routed: false, url: FROM });
    assert.equal((await routing.resolve(FROM)).routed, false);
    assert.equal(calls, 1, "冷却期内不得重复拉取");
    assert.equal(routing.hasSnapshot(), expectSnapshot[index]);
  }
});

test("拒绝非 https、非官方域名与私网重映射目标", async () => {
  const targets = [
    "http://api.z.ai/api/anthropic/v1/messages",
    "https://evil.example.com/anthropic",
    "https://sub.z.ai.evil.com/anthropic",
    "https://127.0.0.1/api/anthropic/v1/messages",
    "https://10.0.0.5/anthropic",
    "https://[fd00::1]/anthropic",
    "https://z.ai@evil.example.com/anthropic",
    "https://zcode.z.ai/anthropic?x=1",
  ];
  for (const to of targets) {
    let calls = 0;
    const routing = service(async () => { calls++; return mappingResponse([{ from: FROM, to }]); });
    assert.equal((await routing.resolve(FROM)).routed, false, to);
    assert.equal(calls, 1, "非法目标必须整表拒绝：", );
  }
});

test("TTL 过期后重新拉取，并发 resolve 在无快照时只触发一次请求", async () => {
  let calls = 0;
  let time = 1_000_000;
  const routing = service(async () => {
    calls++;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return mappingResponse([{ from: FROM, to: TO }]);
  }, () => time);
  const concurrent = await Promise.all([routing.resolve(FROM), routing.resolve(FROM)]);
  assert.equal(calls, 1);
  assert.equal(concurrent.every((item) => item.routed), true);
  await routing.resolve(FROM);
  assert.equal(calls, 1, "TTL 内复用快照");
  time += 300_001;
  assert.equal((await routing.resolve(FROM)).routed, true);
  assert.equal(calls, 2);
});

test("映射条目超过上限时整表拒绝", async () => {
  const entries = Array.from({ length: 257 }, (_, index) => ({
    from: `https://node${index}.z.ai/api/anthropic/v1/messages`,
    to: `https://ultra${index}.z.ai/anthropic/v1/messages`,
  }));
  const routing = service(async () => mappingResponse(entries));
  assert.equal((await routing.resolve("https://node0.z.ai/api/anthropic/v1/messages")).routed, false);
});
