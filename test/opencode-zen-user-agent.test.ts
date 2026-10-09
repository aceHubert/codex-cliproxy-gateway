import assert from "node:assert/strict";
import test from "node:test";
import {
  ZEN_CLIENT_DIST_TAG,
  ZEN_CLIENT_VERSION_URL,
  createZenUserAgentStore,
  parseZenClientVersion,
  zenUserAgent,
} from "../src/opencode/user-agent.ts";
import { ZEN_CLIENT_USER_AGENT, buildZenUpstreamHeaders } from "../src/opencode/fingerprint.ts";
import { createOpenCodeSessionId } from "../src/opencode/session.ts";

const SESSION = createOpenCodeSessionId(1_000_000, "test-session");
/** 快照值（fingerprint-data.json）：官方 GA opencode2 2.0.26，渠道 latest。 */
const SNAPSHOT_UA = "opencode/latest/2.0.26/cli";
/** 同发布线的更新版本（动态拉取命中后的期望值）。 */
const DYNAMIC_UA = "opencode/latest/2.1.3/cli";

test("UA 版本解析：GA 正式版取标签名作渠道，预发布版取版本串的渠道段", () => {
  assert.deepEqual(parseZenClientVersion({ latest: "2.0.26" }), { version: "2.0.26", channel: "latest" });
  assert.deepEqual(parseZenClientVersion({ latest: " 2.1.3 " }), { version: "2.1.3", channel: "latest" });
  // 带预发布段的版本：渠道取自版本自身，标签名不参与（beta 标签指向 beta 构建时仍是 beta 渠道）。
  assert.deepEqual(parseZenClientVersion({ latest: "0.0.0-beta-19507" }), { version: "0.0.0-beta-19507", channel: "beta" });
  assert.deepEqual(parseZenClientVersion({ beta: "0.0.0-beta-19271" }, "beta"), { version: "0.0.0-beta-19271", channel: "beta" });
  assert.deepEqual(parseZenClientVersion({ latest: "0.0.0-dev-20780" }), { version: "0.0.0-dev-20780", channel: "dev" });
  // 畸形与缺失一律 undefined（调用方回退快照）。
  assert.equal(parseZenClientVersion({ latest: "not-a-version" }), undefined);
  assert.equal(parseZenClientVersion({ latest: "beta-19271" }), undefined);
  assert.equal(parseZenClientVersion({ latest: 19 }), undefined);
  assert.equal(parseZenClientVersion({ beta: "0.0.0-beta-19271" }), undefined, "缺目标标签");
  assert.equal(parseZenClientVersion(null), undefined);
  assert.equal(parseZenClientVersion(["2.0.26"]), undefined);
});

test("UA 组装：四段式，渠道段与版本段分离", () => {
  assert.equal(zenUserAgent("2.0.26", "latest"), SNAPSHOT_UA);
  assert.equal(zenUserAgent("2.1.3", "latest"), DYNAMIC_UA);
  assert.equal(zenUserAgent("0.0.0-beta-19271", "beta"), "opencode/beta/0.0.0-beta-19271/cli");
});

test("版本存储：未拉取用快照，拉取成功后用动态版本，TTL 内不重复拉取", async () => {
  let now = 1_000_000;
  const urls: string[] = [];
  const store = createZenUserAgentStore({
    now: () => now,
    ttlMs: 60_000,
    fetch: async (url) => {
      urls.push(url);
      return Response.json({ latest: "2.1.3", beta: "0.0.0-beta-19507" });
    },
  });
  assert.equal(store.current(), SNAPSHOT_UA, "未拉取前回退快照");
  await store.refresh();
  assert.deepEqual(urls, [ZEN_CLIENT_VERSION_URL]);
  assert.equal(store.current(), DYNAMIC_UA);
  await store.refresh();
  assert.equal(urls.length, 1, "TTL 内不重试");
  now += 61_000;
  await store.refresh();
  assert.equal(urls.length, 2, "TTL 过后重试");
});

test("版本存储：网络异常/非 200/跨渠道/畸形响应都保留快照且 TTL 内不重试", async () => {
  let now = 1_000_000;
  const cases: Array<() => Promise<Response>> = [
    async () => { throw new Error("network down"); },
    async () => new Response("nope", { status: 500 }),
    async () => Response.json({ latest: "0.0.0-beta-19507" }), // 跨渠道：latest 标签指向 beta 构建不采信
    async () => Response.json({ latest: "not-a-version" }),
  ];
  for (const respond of cases) {
    let attempts = 0;
    now += 600_000;
    const store = createZenUserAgentStore({
      now: () => now,
      ttlMs: 60_000,
      fetch: async () => { attempts++; return respond(); },
    });
    await store.refresh();
    assert.equal(store.current(), SNAPSHOT_UA, "失败一律回退快照（与改造前行为一致）");
    await store.refresh();
    assert.equal(attempts, 1, "TTL 内不重试");
  }
});

test("版本存储：取到动态版本后拉取失败保留 last-good，不退回快照", async () => {
  let now = 1_000_000;
  let healthy = true;
  const store = createZenUserAgentStore({
    now: () => now,
    ttlMs: 60_000,
    fetch: async () => {
      if (!healthy) throw new Error("blip");
      return Response.json({ latest: "2.1.3" });
    },
  });
  await store.refresh();
  assert.equal(store.current(), DYNAMIC_UA);
  healthy = false;
  now += 61_000;
  await store.refresh();
  assert.equal(store.current(), DYNAMIC_UA, "last-good 不被失败覆盖");
});

test("标头集：UA 可覆盖，其余指纹段不受影响，缺省仍是快照", () => {
  const snapshot = buildZenUpstreamHeaders(SESSION, "public", "a".repeat(40));
  assert.equal(snapshot["user-agent"], ZEN_CLIENT_USER_AGENT);
  assert.equal(ZEN_CLIENT_USER_AGENT, SNAPSHOT_UA);
  const dynamic = buildZenUpstreamHeaders(SESSION, "public", "a".repeat(40), DYNAMIC_UA);
  assert.equal(dynamic["user-agent"], DYNAMIC_UA);
  assert.equal(dynamic["x-opencode-client"], snapshot["x-opencode-client"]);
  assert.equal(dynamic["x-opencode-session"], snapshot["x-opencode-session"]);
  assert.equal(dynamic.authorization, snapshot.authorization);
});

test("版本来源常量：GA 线在 @opencode/cli 的 latest 标签", () => {
  assert.equal(ZEN_CLIENT_DIST_TAG, "latest");
  assert.ok(ZEN_CLIENT_VERSION_URL.includes("@opencode/cli"));
  assert.match(ZEN_CLIENT_VERSION_URL, /dist-tags$/);
});
