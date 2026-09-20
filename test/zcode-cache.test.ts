import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
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

test("ZCode credentials 无关或同值不撤销业务 Key，损坏失效，缺失回退镜像", { timeout: 60_000 }, async () => {
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
      await assert.rejects(() => cache.get(), ZcodeConfigError);
      fs.unlinkSync(path.join(home, "credentials.json"));
      mock.change(home, "credentials.json");
      await sleep(130);
      const restored = await cache.get();
      assert.equal(restored.apiKey, original.apiKey);
      assert.equal(restored.providerID, original.providerID);
      assert.deepEqual(restored.modelIds, original.modelIds);
      // 损坏时失效并释放凭据，删除文件后按镜像重新构建一次。
      assert.equal(builds, 2);
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
      // 套餐服务鉴权走 zcodejwttoken（OAuth 换出的 biz JWT），不是 OAuth access token。
      assert.equal(initial.apiKey, "test-session");
      for (let i = 0; i < 3; i++) {
        json(path.join(home, "credentials.json"), { "oauth:zai:access_token": "test-access", zcodejwttoken: "test-session",
          "oauth:bigmodel:access_token": `test-other-${i}`, user_info: { changed: i }, "oauth:active_provider": i });
        mock.change(home, "credentials.json");
        await sleep(130);
        assert.equal(await cache.get(), initial);
      }
      assert.equal(reads, 1);
      json(path.join(home, "credentials.json"), { "oauth:zai:access_token": "test-access", zcodejwttoken: "test-changed" });
      mock.change(home, "credentials.json");
      await sleep(130);
      assert.equal(reads, 2);
      assert.equal(builds, 2);
      assert.equal((await cache.get()).apiKey, "test-changed");
      json(path.join(home, "v2/credentials.json"), { zcodejwttoken: "test-fallback" });
      fs.writeFileSync(path.join(home, "credentials.json"), "broken");
      mock.change(home, "credentials.json");
      await sleep(130);
      assert.equal(reads, 2);
      await assert.rejects(cache.get(), ZcodeConfigError);
      fs.unlinkSync(path.join(home, "credentials.json"));
      mock.change(home, "credentials.json");
      await sleep(130);
      assert.equal(reads, 3);
      assert.equal((await cache.get()).apiKey, "test-fallback");
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

/** ZCode 3.12.3 起切换套餐只写 providerFamilyConnectionSelections[family].kind。 */
function connectionSettings(kind: string | null, family: "zai" | "bigmodel" = "zai", extra: Record<string, unknown> = {}) {
  const setting: Record<string, unknown> = { providerFamilyDomain: family, ...extra };
  if (kind !== null && !Object.hasOwn(setting, "providerFamilyConnectionSelections")) {
    setting.providerFamilyConnectionSelections = {
      [family]: kind === "team-coding-plan"
        ? { kind, productId: "product-cache", organizationId: "organization-cache", projectId: "project-cache" }
        : { kind },
    };
  }
  return setting;
}
function planConfig(family: "zai" | "bigmodel" = "zai") {
  const url = family === "bigmodel" ? URL_B : URL_A;
  const startKey = jwt(Math.floor(Date.now() / 1000) + 3600);
  return { provider: {
    [`builtin:${family}-coding-plan`]: { options: { apiKey: "test-coding-key", baseURL: url }, models: { "glm-5": {} } },
    [`builtin:${family}-start-plan`]: { options: { apiKey: startKey, baseURL: url }, models: { "glm-5": {} } },
  } };
}

const TEAM_A = { productId: "product-a", organizationId: "organization-a", projectId: "project-a" };
const TEAM_B = { productId: "product-b", organizationId: "organization-b", projectId: "project-b" };
function teamSettings(team: { productId: string; organizationId: string; projectId: string }) {
  return connectionSettings("team-coding-plan", "zai", {
    providerFamilyConnectionSelections: { zai: { kind: "team-coding-plan", ...team } },
  });
}
function bigmodelTeamSettings() {
  return connectionSettings("team-coding-plan", "bigmodel", {
    providerFamilyConnectionSelections: { bigmodel: { kind: "team-coding-plan", ...TEAM_A } },
  });
}
function encryptedCredential(value: string): string {
  const key = createHash("sha256").update("test-zcode-secret").digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return `enc:v1:${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${ciphertext.toString("base64url")}`;
}
function teamCredentials(token = "test-team-oauth") {
  return { "oauth:zai:access_token": token, zcodejwttoken: "test-zcode-jwt" };
}
function teamFetch(keys: Record<string, string>, calls: { method?: string; url: string; headers: Headers; body?: unknown }[] = []): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    calls.push({ method: init?.method, url, headers, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    const project = url.includes(TEAM_A.projectId) ? TEAM_A
      : url.includes("project-cache") ? { ...TEAM_A, projectId: "project-cache" }
      : TEAM_B;
    const apiKey = keys[project.projectId];
    if (url.endsWith("/api/biz/customer/getCustomerInfo")) {
      return Response.json({ code: 0, data: { organizations: [...[TEAM_A, TEAM_B].map((team) => ({
        organizationId: team.organizationId, projects: [{ projectId: team.projectId }],
      })), { organizationId: "organization-cache", projects: [{ projectId: "project-cache" }] }] } });
    }
    if (/\/api_keys$/.test(url)) {
      if (init?.method === "POST") return Response.json({ code: 0, data: { apiKey, keyType: 2, name: "zcode-team-api-key" } });
      return Response.json({ code: 0, data: [{ apiKey, keyType: 2, name: "zcode-team-api-key" }] });
    }
    if (/\/api_keys\/copy\//.test(url)) return Response.json({ code: 0, data: { secretKey: `${apiKey}-secret` } });
    throw new Error(`测试未模拟团队凭据接口: ${url}`);
  }) as typeof fetch;
}

test("ZCode 3.12.3 connectionSelections 把已知 kind 归一化为 legacy providerID", { timeout: 60_000 }, async () => {
  await fixture(async (home) => {
    const mock = mockWatch();
    json(path.join(home, "setting.json"), connectionSettings("team-coding-plan"));
    json(path.join(home, "config.json"), planConfig());
    json(path.join(home, "credentials.json"), teamCredentials());
    const cache = createZcodeConfigCache(home, { watch: mock.watch, fetch: teamFetch({ "project-cache": "test-team-key" }) });
    try {
      for (const kind of ["individual-coding-plan", "team-coding-plan"] as const) {
        json(path.join(home, "setting.json"), connectionSettings(kind));
        mock.change(home, "setting.json");
        await eventually(async () => {
          const snapshot = await cache.get();
          assert.equal(snapshot.family, "zai");
          assert.equal(snapshot.providerID, "builtin:zai-coding-plan");
          assert.equal(snapshot.apiKey, kind === "individual-coding-plan" ? "test-coding-key" : "test-team-key.test-team-key-secret");
        });
      }
      json(path.join(home, "setting.json"), connectionSettings("start-plan"));
      mock.change(home, "setting.json");
      await eventually(async () => {
        const snapshot = await cache.get();
        assert.equal(snapshot.providerID, "builtin:zai-start-plan");
        assert.equal(snapshot.apiKey, "test-zcode-jwt");
        assert.equal(snapshot.expiresAt, undefined);
      });
    } finally { cache.close(); }
  });
});

test("ZCode 个人套餐优先读取当前账号的加密缓存 Key", { timeout: 60_000 }, async () => {
  await fixture(async (home) => {
    const mock = mockWatch();
    const provider = "account:zai-individual-coding-plan";
    const credentialKey = `account-provider:coding-plan:${provider}:account:user-cache-id:api-key`;
    json(path.join(home, "setting.json"), connectionSettings("individual-coding-plan"));
    json(path.join(home, "config.json"), planConfig());
    json(path.join(home, "credentials.json"), {
      "oauth:zai:user_info": encryptedCredential(JSON.stringify({ id: "user-cache-id", username: "user" })),
      [credentialKey]: encryptedCredential("encrypted-personal-key"),
    });
    const cache = createZcodeConfigCache(home, {
      watch: mock.watch,
      env: { ZCODE_CREDENTIAL_SECRET: "test-zcode-secret" },
    });
    try {
      assert.equal((await cache.get()).apiKey, "encrypted-personal-key");
      json(path.join(home, "credentials.json"), {
        "oauth:zai:user_info": encryptedCredential(JSON.stringify({ id: "user-cache-id", username: "user" })),
        [credentialKey]: encryptedCredential("rotated-personal-key"),
      });
      mock.change(home, "credentials.json");
      await eventually(async () => assert.equal((await cache.get()).apiKey, "rotated-personal-key"));
    } finally { cache.close(); }
  });
});

test("ZCode 同渠道换账号后不沿用上一账号的个人 Key", { timeout: 60_000 }, async () => {
  await fixture(async (home) => {
    const mock = mockWatch();
    const provider = "account:zai-individual-coding-plan";
    const accountA = `account-provider:coding-plan:${provider}:account:user-a:api-key`;
    const accountB = `account-provider:coding-plan:${provider}:account:user-b:api-key`;
    json(path.join(home, "setting.json"), connectionSettings("individual-coding-plan"));
    json(path.join(home, "config.json"), { provider: {
      "builtin:zai-coding-plan": { options: { apiKey: "stale-mirror-key", baseURL: URL_A }, models: { "glm-5": {} } },
    } });
    json(path.join(home, "credentials.json"), {
      "oauth:zai:access_token": "oauth-a",
      "oauth:zai:user_info": encryptedCredential(JSON.stringify({ id: "user-a" })),
      [accountA]: encryptedCredential("key-a"),
    });
    const cache = createZcodeConfigCache(home, {
      watch: mock.watch,
      env: { ZCODE_CREDENTIAL_SECRET: "test-zcode-secret" },
      plan: "individual-coding-plan",
    });
    try {
      assert.equal((await cache.get()).apiKey, "key-a");
      // 同一渠道切到账号 B，但 B 的 account-provider Key 尚未落盘：
      // 必须失效，不能回退 config.json 里属于账号 A 的镜像 Key。
      json(path.join(home, "credentials.json"), {
        "oauth:zai:access_token": "oauth-b",
        "oauth:zai:user_info": encryptedCredential(JSON.stringify({ id: "user-b" })),
      });
      mock.change(home, "credentials.json");
      await eventually(async () => {
        await assert.rejects(() => cache.get(), /个人套餐凭据不可用/);
      });
      // 账号 B 的 Key 落盘后恢复。
      json(path.join(home, "credentials.json"), {
        "oauth:zai:access_token": "oauth-b",
        "oauth:zai:user_info": encryptedCredential(JSON.stringify({ id: "user-b" })),
        [accountB]: encryptedCredential("key-b"),
      });
      mock.change(home, "credentials.json");
      await eventually(async () => assert.equal((await cache.get()).apiKey, "key-b"));
    } finally { cache.close(); }
  });
});

test("ZCode 个人套餐识别 user_info.user_id 并读取对应账号 Key", { timeout: 60_000 }, async () => {
  await fixture(async (home) => {
    const provider = "account:zai-individual-coding-plan";
    const key = `account-provider:coding-plan:${provider}:account:user-id-account:api-key`;
    json(path.join(home, "setting.json"), connectionSettings("individual-coding-plan"));
    json(path.join(home, "config.json"), planConfig());
    json(path.join(home, "credentials.json"), {
      "oauth:zai:access_token": "oauth-current",
      "oauth:zai:user_info": encryptedCredential(JSON.stringify({ user_id: "user-id-account", email: "user@example.com" })),
      [key]: encryptedCredential("key-by-user-id"),
    });
    const cache = createZcodeConfigCache(home, {
      watch: mockWatch().watch,
      env: { ZCODE_CREDENTIAL_SECRET: "test-zcode-secret" },
      plan: "individual-coding-plan",
    });
    try {
      assert.equal((await cache.get()).apiKey, "key-by-user-id");
    } finally { cache.close(); }
  });
});

test("ZCode 个人与团队项目切换使用相互隔离的当前凭据", { timeout: 60_000 }, async () => {
  await fixture(async (home) => {
    const mock = mockWatch();
    const calls: { method?: string; url: string; headers: Headers; body?: unknown }[] = [];
    json(path.join(home, "setting.json"), connectionSettings("individual-coding-plan"));
    json(path.join(home, "config.json"), planConfig());
    json(path.join(home, "credentials.json"), teamCredentials());
    let builds = 0;
    const cache = createZcodeConfigCache(home, {
      watch: mock.watch,
      fetch: teamFetch({ "project-a": "team-a-key", "project-b": "team-b-key" }, calls),
      onCredentialBuild() { builds++; },
    });
    try {
      assert.equal((await cache.get()).apiKey, "test-coding-key");
      for (const team of [TEAM_A, TEAM_B]) {
        json(path.join(home, "setting.json"), teamSettings(team));
        mock.change(home, "setting.json");
        await eventually(async () => {
          const snapshot = await cache.get();
          assert.equal(snapshot.providerID, "builtin:zai-coding-plan");
          assert.equal(snapshot.apiKey, `${team.projectId === TEAM_A.projectId ? "team-a-key" : "team-b-key"}.team-${team.projectId === TEAM_A.projectId ? "a" : "b"}-key-secret`);
        });
      }
      json(path.join(home, "setting.json"), connectionSettings("individual-coding-plan"));
      mock.change(home, "setting.json");
      await eventually(async () => assert.equal((await cache.get()).apiKey, "test-coding-key"));
      assert.equal(builds, 4);
      assert.ok(calls.some((call) => call.url.includes(TEAM_A.organizationId) && call.url.includes(TEAM_A.projectId)));
      assert.ok(calls.some((call) => call.url.includes(TEAM_B.organizationId) && call.url.includes(TEAM_B.projectId)));
      assert.ok(calls.every((call) => !call.url.includes("product-a") && !call.url.includes("product-b")));
      assert.ok(calls.filter((call) => call.url.includes(TEAM_B.projectId)).every((call) => call.headers.get("authorization") === "test-team-oauth"));
    } finally { cache.close(); }
  });
});

test("ZCode 团队字段缺失、凭据损坏或文件变化不会回退旧快照", { timeout: 60_000 }, async () => {
  await fixture(async (home) => {
    const mock = mockWatch();
    let calls = 0;
    const fetch: typeof globalThis.fetch = (async (...args: Parameters<typeof globalThis.fetch>) => {
      calls++;
      return teamFetch({ "project-a": "team-a-key" })(...args);
    }) as typeof fetch;
    json(path.join(home, "setting.json"), teamSettings(TEAM_A));
    json(path.join(home, "config.json"), planConfig());
    json(path.join(home, "credentials.json"), teamCredentials());
    const cache = createZcodeConfigCache(home, { watch: mock.watch, fetch, env: { ZCODE_CREDENTIAL_SECRET: "test-zcode-secret" } });
    try {
      assert.equal((await cache.get()).apiKey, "team-a-key.team-a-key-secret");
      json(path.join(home, "credentials.json"), { ...teamCredentials(), audit: 1 });
      mock.change(home, "credentials.json");
      const callsAfterInitial = calls;
      await eventually(async () => {
        assert.equal((await cache.get()).apiKey, "team-a-key.team-a-key-secret");
        assert.ok(calls > callsAfterInitial);
      });
      json(path.join(home, "credentials.json"), { "oauth:zai:access_token": "enc:v1:bad" });
      mock.change(home, "credentials.json");
      await eventually(async () => await assert.rejects(cache.get(), /团队凭据/));
      json(path.join(home, "setting.json"), connectionSettings("team-coding-plan", "zai", {
        providerFamilyConnectionSelections: { zai: { kind: "team-coding-plan", organizationId: "organization-a", projectId: "project-a" } },
      }));
      mock.change(home, "setting.json");
      await eventually(async () => await assert.rejects(cache.get(), /productId/));
    } finally { cache.close(); }
  });
});

test("ZCode 团队套餐删除 credentials.json 后失效且恢复后重建 Key", { timeout: 60_000 }, async () => {
  await fixture(async (home) => {
    const mock = mockWatch();
    const calls: { authorization: string | null }[] = [];
    const fetch: typeof globalThis.fetch = (async (...args: Parameters<typeof globalThis.fetch>) => {
      calls.push({ authorization: new Headers(args[1]?.headers).get("authorization") });
      return teamFetch({ "project-a": "team-a-key" })(...args);
    }) as typeof fetch;
    json(path.join(home, "setting.json"), teamSettings(TEAM_A));
    json(path.join(home, "config.json"), planConfig());
    json(path.join(home, "credentials.json"), teamCredentials());
    let builds = 0;
    const cache = createZcodeConfigCache(home, {
      watch: mock.watch,
      fetch,
      onCredentialBuild() { builds++; },
    });
    try {
      assert.equal((await cache.get()).apiKey, "team-a-key.team-a-key-secret");
      const callsAfterInitial = calls.length;
      fs.unlinkSync(path.join(home, "credentials.json"));
      mock.change(home, "credentials.json");
      await assert.rejects(cache.get(), /团队凭据|credentials/);
      assert.equal(calls.length, callsAfterInitial);
      assert.equal(builds, 1);

      json(path.join(home, "credentials.json"), teamCredentials("restored-team-oauth"));
      mock.change(home, "credentials.json");
      await eventually(async () => {
        assert.equal((await cache.get()).apiKey, "team-a-key.team-a-key-secret");
        assert.ok(calls.length > callsAfterInitial);
      });
      assert.equal(builds, 2);
      assert.ok(calls.slice(callsAfterInitial).every((call) => call.authorization === "restored-team-oauth"));
    } finally { cache.close(); }
  });
});

test("ZCode 团队凭据支持 enc:v1 并在项目 Key 缺失时按官方流程创建", { timeout: 60_000 }, async () => {
  await fixture(async (home) => {
    const mock = mockWatch();
    const calls: { method?: string; url: string; body?: unknown }[] = [];
    json(path.join(home, "setting.json"), teamSettings(TEAM_A));
    json(path.join(home, "config.json"), planConfig());
    json(path.join(home, "credentials.json"), { "oauth:zai:access_token": encryptedCredential("encrypted-team-oauth") });
    const fetch: typeof globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ method: init?.method, url: String(input), ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
      const url = String(input);
      if (/\/api_keys$/.test(url) && init?.method === "GET") return Response.json({ code: 0, data: [] });
      return teamFetch({ "project-a": "created-team-key" })(input, init);
    }) as typeof fetch;
    const cache = createZcodeConfigCache(home, { watch: mock.watch, fetch, env: { ZCODE_CREDENTIAL_SECRET: "test-zcode-secret" } });
    try {
      assert.equal((await cache.get()).apiKey, "created-team-key.created-team-key-secret");
      const created = calls.find((call) => call.method === "POST");
      assert.ok(created?.url.endsWith(`/api/biz/v1/organization/${TEAM_A.organizationId}/projects/${TEAM_A.projectId}/api_keys`));
      assert.deepEqual(created?.body, { keyType: 2, name: "zcode-team-api-key" });
    } finally { cache.close(); }
  });
});

test("ZCode BigModel 团队读取实际 OAuth 键且忽略旧个人停用镜像", { timeout: 60_000 }, async () => {
  await fixture(async (home) => {
    const mock = mockWatch();
    const disabledConfig = planConfig("bigmodel");
    const provider = disabledConfig.provider["builtin:bigmodel-coding-plan"]!;
    Object.assign(provider, { enabled: false, systemDisabledReason: "oauth_provider_inactive" });
    json(path.join(home, "setting.json"), bigmodelTeamSettings());
    json(path.join(home, "config.json"), disabledConfig);
    json(path.join(home, "credentials.json"), { "oauth:bigmodel:access_token": "bigmodel-team-oauth" });
    const cache = createZcodeConfigCache(home, {
      watch: mock.watch,
      fetch: teamFetch({ "project-a": "bigmodel-team-key" }),
    });
    try {
      const snapshot = await cache.get();
      assert.equal(snapshot.family, "bigmodel");
      assert.equal(snapshot.providerID, "builtin:bigmodel-coding-plan");
      assert.equal(snapshot.apiKey, "bigmodel-team-key.bigmodel-team-key-secret");
      assert.deepEqual(snapshot.modelIds, ["glm-5"]);
    } finally { cache.close(); }
  });
});

test("ZCode Start Plan 忽略旧 Coding Plan 的停用镜像", { timeout: 60_000 }, async () => {
  await fixture(async (home) => {
    const mock = mockWatch();
    const disabledConfig = planConfig("zai");
    const provider = disabledConfig.provider["builtin:zai-start-plan"]!;
    Object.assign(provider, { enabled: false, systemDisabledReason: "coding_plan_not_entitled" });
    json(path.join(home, "setting.json"), connectionSettings("start-plan"));
    json(path.join(home, "config.json"), disabledConfig);
    json(path.join(home, "credentials.json"), { zcodejwttoken: "current-start-jwt" });
    const cache = createZcodeConfigCache(home, { watch: mock.watch });
    try {
      const snapshot = await cache.get();
      assert.equal(snapshot.family, "zai");
      assert.equal(snapshot.providerID, "builtin:zai-start-plan");
      assert.equal(snapshot.apiKey, "current-start-jwt");
      assert.notEqual(snapshot.apiKey, disabledConfig.provider["builtin:zai-start-plan"]!.options.apiKey);
      assert.deepEqual(snapshot.modelIds, ["glm-5"]);
    } finally { cache.close(); }
  });
});

test("ZCode 全新安装只有 connectionSelections 时可选通并命中 config 镜像", { timeout: 60_000 }, async () => {
  await fixture(async (home) => {
    const mock = mockWatch();
    // 无任何 legacy 选择字段：只有 3.12.3 全新安装机器才会出现这个组合。
    json(path.join(home, "setting.json"), connectionSettings("individual-coding-plan", "bigmodel"));
    json(path.join(home, "config.json"), planConfig("bigmodel"));
    const cache = createZcodeConfigCache(home, { watch: mock.watch });
    try {
      const snapshot = await cache.get();
      assert.equal(snapshot.family, "bigmodel");
      assert.equal(snapshot.providerID, "builtin:bigmodel-coding-plan");
      assert.equal(snapshot.apiKey, "test-coding-key");
      assert.equal(snapshot.baseURL, URL_B);
    } finally { cache.close(); }
  });
});

test("ZCode connectionSelections 条目缺失或形状非法时回退 legacy 解析", { timeout: 60_000 }, async () => {
  await fixture(async (home) => {
    const mock = mockWatch();
    const id = "custom:account:provider";
    const legacy = { providerFamilyDomain: "zai", modelProviderFamilySelectedKeys: { zai: `apikey:${id}` } };
    const cases = [
      // 迁移惰性持久化：升级后未重启、api-key 模式被迁移跳过、team 连接未解析，
      // 三个窗口下磁盘只有 legacy 选择。
      legacy,
      { ...legacy, providerFamilyConnectionSelections: "garbage" },
      { ...legacy, providerFamilyConnectionSelections: { zai: "garbage" } },
      { ...legacy, providerFamilyConnectionSelections: { zai: { kind: 123 } } },
      { ...legacy, providerFamilyConnectionSelections: { zai: { kind: "" } } },
      { ...legacy, providerFamilyConnectionSelections: {} },
      // 其他 family 的选择不干预当前渠道。
      { ...legacy, providerFamilyConnectionSelections: { bigmodel: { kind: "individual-coding-plan" } } },
    ];
    for (const [index, broken] of cases.entries()) {
      json(path.join(home, "setting.json"), broken);
      json(path.join(home, "config.json"), { provider: { [id]: { options: { apiKey: `test-legacy-key-${index}`, baseURL: URL_A }, models: { "glm-5": {} } } } });
      const cache = createZcodeConfigCache(home, { watch: mock.watch });
      try {
        const snapshot = await cache.get();
        assert.equal(snapshot.providerID, id);
        assert.equal(snapshot.apiKey, `test-legacy-key-${index}`);
      } finally { cache.close(); }
      fs.unlinkSync(path.join(home, "setting.json"));
    }
  });
});

test("ZCode connectionSelections 未知 kind 报错且不回退冻结的 legacy 选择", { timeout: 60_000 }, async () => {
  await fixture(async (home) => {
    const mock = mockWatch();
    // legacy 选择仍存在（升级安装），但条目里已是未知 kind 时必须报错而不是静默跟随旧渠道。
    json(path.join(home, "setting.json"), { providerFamilyDomain: "zai",
      modelProviderFamilySelectedKeys: { zai: "plan:builtin:zai-coding-plan" },
      providerFamilyConnectionSelections: { zai: { kind: "future-plan" } } });
    json(path.join(home, "config.json"), planConfig());
    const cache = createZcodeConfigCache(home, { watch: mock.watch });
    try {
      await assert.rejects(cache.get(), (error: unknown) => {
        assert.ok(error instanceof ZcodeConfigError);
        assert.ok(error.message.includes("future-plan"));
        return true;
      });
      json(path.join(home, "setting.json"), connectionSettings("another-unknown-kind"));
      mock.change(home, "setting.json");
      await eventually(async () => {
        await assert.rejects(cache.get(), (error: unknown) => {
          assert.ok(error instanceof ZcodeConfigError);
          assert.ok(error.message.includes("another-unknown-kind"));
          return true;
        });
      });
    } finally { cache.close(); }
  });
});

test("ZCode 套餐槽位汇总两个渠道的连接，plan 缓存固定解析各自槽位", { timeout: 60_000 }, async () => {
  await fixture(async (home) => {
    const mock = mockWatch();
    // 模拟真实 3.14.0 磁盘：zai 连个人、bigmodel 连团队，两个渠道的连接并存。
    json(path.join(home, "setting.json"), {
      providerFamilyDomain: "zai",
      providerFamilyConnectionSelections: {
        zai: { kind: "individual-coding-plan" },
        bigmodel: { kind: "team-coding-plan", productId: "product-a", organizationId: "organization-a", projectId: "project-a" },
      },
    });
    json(path.join(home, "v2", "config.json"), { provider: {
      "builtin:zai-coding-plan": { options: { apiKey: "test-coding-key", baseURL: URL_A }, models: { "glm-5": {} } },
      "builtin:bigmodel-coding-plan": { options: { apiKey: "", baseURL: URL_B }, models: { "glm-5": {} } },
      "builtin:zai-start-plan": { options: { apiKey: "stale-mirror-jwt", baseURL: URL_A }, models: { "glm-5": {} } },
    } });
    json(path.join(home, "credentials.json"), {
      "oauth:zai:access_token": "test-access",
      "oauth:bigmodel:access_token": "test-team-oauth",
      zcodejwttoken: "test-zcode-jwt",
    });
    const individual = createZcodeConfigCache(home, { watch: mock.watch, plan: "individual-coding-plan" });
    const team = createZcodeConfigCache(home, { watch: mock.watch, plan: "team-coding-plan", fetch: teamFetch({ "project-a": "test-team-key" }) });
    const startPlan = createZcodeConfigCache(home, { watch: mock.watch, plan: "start-plan" });
    const apiKey = createZcodeConfigCache(home, { watch: mock.watch, plan: "api-key" });
    try {
      assert.equal((await individual.get()).providerID, "builtin:zai-coding-plan");
      assert.equal((await individual.get()).apiKey, "test-coding-key");
      const teamSnapshot = await team.get();
      assert.equal(teamSnapshot.family, "bigmodel");
      assert.equal(teamSnapshot.providerID, "builtin:bigmodel-coding-plan");
      assert.equal(teamSnapshot.plan, "team-coding-plan");
      assert.equal(teamSnapshot.apiKey, "test-team-key.test-team-key-secret");
      assert.equal((await startPlan.get()).providerID, "builtin:zai-start-plan");
      assert.equal((await startPlan.get()).apiKey, "test-zcode-jwt");
      assert.equal((await startPlan.get()).plan, "start-plan");
      // api-key 槽位只跟随当前渠道：zai 连的是个人，没有自定义 provider 选择。
      await assert.rejects(() => apiKey.get(), /未选择自定义 provider/);
    } finally {
      individual.close();
      team.close();
      startPlan.close();
      apiKey.close();
    }
  });
});

test("ZCode 仅保留仍有 OAuth 凭证的套餐连接槽位", { timeout: 60_000 }, async () => {
  await fixture(async (home) => {
    const mock = mockWatch();
    // 3.14.0 切换渠道后 zai 的个人连接可能仍留在 setting.json，但账号实际只有
    // bigmodel 团队凭证；无凭证的残留槽位不能继续暴露旧个人 Key。
    json(path.join(home, "setting.json"), {
      providerFamilyDomain: "bigmodel",
      providerFamilyConnectionSelections: {
        zai: { kind: "individual-coding-plan" },
        bigmodel: { kind: "team-coding-plan", productId: "product-a", organizationId: "organization-a", projectId: "project-a" },
      },
    });
    json(path.join(home, "v2", "config.json"), { provider: {
      "builtin:zai-coding-plan": { options: { apiKey: "stale-personal-key", baseURL: URL_A }, models: { "glm-5": {} } },
      "builtin:bigmodel-coding-plan": { options: { apiKey: "", baseURL: URL_B }, models: { "glm-5": {} } },
    } });
    json(path.join(home, "credentials.json"), { "oauth:bigmodel:access_token": "bigmodel-team-oauth" });
    const individual = createZcodeConfigCache(home, { watch: mock.watch, plan: "individual-coding-plan" });
    const team = createZcodeConfigCache(home, { watch: mock.watch, plan: "team-coding-plan", fetch: teamFetch({ "project-a": "test-team-key" }) });
    try {
      await assert.rejects(() => individual.get(), /没有可用的个人 Coding Plan 连接/);
      const snapshot = await team.get();
      assert.equal(snapshot.family, "bigmodel");
      assert.equal(snapshot.apiKey, "test-team-key.test-team-key-secret");
    } finally { individual.close(); team.close(); }
  });
});

test("ZCode bigmodel 团队槽位不接受 zai 凭证回退", { timeout: 60_000 }, async () => {
  await fixture(async (home) => {
    const mock = mockWatch();
    // 当前已切回 zai 个人，bigmodel 团队连接只是磁盘残留；此时仅有 oauth:zai
    // 不能证明 bigmodel 团队仍已登录。
    json(path.join(home, "setting.json"), {
      providerFamilyDomain: "zai",
      providerFamilyConnectionSelections: {
        zai: { kind: "individual-coding-plan" },
        bigmodel: { kind: "team-coding-plan", productId: "product-a", organizationId: "organization-a", projectId: "project-a" },
      },
    });
    json(path.join(home, "v2", "config.json"), { provider: {
      "builtin:zai-coding-plan": { options: { apiKey: "zai-personal-key", baseURL: URL_A }, models: { "glm-5": {} } },
      "builtin:bigmodel-coding-plan": { options: { apiKey: "", baseURL: URL_B }, models: { "glm-5": {} } },
    } });
    json(path.join(home, "credentials.json"), { "oauth:zai:access_token": "zai-personal-oauth" });
    const individual = createZcodeConfigCache(home, { watch: mock.watch, plan: "individual-coding-plan" });
    const team = createZcodeConfigCache(home, { watch: mock.watch, plan: "team-coding-plan" });
    try {
      assert.equal((await individual.get()).family, "zai");
      await assert.rejects(() => team.get(), /没有可用的团队 Coding Plan 连接/);
    } finally { individual.close(); team.close(); }
  });
});

test("ZCode 个人连接在对应渠道凭证恢复后重新可用", { timeout: 60_000 }, async () => {
  await fixture(async (home) => {
    const mock = mockWatch();
    json(path.join(home, "setting.json"), connectionSettings("individual-coding-plan"));
    json(path.join(home, "config.json"), planConfig());
    json(path.join(home, "credentials.json"), {});
    const cache = createZcodeConfigCache(home, { watch: mock.watch, plan: "individual-coding-plan" });
    try {
      await assert.rejects(() => cache.get(), /没有可用的个人 Coding Plan 连接/);
      json(path.join(home, "credentials.json"), { "oauth:zai:access_token": "restored-oauth" });
      mock.change(home, "credentials.json");
      await eventually(async () => {
        const snapshot = await cache.get();
        assert.equal(snapshot.providerID, "builtin:zai-coding-plan");
        assert.equal(snapshot.apiKey, "test-coding-key");
      });
      json(path.join(home, "credentials.json"), {});
      mock.change(home, "credentials.json");
      await eventually(async () => {
        await assert.rejects(() => cache.get(), /没有可用的个人 Coding Plan 连接/);
      });
    } finally { cache.close(); }
  });
});

test("单个渠道解析失败只影响该渠道的套餐槽位", { timeout: 60_000 }, async () => {
  await fixture(async (home) => {
    const mock = mockWatch();
    json(path.join(home, "setting.json"), {
      providerFamilyDomain: "zai",
      providerFamilyConnectionSelections: {
        zai: { kind: "another-unknown-kind" },
        bigmodel: { kind: "team-coding-plan", productId: "product-a", organizationId: "organization-a", projectId: "project-a" },
      },
    });
    json(path.join(home, "v2", "config.json"), { provider: {
      "builtin:bigmodel-coding-plan": { options: { apiKey: "", baseURL: URL_B }, models: { "glm-5": {} } },
    } });
    json(path.join(home, "credentials.json"), {
      "oauth:bigmodel:access_token": "test-team-oauth", zcodejwttoken: "test-zcode-jwt",
    });
    const team = createZcodeConfigCache(home, { watch: mock.watch, plan: "team-coding-plan", fetch: teamFetch({ "project-a": "test-team-key" }) });
    const individual = createZcodeConfigCache(home, { watch: mock.watch, plan: "individual-coding-plan" });
    try {
      assert.equal((await team.get()).providerID, "builtin:bigmodel-coding-plan");
      // 个人槽位缺失时，优先透出当前渠道的根因（未知 kind 携带原值）。
      await assert.rejects(() => individual.get(), (error: unknown) => {
        assert.ok(error instanceof ZcodeConfigError);
        assert.match(error.message, /another-unknown-kind/);
        return true;
      });
    } finally { team.close(); individual.close(); }
  });
});

test("渠道连接形态变化时 plan 缓存重新解析槽位", { timeout: 60_000 }, async () => {
  await fixture(async (home) => {
    const mock = mockWatch();
    json(path.join(home, "setting.json"), connectionSettings("individual-coding-plan"));
    json(path.join(home, "config.json"), planConfig());
    json(path.join(home, "credentials.json"), { "oauth:zai:access_token": "test-access", zcodejwttoken: "test-access" });
    const startPlan = createZcodeConfigCache(home, { watch: mock.watch, plan: "start-plan" });
    const individual = createZcodeConfigCache(home, { watch: mock.watch, plan: "individual-coding-plan" });
    try {
      assert.equal((await individual.get()).providerID, "builtin:zai-coding-plan");
      // Start Plan 槽位不依赖连接形态：zai 连着个人时免费档依然可解析。
      const initialStart = await startPlan.get();
      assert.equal(initialStart.providerID, "builtin:zai-start-plan");
      assert.equal(initialStart.apiKey, "test-access");
      json(path.join(home, "setting.json"), connectionSettings("start-plan"));
      mock.change(home, "setting.json");
      // 个人槽位随连接形态消失；免费槽位不受影响，快照对象保持稳定。
      await eventually(async () => {
        await assert.rejects(() => individual.get(), /没有可用的个人 Coding Plan 连接/);
      });
      assert.equal(await startPlan.get(), initialStart);
    } finally { startPlan.close(); individual.close(); }
  });
});
