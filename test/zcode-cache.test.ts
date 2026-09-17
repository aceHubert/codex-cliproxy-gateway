import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createZcodeConfigCache, ZcodeConfigError } from "../src/zcode/config.ts";

const URL_A = "https://api.z.ai/api/anthropic";
const URL_B = "https://open.bigmodel.cn/api/anthropic/v1";
const ID = "builtin:zai-coding-plan";
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
function json(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
}
function settings(extra: Record<string, unknown> = {}) {
  return { providerFamilyDomain: "zai", modelProviderFamilySelectedKeys: { zai: `oauth:${ID}`, bigmodel: "key:other" }, ...extra };
}
function config(key = "test-business-key", url = URL_A, extra: Record<string, unknown> = {}) {
  return { provider: { [ID]: { options: { apiKey: key, baseURL: url }, models: { "glm-5": {} }, ...extra }, other: { options: { apiKey: "test-other-key" }, models: { "other-model": {} } } } };
}
function jwt(exp: number): string {
  return `${Buffer.from('{"alg":"HS256"}').toString("base64url")}.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.test`;
}
function mockWatch() {
  const entries: { directory: string; closed: boolean; emitter: EventEmitter; listener: (event: string, filename: string) => void }[] = [];
  const watch = ((directory: string, _options: unknown, listener: (event: string, filename: string) => void) => {
    const emitter = new EventEmitter();
    const entry = { directory: String(directory), closed: false, emitter, listener };
    entries.push(entry);
    return Object.assign(emitter, { close() { entry.closed = true; emitter.emit("close"); } });
  }) as unknown as typeof fs.watch;
  return { watch, entries, change(directory: string, name: string) {
    for (const entry of [...entries]) if (!entry.closed && entry.directory === directory) entry.listener("rename", name);
  } };
}
async function fixture(fn: (home: string, root: string) => Promise<void>): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-cache-test-"));
  const home = path.join(root, "parent", ".zcode");
  json(path.join(home, "setting.json"), settings());
  json(path.join(home, "v2", "config.json"), config());
  try { await fn(home, root); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
async function eventually(fn: () => Promise<void>): Promise<void> {
  let last: unknown;
  for (let i = 0; i < 80; i++) {
    try { await fn(); return; } catch (error) { last = error; }
    await sleep(25);
  }
  throw last;
}

test("ZCode 100 次无关设置写入不构建 Key、不阻塞请求并保留快照对象", { timeout: 60_000 }, async () => {
  await fixture(async (home) => {
    const mock = mockWatch();
    let builds = 0;
    let configReads = 0;
    const cache = createZcodeConfigCache(home, { watch: mock.watch, onCredentialBuild() { builds++; }, onConfigRead() { configReads++; } });
    try {
      const initial = await cache.get();
      builds = 0;
      for (let i = 0; i < 100; i++) {
        json(path.join(home, "setting.json"), settings({ theme: i }));
        mock.change(home, "setting.json");
        assert.equal(await cache.get(), initial);
      }
      await sleep(160);
      assert.equal(await cache.get(), initial);
      assert.equal(builds, 0);
      assert.equal(configReads, 1);
      json(path.join(home, "v2", "config.json"), { ...config(), other: "ignored" });
      mock.change(path.join(home, "v2"), "config.json");
      await sleep(140);
      assert.equal(await cache.get(), initial);
      assert.equal(builds, 0);
    } finally { cache.close(); }
  });
});

test("ZCode URL 更新保留绝对 expiry，真实换 Key 仅构建一次", { timeout: 60_000 }, async () => {
  await fixture(async (home) => {
    const mock = mockWatch();
    const key = jwt(Math.floor(Date.now() / 1000) + 3600);
    json(path.join(home, "v2/config.json"), config(key));
    let builds = 0;
    const cache = createZcodeConfigCache(home, { watch: mock.watch, onCredentialBuild() { builds++; } });
    try {
      const first = await cache.get();
      json(path.join(home, "v2/config.json"), config(key, URL_B));
      mock.change(path.join(home, "v2"), "config.json");
      await sleep(140);
      const next = await cache.get();
      assert.notEqual(next, first);
      assert.equal(next.baseURL, URL_B);
      assert.equal(next.expiresAt, first.expiresAt);
      assert.equal(builds, 1);
      json(path.join(home, "v2/config.json"), config("test-new-key", URL_B));
      for (let i = 0; i < 20; i++) mock.change(path.join(home, "v2"), "config.json");
      await sleep(140);
      assert.equal((await cache.get()).apiKey, "test-new-key");
      assert.equal((await cache.get()).expiresAt, undefined);
      assert.equal(builds, 2);
      assert.equal(first.apiKey, key);
    } finally { cache.close(); }
  });
});

test("ZCode 持续相关写入在首事件 500ms 上限内检查，不发生饥饿", { timeout: 60_000 }, async () => {
  await fixture(async (home) => {
    const mock = mockWatch();
    const cache = createZcodeConfigCache(home, { watch: mock.watch });
    try {
      await cache.get();
      json(path.join(home, "v2/config.json"), config("test-maxwait"));
      mock.change(path.join(home, "v2"), "config.json");
      const interval = setInterval(() => mock.change(home, "setting.json"), 30);
      try {
        await sleep(620);
        assert.equal((await cache.get()).apiKey, "test-maxwait");
      } finally { clearInterval(interval); }
    } finally { cache.close(); }
  });
});

test("ZCode 到期同值 Key 共享一次重读且不延期，不随请求重复检查", { timeout: 60_000 }, async () => {
  await fixture(async (home) => {
    const mock = mockWatch();
    let now = 100_000;
    let stats = 0;
    let builds = 0;
    json(path.join(home, "v2/config.json"), config(jwt(101)));
    const cache = createZcodeConfigCache(home, { watch: mock.watch, now: () => now,
      stat: ((...args: Parameters<typeof fs.statSync>) => { stats++; return fs.statSync(...args); }) as typeof fs.statSync,
      onCredentialBuild() { builds++; } });
    try {
      assert.equal((await cache.get()).expiresAt, 101_000);
      const before = stats;
      now = 101_001;
      await Promise.all(Array.from({ length: 20 }, () => assert.rejects(cache.get(), /已过期/)));
      assert.ok(stats > before);
      const after = stats;
      await Promise.all(Array.from({ length: 20 }, () => assert.rejects(cache.get(), /已过期/)));
      assert.equal(stats, after);
      json(path.join(home, "v2/config.json"), config(jwt(101), URL_B));
      mock.change(path.join(home, "v2"), "config.json");
      await sleep(140);
      await assert.rejects(cache.get(), /已过期/);
      assert.equal(builds, 1);
      json(path.join(home, "v2/config.json"), config(jwt(1000)));
      mock.change(path.join(home, "v2"), "config.json");
      assert.equal((await cache.get()).expiresAt, 1_000_000);
      assert.equal(builds, 2);
    } finally { cache.close(); }
  });
});

test("ZCode credentials 无关、同值、损坏或丢失不撤销业务 Key", { timeout: 60_000 }, async () => {
  await fixture(async (home) => {
    const mock = mockWatch();
    let builds = 0;
    const cache = createZcodeConfigCache(home, { watch: mock.watch, onCredentialBuild() { builds++; } });
    try {
      const original = await cache.get();
      for (const value of [{ other: { accessToken: "test-token" } }, { zai: { accessToken: "test-next" } }]) {
        json(path.join(home, "credentials.json"), value);
        mock.change(home, "credentials.json");
        await sleep(130);
        assert.equal(await cache.get(), original);
      }
      fs.writeFileSync(path.join(home, "credentials.json"), "broken");
      mock.change(home, "credentials.json");
      await sleep(130);
      assert.equal(await cache.get(), original);
      fs.unlinkSync(path.join(home, "credentials.json"));
      mock.change(home, "credentials.json");
      await sleep(130);
      assert.equal(await cache.get(), original);
      assert.equal(builds, 1);
    } finally { cache.close(); }
  });
});

test("ZCode setting/config 各自根目录优先，仅缺失回退 v2，坏配置可以恢复", { timeout: 60_000 }, async () => {
  await fixture(async (home) => {
    const mock = mockWatch();
    json(path.join(home, "v2/setting.json"), settings());
    const cache = createZcodeConfigCache(home, { watch: mock.watch });
    try {
      assert.equal((await cache.get()).providerID, ID);
      json(path.join(home, "config.json"), config("test-root-key"));
      mock.change(home, "config.json");
      await sleep(130);
      assert.equal((await cache.get()).apiKey, "test-root-key");
      fs.writeFileSync(path.join(home, "config.json"), "invalid");
      mock.change(home, "config.json");
      await sleep(130);
      await assert.rejects(cache.get(), ZcodeConfigError);
      fs.unlinkSync(path.join(home, "config.json"));
      fs.unlinkSync(path.join(home, "setting.json"));
      mock.change(home, "config.json");
      assert.equal((await cache.get()).apiKey, "test-business-key");
      json(path.join(home, "setting.json"), settings({ providerFamilyDomain: "unknown" }));
      mock.change(home, "setting.json");
      await sleep(130);
      await assert.rejects(cache.get(), /未选择/);
      json(path.join(home, "setting.json"), settings());
      mock.change(home, "setting.json");
      assert.equal((await cache.get()).family, "zai");
    } finally { cache.close(); }
  });
});

test("ZCode 禁用、缺失地址、错误域名和符号链接均失效且不回退", { timeout: 60_000 }, async () => {
  await fixture(async (home, root) => {
    const mock = mockWatch();
    const cache = createZcodeConfigCache(home, { watch: mock.watch });
    try {
      for (const value of [config("test", URL_A, { enabled: false }), config("test", URL_A, { systemDisabledReason: "disabled" }),
        config("test", ""), config("test", "https://evil.test/api/anthropic"), config("test", "http://api.z.ai/api/anthropic")]) {
        json(path.join(home, "config.json"), value);
        mock.change(home, "config.json");
        await sleep(130);
        await assert.rejects(cache.get(), ZcodeConfigError);
      }
      const target = path.join(root, "target.json");
      json(target, config());
      fs.unlinkSync(path.join(home, "config.json"));
      fs.symlinkSync(target, path.join(home, "config.json"));
      mock.change(home, "config.json");
      await assert.rejects(cache.get(), /符号链接/);
      fs.unlinkSync(path.join(home, "config.json"));
      mock.change(home, "config.json");
      assert.equal((await cache.get()).apiKey, "test-business-key");
    } finally { cache.close(); }
  });
});

test("ZCode 文件原子替换、v2 替换和父目录缺失重建会重新绑定监听", { timeout: 60_000 }, async () => {
  await fixture(async (home, root) => {
    const mock = mockWatch();
    const cache = createZcodeConfigCache(home, { watch: mock.watch });
    try {
      await cache.get();
      json(path.join(home, "v2/config.tmp"), config("test-atomic"));
      fs.renameSync(path.join(home, "v2/config.tmp"), path.join(home, "v2/config.json"));
      mock.change(path.join(home, "v2"), "config.json");
      await eventually(async () => assert.equal((await cache.get()).apiKey, "test-atomic"));
      fs.renameSync(path.join(home, "v2"), path.join(root, "old-v2"));
      json(path.join(home, "v2/config.json"), config("test-v2"));
      mock.change(home, "v2");
      await eventually(async () => assert.equal((await cache.get()).apiKey, "test-v2"));
      fs.rmSync(path.dirname(home), { recursive: true });
      mock.change(root, "parent");
      await eventually(async () => { await assert.rejects(cache.get()); });
      json(path.join(home, "setting.json"), settings());
      json(path.join(home, "v2/config.json"), config("test-rebuilt"));
      mock.change(root, "parent");
      await eventually(async () => assert.equal((await cache.get()).apiKey, "test-rebuilt"));
    } finally { cache.close(); }
  });
});

test("ZCode 初始目录缺失后恢复，close 取消等待并释放全部监听", { timeout: 60_000 }, async () => {
  await fixture(async (home, root) => {
    fs.rmSync(path.dirname(home), { recursive: true });
    const mock = mockWatch();
    const cache = createZcodeConfigCache(home, { watch: mock.watch });
    await assert.rejects(cache.get());
    json(path.join(home, "setting.json"), settings());
    json(path.join(home, "config.json"), config());
    mock.change(root, "parent");
    assert.equal((await cache.get()).apiKey, "test-business-key");
    fs.writeFileSync(path.join(home, "setting.json"), "broken");
    mock.change(home, "setting.json");
    await sleep(130);
    await assert.rejects(cache.get());
    mock.change(home, "setting.json");
    const pending = assert.rejects(cache.get(), /关闭/);
    cache.close();
    cache.close();
    await pending;
    assert.ok(mock.entries.every((entry) => entry.closed));
    await assert.rejects(cache.get(), /关闭/);
  });
});

// Bun 1.3 的 node:test 尚不支持动态 t.skip，能力探测放在测试注册前。
const nativeWatchUnavailable = (() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-watch-probe-"));
  try {
    // 只按明确系统错误跳过，普通事件等待超时仍使测试失败。
    const probe = spawnSync("node", ["-e", `
      const fs = require("node:fs");
      const watcher = fs.watch(process.argv[1]);
      watcher.on("error", (error) => { console.error(error.code); process.exitCode = 2; });
      setTimeout(() => watcher.close(), 100);
    `, root], { encoding: "utf8", timeout: 3000 });
    const unavailable = /\b(EMFILE|ENFILE|EACCES|EPERM)\b/.exec(probe.stderr ?? "");
    return unavailable ? `宿主机 fs.watch 明确返回 ${unavailable[1]}` : false;
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
})();

(nativeWatchUnavailable ? test.skip : test)(`ZCode 实际 fs.watch 收到原子替换事件后刷新${nativeWatchUnavailable ? `（${nativeWatchUnavailable}）` : ""}`, { timeout: 60_000 }, async () => {
  await fixture(async (home, root) => {
    const cache = createZcodeConfigCache(home);
    try {
      await cache.get();
      json(path.join(home, "v2/config.tmp"), config("test-real-atomic"));
      fs.renameSync(path.join(home, "v2/config.tmp"), path.join(home, "v2/config.json"));
      await eventually(async () => assert.equal((await cache.get()).apiKey, "test-real-atomic"));
      fs.renameSync(path.join(home, "v2"), path.join(root, "real-old-v2"));
      json(path.join(home, "v2/config.json"), config("test-real-directory"));
      await eventually(async () => assert.equal((await cache.get()).apiKey, "test-real-directory"));
      fs.rmSync(path.dirname(home), { recursive: true });
      await eventually(async () => { await assert.rejects(cache.get()); });
      json(path.join(home, "setting.json"), settings());
      json(path.join(home, "v2/config.json"), config("test-real-rebuilt"));
      await eventually(async () => assert.equal((await cache.get()).apiKey, "test-real-rebuilt"));
    } finally { cache.close(); }
  });
});

test("ZCode API Key 模式只选当前 family，保留完整 ID 且不推测 TTL", { timeout: 60_000 }, async () => {
  await fixture(async (home) => {
    const mock = mockWatch();
    const id = "custom:account:provider";
    json(path.join(home, "setting.json"), settings({ providerFamilyDomain: "bigmodel",
      modelProviderFamilySelectedKeys: { zai: "bad", bigmodel: `apikey:${id}` } }));
    json(path.join(home, "config.json"), { provider: { [id]: { options: { apiKey: "test-key", baseURL: URL_B }, models: { "glm-5": {} } } } });
    let reads = 0;
    const cache = createZcodeConfigCache(home, { watch: mock.watch, onConfigRead() { reads++; } });
    try {
      const first = await cache.get();
      assert.equal(first.family, "bigmodel");
      assert.equal(first.providerID, id);
      assert.equal(first.expiresAt, undefined);
      json(path.join(home, "credentials.json"), { bigmodel: { accessToken: "test-oauth-changed" } });
      mock.change(home, "credentials.json");
      await sleep(130);
      assert.equal(await cache.get(), first);
      assert.equal(reads, 1);
    } finally { cache.close(); }
  });
});

test("ZCode watcher 错误关闭全部监听且不会泄露底层错误", { timeout: 60_000 }, async () => {
  await fixture(async (home) => {
    const mock = mockWatch();
    const cache = createZcodeConfigCache(home, { watch: mock.watch });
    await cache.get();
    mock.entries[0].emitter.emit("error", new Error("test-sensitive-detail"));
    await assert.rejects(cache.get(), (error: unknown) => {
      assert.ok(error instanceof ZcodeConfigError);
      assert.ok(!error.message.includes("test-sensitive-detail"));
      return true;
    });
    assert.ok(mock.entries.every((entry) => entry.closed));
    cache.close();
  });
});

test("ZCode START 计划 credentials 仅当前渠道 token 变化重读 config", { timeout: 60_000 }, async () => {
  await fixture(async (home) => {
    const mock = mockWatch();
    const id = "builtin:zai-start-plan";
    json(path.join(home, "setting.json"), settings({ modelProviderFamilySelectedKeys: { zai: `plan:${id}` } }));
    json(path.join(home, "config.json"), { provider: { [id]: { options: { apiKey: "test-start-key", baseURL: URL_A }, models: { "glm-5": {} } } } });
    json(path.join(home, "credentials.json"), { "oauth:zai:access_token": "test-access", zcodejwttoken: "test-session" });
    let reads = 0;
    let builds = 0;
    const cache = createZcodeConfigCache(home, { watch: mock.watch, onConfigRead() { reads++; }, onCredentialBuild() { builds++; } });
    try {
      const initial = await cache.get();
      for (let i = 0; i < 3; i++) {
        json(path.join(home, "credentials.json"), { "oauth:zai:access_token": "test-access", zcodejwttoken: "test-session",
          "oauth:bigmodel:access_token": `test-other-${i}`, user_info: { changed: i }, "oauth:active_provider": i });
        mock.change(home, "credentials.json");
        await sleep(130);
        assert.equal(await cache.get(), initial);
      }
      assert.equal(reads, 1);
      json(path.join(home, "credentials.json"), { "oauth:zai:access_token": "test-changed", zcodejwttoken: "test-session" });
      mock.change(home, "credentials.json");
      await sleep(130);
      assert.equal(reads, 2);
      assert.equal(builds, 1);
      assert.equal(await cache.get(), initial);
      json(path.join(home, "v2/credentials.json"), { "oauth:zai:access_token": "test-fallback" });
      fs.writeFileSync(path.join(home, "credentials.json"), "broken");
      mock.change(home, "credentials.json");
      await sleep(130);
      assert.equal(reads, 2);
      assert.equal(await cache.get(), initial);
      fs.unlinkSync(path.join(home, "credentials.json"));
      mock.change(home, "credentials.json");
      await sleep(130);
      assert.equal(reads, 3);
      assert.equal(await cache.get(), initial);
    } finally { cache.close(); }
  });
});

test("ZCode models 使用字典键稳定去重排序，变化仅发布路由快照", { timeout: 60_000 }, async () => {
  await fixture(async (home) => {
    const mock = mockWatch();
    const key = jwt(Math.floor(Date.now() / 1000) + 3600);
    json(path.join(home, "config.json"), config(key, URL_A, { models: {
      " glm-5 ": { name: "显示名不能成为 ID" }, "GLM-4.7": {}, "glm-4.7": { name: "别名" }, " ": {},
    } }));
    let builds = 0;
    const cache = createZcodeConfigCache(home, { watch: mock.watch, onCredentialBuild() { builds++; } });
    try {
      const initial = await cache.get();
      assert.deepEqual(initial.modelIds, ["GLM-4.7", "glm-5"]);
      assert.ok(Object.isFrozen(initial.modelIds));
      json(path.join(home, "config.json"), config(key, URL_A, { models: {
        "glm-4.7": { name: "新显示名", limit: { context: 200000 } }, "GLM-4.7": {}, "glm-5": { name: "变化" },
      } }));
      mock.change(home, "config.json");
      await sleep(130);
      assert.equal(await cache.get(), initial);
      json(path.join(home, "config.json"), config(key, URL_A, { models: { "GLM-5.1": { name: "其它显示名" } } }));
      mock.change(home, "config.json");
      await sleep(130);
      const changed = await cache.get();
      assert.notEqual(changed, initial);
      assert.deepEqual(changed.modelIds, ["GLM-5.1"]);
      assert.equal(changed.expiresAt, initial.expiresAt);
      assert.equal(changed.apiKey, initial.apiKey);
      assert.equal(builds, 1);
      assert.deepEqual(initial.modelIds, ["GLM-4.7", "glm-5"]);
      for (const models of [undefined, null, [], "invalid"]) {
        json(path.join(home, "config.json"), config(key, URL_A, { models }));
        mock.change(home, "config.json");
        await sleep(130);
        assert.deepEqual((await cache.get()).modelIds, []);
        assert.equal((await cache.get()).expiresAt, initial.expiresAt);
      }
      assert.equal(builds, 1);
    } finally { cache.close(); }
  });
});
