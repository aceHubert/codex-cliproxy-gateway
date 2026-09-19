import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CodebuddyCredentialError,
  codebuddyEndpoint,
  createCodebuddyCredentialCache,
  defaultAuthDirectory,
  codebuddyCredentialsPresent,
  profileForAuth,
  profileProduct,
  profileRegion,
  profileSite,
  tokenIssuer,
} from "../src/codebuddy/credentials.ts";

function jwt(iss: string): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iss, exp: 1893456000 })}.${encode({ sig: "test" })}`;
}

function infoFile(domain: string, issuer: string, extra: Record<string, unknown> = {}): { account: Record<string, unknown>; auth: Record<string, unknown> } {
  return {
    account: { uid: "uid-1234", enterpriseId: "" },
    auth: {
      accessToken: jwt(issuer),
      refreshToken: jwt("https://refresh.example"),
      domain,
      expiresAt: Date.now() + 90 * 24 * 3600 * 1000,
      ...extra,
    },
  };
}

test("tokenIssuer 提取 JWT iss；非 JWT 与损坏载荷返回 undefined", () => {
  assert.equal(tokenIssuer(jwt("https://www.codebuddy.ai/auth/realms/copilot")), "https://www.codebuddy.ai/auth/realms/copilot");
  assert.equal(tokenIssuer("not-a-jwt"), undefined);
  assert.equal(tokenIssuer("a.!!!.c"), undefined);
});

test("profileForAuth 双源判定：已知域名与 issuer 各自归位", () => {
  const issuerOf = { "www.codebuddy.cn": "https://www.codebuddy.cn/auth/realms/copilot", "www.codebuddy.ai": "https://www.codebuddy.ai/auth/realms/copilot" } as Record<string, string>;
  assert.equal(profileForAuth(infoFile("www.codebuddy.cn", issuerOf["www.codebuddy.cn"]).auth), "cn-cli");
  assert.equal(profileForAuth(infoFile("www.codebuddy.ai", issuerOf["www.codebuddy.ai"]).auth), "intl-cli");
  assert.equal(profileForAuth(infoFile("www.workbuddy.cn", "https://www.workbuddy.cn/auth/realms/x").auth), "cn-work");
  assert.equal(profileForAuth(infoFile("www.workbuddy.ai", "https://www.workbuddy.ai/auth/realms/x").auth), "intl-work");
  // 共享端点 copilot.tencent.com 由品牌域名消歧，双 copilot 默认 cn-cli。
  assert.equal(profileForAuth(infoFile("copilot.tencent.com", "https://copilot.tencent.com/auth/realms/x").auth), "cn-cli");
  assert.equal(profileForAuth(infoFile("copilot.tencent.com", "https://www.workbuddy.cn/auth/realms/x").auth), "cn-work");
  // 共享端点指向国际站属于区域冲突，拒绝（对齐 codebuddy2api 的 site_for_auth）。
  assert.throws(() => profileForAuth(infoFile("copilot.tencent.com", "https://www.codebuddy.ai/auth/realms/copilot").auth), /不同区域站点/);
  // 缺 domain 时 issuer 单源即可判定。
  const noDomain = infoFile("", "https://www.workbuddy.ai/auth/realms/x");
  assert.equal(profileForAuth(noDomain.auth), "intl-work");
});

test("profileForAuth 拒绝未知域名、区域冲突与产品冲突", () => {
  assert.throws(() => profileForAuth(infoFile("evil.example.com", "https://www.codebuddy.ai/auth/realms/copilot").auth), /不在官方端点白名单内/);
  assert.throws(() => profileForAuth(infoFile("www.codebuddy.cn", "https://www.codebuddy.ai/auth/realms/copilot").auth), /不同区域站点/);
  assert.throws(() => profileForAuth(infoFile("www.codebuddy.ai", "https://www.workbuddy.ai/auth/realms/x").auth), /不同产品/);
  // issuer 允许带路径，但域名外的东西（端口、userinfo、query）一律拒绝。
  assert.throws(() => profileForAuth(infoFile("", "https://www.codebuddy.ai:8443/auth/realms/x").auth), /白名单/);
  assert.throws(() => profileForAuth(infoFile("https://user@www.codebuddy.ai", "https://www.codebuddy.ai/auth/realms/x").auth), /白名单/);
});

test("profile 派生与端点白名单", () => {
  assert.equal(profileRegion("cn-work"), "cn");
  assert.equal(profileRegion("intl-cli"), "intl");
  assert.equal(profileProduct("intl-work"), "work");
  assert.equal(profileProduct("cn-cli"), "cli");
  assert.equal(profileSite("intl-cli"), "international");
  assert.equal(profileSite("cn-work"), "domestic");
  assert.equal(codebuddyEndpoint("intl-cli"), "https://www.codebuddy.ai");
  assert.equal(codebuddyEndpoint("cn-cli"), "https://copilot.tencent.com");
  assert.equal(codebuddyEndpoint("cn-work"), "https://www.workbuddy.cn");
  assert.equal(codebuddyEndpoint("intl-work"), "https://www.workbuddy.ai");
});

test("凭据缓存扫描目录并按前缀产品选取接口", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cb-cred-"));
  try {
    fs.writeFileSync(path.join(directory, "Tencent-Cloud.coding-copilot.info"),
      JSON.stringify(infoFile("www.codebuddy.ai", "https://www.codebuddy.ai/auth/realms/copilot", { lastRefreshTime: 2_000 })));
    const cache = createCodebuddyCredentialCache(directory);
    try {
      const cli = await cache.forProduct("cli");
      assert.equal(cli.profile, "intl-cli");
      assert.equal(cli.endpoint, "https://www.codebuddy.ai");
      assert.equal(cli.accountUid, "uid-1234");
      assert.equal(cli.domain, "www.codebuddy.ai");
      // 只有 cli 登录时 workbuddy/ 前缀回退同一 token，但接口换成 IDE 端点与身份。
      const work = await cache.forProduct("work");
      assert.equal(work.profile, "intl-work");
      assert.equal(work.endpoint, "https://www.workbuddy.ai");
      assert.equal(work.accessToken, cli.accessToken, "同地域回退沿用现有登录的 token");
    } finally {
      cache.close();
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("双产品登录时按前缀各自选取，不再互相回退", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cb-cred-duo-"));
  try {
    fs.writeFileSync(path.join(directory, "cli.info"),
      JSON.stringify(infoFile("www.codebuddy.ai", "https://www.codebuddy.ai/auth/realms/copilot", { lastRefreshTime: 1_000 })));
    fs.writeFileSync(path.join(directory, "work.info"),
      JSON.stringify(infoFile("www.workbuddy.ai", "https://www.workbuddy.ai/auth/realms/x", { lastRefreshTime: 2_000 })));
    const cache = createCodebuddyCredentialCache(directory);
    try {
      const cli = await cache.forProduct("cli");
      const work = await cache.forProduct("work");
      assert.equal(cli.profile, "intl-cli");
      assert.equal(work.profile, "intl-work");
      assert.notEqual(cli.accessToken, work.accessToken, "双产品登录各用各的 token");
    } finally {
      cache.close();
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("混合地域登录以最近刷新者决定活动地域", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cb-cred-mixed-"));
  try {
    fs.writeFileSync(path.join(directory, "cn.info"),
      JSON.stringify(infoFile("www.codebuddy.cn", "https://www.codebuddy.cn/auth/realms/copilot", { lastRefreshTime: 5_000 })));
    fs.writeFileSync(path.join(directory, "intl.info"),
      JSON.stringify(infoFile("www.codebuddy.ai", "https://www.codebuddy.ai/auth/realms/copilot", { lastRefreshTime: 1_000 })));
    const cache = createCodebuddyCredentialCache(directory);
    try {
      // cn 登录更新 → 活动地域 cn；两个前缀都落在 cn 端点。
      assert.equal((await cache.forProduct("cli")).endpoint, "https://copilot.tencent.com");
      const work = await cache.forProduct("work");
      assert.equal(work.endpoint, "https://www.workbuddy.cn");
      assert.equal(work.profile, "cn-work");
    } finally {
      cache.close();
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("同 profile 多文件取最近刷新的一份", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cb-cred-dup-"));
  try {
    const older = infoFile("www.codebuddy.ai", "https://www.codebuddy.ai/auth/realms/copilot", { lastRefreshTime: 1_000 });
    const newer = infoFile("www.codebuddy.ai", "https://www.codebuddy.ai/auth/realms/copilot", { lastRefreshTime: 9_000 });
    newer.auth.accessToken = jwt("https://www.codebuddy.ai/auth/realms/copilot") + "new";
    fs.writeFileSync(path.join(directory, "a-stale.info"), JSON.stringify(older));
    fs.writeFileSync(path.join(directory, "b-fresh.info"), JSON.stringify(newer));
    const cache = createCodebuddyCredentialCache(directory);
    try {
      const credential = await cache.forProduct("cli");
      assert.equal(credential.accessToken, newer.auth.accessToken, "最近刷新的登录优先");
    } finally {
      cache.close();
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("单个损坏/未知域名的 .info 只跳过，不拖垮其余有效登录", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cb-cred-bad-"));
  try {
    fs.writeFileSync(path.join(directory, "broken.info"), "{ not json");
    fs.writeFileSync(path.join(directory, "foreign.info"),
      JSON.stringify(infoFile("other-product.example.com", "https://other.example/auth/realms/x")));
    const linkTarget = path.join(directory, "target.info");
    fs.writeFileSync(linkTarget, JSON.stringify(infoFile("www.codebuddy.ai", "https://www.codebuddy.ai/auth/realms/copilot")));
    fs.symlinkSync(linkTarget, path.join(directory, "link.info"));
    fs.writeFileSync(path.join(directory, "good.info"),
      JSON.stringify(infoFile("www.codebuddy.ai", "https://www.codebuddy.ai/auth/realms/copilot")));
    const cache = createCodebuddyCredentialCache(directory);
    try {
      const credential = await cache.forProduct("cli");
      assert.equal(credential.profile, "intl-cli");
    } finally {
      cache.close();
    }
    // 全部无效时错误带文件名上下文。
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "cb-cred-none-"));
    try {
      fs.writeFileSync(path.join(empty, "broken.info"), "{ not json");
      const failing = createCodebuddyCredentialCache(empty);
      try {
        await assert.rejects(failing.forProduct("cli"), (error: unknown) => {
          assert.ok(error instanceof CodebuddyCredentialError);
          assert.match(error.message, /broken\.info/);
          return true;
        });
      } finally {
        failing.close();
      }
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("临近过期的凭据返回带修复指引的错误，重读成功后恢复", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cb-cred-exp-"));
  const file = path.join(directory, "test.info");
  fs.writeFileSync(file, JSON.stringify(infoFile("www.codebuddy.ai", "https://www.codebuddy.ai/auth/realms/copilot", { expiresAt: Date.now() + 60_000 })));
  const cache = createCodebuddyCredentialCache(directory);
  try {
    await assert.rejects(cache.forProduct("cli"), /重新登录/);
    // CLI 完成刷新：写回新的有效期。签名重扫同步生效，无需等待 watch 事件。
    fs.writeFileSync(file, JSON.stringify(infoFile("www.codebuddy.ai", "https://www.codebuddy.ai/auth/realms/copilot")));
    const credential = await cache.forProduct("cli");
    assert.equal(credential.profile, "intl-cli");
  } finally {
    cache.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("mtime 热更新：CLI 刷新 token 后网关读取新 accessToken", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cb-cred-hot-"));
  const file = path.join(directory, "test.info");
  const first = infoFile("www.codebuddy.ai", "https://www.codebuddy.ai/auth/realms/copilot");
  fs.writeFileSync(file, JSON.stringify(first));
  const cache = createCodebuddyCredentialCache(directory);
  try {
    const before = await cache.forProduct("cli");
    const rotated = infoFile("www.codebuddy.ai", "https://www.codebuddy.ai/auth/realms/copilot");
    (rotated.auth).accessToken = jwt("https://www.codebuddy.ai/auth/realms/copilot") + "x";
    fs.writeFileSync(file, JSON.stringify(rotated));
    // 签名（mtime/size/ino）变化在下一次选取前同步重扫，不依赖 fs.watch 事件到达。
    const after = await cache.forProduct("cli");
    assert.notEqual(after.accessToken, before.accessToken, "刷新后的 token 必须立即可见");
  } finally {
    cache.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("defaultAuthDirectory 按平台指向桌面扩展公共认证目录", () => {
  const directory = defaultAuthDirectory();
  assert.ok(directory.endsWith(path.join("CodeBuddyExtension", "Data", "Public", "auth")), directory);
});

test("codebuddyCredentialsPresent 只做目录级存在性探测", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccp-codebuddy-present-"));
  try {
    assert.equal(codebuddyCredentialsPresent(root), false, "目录内没有 .info 视为未登录");
    assert.equal(codebuddyCredentialsPresent(path.join(root, "missing")), false, "目录缺失视为未登录");
    // 内容不解析：空文件也算「检测到」，可用性留给网关侧凭据缓存判定。
    fs.writeFileSync(path.join(root, "whatever.info"), "");
    fs.writeFileSync(path.join(root, "noise.txt"), "");
    assert.equal(codebuddyCredentialsPresent(root), true, "存在 .info 即视为已登录");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
