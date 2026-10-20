import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CodebuddyDependencies } from "@agent-proxy/codebuddy";
import { collectAdapterModels } from "../apps/gateway/src/model-composition.ts";
import { pushModelsToTargets } from "../apps/gateway/src/models-push.ts";
import { createZcodePushTarget, resolveZcodeClientPaths } from "../apps/gateway/src/zcode-client-sync.ts";
import type { GatewayConfig } from "../apps/gateway/src/types.ts";
import test from "./host-test.ts";

const TIMEOUT = { timeout: 60_000 };
const BOTH_REGION_SLUGS = [
  "codebuddy-cn/shared-model",
  "codebuddy-intl/shared-model",
  "workbuddy-cn/shared-model",
  "workbuddy-intl/shared-model",
];

function loginInfo(domain: string, lastRefreshTime: number) {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const token = `${encode({ alg: "RS256" })}.${encode({ iss: `https://${domain}/auth/realms/copilot` })}.test`;
  return {
    account: { uid: "sync-test-account", enterpriseId: "" },
    auth: {
      domain,
      accessToken: token,
      refreshToken: "sync-test-refresh-token",
      expiresAt: Date.now() + 3_600_000,
      lastRefreshTime,
    },
  };
}

function makeFixture(regions: readonly ("cn" | "intl")[] = ["cn", "intl"]) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codebuddy-model-sync-"));
  const authDirectory = path.join(directory, "auth");
  const cacheDirectory = path.join(directory, "runtime");
  fs.mkdirSync(authDirectory);
  fs.mkdirSync(cacheDirectory);
  for (const region of regions) {
    const domain = region === "cn" ? "www.codebuddy.cn" : "www.codebuddy.ai";
    // 国内登录更新，确认 auto 仍保留较旧国际登录所支持的目录。
    fs.writeFileSync(path.join(authDirectory, `${region}.info`), JSON.stringify(loginInfo(domain, region === "cn" ? 2_000 : 1_000)));
  }
  const config: GatewayConfig = {
    host: "127.0.0.1", port: 8327, mountPath: "/v1", prefix: "cliproxy/",
    officialBaseUrl: "https://official.invalid/v1", upstreamBaseUrl: "https://upstream.invalid/v1",
    catalogPath: path.join(cacheDirectory, "models.json"),
    zcode: false, codebuddy: true, qoder: false, agy: false, opencodeZen: false,
    codebuddyAccount: "auto", upstreamOnly: true,
  };
  const requested: string[] = [];
  const allowedOrigins = new Set(regions.flatMap((region) => region === "cn"
    ? ["https://copilot.tencent.com", "https://www.workbuddy.cn"]
    : ["https://www.codebuddy.ai", "https://www.workbuddy.ai"]));
  const dependencies: CodebuddyDependencies = {
    authDirectory,
    cacheDirectory,
    codexModelsCacheFile: path.join(directory, "codex-models-cache.json"),
    setInterval: (() => { throw new Error("模型同步不得启动后台刷新计时器"); }) as typeof setInterval,
    fetch: async (url, init) => {
      const parsed = new URL(url);
      assert.ok(allowedOrigins.has(parsed.origin), `不应请求未登录地域的接口：${url}`);
      assert.equal(parsed.pathname, "/v3/config");
      assert.equal(init.method, "GET");
      requested.push(url);
      return Response.json({
        code: 0,
        data: {
          models: [{ id: "shared-model", name: "同名模型", supportsToolCall: true, maxInputTokens: 120_000 }],
          agents: [
            { name: "cli", models: ["shared-model"] },
            { name: "general", tags: ["default"], models: ["shared-model"] },
          ],
        },
      });
    },
  };
  return { directory, cacheDirectory, config, dependencies, requested };
}

test("模型同步刷新同时采集两地目录，并从各 profile 缓存离线恢复同名模型", TIMEOUT, async () => {
  const fixture = makeFixture();
  try {
    const { config, dependencies, cacheDirectory, requested } = fixture;
    const refreshed = await collectAdapterModels(config, { codebuddy: dependencies }, { refresh: true, cacheDirectory });
    assert.deepEqual(refreshed.failures, []);
    assert.deepEqual(refreshed.entries.map((entry) => entry.slug).sort(), BOTH_REGION_SLUGS);
    assert.deepEqual(requested.sort(), [
      "https://copilot.tencent.com/v3/config",
      "https://www.codebuddy.ai/v3/config",
      "https://www.workbuddy.ai/v3/config",
      "https://www.workbuddy.cn/v3/config",
    ]);
    for (const [product, profiles] of [
      ["codebuddy", ["cn-cli", "intl-cli"]],
      ["workbuddy", ["cn-work", "intl-work"]],
    ] as const) {
      const cache = JSON.parse(fs.readFileSync(path.join(cacheDirectory, `${product}-catalog.json`), "utf8"));
      assert.deepEqual(Object.keys(cache.profiles).sort(), profiles);
    }
    let offlineRequests = 0;
    const offline = await collectAdapterModels(config, {
      codebuddy: { ...dependencies, fetch: async () => { offlineRequests++; throw new Error("禁止离线同步访问网络"); } },
    }, { refresh: false, cacheDirectory });
    assert.equal(offlineRequests, 0);
    assert.deepEqual(offline, refreshed);
  } finally {
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("模型同步仅存在国内 info 登录时不生成或请求国际目录", TIMEOUT, async () => {
  const fixture = makeFixture(["cn"]);
  try {
    const result = await collectAdapterModels(fixture.config, { codebuddy: fixture.dependencies }, {
      refresh: true, cacheDirectory: fixture.cacheDirectory,
    });
    assert.deepEqual(result.failures, []);
    assert.deepEqual(result.entries.map((entry) => entry.slug).sort(), ["codebuddy-cn/shared-model", "workbuddy-cn/shared-model"]);
    assert.equal(fixture.requested.length, 2);
  } finally {
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("模型同步推送把两地同名模型完整写入 ZCode 的模型映射和选择顺序", TIMEOUT, async () => {
  const fixture = makeFixture();
  try {
    const { config, dependencies, cacheDirectory } = fixture;
    await collectAdapterModels(config, { codebuddy: dependencies }, { refresh: true, cacheDirectory });
    const collected = await collectAdapterModels(config, {
      codebuddy: { ...dependencies, fetch: async () => { throw new Error("推送只能读取本地目录"); } },
    }, { refresh: false, cacheDirectory });
    const env = { HOME: fixture.directory, ZCODE_HOME: path.join(fixture.directory, "zcode") };
    const paths = resolveZcodeClientPaths(env);
    fs.mkdirSync(paths.v2, { recursive: true });
    fs.writeFileSync(paths.configFile, JSON.stringify({ provider: {} }));
    fs.writeFileSync(paths.providerConfigFile, JSON.stringify({ config: {
      providerOrder: [],
      providerConfigRules: { providerRules: [] },
      modelConfigRules: { providerModelRules: [] },
    } }));
    await pushModelsToTargets({
      ...collected,
      config,
      targets: [createZcodePushTarget({ config, env })],
    });
    const document = JSON.parse(fs.readFileSync(paths.providerConfigFile, "utf8"));
    const rules = document.config.providerConfigRules.providerRules;
    assert.equal(rules.length, 1);
    const rule = rules[0];
    assert.equal(rule.providerName, "AgentProxy");
    assert.deepEqual([...rule.config.modelOrder].sort(), BOTH_REGION_SLUGS);
    assert.deepEqual(rule.config.personalModelIds, rule.config.modelOrder);
    const client = JSON.parse(fs.readFileSync(paths.configFile, "utf8"));
    assert.deepEqual(Object.keys(client.provider[rule.providerId].models).sort(), BOTH_REGION_SLUGS);
    assert.deepEqual(document.config.modelConfigRules.providerModelRules.map((item: { modelId: string }) => item.modelId).sort(), BOTH_REGION_SLUGS);
  } finally {
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});
