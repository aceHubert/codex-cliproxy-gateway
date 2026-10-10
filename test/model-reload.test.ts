import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  createModelReloadReceiver,
  modelReloadRequestFile,
  modelReloadResultFile,
  reloadGatewayModels,
  requestModelReload,
  type ModelReloadFetch,
} from "../src/model-reload.ts";
import { instanceMarker, resolvePaths } from "../src/paths.ts";
import { atomicWrite } from "../src/toml.ts";
import type { GatewayConfig, ResolvedPaths } from "../src/types.ts";

function fixture(): { paths: ResolvedPaths; config: GatewayConfig; cleanup(): void } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccp-model-reload-"));
  const paths = resolvePaths({ HOME: home }, path.join(home, "runtime"));
  const config: GatewayConfig = {
    host: "127.0.0.1", port: 8320, mountPath: "/v1", prefix: "cliproxy/",
    officialBaseUrl: "https://official.example", upstreamBaseUrl: "https://upstream.example",
    catalogPath: paths.catalogFile, selectedModels: ["before"],
  };
  atomicWrite(paths.gatewayConfig, JSON.stringify(config));
  return { paths, config, cleanup: () => fs.rmSync(home, { recursive: true, force: true }) };
}

function result(paths: ResolvedPaths): Record<string, unknown> {
  const { receipts: _receipts, ...latest } = JSON.parse(fs.readFileSync(modelReloadResultFile(paths), "utf8"));
  return latest;
}

function health(paths: ResolvedPaths, upstreamOnly = false): Response {
  return Response.json({ ok: true, upstreamOnly }, { headers: { "x-ccp-instance": instanceMarker(paths.runtimeHome) } });
}

test("重载通知使用独立修订和仅当前用户可读的文件", () => {
  const f = fixture();
  try {
    const first = requestModelReload(f.paths);
    const second = requestModelReload(f.paths);
    assert.notEqual(first, second);
    assert.deepEqual(JSON.parse(fs.readFileSync(modelReloadRequestFile(f.paths), "utf8")), { revision: second });
    assert.equal(fs.statSync(modelReloadRequestFile(f.paths)).mode & 0o777, 0o600);
    assert.equal(path.dirname(modelReloadResultFile(f.paths)), f.paths.runtimeHome);
  } finally { f.cleanup(); }
});

test("没有通知时不读取配置或刷新目录，已有通知在创建后处理", async () => {
  const f = fixture();
  let calls = 0;
  let loaded: GatewayConfig | undefined;
  const receiver = createModelReloadReceiver(f.paths, async (config) => { calls += 1; loaded = config; });
  try {
    fs.rmSync(f.paths.gatewayConfig);
    await receiver.reloadPending();
    assert.equal(calls, 0);
    atomicWrite(f.paths.gatewayConfig, JSON.stringify({ ...f.config, selectedModels: ["after"] }));
    const revision = requestModelReload(f.paths);
    await receiver.reloadPending();
    assert.equal(calls, 1);
    assert.deepEqual(loaded?.selectedModels, ["after"]);
    assert.deepEqual(result(f.paths), { revision, status: "loaded" });
  } finally { receiver.close(); f.cleanup(); }

  const existing = fixture();
  const revision = requestModelReload(existing.paths);
  const startup = createModelReloadReceiver(existing.paths, async () => {});
  try {
    await startup.reloadPending();
    assert.deepEqual(result(existing.paths), { revision, status: "loaded" });
  } finally { startup.close(); existing.cleanup(); }
});

test("并发请求对同一修订只刷新一次，重载期间的新修订按顺序接续", async () => {
  const f = fixture();
  let calls = 0;
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const receiver = createModelReloadReceiver(f.paths, async () => {
    calls += 1;
    if (calls === 1) await blocked;
  });
  try {
    requestModelReload(f.paths);
    const first = receiver.reloadPending();
    const same = receiver.reloadPending();
    assert.equal(first, same);
    const latest = requestModelReload(f.paths);
    release();
    await Promise.all([first, same]);
    assert.equal(calls, 2);
    await receiver.reloadPending();
    assert.equal(calls, 2);
    assert.deepEqual(result(f.paths), { revision: latest, status: "loaded" });
  } finally { release(); receiver.close(); f.cleanup(); }
});

test("重载失败不会泄露异常内容，不会重复刷新，新修订可以重试", async () => {
  const f = fixture();
  let calls = 0;
  const receiver = createModelReloadReceiver(f.paths, async () => {
    calls += 1;
    if (calls === 1) throw new Error("secret-token=topsecret");
  });
  try {
    const revision = requestModelReload(f.paths);
    await receiver.reloadPending();
    assert.equal(result(f.paths).revision, revision);
    assert.equal(result(f.paths).status, "failed");
    assert.match(String(result(f.paths).error), /重新执行 models --sync/);
    assert.doesNotMatch(JSON.stringify(result(f.paths)), /topsecret|secret-token/);
    await receiver.reloadPending();
    assert.equal(calls, 1);
    requestModelReload(f.paths);
    await receiver.reloadPending();
    assert.equal(calls, 2);
    assert.equal(result(f.paths).status, "loaded");
  } finally { receiver.close(); f.cleanup(); }
});

test("接收器重启不重复处理已成功修订，不会用后来损坏的配置覆盖成功回执", async () => {
  const f = fixture();
  let calls = 0;
  const first = createModelReloadReceiver(f.paths, async () => { calls += 1; });
  let restarted: ReturnType<typeof createModelReloadReceiver> | undefined;
  try {
    const revision = requestModelReload(f.paths);
    await first.reloadPending();
    first.close();
    const saved = fs.readFileSync(modelReloadResultFile(f.paths), "utf8");
    atomicWrite(f.paths.gatewayConfig, "broken-secret");
    restarted = createModelReloadReceiver(f.paths, async () => { calls += 1; });
    await restarted.reloadPending();
    assert.equal(calls, 1);
    assert.equal(fs.readFileSync(modelReloadResultFile(f.paths), "utf8"), saved);
    assert.deepEqual(result(f.paths), { revision, status: "loaded" });
    atomicWrite(f.paths.gatewayConfig, JSON.stringify(f.config));
    const next = requestModelReload(f.paths);
    await restarted.reloadPending();
    assert.equal(calls, 2);
    assert.deepEqual(result(f.paths), { revision: next, status: "loaded" });
  } finally { first.close(); restarted?.close(); f.cleanup(); }
});

test("多个命令的独立通知在同轮得到各自回执，不因最新通知覆盖而超时", async () => {
  const f = fixture();
  let calls = 0;
  let healthCalls = 0;
  let release!: () => void;
  const bothRequested = new Promise<void>((resolve) => { release = resolve; });
  const receiver = createModelReloadReceiver(f.paths, async () => { calls += 1; });
  const fetchHealth: ModelReloadFetch = async () => {
    healthCalls += 1;
    if (healthCalls === 2) release();
    await bothRequested;
    await receiver.reloadPending();
    return health(f.paths);
  };
  try {
    const [first, second] = await Promise.all([
      reloadGatewayModels(f.paths, f.config, { fetch: fetchHealth }),
      reloadGatewayModels(f.paths, f.config, { fetch: fetchHealth }),
    ]);
    assert.notEqual(first.revision, second.revision);
    assert.equal(first.loaded, true);
    assert.equal(second.loaded, true);
    assert.equal(calls, 1);
    const receipts = JSON.parse(fs.readFileSync(modelReloadResultFile(f.paths), "utf8")).receipts;
    assert.deepEqual(new Set(receipts.map((receipt: { revision: string }) => receipt.revision)), new Set([first.revision, second.revision]));
    assert.deepEqual(fs.readdirSync(path.join(f.paths.runtimeHome, "model-reload-requests")), []);
  } finally { release(); receiver.close(); f.cleanup(); }
});

test("确认通知后清理独立文件，结果历史只保留最近 64 条且最新修订不丢失", async () => {
  const f = fixture();
  const receiver = createModelReloadReceiver(f.paths, async () => {});
  try {
    let latest = "";
    for (let i = 0; i < 70; i += 1) {
      latest = requestModelReload(f.paths);
      await receiver.reloadPending();
    }
    const saved = JSON.parse(fs.readFileSync(modelReloadResultFile(f.paths), "utf8"));
    assert.equal(saved.receipts.length, 64);
    assert.equal(saved.receipts.at(-1).revision, latest);
    assert.equal(saved.revision, latest);
    assert.deepEqual(fs.readdirSync(path.join(f.paths.runtimeHome, "model-reload-requests")), []);
  } finally { receiver.close(); f.cleanup(); }
});

test("配置和通知损坏时只返回可执行提示，不返回文件内容", async () => {
  const f = fixture();
  const receiver = createModelReloadReceiver(f.paths, async () => assert.fail("配置损坏不应调用重载"));
  try {
    atomicWrite(f.paths.gatewayConfig, "broken-secret-token");
    requestModelReload(f.paths);
    await receiver.reloadPending();
    assert.equal(result(f.paths).status, "failed");
    assert.doesNotMatch(JSON.stringify(result(f.paths)), /secret-token/);
    atomicWrite(modelReloadRequestFile(f.paths), "broken-secret-token");
    await assert.rejects(receiver.reloadPending(), /通知已损坏/);
    atomicWrite(modelReloadRequestFile(f.paths), JSON.stringify({ revision: "secret-token" }));
    await assert.rejects(receiver.reloadPending(), /修订无效/);
  } finally { receiver.close(); f.cleanup(); }
});

test("轮询无需模型请求即可接收独立进程通知，关闭后不再处理", async () => {
  const f = fixture();
  let calls = 0;
  let loaded!: () => void;
  const seen = new Promise<void>((resolve) => { loaded = resolve; });
  const receiver = createModelReloadReceiver(f.paths, async () => { calls += 1; loaded(); }, { pollIntervalMs: 5 });
  try {
    requestModelReload(f.paths);
    await Promise.race([seen, delay(1_000).then(() => assert.fail("轮询未接收通知"))]);
    receiver.close();
    requestModelReload(f.paths);
    await receiver.reloadPending();
    await delay(20);
    assert.equal(calls, 1);
  } finally { receiver.close(); f.cleanup(); }
});

test("命令只请求 healthz 并等待当前修订，不使用模型控制 API", async () => {
  const f = fixture();
  const receiver = createModelReloadReceiver(f.paths, async () => {});
  const requests: string[] = [];
  try {
    const loaded = await reloadGatewayModels(f.paths, f.config, {
      fetch: (async (input, init) => {
        requests.push(String(input));
        assert.ok(init?.signal);
        await receiver.reloadPending();
        return health(f.paths);
      }) as ModelReloadFetch,
    });
    assert.equal(loaded.loaded, true);
    assert.deepEqual(requests, ["http://127.0.0.1:8320/healthz"]);
    assert.equal(result(f.paths).revision, loaded.revision);
  } finally { receiver.close(); f.cleanup(); }
});

test("网关未运行时保留通知且不启动服务", async () => {
  const f = fixture();
  try {
    const loaded = await reloadGatewayModels(f.paths, f.config, {
      fetch: (async () => { throw new TypeError("fetch failed", { cause: Object.assign(new Error("refused"), { code: "ECONNREFUSED" }) }); }) as ModelReloadFetch,
    });
    assert.equal(loaded.loaded, false);
    assert.equal(JSON.parse(fs.readFileSync(modelReloadRequestFile(f.paths), "utf8")).revision, loaded.revision);
    assert.equal(fs.existsSync(modelReloadResultFile(f.paths)), false);
  } finally { f.cleanup(); }
});

test("模式切换等待新网关，旧模式的成功重载结果不能提前确认就绪", async () => {
  const f = fixture();
  let calls = 0;
  let time = 0;
  try {
    const loaded = await reloadGatewayModels(f.paths, { ...f.config, upstreamOnly: true }, {
      fetch: async () => {
        calls += 1;
        const { revision } = JSON.parse(fs.readFileSync(modelReloadRequestFile(f.paths), "utf8"));
        atomicWrite(modelReloadResultFile(f.paths), JSON.stringify({ revision, status: "loaded" }));
        return health(f.paths, calls >= 2);
      },
      now: () => time,
      wait: async (milliseconds) => { time += milliseconds; },
      timeoutMs: 300,
    });
    assert.equal(loaded.loaded, true);
    assert.equal(calls, 2);
    await assert.rejects(reloadGatewayModels(f.paths, { ...f.config, upstreamOnly: true }, {
      fetch: async () => health(f.paths),
      now: () => time,
      wait: async (milliseconds) => { time += milliseconds; },
      timeoutMs: 300,
    }), /未在期限内切换到目标模型模式/);
  } finally { f.cleanup(); }
});

test("其他实例及没有身份标记的响应不能确认重载", async () => {
  const f = fixture();
  try {
    for (const headers of [new Headers({ "x-ccp-instance": "wrong" }), new Headers()]) {
      await assert.rejects(reloadGatewayModels(f.paths, f.config, {
        fetch: (async () => Response.json({ ok: true }, { headers })) as ModelReloadFetch,
      }), /instance marker|different codex-cliproxy instance/);
    }
  } finally { f.cleanup(); }
});

test("失败结果与过期结果不会被误判成功，健康超时提供安全提示", async () => {
  const f = fixture();
  try {
    await assert.rejects(reloadGatewayModels(f.paths, f.config, {
      fetch: (async () => {
        const { revision } = JSON.parse(fs.readFileSync(modelReloadRequestFile(f.paths), "utf8"));
        atomicWrite(modelReloadResultFile(f.paths), JSON.stringify({ revision, status: "failed", error: "secret-token" }));
        return health(f.paths);
      }) as ModelReloadFetch,
    }), /模型配置重载失败/);
    let time = 0;
    await assert.rejects(reloadGatewayModels(f.paths, f.config, {
      fetch: (async () => health(f.paths)) as ModelReloadFetch,
      now: () => time,
      wait: async (milliseconds) => { time += milliseconds; },
      timeoutMs: 300,
    }), /未在期限内确认/);
    await assert.rejects(reloadGatewayModels(f.paths, f.config, {
      fetch: (async () => { throw new DOMException("secret-token", "TimeoutError"); }) as ModelReloadFetch,
    }), /无法确认网关健康状态/);
  } finally { f.cleanup(); }
});
