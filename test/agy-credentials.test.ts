import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  AgyCredentialError,
  agyCredentialsPresent,
  agyTokenStale,
  defaultAgyCredentialFile,
  loadAgyCredentials,
} from "../src/agy/credentials.ts";

const TIMEOUT = { timeout: 30_000 };

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
  const credentials = loadAgyCredentials({ credentialFile: tokenFile("2026-10-06T10:33:46.645056+08:00") });
  assert.equal(credentials.accessToken, "ya29.fake-access");
  assert.equal(credentials.authMethod, "consumer");
  // 身份摘要来自 refresh_token，不落明文。
  assert.match(credentials.identity, /^[0-9a-f]{64}$/);
  assert.notEqual(credentials.identity, "1//0g.fake-refresh");
});

test("agy 凭据缺失、损坏与字段缺失分别报可执行错误", TIMEOUT, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agy-cred-"));
  try {
    const missing = path.join(directory, "missing");
    assert.throws(() => loadAgyCredentials({ credentialFile: missing }), (error: unknown) =>
      error instanceof AgyCredentialError && error.message.includes(missing) && error.message.includes("agy"));
    const broken = path.join(directory, "broken");
    fs.writeFileSync(broken, "{not-json");
    assert.throws(() => loadAgyCredentials({ credentialFile: broken }), (error: unknown) =>
      error instanceof AgyCredentialError && error.message.includes("不是有效 JSON") && error.message.includes(broken));
    const empty = path.join(directory, "empty-access");
    fs.writeFileSync(empty, JSON.stringify({ token: { expiry: "2026-10-06T10:33:46+08:00" } }));
    assert.throws(() => loadAgyCredentials({ credentialFile: empty }), (error: unknown) =>
      error instanceof AgyCredentialError && error.message.includes("access_token"));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("agy 过期判定：RFC3339 纳秒可解析、过期与临期判定、未知过期时间不误杀", TIMEOUT, () => {
  const now = Date.parse("2026-10-06T10:00:00+08:00");
  const fresh = loadAgyCredentials({ credentialFile: tokenFile("2026-10-06T10:33:46.645056+08:00") });
  assert.equal(fresh.expiryMs, Date.parse("2026-10-06T10:33:46.645056+08:00"));
  assert.equal(agyTokenStale(fresh, now), false);
  const expired = loadAgyCredentials({ credentialFile: tokenFile("2026-10-06T09:00:00+08:00") });
  assert.equal(agyTokenStale(expired, now), true);
  // 偏移余量 10s 内按过期处理。
  const imminent = loadAgyCredentials({ credentialFile: tokenFile("2026-10-06T10:00:05+08:00") });
  assert.equal(agyTokenStale(imminent, now), true);
  // expiry 缺失时按未知处理，交由上游 401 兜底。
  const unknown = loadAgyCredentials({ readFile: () => JSON.stringify({ token: { access_token: "ya29.x" } }) , credentialFile: "/fake" });
  assert.equal(unknown.expiryMs, 0);
  assert.equal(agyTokenStale(unknown, now), false);
});

test("agy 存在性探测只看文件，不解析内容", TIMEOUT, () => {
  const file = tokenFile("2026-10-06T10:33:46+08:00");
  assert.equal(agyCredentialsPresent(file), true);
  assert.equal(agyCredentialsPresent(path.join(path.dirname(file), "nope")), false);
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
