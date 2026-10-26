import assert from "node:assert/strict";
import test from "./host-test.ts";
import {
  OPENCODE_SESSION_PATTERN,
  createOpenCodeSessionId,
  createOpenCodeSessionResolver,
  decodeOpenCodeSessionTimestamp,
  deriveOpenCodeSessionId,
} from "@agent-proxy/opencode-zen/session";

test("生成的 session id 符合 ses_ + 12位Hex + 14位Base62 的 30 字符结构", () => {
  for (let index = 0; index < 50; index++) {
    const sessionId = createOpenCodeSessionId();
    assert.match(sessionId, OPENCODE_SESSION_PATTERN);
    assert.equal(sessionId.length, 30);
    // 前 12 位必须是合法十六进制（降序时间戳部分）。
    assert.match(sessionId.slice(4, 16), /^[0-9a-f]{12}$/);
  }
});

test("session id 的时间戳可反解（mod 2^36 回绕语义）且与生成时间一致", () => {
  const timestamp = 1_000_000_000; // < 2^36，无回绕
  const sessionId = createOpenCodeSessionId(timestamp);
  assert.equal(decodeOpenCodeSessionTimestamp(sessionId), timestamp);
  // 当前纪元的时间戳左移 12 位超出 48 位：反解按官方客户端同款 mod 2^36 回绕。
  const now = Date.now();
  assert.equal(decodeOpenCodeSessionTimestamp(createOpenCodeSessionId(now)), now % 2 ** 36);
  // 同一毫秒生成的 id 时间戳相同，随机后缀不同。
  assert.notEqual(createOpenCodeSessionId(timestamp), createOpenCodeSessionId(timestamp));
});

test("时间段含同毫秒 counter=1：与官方客户端逆向样例的低位结构一致", () => {
  // 官方 Identifier.descending：r = ts*0x1000 + counter，降序 Hex = MASK - r。
  // 官方真实样例 ses_3a4ee6335ffedFB8f76BPU1Eb3 以 ffe 结尾即 counter=1 的结果；
  // 本生成器同样以 counter=1 起步，低位恒为 ...ffe 而非无 counter 公式的 ...fff。
  const sessionId = createOpenCodeSessionId(1_000_000_000);
  assert.ok(sessionId.slice(4, 16).endsWith("ffe"), `hex 段应含 counter=1：${sessionId}`);
  assert.ok(decodeOpenCodeSessionTimestamp(sessionId) !== undefined);
});

test("时间戳越新的 session id 降序 Hex 越小，且反解拒绝非法格式", () => {
  const older = createOpenCodeSessionId(100_000_000);
  const newer = createOpenCodeSessionId(200_000_000);
  assert.ok(older.slice(4, 16) > newer.slice(4, 16));
  assert.equal(decodeOpenCodeSessionTimestamp("ses_zzzzzzzzzzzzzzzzzzzzzzzzzz"), undefined);
  assert.equal(decodeOpenCodeSessionTimestamp("garbage"), undefined);
});

test("相同 seed 生成确定性 session id，不同 seed 互不相同", () => {
  const first = createOpenCodeSessionId(1_000, "test-conv-1");
  assert.equal(first, createOpenCodeSessionId(1_000, "test-conv-1"));
  assert.notEqual(first, createOpenCodeSessionId(1_000, "test-conv-2"));
  assert.match(first, OPENCODE_SESSION_PATTERN);
});

test("派生：时间段取铸造时刻（新鲜度硬校验）、后缀由外部会话确定", () => {
  // 2026-10-26 实测：服务端校验时间段新鲜度——哈希位当时间段的派生 id 一律 429，
  // 现铸 id 过闸；确定性只保留在后缀，跨请求粘性由 resolver 的进程内缓存提供。
  const external = "01a13e5e-fd6e-7b31-88cb-faaefcd6cb45";
  const at = 1_000_000_000;
  const derived = deriveOpenCodeSessionId(external, at);
  assert.equal(derived, deriveOpenCodeSessionId(external, at), "同一外部会话同刻派生恒定");
  assert.equal(decodeOpenCodeSessionTimestamp(derived), at, "时间段取铸造时刻而非外部 id 哈希");
  const later = deriveOpenCodeSessionId(external, at + 60_000);
  assert.notEqual(derived, later, "不同时刻铸的 id 时间段不同（不承诺跨进程恒定）");
  assert.equal(derived.slice(16), later.slice(16), "后缀由外部会话派生（确定性）");
  assert.notEqual(derived.slice(16), deriveOpenCodeSessionId("another-conv", at).slice(16), "不同外部会话后缀互不相同");
  assert.match(derived, OPENCODE_SESSION_PATTERN);
  assert.ok(derived.slice(4, 16).endsWith("ffe"), "counter 位固定为官方形状（hex 以 ffe 结尾）");
});

test("resolveOpenCodeSession：入站已带合法 x-opencode-session 时原样透传", () => {
  const resolver = createOpenCodeSessionResolver();
  const inbound = "ses_3a4ee6335ffedFB8f76BPU1Eb3";
  const headers = new Headers({
    "x-opencode-session": inbound,
    "session-id": "should-be-ignored",
  });
  assert.equal(resolver.resolve(headers), inbound);
});

test("resolveOpenCodeSession：非法 x-opencode-session 不透传，回落外部会话派生并进程内粘住", () => {
  let now = 2_000_000_000;
  const resolver = createOpenCodeSessionResolver({ now: () => now });
  const resolved = resolver.resolve(new Headers({
    "x-opencode-session": "not-a-valid-session",
    "Session-Id": "01a13e5e-fd6e-7b31-88cb-faaefcd6cb45",
  }));
  assert.match(resolved, OPENCODE_SESSION_PATTERN);
  // 铸造时刻取 resolver 的当前时间（Codex 实发 session-id 头）。
  assert.equal(resolved, deriveOpenCodeSessionId("01a13e5e-fd6e-7b31-88cb-faaefcd6cb45", now));
  // 时间流逝后同一外部会话仍复用进程内已铸 id：prompt cache 亲和不随时间漂移。
  now += 60_000;
  assert.equal(resolver.resolve(new Headers({ "session-id": "01a13e5e-fd6e-7b31-88cb-faaefcd6cb45" })), resolved);
});

test("resolveOpenCodeSession：外部会话标头按 x-session-id → session-id → thread-id 优先级取值", () => {
  const now = 3_000_000_000;
  const resolver = createOpenCodeSessionResolver({ now: () => now });
  assert.equal(
    resolver.resolve(new Headers({ "x-session-id": "first", "session-id": "second", "thread-id": "third" })),
    deriveOpenCodeSessionId("first", now),
  );
  assert.equal(
    resolver.resolve(new Headers({ "session-id": "second", "thread-id": "third" })),
    deriveOpenCodeSessionId("second", now),
  );
  // 仅 thread-id 在场（如 fork 线程）时仍可派生。
  assert.equal(resolver.resolve(new Headers({ "thread-id": "third" })), deriveOpenCodeSessionId("third", now));
});

test("resolveOpenCodeSession：plain object 标头大小写不敏感", () => {
  const now = 4_000_000_000;
  const resolver = createOpenCodeSessionResolver({ now: () => now });
  const resolved = resolver.resolve({ "session-id": "conv-plain" });
  assert.equal(resolved, deriveOpenCodeSessionId("conv-plain", now));
  assert.equal(
    resolver.resolve({ "X-Opencode-Session": "ses_3a4ee6335ffedFB8f76BPU1Eb3" }),
    "ses_3a4ee6335ffedFB8f76BPU1Eb3",
  );
});

test("resolveOpenCodeSession：无任何会话标头时生成单次临时合规 session", () => {
  let now = 1_000_000;
  const resolver = createOpenCodeSessionResolver({ now: () => now });
  const first = resolver.resolve(new Headers());
  assert.match(first, OPENCODE_SESSION_PATTERN);
  assert.equal(decodeOpenCodeSessionTimestamp(first), now);
  now += 5_000;
  const second = resolver.resolve(new Headers());
  assert.notEqual(second, first, "兜底临时 session 不得跨请求复用");
  // 空白标头视同缺失。
  assert.notEqual(resolver.resolve(new Headers({ "session-id": "  " })), second);
});
