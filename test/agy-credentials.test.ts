import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "./host-test.ts";
import {
  AgyCredentialError,
  agyCredentialsPresent,
  agyTokenStale,
  defaultAgyCredentialFile,
  loadAgyCredentials,
} from "@agent-proxy/agy/credentials";

const TIMEOUT = { timeout: 30_000 };

/** 钥匙串一律注入 stub：测试与本机真实 gemini/antigravity 条目隔离。 */
const noKeychain = () => { throw new Error("keychain stub"); };

function tokenFile(expiry: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agy-cred-"));
  const file = path.join(directory, "antigravity-oauth-token");
  fs.writeFileSync(file, JSON.stringify({
    token: {
      access_token: "ya29.fake-access",
      token_type: "Bearer",
      refresh_token: "1//0g.fake-refresh",
      expiry,
    },
    auth_method: "consumer",
    id_token: "eyJhbGciOiJSUzI1NiJ9.fake",
  }));
  return file;
}

test("agy 凭据正常解析：token 字段、身份摘要与 auth_method", TIMEOUT, () => {
  const credentials = loadAgyCredentials({ credentialFile: tokenFile("2026-10-06T10:33:46.645056+08:00"), readKeychain: noKeychain });
  assert.equal(credentials.accessToken, "ya29.fake-access");
  assert.equal(credentials.authMethod, "consumer");
  // 身份摘要来自 refresh_token，不落明文。
  assert.match(credentials.identity, /^[0-9a-f]{64}$/);
  assert.notEqual(credentials.identity, "1//0g.fake-refresh");
});

test("agy 凭据缺失、损坏与字段缺失分别报可执行错误", TIMEOUT, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agy-cred-"));
  const noKeychainOption = { readKeychain: noKeychain };
  try {
    const missing = path.join(directory, "missing");
    assert.throws(() => loadAgyCredentials({ credentialFile: missing, ...noKeychainOption }), (error: unknown) =>
      error instanceof AgyCredentialError && error.message.includes(missing) && error.message.includes("agy"));
    const broken = path.join(directory, "broken");
    fs.writeFileSync(broken, "{not-json");
    assert.throws(() => loadAgyCredentials({ credentialFile: broken, ...noKeychainOption }), (error: unknown) =>
      error instanceof AgyCredentialError && error.message.includes("不是有效 JSON") && error.message.includes(broken));
    const empty = path.join(directory, "empty-access");
    fs.writeFileSync(empty, JSON.stringify({ token: { expiry: "2026-10-06T10:33:46+08:00" } }));
    assert.throws(() => loadAgyCredentials({ credentialFile: empty, ...noKeychainOption }), (error: unknown) =>
      error instanceof AgyCredentialError && error.message.includes("access_token"));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("agy 过期判定：RFC3339 纳秒可解析、过期与临期判定、未知过期时间不误杀", TIMEOUT, () => {
  const now = Date.parse("2026-10-06T10:00:00+08:00");
  const fresh = loadAgyCredentials({ credentialFile: tokenFile("2026-10-06T10:33:46.645056+08:00"), readKeychain: noKeychain });
  assert.equal(fresh.expiryMs, Date.parse("2026-10-06T10:33:46.645056+08:00"));
  assert.equal(agyTokenStale(fresh, now), false);
  const expired = loadAgyCredentials({ credentialFile: tokenFile("2026-10-06T09:00:00+08:00"), readKeychain: noKeychain });
  assert.equal(agyTokenStale(expired, now), true);
  // 偏移余量 10s 内按过期处理。
  const imminent = loadAgyCredentials({ credentialFile: tokenFile("2026-10-06T10:00:05+08:00"), readKeychain: noKeychain });
  assert.equal(agyTokenStale(imminent, now), true);
  // expiry 缺失时按未知处理，交由上游 401 兜底。
  const unknown = loadAgyCredentials({ readFile: () => JSON.stringify({ token: { access_token: "ya29.x" } }) , credentialFile: "/fake", readKeychain: noKeychain });
  assert.equal(unknown.expiryMs, 0);
  assert.equal(agyTokenStale(unknown, now), false);
});

test("agy 存在性探测先看文件，缺失时按平台与钥匙串条目判定", TIMEOUT, () => {
  const file = tokenFile("2026-10-06T10:33:46+08:00");
  assert.equal(agyCredentialsPresent(file), true);
  assert.equal(agyCredentialsPresent(path.join(path.dirname(file), "nope"), { probeKeychain: () => false }), false);
  // darwin 下文件缺失 + 钥匙串条目存在 → 视为已登录；非 darwin 不探测钥匙串。
  assert.equal(agyCredentialsPresent("/definitely/missing", { os: "darwin", probeKeychain: () => true }), true);
  assert.equal(agyCredentialsPresent("/definitely/missing", { os: "darwin", probeKeychain: () => false }), false);
  assert.equal(agyCredentialsPresent("/definitely/missing", { os: "linux", probeKeychain: () => true }), false);
});

test("agy 默认凭据路径按平台解析", TIMEOUT, () => {
  assert.equal(
    defaultAgyCredentialFile("/Users/tester", "darwin"),
    "/Users/tester/.gemini/antigravity-cli/antigravity-oauth-token",
  );
  assert.equal(
    defaultAgyCredentialFile("C:/Users/tester", "win32"),
    "C:/Users/tester/AppData/Local/Google/antigravity-cli/antigravity-oauth-token",
  );
});

test("agy 钥匙串优先：合法令牌屏蔽文件，无合法令牌才回落文件", TIMEOUT, () => {
  const keychainJson = (expiry: string) => JSON.stringify({
    token: {
      access_token: Date.parse(expiry) < Date.now() ? "ya29.keychain-stale" : "ya29.keychain-access",
      token_type: "Bearer",
      refresh_token: "1//0g.keychain-refresh",
      expiry,
    },
    auth_method: "consumer",
    id_token: "eyJhbGciOiJSUzI1NiJ9.keychain",
  });
  const keychainValue = (expiry: string) => `go-keyring-base64:${Buffer.from(keychainJson(expiry), "utf8").toString("base64")}`;
  const fileJson = JSON.stringify({
    token: { access_token: "ya29.file-access", refresh_token: "1//0g.file-refresh", expiry: "" },
    auth_method: "consumer",
  });
  const credentialFile = "/synthetic/antigravity-oauth-token";
  const noFile = "/synthetic/missing";

  // ① 钥匙串有合法（未过期）令牌：直接采用，文件被完全屏蔽（哪怕内容合法且不同）。
  let fileReads = 0;
  const masked = loadAgyCredentials({
    credentialFile, os: "darwin", readFile: () => { fileReads++; return fileJson; },
    readKeychain: () => keychainValue("2099-01-01T00:00:00Z"),
  });
  assert.equal(masked.accessToken, "ya29.keychain-access");
  assert.equal(fileReads, 0);
  // 钥匙串合法时文件损坏也不影响（根本不读文件）。
  const maskedBrokenFile = loadAgyCredentials({
    credentialFile, os: "darwin", readFile: () => { fileReads++; return "{broken"; },
    readKeychain: () => keychainValue("2099-01-01T00:00:00Z"),
  });
  assert.equal(maskedBrokenFile.accessToken, "ya29.keychain-access");
  assert.equal(fileReads, 0);

  // ② 钥匙串令牌已过期：回落文件。
  const fallback = loadAgyCredentials({
    credentialFile, os: "darwin", readFile: (f) => f === credentialFile ? fileJson : (() => { throw new Error("ENOENT"); })(),
    readKeychain: () => keychainValue("2000-01-01T00:00:00Z"),
  });
  assert.equal(fallback.accessToken, "ya29.file-access");

  // ③ 钥匙串过期且文件缺失：原样返回过期钥匙串凭据（请求层按过期 401 给指引）。
  const staleOnly = loadAgyCredentials({
    credentialFile: noFile, os: "darwin", readFile: () => { throw new Error("ENOENT"); },
    readKeychain: () => keychainValue("2000-01-01T00:00:00Z"),
  });
  assert.equal(staleOnly.accessToken, "ya29.keychain-stale");
  assert.ok(agyTokenStale(staleOnly));

  // ④ 钥匙串不可读 + 文件缺失：报未登录（提及两侧位置）。
  assert.throws(() => loadAgyCredentials({
    credentialFile: noFile, os: "darwin", readFile: () => { throw new Error("ENOENT"); },
    readKeychain: () => { throw new Error("keychain locked"); },
  }), /未检测到 Antigravity CLI 登录.*gemini\/antigravity 无可用令牌.*missing/);

  // ⑤ 钥匙串格式异常：回落文件；文件也缺失时报未登录并带上钥匙串问题。
  const malformedFallsBack = loadAgyCredentials({
    credentialFile, os: "darwin", readFile: (f) => f === credentialFile ? fileJson : (() => { throw new Error("ENOENT"); })(),
    readKeychain: () => "not-the-prefix",
  });
  assert.equal(malformedFallsBack.accessToken, "ya29.file-access");
  assert.throws(() => loadAgyCredentials({
    credentialFile, os: "darwin", readFile: () => { throw new Error("ENOENT"); },
    readKeychain: () => "not-the-prefix",
  }), /不以 go-keyring-base64: 开头/);

  // ⑥ 非 darwin 平台不走钥匙串：只看文件；缺失报"无钥匙串回退"。
  const linuxFile = loadAgyCredentials({
    credentialFile, os: "linux", readFile: (f) => f === credentialFile ? fileJson : (() => { throw new Error("ENOENT"); })(),
    readKeychain: () => keychainValue("2099-01-01T00:00:00Z"),
  });
  assert.equal(linuxFile.accessToken, "ya29.file-access");
  assert.throws(() => loadAgyCredentials({
    credentialFile: noFile, os: "linux", readFile: () => { throw new Error("ENOENT"); },
    readKeychain: () => keychainValue("2099-01-01T00:00:00Z"),
  }), /当前平台无钥匙串回退/);

  // ⑦ 钥匙串无合法令牌且文件损坏：损坏显式报错（不静默当作缺失）。
  assert.throws(() => loadAgyCredentials({
    credentialFile, os: "darwin", readFile: (f) => f === credentialFile ? "{broken" : (() => { throw new Error("ENOENT"); })(),
    readKeychain: () => keychainValue("2000-01-01T00:00:00Z"),
  }), /不是有效 JSON/);
});

function keychainToken(expiry?: string): string {
  return `go-keyring-base64:${Buffer.from(JSON.stringify({
    token: { access_token: "synthetic-keychain", refresh_token: "synthetic-identity", expiry },
  })).toString("base64")}`;
}

test("agy 钥匙串过期时间未知时保持优先，且不触碰凭据文件", TIMEOUT, () => {
  for (const expiry of [undefined, "", "invalid-expiry"]) {
    let fileReads = 0;
    const credential = loadAgyCredentials({
      os: "darwin", credentialFile: "/synthetic/missing-token",
      readKeychain: () => keychainToken(expiry),
      readFile: () => { fileReads++; throw new Error("ENOENT"); },
    });
    assert.equal(credential.accessToken, "synthetic-keychain");
    assert.equal(credential.expiryMs, 0);
    assert.equal(fileReads, 0);
  }
});

test("agy 钥匙串缺失、JSON 损坏或缺少令牌时按顺序回落文件", TIMEOUT, () => {
  const invalidValues = [
    undefined,
    "go-keyring-base64:" + Buffer.from("{broken").toString("base64"),
    "go-keyring-base64:" + Buffer.from(JSON.stringify({ token: {} })).toString("base64"),
  ];
  for (const value of invalidValues) {
    const calls: string[] = [];
    const credential = loadAgyCredentials({
      os: "darwin", credentialFile: "/synthetic/token",
      readKeychain: () => {
        calls.push("keychain");
        if (value === undefined) throw new Error("unavailable");
        return value;
      },
      readFile: () => {
        calls.push("file");
        return JSON.stringify({ token: { access_token: "synthetic-file" } });
      },
    });
    assert.equal(credential.accessToken, "synthetic-file");
    assert.deepEqual(calls, ["keychain", "file"]);
  }
});

test("agy 凭据每次重新读取钥匙串，账号变化不会沿用旧令牌", TIMEOUT, () => {
  let current = keychainToken("2099-01-01T00:00:00Z");
  const options = {
    os: "darwin" as const,
    readKeychain: () => current,
    readFile: () => { assert.fail("有效钥匙串不应读取文件"); },
  };
  const first = loadAgyCredentials(options);
  current = `go-keyring-base64:${Buffer.from(JSON.stringify({
    token: { access_token: "synthetic-next-account", refresh_token: "next-identity", expiry: "2099-01-01T00:00:00Z" },
  })).toString("base64")}`;
  const second = loadAgyCredentials(options);
  assert.equal(second.accessToken, "synthetic-next-account");
  assert.notEqual(first.identity, second.identity);
});

test("agy 钥匙串读取失败不会把子进程错误内容带入登录错误", TIMEOUT, () => {
  assert.throws(() => loadAgyCredentials({
    os: "darwin", credentialFile: "/synthetic/missing-token",
    readKeychain: () => { throw new Error("synthetic-sensitive-stdout"); },
    readFile: () => { throw new Error("ENOENT"); },
  }), (error: unknown) => {
    assert.ok(error instanceof AgyCredentialError);
    assert.match(error.message, /钥匙串不可读或读取超时/);
    assert.ok(!error.message.includes("synthetic-sensitive-stdout"));
    return true;
  });
});

test("agy 非 macOS 平台只读文件并使用对应平台的默认路径", TIMEOUT, () => {
  for (const platform of ["linux", "win32"] as const) {
    let keychainReads = 0;
    let requestedFile = "";
    const credential = loadAgyCredentials({
      home: "/synthetic/home", os: platform,
      readKeychain: () => { keychainReads++; return keychainToken("2099-01-01T00:00:00Z"); },
      readFile: (file) => {
        requestedFile = file;
        return JSON.stringify({ token: { access_token: "synthetic-file" } });
      },
    });
    assert.equal(credential.accessToken, "synthetic-file");
    assert.equal(keychainReads, 0);
    assert.equal(requestedFile, defaultAgyCredentialFile("/synthetic/home", platform));
  }
});
