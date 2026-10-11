import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "./host-test.ts";
import { getInstallApiKey } from "../apps/gateway/src/cli.ts";
import { createApiKeyStore } from "../apps/gateway/src/keychain.ts";
import { resolvePaths, runWithInstancePaths } from "../apps/gateway/src/paths.ts";

const upstream = { upstreamBaseUrl: "https://upstream.invalid/v1", upstreamType: "cliproxy" as const };
const unexpected = (): never => { throw new Error("不应调用此密钥来源"); };

test("重装同一上游跳过提示并复用已存密钥，兼容 URL 规范化与缺省类型", () => {
  for (const previous of [upstream, { upstreamBaseUrl: "https://UPSTREAM.invalid:443/v1/" }]) {
    assert.equal(getInstallApiKey(upstream, previous, undefined, {
      env: {}, readStoredKey: () => "saved-key", prompt: unexpected,
    }), "saved-key");
  }
});

test("上游地址或类型变化不能自动向新上游发送旧密钥", () => {
  const changes = [
    { ...upstream, upstreamBaseUrl: "https://other.invalid/v1" },
    { ...upstream, upstreamBaseUrl: "https://upstream.invalid/v2" },
    { ...upstream, upstreamBaseUrl: "http://upstream.invalid/v1" },
    { ...upstream, upstreamBaseUrl: "https://upstream.invalid/v1?tenant=other" },
    { ...upstream, upstreamType: "newapi" as const },
  ];
  for (const next of changes) {
    assert.equal(getInstallApiKey(next, upstream, undefined, {
      env: {}, readStoredKey: unexpected, prompt: () => "new-key",
    }), "new-key");
  }
});

test("显式 API_KEY 和指定环境变量优先于已存密钥", () => {
  assert.equal(getInstallApiKey(upstream, upstream, undefined, {
    env: { API_KEY: "new-key" }, readStoredKey: unexpected, prompt: unexpected,
  }), "new-key");
  assert.equal(getInstallApiKey(upstream, upstream, "CUSTOM_KEY", {
    env: { API_KEY: "ignored", CUSTOM_KEY: "custom-key" }, readStoredKey: unexpected, prompt: unexpected,
  }), "custom-key");
  // 显式选择的来源缺失时仍提示，不能悄悄换成另一项凭据。
  assert.equal(getInstallApiKey(upstream, upstream, "CUSTOM_KEY", {
    env: { API_KEY: "ignored" }, readStoredKey: unexpected, prompt: () => "entered-key",
  }), "entered-key");
});

test("显式空密钥保持原规则：本地可空，远端拒绝且不回退旧值", () => {
  const dependencies = { env: { API_KEY: "" }, readStoredKey: unexpected, prompt: unexpected };
  assert.throws(() => getInstallApiKey(upstream, upstream, undefined, dependencies), /empty only for a loopback URL/);
  const local = { upstreamBaseUrl: "http://127.0.0.1:8317/v1" };
  assert.equal(getInstallApiKey(local, local, undefined, dependencies), "");
});

test("新安装或已存密钥缺失时才提示，存储损坏错误不被当成缺失", () => {
  assert.equal(getInstallApiKey(upstream, undefined, undefined, {
    env: {}, readStoredKey: unexpected, prompt: () => "first-key",
  }), "first-key");
  assert.equal(getInstallApiKey(upstream, upstream, undefined, {
    env: {}, readStoredKey: () => "", prompt: () => "replacement-key",
  }), "replacement-key");
  assert.throws(() => getInstallApiKey(upstream, upstream, undefined, {
    env: {}, readStoredKey: () => { throw new Error("credentials corrupted"); }, prompt: unexpected,
  }), /credentials corrupted/);
});

test("复用密钥只读当前实例的分派存储，不回退其他实例", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agent-proxy-install-keys-"));
  try {
    for (const [name, key] of [["a", "key-a"], ["b", "key-b"]] as const) {
      const paths = resolvePaths({ HOME: home, CODEX_CLIPROXY_HOME: path.join(home, name) });
      createApiKeyStore("linux", paths.credentialsFile).save(key);
      runWithInstancePaths(paths, () => {
        assert.equal(getInstallApiKey(upstream, upstream, undefined, {
          env: {}, readStoredKey: () => createApiKeyStore("linux", resolvePaths().credentialsFile).read(true), prompt: unexpected,
        }), key);
      });
    }
    const empty = resolvePaths({ HOME: home, CODEX_CLIPROXY_HOME: path.join(home, "empty") });
    runWithInstancePaths(empty, () => {
      assert.equal(getInstallApiKey(upstream, upstream, undefined, {
        env: {}, readStoredKey: () => createApiKeyStore("linux", resolvePaths().credentialsFile).read(true), prompt: () => "entered-key",
      }), "entered-key");
    });
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
