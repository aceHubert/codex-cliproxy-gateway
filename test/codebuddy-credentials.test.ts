import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CodebuddyCredentialError,
  codebuddyAccountLabel,
  codebuddyEndpoint,
  createCodebuddyCredentialCache,
  defaultAuthDirectory,
  codebuddyCredentialsPresent,
  isCodebuddyAccountName,
  listCodebuddyAccounts,
  profileForAuth,
  profileProduct,
  profileRegion,
  profileSite,
  resolveCodebuddyAccountFile,
  tokenIssuer,
} from "../src/codebuddy/credentials.ts";

function jwt(iss: string, claims: Record<string, unknown> = {}): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iss, exp: 1893456000, ...claims })}.${encode({ sig: "test" })}`;
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
      // 只有 cli 登录时 workbuddy-intl/ 前缀回退同一 token，但接口换成 IDE 端点与身份。
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

test("锁定账号直读单文件：跳过全扫，产品接口按需适配", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cb-cred-lock-"));
  try {
    const stale = infoFile("www.codebuddy.ai", "https://www.codebuddy.ai/auth/realms/copilot", { lastRefreshTime: 1_000 });
    const fresh = infoFile("www.codebuddy.ai", "https://www.codebuddy.ai/auth/realms/copilot", { lastRefreshTime: 9_000 });
    fresh.auth.accessToken = jwt("https://www.codebuddy.ai/auth/realms/copilot") + "fresh";
    fs.writeFileSync(path.join(directory, "a-locked.info"), JSON.stringify(stale));
    fs.writeFileSync(path.join(directory, "b-fresh.info"), JSON.stringify(fresh));
    let reads = 0;
    const cache = createCodebuddyCredentialCache(directory, {
      preferredAccount: "a-locked.info",
      onCredentialRead: () => { reads += 1; },
    });
    try {
      // 锁定文件即唯一凭据来源：同 profile 的更新登录被忽略，且每次只读这一个文件。
      const cli = await cache.forProduct("cli");
      assert.equal(cli.accessToken, stale.auth.accessToken, "锁定文件优先于更新的同 profile 登录");
      assert.equal(reads, 1, "锁定命中只读该文件，不全扫");
      // 请求产品与账号产品不一致时沿用同账号 token，只切换端点与身份。
      const work = await cache.forProduct("work");
      assert.equal(work.accessToken, stale.auth.accessToken);
      assert.equal(work.profile, "intl-work");
      assert.equal(work.endpoint, "https://www.workbuddy.ai");
      assert.equal(reads, 2);
    } finally {
      cache.close();
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("锁定账号的地域与请求 slug 不匹配时直接报错，不跨地域回退", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cb-cred-lock-region-"));
  try {
    fs.writeFileSync(path.join(directory, "intl.info"),
      JSON.stringify(infoFile("www.codebuddy.ai", "https://www.codebuddy.ai/auth/realms/copilot", { lastRefreshTime: 1_000 })));
    fs.writeFileSync(path.join(directory, "cn.info"),
      JSON.stringify(infoFile("www.codebuddy.cn", "https://www.codebuddy.cn/auth/realms/copilot", { lastRefreshTime: 5_000 })));
    const cache = createCodebuddyCredentialCache(directory, { preferredAccount: "intl.info" });
    try {
      assert.equal((await cache.forProduct("cli")).profile, "intl-cli");
      await assert.rejects(cache.forProduct("cli", "cn"), /国内.*登录凭据/);
    } finally {
      cache.close();
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("锁定的账号文件缺失：运行期 fallback auto 并告警一次，不改写配置", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cb-cred-fallback-"));
  const locked = path.join(directory, "locked.info");
  fs.writeFileSync(path.join(directory, "cn.info"),
    JSON.stringify(infoFile("www.codebuddy.cn", "https://www.codebuddy.cn/auth/realms/copilot", { lastRefreshTime: 1_000 })));
  fs.writeFileSync(path.join(directory, "intl.info"),
    JSON.stringify(infoFile("www.codebuddy.ai", "https://www.codebuddy.ai/auth/realms/copilot", { lastRefreshTime: 5_000 })));
  const warnings: string[] = [];
  const cache = createCodebuddyCredentialCache(directory, {
    preferredAccount: "locked.info",
    onAccountFallback: (account) => warnings.push(account),
  });
  try {
    // 文件缺失：回落 default 全扫 + auto（最近刷新 = intl），配置仍指向 locked.info。
    assert.equal((await cache.forProduct("cli")).profile, "intl-cli");
    assert.equal((await cache.forProduct("cli")).profile, "intl-cli");
    assert.deepEqual(warnings, ["locked.info"], "fallback 告警只记一次");

    // 文件恢复存在后改回直读；再次缺失时告警重新布防。
    fs.writeFileSync(locked, JSON.stringify(infoFile("www.codebuddy.cn", "https://www.codebuddy.cn/auth/realms/copilot", { lastRefreshTime: 2_000 })));
    assert.equal((await cache.forProduct("cli")).profile, "cn-cli");
    fs.rmSync(locked);
    assert.equal((await cache.forProduct("cli")).profile, "intl-cli");
    assert.deepEqual(warnings, ["locked.info", "locked.info"]);
  } finally {
    cache.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("auto 模式：模型 slug 显式地域缺失直接报错", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cb-cred-auto-"));
  try {
    fs.writeFileSync(path.join(directory, "intl.info"),
      JSON.stringify(infoFile("www.codebuddy.ai", "https://www.codebuddy.ai/auth/realms/copilot", { lastRefreshTime: 5_000 })));
    const cache = createCodebuddyCredentialCache(directory);
    try {
      assert.equal((await cache.forProduct("cli")).profile, "intl-cli");
      await assert.rejects(cache.forProduct("cli", "cn"), /国内.*登录凭据/);
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

/** 混合地域登录目录：cn 更新（t=5_000）、intl 较旧（t=1_000）；cn 只有昵称，intl 昵称 + JWT email。 */
function mixedAccountDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cb-account-label-"));
  const cn = infoFile("www.codebuddy.cn", "https://www.codebuddy.cn/auth/realms/copilot", { lastRefreshTime: 5_000 });
  cn.account.uid = "uid-cn";
  cn.account.nickname = "小明";
  const intl = infoFile("www.codebuddy.ai", "https://www.codebuddy.ai/auth/realms/copilot", { lastRefreshTime: 1_000 });
  intl.account.uid = "uid-intl";
  intl.account.nickname = "Alice";
  intl.auth.accessToken = jwt("https://www.codebuddy.ai/auth/realms/copilot", { email: "alice@example.com" });
  fs.writeFileSync(path.join(directory, "cn-login.info"), JSON.stringify(cn));
  fs.writeFileSync(path.join(directory, "intl-login.info"), JSON.stringify(intl));
  return directory;
}

test("isCodebuddyAccountName 只接受 auto 与 .info 纯文件名（历史哨兵 default 不再接受）", () => {
  assert.equal(isCodebuddyAccountName("auto"), true);
  assert.equal(isCodebuddyAccountName("Tencent-Cloud.coding-copilot.info"), true);
  for (const bad of ["default", "AUTO", "", ".info", "a/b.info", "../escape.info", "x.info.bak"]) {
    assert.equal(isCodebuddyAccountName(bad), false, bad);
  }
});

test("resolveCodebuddyAccountFile：锁定命中、auto/缺失/非法值走最近刷新、无凭据为 undefined", () => {
  const directory = mixedAccountDirectory();
  try {
    // auto 与缺省：取最近刷新的登录（cn 更新）。
    assert.equal(resolveCodebuddyAccountFile(directory), "cn-login.info");
    assert.equal(resolveCodebuddyAccountFile(directory, "auto"), "cn-login.info");
    assert.equal(resolveCodebuddyAccountFile(directory, undefined), "cn-login.info");
    // 具体文件名存在即命中；缺失回落 auto；带路径的值按非法处理同样回落 auto。
    assert.equal(resolveCodebuddyAccountFile(directory, "intl-login.info"), "intl-login.info");
    assert.equal(resolveCodebuddyAccountFile(directory, "gone.info"), "cn-login.info");
    assert.equal(resolveCodebuddyAccountFile(directory, "../escape.info"), "cn-login.info");
    // 目录不存在或没有可用凭据时无可展示账号。
    assert.equal(resolveCodebuddyAccountFile(path.join(directory, "missing")), undefined);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "cb-account-empty-"));
  try {
    assert.equal(resolveCodebuddyAccountFile(empty), undefined);
    assert.equal(resolveCodebuddyAccountFile(empty, "auto"), undefined);
  } finally {
    fs.rmSync(empty, { recursive: true, force: true });
  }
});

test("codebuddyAccountLabel 拼「昵称 <邮箱> / 地域」，token 绝不出现在标签里", () => {
  const directory = mixedAccountDirectory();
  try {
    // cn 只有昵称：不带 <email>；intl 昵称 + JWT email。
    assert.equal(codebuddyAccountLabel(directory), "小明 / cn");
    assert.equal(codebuddyAccountLabel(directory, "intl-login.info"), "Alice <alice@example.com> / intl");
    const label = codebuddyAccountLabel(directory, "auto") ?? "";
    const credential = JSON.parse(fs.readFileSync(path.join(directory, "cn-login.info"), "utf8")) as { auth: { accessToken: string; refreshToken: string } };
    assert.ok(!label.includes(credential.auth.accessToken), "标签不得包含 accessToken");
    assert.ok(!label.includes(credential.auth.refreshToken), "标签不得包含 refreshToken");
    // 主标识回退链：无昵称退 JWT preferred_username → uid → 文件名。
    const fallbackDir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-account-fallback-"));
    try {
      const issuer = "https://www.codebuddy.ai/auth/realms/copilot";
      const byUsername = infoFile("www.codebuddy.ai", issuer);
      byUsername.auth.accessToken = jwt(issuer, { preferred_username: "bob", email: "bob@example.com" });
      const byUid = infoFile("www.codebuddy.ai", issuer);
      byUid.account.uid = "uid-only";
      const anon = infoFile("www.codebuddy.ai", issuer);
      anon.account.uid = "";
      fs.writeFileSync(path.join(fallbackDir, "username.info"), JSON.stringify(byUsername));
      fs.writeFileSync(path.join(fallbackDir, "uid.info"), JSON.stringify(byUid));
      fs.writeFileSync(path.join(fallbackDir, "anon.info"), JSON.stringify(anon));
      assert.equal(codebuddyAccountLabel(fallbackDir, "username.info"), "bob <bob@example.com> / intl");
      assert.equal(codebuddyAccountLabel(fallbackDir, "uid.info"), "uid-only / intl");
      assert.equal(codebuddyAccountLabel(fallbackDir, "anon.info"), "anon.info / intl");
    } finally {
      fs.rmSync(fallbackDir, { recursive: true, force: true });
    }
    // 锁定文件存在但持续损坏：返回诊断标签而非「未选择」（网关同样直读报错）。
    fs.writeFileSync(path.join(directory, "broken-locked.info"), "{ not json");
    assert.equal(codebuddyAccountLabel(directory, "broken-locked.info"), "broken-locked.info（凭据无法读取）");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("标签解析与网关凭据选取同源：auto 命中同一份登录", () => {
  const directory = mixedAccountDirectory();
  const cache = createCodebuddyCredentialCache(directory);
  return (async () => {
    try {
      const credential = await cache.forProduct("cli");
      assert.equal(credential.accountNickname, "小明");
      assert.equal(codebuddyAccountLabel(directory), "小明 / cn", "UI 标签与网关命中的是同一账号");
    } finally {
      cache.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  })();
});

test("listCodebuddyAccounts 列出全部登录，损坏文件标注不可选", () => {
  const directory = mixedAccountDirectory();
  try {
    fs.writeFileSync(path.join(directory, "broken.info"), "{ not json");
    const entries = listCodebuddyAccounts(directory);
    assert.deepEqual(entries.map((entry) => entry.file), ["broken.info", "cn-login.info", "intl-login.info"]);
    assert.equal(entries[0].broken, true);
    assert.match(entries[0].label, /broken\.info/);
    const usable = entries.filter((entry) => !entry.broken);
    assert.deepEqual(usable.map((entry) => entry.label), ["小明 / cn", "Alice <alice@example.com> / intl"]);
    // 目录缺失时为空列表（--switch 显示未登录提示）。
    assert.deepEqual(listCodebuddyAccounts(path.join(directory, "missing")), []);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("锁定账号时 watch 事件不触发全扫，只有选取路径直读文件", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cb-cred-watch-"));
  try {
    fs.writeFileSync(path.join(directory, "locked.info"),
      JSON.stringify(infoFile("www.codebuddy.ai", "https://www.codebuddy.ai/auth/realms/copilot")));
    fs.writeFileSync(path.join(directory, "other.info"),
      JSON.stringify(infoFile("www.codebuddy.cn", "https://www.codebuddy.cn/auth/realms/copilot")));
    let reads = 0;
    let listener: ((event: string, filename: Buffer | string | null) => void) | undefined;
    const cache = createCodebuddyCredentialCache(directory, {
      preferredAccount: "locked.info",
      onCredentialRead: () => { reads += 1; },
      watch: ((_dir: string, _options: unknown, callback: (event: string, filename: Buffer | string | null) => void) => {
        listener = callback;
        return { close: () => {}, on: () => {} } as unknown as fs.FSWatcher;
      }) as typeof fs.watch,
    });
    try {
      assert.equal((await cache.forProduct("cli")).profile, "intl-cli");
      assert.equal(reads, 1);
      // 目录事件（去抖 100ms 后合并重扫）在锁定模式下不得触发任何读取。
      listener!("change", "other.info");
      await Bun.sleep(300);
      assert.equal(reads, 1, "锁定模式下 watch 事件不得触发全扫");
      assert.equal((await cache.forProduct("cli")).profile, "intl-cli");
      assert.equal(reads, 2, "选取仍直读锁定文件");
    } finally {
      cache.close();
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
