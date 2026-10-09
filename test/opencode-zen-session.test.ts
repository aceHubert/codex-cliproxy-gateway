import assert from "node:assert/strict";
import test from "node:test";
import {
  OPENCODE_SESSION_PATTERN,
  createOpenCodeSessionId,
  createOpenCodeSessionResolver,
  createSessionBindingCache,
  decodeOpenCodeSessionTimestamp,
} from "../src/opencode/session.ts";

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

test("绑定表：同一 X-Session-Id 稳定复用同一 Zen session", () => {
  const cache = createSessionBindingCache({ now: () => 1_000_000 });
  const first = cache.resolve("test-conv-1");
  assert.match(first, OPENCODE_SESSION_PATTERN);
  assert.equal(cache.resolve("test-conv-1"), first);
  const second = cache.resolve("test-conv-2");
  assert.notEqual(second, first);
  assert.equal(cache.size(), 2);
});

test("绑定表：TTL 滑动续期，活跃会话不过期、静默会话到期后重新绑定", () => {
  let now = 1_000_000;
  const cache = createSessionBindingCache({ ttlMs: 10_000, now: () => now });
  const first = cache.resolve("conv");
  // 9 秒后访问：续期到 now+10s。
  now += 9_000;
  assert.equal(cache.resolve("conv"), first);
  // 再过 9 秒（距上次访问 9s < 10s）：仍在滑动窗口内。
  now += 9_000;
  assert.equal(cache.resolve("conv"), first);
  // 连续静默超过 TTL 后过期，重新绑定生成新 session。
  now += 20_000;
  const rebound = cache.resolve("conv");
  assert.notEqual(rebound, first);
  // 旧值不残留。
  assert.equal(cache.size(), 1);
});

test("绑定表：超容量按最久未使用淘汰", () => {
  let now = 1_000_000;
  const cache = createSessionBindingCache({ ttlMs: 60_000, maxEntries: 2, now: () => now });
  const a = cache.resolve("a");
  cache.resolve("b");
  // touch a：b 变为最久未使用，下一次写入淘汰 b。
  assert.equal(cache.resolve("a"), a);
  cache.resolve("c");
  assert.equal(cache.size(), 2);
  assert.equal(cache.resolve("a"), a);
  const reboundB = cache.resolve("b");
  assert.notEqual(reboundB, a);
});

test("resolveOpenCodeSession：入站已带合法 x-opencode-session 时原样透传", () => {
  const cache = createSessionBindingCache();
  const resolver = createOpenCodeSessionResolver(cache);
  const inbound = "ses_3a4ee6335ffedFB8f76BPU1Eb3";
  const headers = new Headers({
    "x-opencode-session": inbound,
    "x-session-id": "should-be-ignored",
  });
  assert.equal(resolver.resolve(headers), inbound);
  // 透传路径不产生任何绑定。
  assert.equal(cache.size(), 0);
});

test("resolveOpenCodeSession：非法 x-opencode-session 不透传，回落到 X-Session-Id 绑定", () => {
  const resolver = createOpenCodeSessionResolver(createSessionBindingCache({ now: () => 5_000_000 }));
  const headers = new Headers({
    "x-opencode-session": "not-a-valid-session",
    "X-Session-Id": "test-conv-1",
  });
  const resolved = resolver.resolve(headers);
  assert.match(resolved, OPENCODE_SESSION_PATTERN);
  // 与同 seed 的确定性生成一致（绑定转换路径）。
  assert.equal(resolved, createOpenCodeSessionId(5_000_000, "test-conv-1"));
  // 同一外部会话再次解析结果稳定。
  assert.equal(resolver.resolve(new Headers({ "x-session-id": "test-conv-1" })), resolved);
});

test("resolveOpenCodeSession：plain object 标头大小写不敏感", () => {
  const resolver = createOpenCodeSessionResolver(createSessionBindingCache({ now: () => 5_000_000 }));
  const resolved = resolver.resolve({ "x-session-id": "conv-plain" });
  assert.equal(resolved, createOpenCodeSessionId(5_000_000, "conv-plain"));
  assert.equal(
    resolver.resolve({ "X-Opencode-Session": "ses_3a4ee6335ffedFB8f76BPU1Eb3" }),
    "ses_3a4ee6335ffedFB8f76BPU1Eb3",
  );
});

test("resolveOpenCodeSession：无任何会话标头时生成单次临时合规 session", () => {
  let now = 1_000_000;
  const resolver = createOpenCodeSessionResolver(createSessionBindingCache(), { now: () => now });
  const first = resolver.resolve(new Headers());
  assert.match(first, OPENCODE_SESSION_PATTERN);
  assert.equal(decodeOpenCodeSessionTimestamp(first), now);
  now += 5_000;
  const second = resolver.resolve(new Headers());
  assert.notEqual(second, first, "兜底临时 session 不得跨请求复用");
  // 空白标头视同缺失。
  assert.notEqual(resolver.resolve(new Headers({ "x-session-id": "  " })), second);
});
