import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "./host-test.ts";
import { bindHostMethods, getHostServices, withHostServices, type GatewayPlugin } from "@agent-proxy/plugin-api";
import { getActiveAccount, withInstanceContext as withCodebuddyContext } from "@agent-proxy/codebuddy";
import { getActiveSources, withInstanceContext as withQoderContext } from "@agent-proxy/qoder";
import { createGatewayHostServices } from "../apps/gateway/src/host-services.ts";
import { resolvePaths } from "../apps/gateway/src/paths.ts";
import type { GatewayConfig } from "../apps/gateway/src/types.ts";

function config(account = "auto"): GatewayConfig {
  return { host: "127.0.0.1", port: 0, mountPath: "/v1", prefix: "cliproxy/", officialBaseUrl: "https://official.invalid", upstreamBaseUrl: "https://upstream.invalid", catalogPath: "", codebuddyAccount: account };
}

function host(home: string) {
  return createGatewayHostServices(config(), undefined, resolvePaths({ HOME: home }, path.join(home, "runtime")));
}

test("并发主机上下文跨异步边界保持实例隔离", async () => {
  const first = host("/synthetic/first");
  const second = host("/synthetic/second");
  const observed = await Promise.all([first, second].map((current) => withHostServices(current, async () => {
    const before = getHostServices().getPaths().home;
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
    return [before, getHostServices().getPaths().home];
  })));
  assert.deepEqual(observed, [["/synthetic/first", "/synthetic/first"], ["/synthetic/second", "/synthetic/second"]]);
});

test("绑定的插件目录和关闭方法使用创建实例的主机上下文", async () => {
  const first = host("/synthetic/owner");
  const second = host("/synthetic/caller");
  const observations: string[] = [];
  const lifecycle = withHostServices(first, () => bindHostMethods({
    id: "bound", modelPatterns: ["bound/*"],
    handleHttp: () => new Response(getHostServices().getPaths().home),
    async getCatalog() {
      await Promise.resolve();
      return { models: [{ slug: getHostServices().getPaths().home }] };
    },
    refreshCatalog: async () => ({ models: [] }),
    reloadCatalog: async () => ({ models: [] }),
    ready: async () => { observations.push(getHostServices().getPaths().home); },
    close: () => { observations.push(getHostServices().getPaths().home); },
  } satisfies GatewayPlugin));
  await withHostServices(second, async () => {
    await lifecycle.ready();
    assert.equal((await lifecycle.getCatalog()).models[0].slug, "/synthetic/owner");
    lifecycle.close();
    assert.equal(getHostServices().getPaths().home, "/synthetic/caller");
  });
  assert.deepEqual(observations, ["/synthetic/owner", "/synthetic/owner"]);
});

function writeAccount(directory: string, file: string, nickname: string, refreshed: number): void {
  const encoded = Buffer.from(JSON.stringify({ iss: "https://www.codebuddy.ai/auth/realms/copilot", email: `${nickname}@example.invalid` })).toString("base64url");
  fs.writeFileSync(path.join(directory, file), JSON.stringify({
    account: { uid: nickname, nickname },
    auth: { domain: "www.codebuddy.ai", accessToken: `header.${encoded}.signature`, refreshToken: "synthetic-refresh", lastRefreshTime: refreshed, expiresAt: Date.now() + 3_600_000 },
  }));
}

test("CodeBuddy 零参数账号查询实时跟随配置、账号文件和实例切换", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-account-"));
  const another = path.join(directory, "another");
  fs.mkdirSync(another);
  let account = "first.info";
  try {
    writeAccount(directory, "first.info", "甲", 1);
    writeAccount(directory, "second.info", "乙", 2);
    writeAccount(another, "first.info", "其他实例", 1);
    const context = { authDirectory: directory, getConfig: () => ({ codebuddyAccount: account }) };
    withCodebuddyContext(context, () => {
      assert.equal(getActiveAccount(), "甲 <甲@example.invalid> / intl");
      account = "second.info";
      assert.equal(getActiveAccount(), "乙 <乙@example.invalid> / intl");
      writeAccount(directory, "second.info", "新账号", 3);
      const file = path.join(directory, "second.info");
      const before = fs.readFileSync(file, "utf8");
      const modified = fs.statSync(file).mtimeMs;
      assert.equal(getActiveAccount(), "新账号 <新账号@example.invalid> / intl");
      assert.equal(fs.readFileSync(file, "utf8"), before);
      assert.equal(fs.statSync(file).mtimeMs, modified);
      withCodebuddyContext({ authDirectory: another, getConfig: () => ({ codebuddyAccount: "first.info" }) }, () => {
        assert.equal(getActiveAccount(), "其他实例 <其他实例@example.invalid> / intl");
      });
      assert.equal(getActiveAccount(), "新账号 <新账号@example.invalid> / intl");
      account = "auto";
      assert.equal(getActiveAccount(), "新账号 <新账号@example.invalid> / intl");
    });
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("Qoder 零参数来源查询实时检查存在性、优先 CLI，且不解密刷新或发送网络请求", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-source-"));
  const cli = path.join(directory, "cli");
  const auth = path.join(cli, ".auth");
  const desktop = path.join(directory, "desktop");
  fs.mkdirSync(auth, { recursive: true });
  fs.mkdirSync(desktop);
  const userFile = path.join(auth, "user");
  let activeHome = directory;
  let requests = 0;
  const currentHost = host(directory);
  currentHost.fetch = Object.assign(async () => {
    requests++;
    throw new Error("只读来源查询不得发送网络请求");
  }, { preconnect: globalThis.fetch.preconnect }) as typeof fetch;
  try {
    fs.writeFileSync(path.join(desktop, "auth.v1.dat"), "无效加密内容：来源检查不能解析它");
    fs.writeFileSync(path.join(desktop, "auth.machine-id"), "machine");
    withHostServices(currentHost, () => withQoderContext({
      getHome: () => activeHome,
      getSourceOptions: () => ({ intlConfigDir: cli, intlDesktopDir: desktop, cnConfigDir: path.join(activeHome, "cn"), cnDesktopDir: null, env: {} }),
    }, () => {
      assert.deepEqual(getActiveSources(), ["DESKTOP-INTL"]);
      fs.writeFileSync(path.join(auth, "machine_id"), "machine");
      fs.writeFileSync(userFile, "无效加密内容：来源检查不能读取登录正文");
      const before = fs.readFileSync(userFile, "utf8");
      const modified = fs.statSync(userFile).mtimeMs;
      assert.deepEqual(getActiveSources(), ["CLI-INTL"]);
      assert.equal(fs.readFileSync(userFile, "utf8"), before);
      assert.equal(fs.statSync(userFile).mtimeMs, modified);
      withQoderContext({ getHome: () => path.join(directory, "empty"), getSourceOptions: () => ({ intlDesktopDir: null, cnDesktopDir: null, env: {} }) }, () => {
        assert.deepEqual(getActiveSources(), []);
      });
      assert.deepEqual(getActiveSources(), ["CLI-INTL"]);
      activeHome = path.join(directory, "changed");
      fs.mkdirSync(path.join(activeHome, "cn", ".auth"), { recursive: true });
      fs.writeFileSync(path.join(activeHome, "cn", ".auth", "user"), "存在即可");
      fs.writeFileSync(path.join(activeHome, "cn", ".auth", "machine_id"), "machine");
      assert.deepEqual(getActiveSources(), ["CLI-INTL", "CLI-CN"]);
      fs.unlinkSync(userFile);
      assert.deepEqual(getActiveSources(), ["DESKTOP-INTL", "CLI-CN"]);
    }));
    assert.equal(requests, 0);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
