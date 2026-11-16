import assert from "node:assert/strict";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { readZcodeJwt } from "@agent-proxy/zcode/config";
import { decryptZcodeCredential, resolveZcodeCredentialPath } from "@agent-proxy/zcode/credential-cipher";
import { readZcodeIndividualCredential } from "@agent-proxy/zcode/individual-credentials";

function digest(value: string | Buffer): Buffer {
  return createHash("sha256").update(value).digest();
}

function encrypt(value: string, key: Buffer, source: "os" | "env" = "env"): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return `enc:v2:${source}:${digest(key).toString("hex").slice(0, 24)}:`
    + [iv, cipher.getAuthTag(), encrypted].map((part) => part.toString("base64url")).join(".");
}

function fixture(run: (directory: string, filePath: string) => void): void {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-cipher-"));
  try { run(directory, path.join(directory, "credentials.json")); }
  finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

test("系统解密密钥仅首次读取，凭据文件更新及多字段读取复用缓存", () => {
  fixture((_directory, filePath) => {
    const key = randomBytes(32);
    let reads = 0;
    const readSystemKey = () => { reads++; return key.toString("base64url"); };
    const dependencies = { filePath, readSystemKey };
    for (const token of ["first-token", "refreshed-token"]) {
      fs.writeFileSync(filePath, JSON.stringify({ token: encrypt(token, key, "os"), profile: encrypt("profile", key, "os") }));
      const credentials = JSON.parse(fs.readFileSync(filePath, "utf8"));
      assert.equal(decryptZcodeCredential(credentials.token, {}, dependencies), token);
      assert.equal(decryptZcodeCredential(credentials.profile, {}, { ...dependencies }), "profile");
    }
    assert.equal(reads, 1);
    const otherPath = path.join(path.dirname(filePath), "other-credentials.json");
    assert.equal(decryptZcodeCredential(encrypt("other", key, "os"), {}, { filePath: otherPath, readSystemKey }), "other");
    assert.equal(reads, 2);
  });
});

test("系统密钥轮换时刷新一次并复用新密钥，密钥未变且密文损坏时明确失败", () => {
  fixture((_directory, filePath) => {
    const key = randomBytes(32);
    let stored = key;
    let reads = 0;
    const readSystemKey = () => { reads++; return stored.toString("base64url"); };
    const dependencies = { filePath, readSystemKey };
    const original = encrypt("token", key, "os");
    assert.equal(decryptZcodeCredential(original, {}, dependencies), "token");
    stored = randomBytes(32);
    const rotated = encrypt("rotated", stored, "os");
    assert.equal(decryptZcodeCredential(rotated, {}, dependencies), "rotated");
    assert.equal(reads, 2);
    assert.equal(decryptZcodeCredential(rotated, {}, dependencies), "rotated");
    assert.equal(reads, 2);
    const parts = rotated.split(":");
    const payload = parts[4]!.split(".");
    const tag = Buffer.from(payload[1]!, "base64url");
    tag[0] = tag[0]! ^ 1;
    payload[1] = tag.toString("base64url");
    parts[4] = payload.join(".");
    assert.throws(() => decryptZcodeCredential(parts.join(":"), {}, dependencies), /解密失败.*重启网关/);
    assert.equal(decryptZcodeCredential(rotated, {}, dependencies), "rotated");
    assert.equal(reads, 3);

    // 系统密钥变化但仍不能匹配当前密文时，也不得连续读取或无限重试。
    stored = randomBytes(32);
    assert.throws(() => decryptZcodeCredential(original, {}, dependencies), /指纹不匹配/);
    assert.equal(reads, 4);
    assert.equal(decryptZcodeCredential(encrypt("latest", stored, "os"), {}, dependencies), "latest");
    assert.equal(reads, 4);

    let failures = 0;
    const unavailableReader = () => { failures++; throw new Error("private-material"); };
    for (let attempt = 0; attempt < 2; attempt++) {
      assert.throws(() => decryptZcodeCredential(original, {}, { filePath, readSystemKey: unavailableReader }), /无法读取.*重启网关/);
    }
    assert.equal(failures, 1);
  });
});

test("ZCode v2 环境密钥保持原始空白并解密空字符串，未知加密版本拒绝透传", () => {
  fixture((_directory, filePath) => {
    const secret = "  test-only-managed-secret-with-whitespace\n";
    const env = { ZCODE_CREDENTIAL_SECRET: secret };
    const encrypted = encrypt("simulated-access-token", digest(secret));
    assert.equal(decryptZcodeCredential(encrypted, env, { filePath }), "simulated-access-token");
    assert.equal(decryptZcodeCredential(encrypt("", digest(secret)), env, { filePath }), "");
    assert.equal(decryptZcodeCredential("plain-token", {}, { filePath }), "plain-token");
    assert.throws(() => decryptZcodeCredential("enc:v9:anything", env, { filePath }), /加密版本/);
    assert.throws(() => decryptZcodeCredential(encrypted, { ...env, ZCODE_CREDENTIAL_SECRET_FILE: "unused" }, { filePath }), /不能同时设置/);
    assert.throws(() => decryptZcodeCredential(encrypted, { ZCODE_CREDENTIAL_SECRET: "wrong-key" }, { filePath }), /指纹不匹配/);
  });
});

test("ZCode v2 系统密钥严格绑定实际凭据文件路径、来源与指纹", () => {
  fixture((_directory, filePath) => {
    const key = randomBytes(32);
    const encrypted = encrypt("simulated-system-token", key, "os");
    let reads = 0;
    const readSystemKey = (service: string, account: string) => {
      reads++;
      assert.equal(service, "ZCode Credential Encryption");
      assert.equal(account, digest(path.resolve(filePath)).toString("hex"));
      return key.toString("base64url");
    };
    assert.equal(decryptZcodeCredential(encrypted, {}, { filePath, readSystemKey }), "simulated-system-token");
    assert.equal(reads, 1);
    assert.throws(() => decryptZcodeCredential(encrypted, {}, { filePath, readSystemKey: () => randomBytes(32).toString("base64url") }), /指纹不匹配/);
    assert.throws(() => decryptZcodeCredential(encrypted, {}, { filePath, readSystemKey: () => "bad" }), /无法读取/);
    assert.throws(() => decryptZcodeCredential(encrypted, {}, { filePath, readSystemKey: () => { throw new Error("private-key-material"); } }), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.doesNotMatch(error.message, /private-key-material/);
      return true;
    });
    assert.throws(() => decryptZcodeCredential(encrypted, { ZCODE_CREDENTIAL_SECRET: "different-env" }, { filePath, readSystemKey }), /指纹不匹配/);
    assert.equal(reads, 1);
  });
});

test("ZCode v2 显式与自动发现的密钥文件遵循来源标记和文件权限", () => {
  fixture((directory, filePath) => {
    const secret = "fake-secret-file-32-bytes-minimum\n";
    const encrypted = encrypt("file-token", digest(secret));
    const secretFile = path.join(directory, "credential-secret");
    fs.writeFileSync(secretFile, secret, { mode: 0o600 });
    assert.equal(decryptZcodeCredential(encrypted, {}, { filePath }), "file-token");
    assert.equal(decryptZcodeCredential(encrypted, { ZCODE_CREDENTIAL_SECRET_FILE: secretFile }, { filePath }), "file-token");
    if (process.platform !== "win32") {
      fs.chmodSync(secretFile, 0o644);
      assert.throws(() => decryptZcodeCredential(encrypted, {}, { filePath }), /无法读取/);
      fs.chmodSync(secretFile, 0o600);
    }
    fs.writeFileSync(path.join(directory, "credential-source"), "os\n");
    assert.throws(() => decryptZcodeCredential(encrypted, {}, { filePath, readSystemKey: () => { throw new Error("不应读取系统密钥"); } }), /无法读取/);
    assert.equal(decryptZcodeCredential(encrypted, { ZCODE_CREDENTIAL_SECRET_FILE: secretFile }, { filePath }), "file-token");
    fs.writeFileSync(path.join(directory, "credential-source"), "unexpected\n");
    assert.throws(() => decryptZcodeCredential(encrypted, {}, { filePath }), /无法读取/);
    fs.writeFileSync(secretFile, "too-short");
    assert.throws(() => decryptZcodeCredential(encrypted, { ZCODE_CREDENTIAL_SECRET_FILE: secretFile }, { filePath }), /无法读取/);
  });
});

test("ZCode v2 损坏载荷不能解密或变成明文凭据", () => {
  fixture((_directory, filePath) => {
    const secret = "test-secret";
    const env = { ZCODE_CREDENTIAL_SECRET: secret };
    const encrypted = encrypt("sensitive", digest(secret));
    const suffix = encrypted.endsWith("A") ? "B" : "A";
    assert.throws(() => decryptZcodeCredential(encrypted.slice(0, -1) + suffix, env, { filePath }), /解密失败/);
    const prefix = encrypted.slice(0, encrypted.lastIndexOf(":") + 1);
    for (const payload of ["!.b.c", "a.b.c", "a.b.c.d"]) {
      assert.throws(() => decryptZcodeCredential(prefix + payload, env, { filePath }));
    }
  });
});

test("ZCode 旧 v1 密文可通过机器密钥回退且不会将 v2 当作明文", () => {
  const fallback = `zcode-credential-fallback:${os.platform()}:${os.homedir()}:${os.userInfo().username}`;
  const v2 = encrypt("legacy-token", digest(fallback));
  const payload = v2.slice(v2.lastIndexOf(":") + 1);
  assert.equal(decryptZcodeCredential(`enc:v1:${payload}`, { ZCODE_CREDENTIAL_SECRET: "different" }), "legacy-token");
});

test("ZCode 凭据路径根目录优先，JWT 和个人账号读取使用 v2 上下文", () => {
  fixture((directory, rootPath) => {
    const v2Directory = path.join(directory, "v2");
    fs.mkdirSync(v2Directory);
    const filePath = path.join(v2Directory, "credentials.json");
    assert.equal(resolveZcodeCredentialPath(directory), filePath);
    const secret = "simulated-credential-secret-for-integration\n";
    fs.writeFileSync(path.join(v2Directory, "credential-secret"), secret, { mode: 0o600 });
    const credentials = {
      zcodejwttoken: encrypt("simulated-business-jwt", digest(secret)),
      "oauth:zai:user_info": encrypt(JSON.stringify({ user_id: "fake-user" }), digest(secret)),
      "account-provider:coding-plan:account:zai-individual-coding-plan:account:fake-user:api-key": encrypt("simulated-api-key", digest(secret)),
    };
    fs.writeFileSync(filePath, JSON.stringify(credentials));
    assert.equal(readZcodeJwt(directory, {}), "simulated-business-jwt");
    assert.deepEqual(readZcodeIndividualCredential(credentials, "zai", {}, { filePath }), {
      state: "available", identity: "fake-user", apiKey: "simulated-api-key",
    });
    fs.writeFileSync(rootPath, "{}");
    assert.equal(resolveZcodeCredentialPath(directory), rootPath);
    assert.equal(readZcodeJwt(directory, {}), "");
  });
});
