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

test("确定性派生：同一外部会话跨实例稳定，id 具备官方 counter=1 形状", () => {
  // Zen 解码校验时间段结构：哈希前缀一律 403，counter=1 官方形状的派生 id 过闸
  // （2026-10-15 实测 3/3）；确定性派生让会话粘性不依赖任何进程内状态。
  const external = "01a13e5e-fd6e-7b31-88cb-faaefcd6cb45";
  const derived = deriveOpenCodeSessionId(external);
  assert.equal(derived, deriveOpenCodeSessionId(external), "同一外部会话派生结果恒定");
  assert.notEqual(derived, deriveOpenCodeSessionId("another-conv"), "不同外部会话互不相同");
  assert.match(derived, OPENCODE_SESSION_PATTERN);
  assert.ok(derived.slice(4, 16).endsWith("ffe"), "counter 位固定为官方形状（hex 以 ffe 结尾）");
  assert.ok(decodeOpenCodeSessionTimestamp(derived) !== undefined, "时间段可反解（服务端同款校验）");
  assert.notEqual(derived, createOpenCodeSessionId(1_000, external), "与铸币路径（时间戳在前）独立");
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

test("resolveOpenCodeSession：非法 x-opencode-session 不透传，回落到外部会话派生", () => {
  const resolver = createOpenCodeSessionResolver();
  const headers = new Headers({
    "x-opencode-session": "not-a-valid-session",
    "Session-Id": "01a13e5e-fd6e-7b31-88cb-faaefcd6cb45",
  });
  const resolved = resolver.resolve(headers);
  assert.match(resolved, OPENCODE_SESSION_PATTERN);
  // 与同外部会话的确定性派生一致（Codex 实发 session-id 头，不再依赖绑定表）。
  assert.equal(resolved, deriveOpenCodeSessionId("01a13e5e-fd6e-7b31-88cb-faaefcd6cb45"));
  // 同一外部会话再次解析结果稳定。
  assert.equal(resolver.resolve(new Headers({ "session-id": "01a13e5e-fd6e-7b31-88cb-faaefcd6cb45" })), resolved);
});

test("resolveOpenCodeSession：外部会话标头按 x-session-id → session-id → thread-id 优先级取值", () => {
  const resolver = createOpenCodeSessionResolver();
  assert.equal(
    resolver.resolve(new Headers({ "x-session-id": "first", "session-id": "second", "thread-id": "third" })),
    deriveOpenCodeSessionId("first"),
  );
  assert.equal(
    resolver.resolve(new Headers({ "session-id": "second", "thread-id": "third" })),
    deriveOpenCodeSessionId("second"),
  );
  // 仅 thread-id 在场（如 fork 线程）时仍可稳定派生。
  assert.equal(resolver.resolve(new Headers({ "thread-id": "third" })), deriveOpenCodeSessionId("third"));
});

test("resolveOpenCodeSession：plain object 标头大小写不敏感", () => {
  const resolver = createOpenCodeSessionResolver();
  const resolved = resolver.resolve({ "session-id": "conv-plain" });
  assert.equal(resolved, deriveOpenCodeSessionId("conv-plain"));
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
