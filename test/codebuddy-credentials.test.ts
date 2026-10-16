import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "./host-test.ts";
import {
  CodebuddyCredentialError,
  canonicalCodebuddyAccountValue,
  codebuddyAccountLabel,
  codebuddyEndpoint,
  createCodebuddyCredentialCache,
  defaultAuthDirectory,
  codebuddyCredentialsPresent,
  isCodebuddyAccountValue,
  listCodebuddyAccounts,
  profileForAuth,
  profileProduct,
  profileRegion,
  profileSite,
  resolveCodebuddyAccountFile,
  tokenIssuer,
} from "@agent-proxy/codebuddy/credentials";

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

test("锁定账号（uid）跟随同账号最新登录：产品接口按需适配，历史文件名值同样换算", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cb-cred-lock-"));
  try {
    // 同一账号（uid-alpha）两份快照：旧快照是规范文件，新快照是 CLI 刷新后的新文件。
    const stale = infoFile("www.codebuddy.ai", "https://www.codebuddy.ai/auth/realms/copilot", { lastRefreshTime: 1_000 });
    stale.account.uid = "uid-alpha";
    const fresh = infoFile("www.codebuddy.ai", "https://www.codebuddy.ai/auth/realms/copilot", { lastRefreshTime: 9_000 });
    fresh.account.uid = "uid-alpha";
    fresh.auth.accessToken = jwt("https://www.codebuddy.ai/auth/realms/copilot") + "fresh";
    fs.writeFileSync(path.join(directory, "a-locked.info"), JSON.stringify(stale));
    fs.writeFileSync(path.join(directory, "b-fresh.info"), JSON.stringify(fresh));
    // uid 锁定：命中同账号最新登录（b-fresh），CLI 换文件后自动跟随。
    const byUid = createCodebuddyCredentialCache(directory, { preferredAccount: "uid-alpha" });
    try {
      assert.equal((await byUid.forProduct("cli")).accessToken, fresh.auth.accessToken, "uid 锁定命中同账号最新登录");
      // 请求产品与账号产品不一致时沿用同账号 token，只切换端点与身份。
      const work = await byUid.forProduct("work");
      assert.equal(work.accessToken, fresh.auth.accessToken);
      assert.equal(work.profile, "intl-work");
      assert.equal(work.endpoint, "https://www.workbuddy.ai");
    } finally {
      byUid.close();
    }
    // 历史文件名锁定值换算为同账号 uid：锁旧快照也命中最新登录。
    const byFile = createCodebuddyCredentialCache(directory, { preferredAccount: "a-locked.info" });
    try {
      assert.equal((await byFile.forProduct("cli")).accessToken, fresh.auth.accessToken, "文件名值按同账号最新登录解析");
    } finally {
      byFile.close();
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("锁定账号的地域与请求 slug 不匹配时直接报错，不跨地域回退", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cb-cred-lock-region-"));
  try {
    const intl = infoFile("www.codebuddy.ai", "https://www.codebuddy.ai/auth/realms/copilot", { lastRefreshTime: 1_000 });
    intl.account.uid = "uid-intl";
    const cn = infoFile("www.codebuddy.cn", "https://www.codebuddy.cn/auth/realms/copilot", { lastRefreshTime: 5_000 });
    cn.account.uid = "uid-cn";
    fs.writeFileSync(path.join(directory, "intl.info"), JSON.stringify(intl));
    fs.writeFileSync(path.join(directory, "cn.info"), JSON.stringify(cn));
    const cache = createCodebuddyCredentialCache(directory, { preferredAccount: "uid-intl" });
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

test("锁定的账号不存在：运行期 fallback auto 并告警一次，不改写配置", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cb-cred-fallback-"));
  const cnFile = path.join(directory, "cn.info");
  const cnLogin = infoFile("www.codebuddy.cn", "https://www.codebuddy.cn/auth/realms/copilot", { lastRefreshTime: 1_000 });
  cnLogin.account.uid = "uid-gone";
  fs.writeFileSync(path.join(directory, "intl.info"),
    JSON.stringify(infoFile("www.codebuddy.ai", "https://www.codebuddy.ai/auth/realms/copilot", { lastRefreshTime: 5_000 })));
  const warnings: string[] = [];
  const cache = createCodebuddyCredentialCache(directory, {
    preferredAccount: "uid-gone",
    onAccountFallback: (account) => warnings.push(account),
  });
  try {
    // 账号尚无登录：回落 auto 全扫（最近刷新 = intl），配置仍指向 uid-gone。
    assert.equal((await cache.forProduct("cli")).profile, "intl-cli");
    assert.equal((await cache.forProduct("cli")).profile, "intl-cli");
    assert.deepEqual(warnings, ["uid-gone"], "fallback 告警只记一次");

    // 该账号重新登录（新文件，即使比其他账号旧）：uid 命中优先，无需改配置。
    fs.writeFileSync(cnFile, JSON.stringify(cnLogin));
    cache.refresh();
    assert.equal((await cache.forProduct("cli")).profile, "cn-cli");
    // 再登出（文件删除）后又回退，告警重新布防。
    fs.rmSync(cnFile);
    cache.refresh();
    assert.equal((await cache.forProduct("cli")).profile, "intl-cli");
    assert.deepEqual(warnings, ["uid-gone", "uid-gone"]);
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

test("临近过期的凭据返回带修复指引的错误，refresh 重扫后恢复", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cb-cred-exp-"));
  const file = path.join(directory, "test.info");
  fs.writeFileSync(file, JSON.stringify(infoFile("www.codebuddy.ai", "https://www.codebuddy.ai/auth/realms/copilot", { expiresAt: Date.now() + 60_000 })));
  const cache = createCodebuddyCredentialCache(directory);
  try {
    await assert.rejects(cache.forProduct("cli"), /重新登录/);
    // CLI 完成刷新：写回新的有效期。缓存不自动跟随，refresh 强制重扫后恢复。
    fs.writeFileSync(file, JSON.stringify(infoFile("www.codebuddy.ai", "https://www.codebuddy.ai/auth/realms/copilot")));
    await assert.rejects(cache.forProduct("cli"), /重新登录/, "refresh 前缓存中的过期凭据仍然报错");
    cache.refresh();
    const credential = await cache.forProduct("cli");
    assert.equal(credential.profile, "intl-cli");
  } finally {
    cache.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("mtime 热更新：CLI 刷新 token 后经 refresh 重扫读取新 accessToken", async () => {
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
    // 缓存语义：文件变化在 refresh 前不生效（fs.watch 只是提前触发）。
    assert.equal((await cache.forProduct("cli")).accessToken, before.accessToken, "refresh 前沿用缓存中的旧 token");
    cache.refresh();
    const after = await cache.forProduct("cli");
    assert.notEqual(after.accessToken, before.accessToken, "refresh 重扫后刷新的 token 立即可见");
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

test("isCodebuddyAccountValue 只接受 auto、账号 uid 与历史 .info 文件名（拒绝路径形状）", () => {
  assert.equal(isCodebuddyAccountValue("auto"), true);
  assert.equal(isCodebuddyAccountValue("uid-1234"), true);
  assert.equal(isCodebuddyAccountValue("Tencent-Cloud.coding-copilot.info"), true);
  for (const bad of ["", "a/b.info", "../escape.info", "sub\\dir.info"]) {
    assert.equal(isCodebuddyAccountValue(bad), false, bad);
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

test("listCodebuddyAccounts 按 (uid, profile) 去重：CLI 留下的时间戳备份只保留最新一份", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cb-account-dedupe-"));
  try {
    // 同一账号（同 uid、同 cn-cli profile）：规范文件较旧，CLI logout 备份反而更新——
    // 真实机器上观察到的形态（备份保留登录状态，规范文件随后被新登录覆盖）。
    const staleBackup = infoFile("www.codebuddy.cn", "https://www.codebuddy.cn/auth/realms/copilot", { lastRefreshTime: 1_000 });
    staleBackup.account.uid = "uid-cn";
    staleBackup.account.nickname = "小明";
    const freshBackup = infoFile("www.codebuddy.cn", "https://www.codebuddy.cn/auth/realms/copilot", { lastRefreshTime: 9_000 });
    freshBackup.account.uid = "uid-cn";
    freshBackup.account.nickname = "小明";
    fs.writeFileSync(path.join(directory, "Tencent-Cloud.coding-copilot.2026-10-15T02-13-19-969Z.67560.a.info"), JSON.stringify(staleBackup));
    fs.writeFileSync(path.join(directory, "Tencent-Cloud.coding-copilot.2026-10-15T02-18-39-210Z.67560.b.info"), JSON.stringify(freshBackup));
    // 同 uid 的国际站登录：合法的不同登录，不合并。
    const intl = infoFile("www.codebuddy.ai", "https://www.codebuddy.ai/auth/realms/copilot", { lastRefreshTime: 5_000 });
    intl.account.uid = "uid-cn";
    intl.account.nickname = "小明";
    fs.writeFileSync(path.join(directory, "intl-login.info"), JSON.stringify(intl));
    // uid 缺失的文件无法归并，按独立登录保留。
    const noUid = infoFile("www.codebuddy.cn", "https://www.codebuddy.cn/auth/realms/copilot", { lastRefreshTime: 8_000 });
    delete noUid.account.uid;
    fs.writeFileSync(path.join(directory, "no-uid.info"), JSON.stringify(noUid));

    const entries = listCodebuddyAccounts(directory);
    // cn 登录只保留最新备份（b），uid 缺失文件独立成项；同 uid 的 intl 不被合并。
    assert.deepEqual(entries.map((entry) => entry.file), [
      "Tencent-Cloud.coding-copilot.2026-10-15T02-18-39-210Z.67560.b.info",
      "intl-login.info",
      "no-uid.info",
    ]);
    assert.deepEqual(entries.map((entry) => entry.label), ["小明 / cn", "小明 / intl", "no-uid.info / cn"]);
    // 条目携带账号 uid 与选择值（profile:uid）；无 uid 登录的值为文件名。
    assert.deepEqual(entries.map((entry) => entry.uid), ["uid-cn", "uid-cn", ""]);
    assert.deepEqual(entries.map((entry) => entry.value), ["cn-cli:uid-cn", "intl-cli:uid-cn", "no-uid.info"]);
    assert.equal(new Set(entries.map((entry) => entry.value)).size, entries.length, "同账号跨地域两行的选择值必须唯一");
    // 去重保留的是最新文件：按选择值（或历史文件名）锁定命中 lastRefreshTime 最大的那份。
    assert.equal(resolveCodebuddyAccountFile(directory, entries[0].value), entries[0].file);
    assert.equal(resolveCodebuddyAccountFile(directory, entries[1].value), entries[1].file, "profile 作用域钉住该地域登录");
    assert.equal(resolveCodebuddyAccountFile(directory, entries[0].file), entries[0].file, "历史文件名值按同账号最新解析");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("canonicalCodebuddyAccountValue：uid 原样、文件名换算 uid、无 uid/缺失保留、auto 归一", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cb-account-canonical-"));
  try {
    const oldSnap = infoFile("www.codebuddy.cn", "https://www.codebuddy.cn/auth/realms/copilot", { lastRefreshTime: 1_000 });
    oldSnap.account.uid = "uid-cn";
    fs.writeFileSync(path.join(directory, "old-snap.info"), JSON.stringify(oldSnap));
    const newSnap = infoFile("www.codebuddy.cn", "https://www.codebuddy.cn/auth/realms/copilot", { lastRefreshTime: 9_000 });
    newSnap.account.uid = "uid-cn";
    fs.writeFileSync(path.join(directory, "new-snap.info"), JSON.stringify(newSnap));
    const noUid = infoFile("www.codebuddy.cn", "https://www.codebuddy.cn/auth/realms/copilot", { lastRefreshTime: 5_000 });
    delete noUid.account.uid;
    fs.writeFileSync(path.join(directory, "no-uid.info"), JSON.stringify(noUid));

    assert.equal(canonicalCodebuddyAccountValue(directory), "auto");
    assert.equal(canonicalCodebuddyAccountValue(directory, "auto"), "auto");
    assert.equal(canonicalCodebuddyAccountValue(directory, "uid-cn"), "cn-cli:uid-cn", "裸 uid 规范化为当前命中行的 profile 作用域值");
    assert.equal(canonicalCodebuddyAccountValue(directory, "cn-cli:uid-cn"), "cn-cli:uid-cn", "profile 作用域值命中时原样");
    assert.equal(canonicalCodebuddyAccountValue(directory, "intl-cli:uid-cn"), "intl-cli:uid-cn", "该地域无登录时保留原值（占位提示）");
    assert.equal(canonicalCodebuddyAccountValue(directory, "old-snap.info"), "cn-cli:uid-cn", "历史文件名换算为该文件 profile 的作用域值");
    assert.equal(canonicalCodebuddyAccountValue(directory, "no-uid.info"), "no-uid.info", "无 uid 登录保持文件名");
    assert.equal(canonicalCodebuddyAccountValue(directory, "gone.info"), "gone.info", "文件缺失保留原值（占位提示）");
    assert.equal(canonicalCodebuddyAccountValue(directory, "uid-gone"), "uid-gone", "账号不存在保留原值（占位提示）");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("同账号跨地域双登录：profile 作用域锁定钉住地域，裸 uid 跟随最新", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cb-cred-dual-region-"));
  try {
    // 同一账号（uid-dual）在 cn 与 intl 各有一份登录，intl 更近刷新。
    const cn = infoFile("www.codebuddy.cn", "https://www.codebuddy.cn/auth/realms/copilot", { lastRefreshTime: 1_000 });
    cn.account.uid = "uid-dual";
    cn.account.nickname = "双区账号";
    const intl = infoFile("www.codebuddy.ai", "https://www.codebuddy.ai/auth/realms/copilot", { lastRefreshTime: 9_000 });
    intl.account.uid = "uid-dual";
    intl.account.nickname = "双区账号";
    fs.writeFileSync(path.join(directory, "cn-login.info"), JSON.stringify(cn));
    fs.writeFileSync(path.join(directory, "intl-login.info"), JSON.stringify(intl));
    // 列表两行、选择值唯一（同 uid 不同 profile）。
    assert.deepEqual(listCodebuddyAccounts(directory).map((entry) => entry.value), ["cn-cli:uid-dual", "intl-cli:uid-dual"]);

    // profile 作用域锁定：即使 intl 更新，cn 锁定仍取 cn 登录，并可服务 cn 地域。
    const pinned = createCodebuddyCredentialCache(directory, { preferredAccount: "cn-cli:uid-dual" });
    try {
      assert.equal((await pinned.forProduct("cli")).profile, "cn-cli");
      assert.equal((await pinned.forProduct("cli", "cn")).profile, "cn-cli");
      await assert.rejects(pinned.forProduct("cli", "intl"), /国际.*登录凭据/, "钉住 cn 时不跨地域回退");
    } finally {
      pinned.close();
    }
    // 裸 uid 锁定：跟随该账号最近刷新的登录（intl）。
    const follow = createCodebuddyCredentialCache(directory, { preferredAccount: "uid-dual" });
    try {
      assert.equal((await follow.forProduct("cli")).profile, "intl-cli");
    } finally {
      follow.close();
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("uid 锁定经 refresh 跟随同账号更新的登录", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cb-cred-uidscan-"));
  try {
    const old = infoFile("www.codebuddy.ai", "https://www.codebuddy.ai/auth/realms/copilot", { lastRefreshTime: 1_000 });
    old.account.uid = "uid-x";
    fs.writeFileSync(path.join(directory, "x-old.info"), JSON.stringify(old));
    const cache = createCodebuddyCredentialCache(directory, { preferredAccount: "uid-x" });
    try {
      assert.equal((await cache.forProduct("cli")).accessToken, old.auth.accessToken);
      // CLI 刷新写出同账号新文件（不改动旧文件）：refresh 重扫后切换，无需重启网关。
      const fresh = infoFile("www.codebuddy.ai", "https://www.codebuddy.ai/auth/realms/copilot", { lastRefreshTime: 9_000 });
      fresh.account.uid = "uid-x";
      fs.writeFileSync(path.join(directory, "x-fresh.info"), JSON.stringify(fresh));
      assert.equal((await cache.forProduct("cli")).accessToken, old.auth.accessToken, "refresh 前仍用缓存中的旧登录");
      cache.refresh();
      assert.equal((await cache.forProduct("cli")).accessToken, fresh.auth.accessToken, "refresh 后同账号新登录立即生效");
    } finally {
      cache.close();
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("选取基于内存缓存：无变更时多次选取不重扫", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cb-cred-noscan-"));
  try {
    fs.writeFileSync(path.join(directory, "intl.info"),
      JSON.stringify(infoFile("www.codebuddy.ai", "https://www.codebuddy.ai/auth/realms/copilot")));
    let reads = 0;
    const cache = createCodebuddyCredentialCache(directory, { onCredentialRead: () => { reads += 1; } });
    try {
      for (let index = 0; index < 3; index++) await cache.forProduct("cli");
      assert.equal(reads, 1, "只有构造期初始扫描读取 .info，选取不再重扫");
    } finally {
      cache.close();
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("fs.watch 目录事件经去抖更新缓存", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cb-cred-watch-"));
  try {
    const file = path.join(directory, "test.info");
    fs.writeFileSync(file, JSON.stringify(infoFile("www.codebuddy.ai", "https://www.codebuddy.ai/auth/realms/copilot")));
    let listener: ((event: string, filename: Buffer | string | null) => void) | undefined;
    const cache = createCodebuddyCredentialCache(directory, {
      watch: ((_directory: string, _options: unknown, callback: (event: string, filename: Buffer | string | null) => void) => {
        listener = callback;
        return { close() {}, on() {} } as unknown as fs.FSWatcher;
      }) as unknown as typeof fs.watch,
    });
    try {
      const before = await cache.forProduct("cli");
      const rotated = infoFile("www.codebuddy.ai", "https://www.codebuddy.ai/auth/realms/copilot");
      (rotated.auth).accessToken = jwt("https://www.codebuddy.ai/auth/realms/copilot") + "x";
      fs.writeFileSync(file, JSON.stringify(rotated));
      // 事件只排程去抖重扫；定时器未到时选取仍读缓存。
      listener!("change", "test.info");
      assert.equal((await cache.forProduct("cli")).accessToken, before.accessToken, "去抖窗口内仍用缓存 token");
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.notEqual((await cache.forProduct("cli")).accessToken, before.accessToken, "去抖重扫后缓存更新为新 token");
    } finally {
      cache.close();
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("目录删除与重建：缓存暂留旧凭据，refresh 后恢复", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cb-cred-rebuild-"));
  try {
    fs.writeFileSync(path.join(directory, "intl.info"),
      JSON.stringify(infoFile("www.codebuddy.ai", "https://www.codebuddy.ai/auth/realms/copilot")));
    const cache = createCodebuddyCredentialCache(directory);
    try {
      assert.equal((await cache.forProduct("cli")).profile, "intl-cli");
      // 目录被删：缓存快照仍在，选取不报错（陈旧凭据由请求路径的 401 重试兜底）。
      fs.rmSync(directory, { recursive: true, force: true });
      assert.equal((await cache.forProduct("cli")).profile, "intl-cli");
      cache.refresh();
      await assert.rejects(cache.forProduct("cli"), /无法读取/);
      // 目录重建并登录国内站：refresh 后立即可用。
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(path.join(directory, "cn.info"),
        JSON.stringify(infoFile("www.codebuddy.cn", "https://www.codebuddy.cn/auth/realms/copilot")));
      cache.refresh();
      assert.equal((await cache.forProduct("cli", "cn")).profile, "cn-cli");
    } finally {
      cache.close();
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
