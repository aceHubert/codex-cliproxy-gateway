import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCipheriv, pbkdf2Sync, randomBytes } from "node:crypto";
import {
  defaultQoderConfigDir,
  loadQoderCredentials,
  qoderActiveSources,
  qoderCliCredentialsPresent,
  qoderCredentialsPresent,
  qoderDesktopCredentialsPresent,
  qoderRegionCredentialsPresent,
} from "../src/qoder/credentials.ts";

const MACHINE = "aabbccdd-1122-3344-5566-778899aabbcc";
const USER = { uid: "synthetic-account", access_token: "synthetic-access-secret", security_oauth_token: "synthetic-security-secret",
  expire_time: 2000000000, organization_id: "synthetic-org", organization_tags: ["tag"], data_policy_agreed: true,
  encrypt_user_info: "synthetic-runtime-info", key: "synthetic-runtime-key" };

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "qoder-credentials-test-"));
  const auth = path.join(directory, ".auth");
  fs.mkdirSync(auth);
  fs.writeFileSync(path.join(auth, "machine_id"), MACHINE);
  return { directory, auth, dispose: () => fs.rmSync(directory, { recursive: true, force: true }) };
}

function encrypted(user: unknown): string {
  const key = Buffer.from(MACHINE.slice(0, 16));
  const cipher = createCipheriv("aes-128-cbc", key, key);
  return Buffer.concat([cipher.update(JSON.stringify(user), "utf8"), cipher.final()]).toString("base64");
}

test("Qoder 国际版默认目录尊重独立配置根，未登录时不创建文件", async () => {
  const fixtureDir = fixture();
  try {
    assert.equal(defaultQoderConfigDir("intl", "/synthetic/home", {}), "/synthetic/home/.qoder");
    assert.equal(defaultQoderConfigDir("intl", "/synthetic/home", { QODER_CONFIG_DIR: "/synthetic/intl", QODERCN_CONFIG_DIR: "/synthetic/cn" }), "/synthetic/intl");
    assert.equal(qoderCredentialsPresent(fixtureDir.directory), false);
    assert.equal(await loadQoderCredentials({ configDir: fixtureDir.directory, desktopDir: null }), null);
    assert.deepEqual(fs.readdirSync(fixtureDir.auth), ["machine_id"]);
  } finally { fixtureDir.dispose(); }
});

test("Qoder 国内版默认目录使用 .qoder-cn 与独立环境变量", async () => {
  const fixtureDir = fixture();
  try {
    assert.equal(defaultQoderConfigDir("cn", "/synthetic/home", {}), "/synthetic/home/.qoder-cn");
    assert.equal(defaultQoderConfigDir("cn", "/synthetic/home", { QODER_CONFIG_DIR: "/synthetic/intl", QODERCN_CONFIG_DIR: "/synthetic/cn" }), "/synthetic/cn");
    const file = path.join(fixtureDir.auth, "user");
    fs.writeFileSync(file, encrypted(USER));
    const credential = await loadQoderCredentials({ region: "cn", configDir: fixtureDir.directory, desktopDir: null, now: 1000000000000 });
    assert.equal(credential?.region, "cn");
    assert.equal(credential?.accountUid, USER.uid);
    assert.equal(credential?.authDirectory, fixtureDir.auth);
    const intl = await loadQoderCredentials({ region: "intl", configDir: fixtureDir.directory, desktopDir: null, now: 1000000000000 });
    assert.notEqual(intl?.identity, credential?.identity, "区域不同时账号身份必须隔离");
  } finally { fixtureDir.dispose(); }
});

test("Qoder 只读解密官方登录并随下次读取跟随账号切换", async () => {
  const fixtureDir = fixture();
  try {
    const file = path.join(fixtureDir.auth, "user");
    const content = encrypted(USER);
    fs.writeFileSync(file, content);
    assert.equal(qoderCredentialsPresent(fixtureDir.directory), true);
    const stat = fs.statSync(file);
    const credential = await loadQoderCredentials({ configDir: fixtureDir.directory, desktopDir: null, now: 1000000000000 });
    assert.equal(credential?.region, "intl");
    assert.equal(credential?.accountUid, USER.uid);
    assert.equal(credential?.accessToken, USER.security_oauth_token);
    assert.equal(credential?.key, USER.key);
    assert.equal(credential?.authDirectory, fixtureDir.auth);
    assert.equal(fs.readFileSync(file, "utf8"), content);
    assert.equal(fs.statSync(file).mtimeMs, stat.mtimeMs);
    fs.writeFileSync(file, encrypted({ ...USER, uid: "other-account" }));
    const next = await loadQoderCredentials({ configDir: fixtureDir.directory, desktopDir: null, now: 1000000000000 });
    assert.equal(next?.accountUid, "other-account");
    assert.notEqual(next?.identity, credential?.identity);
  } finally { fixtureDir.dispose(); }
});

test("缺失运行时认证字段时只在内存生成 AES 和 RSA 认证，不写回登录", async () => {
  const fixtureDir = fixture();
  try {
    const file = path.join(fixtureDir.auth, "user");
    const content = encrypted({ ...USER, encrypt_user_info: undefined, key: undefined });
    fs.writeFileSync(file, content);
    const credential = await loadQoderCredentials({ configDir: fixtureDir.directory, desktopDir: null, now: 1000000000000 });
    assert.equal(Buffer.from(credential!.key, "base64").length, 128);
    assert.equal(Buffer.from(credential!.encryptUserInfo, "base64").length % 16, 0);
    assert.equal(fs.readFileSync(file, "utf8"), content);
  } finally { fixtureDir.dispose(); }
});

test("损坏、缺字段、已过期和符号链接登录均拒绝且错误不泄露凭据", async () => {
  const fixtureDir = fixture();
  try {
    const file = path.join(fixtureDir.auth, "user");
    for (const content of ["synthetic-sensitive-invalid", encrypted({ ...USER, uid: "" }), encrypted({ ...USER, expire_time: 1 }), encrypted({ ...USER, access_token: "", security_oauth_token: "" })]) {
      fs.writeFileSync(file, content);
      await assert.rejects(loadQoderCredentials({ configDir: fixtureDir.directory, desktopDir: null }), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /qoder login|桌面版/);
        assert.ok(!error.message.includes("synthetic"));
        return true;
      });
      assert.equal(fs.readFileSync(file, "utf8"), content);
    }
    fs.unlinkSync(file);
    fs.symlinkSync(path.join(fixtureDir.auth, "machine_id"), file);
    assert.equal(qoderCredentialsPresent(fixtureDir.directory), false);
    await assert.rejects(loadQoderCredentials({ configDir: fixtureDir.directory, desktopDir: null }), /qoder login/);
  } finally { fixtureDir.dispose(); }
});

/** 构造 Electron safeStorage 的 os_crypt v10 信封（PBKDF2 saltysalt + AES-CBC 空格 IV）。 */
const DESKTOP_PASSWORD = "synthetic-keychain-password";
function desktopFixture(): { directory: string; dispose: () => void } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "qoder-desktop-test-"));
  return { directory, dispose: () => fs.rmSync(directory, { recursive: true, force: true }) };
}
function writeDesktopAuth(directory: string, payload: Record<string, unknown>, password = DESKTOP_PASSWORD): void {
  const key = pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1");
  const cipher = createCipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
  const blob = Buffer.concat([Buffer.from("v10", "latin1"), cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  fs.writeFileSync(path.join(directory, "auth.v1.dat"), blob);
  fs.writeFileSync(path.join(directory, "auth.machine-id"), MACHINE + "\n");
}
const DESKTOP_USER = {
  schemaVersion: 1,
  token: "synthetic-desktop-secret-token",
  refreshToken: "synthetic-refresh-secret",
  expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  user: { id: "synthetic-desktop-account", name: "u", email: "u@example.invalid" },
};

test("CLI 缺失时回退桌面版登录，解密 safeStorage 信封生成凭据", async () => {
  const cliDir = fixture();
  const desktop = desktopFixture();
  try {
    // 都缺失 → null
    assert.equal(await loadQoderCredentials({ configDir: cliDir.directory, desktopDir: desktop.directory }), null);
    writeDesktopAuth(desktop.directory, DESKTOP_USER);
    let reads = 0;
    const credential = await loadQoderCredentials({
      configDir: cliDir.directory, desktopDir: desktop.directory,
      keychainPassword: () => { reads++; return DESKTOP_PASSWORD; },
    });
    assert.equal(credential?.region, "intl");
    assert.equal(credential?.accountUid, "synthetic-desktop-account");
    assert.equal(credential?.accessToken, "synthetic-desktop-secret-token");
    assert.equal(credential?.machineId, MACHINE);
    assert.ok(credential!.key && credential!.encryptUserInfo, "运行时认证字段本地生成");
    // 缓存生效：再次加载不再读钥匙串，且身份稳定
    const again = await loadQoderCredentials({ configDir: cliDir.directory, desktopDir: desktop.directory, keychainPassword: () => { reads++; return DESKTOP_PASSWORD; } });
    assert.equal(reads, 1, "文件未变化时复用缓存，不重复读钥匙串");
    assert.equal(again?.identity, credential?.identity);
    // CLI 登录优先于桌面版
    fs.writeFileSync(path.join(cliDir.auth, "user"), encrypted(USER));
    fs.writeFileSync(path.join(cliDir.auth, "machine_id"), MACHINE);
    const preferCli = await loadQoderCredentials({ configDir: cliDir.directory, desktopDir: desktop.directory,
      keychainPassword: () => { throw new Error("不应读取钥匙串"); } });
    assert.equal(preferCli?.accessToken, USER.security_oauth_token);
  } finally { cliDir.dispose(); desktop.dispose(); }
});

test("桌面版钥匙串不可用、信封损坏与过期登录给出带指引的失败", async () => {
  const cliDir = fixture();
  const desktop = desktopFixture();
  try {
    writeDesktopAuth(desktop.directory, DESKTOP_USER);
    await assert.rejects(loadQoderCredentials({
      configDir: cliDir.directory, desktopDir: desktop.directory, keychainPassword: () => null,
    }), (error: unknown) => {
      assert.match((error as Error).message, /钥匙串|始终允许/);
      assert.ok(!(error as Error).message.includes("synthetic"));
      return true;
    });
    fs.writeFileSync(path.join(desktop.directory, "auth.v1.dat"), Buffer.concat([Buffer.from("v11"), randomBytes(64)]));
    await assert.rejects(loadQoderCredentials({
      configDir: cliDir.directory, desktopDir: desktop.directory, keychainPassword: () => DESKTOP_PASSWORD,
    }), /桌面版登录文件损坏|格式不受支持/);
    writeDesktopAuth(desktop.directory, { ...DESKTOP_USER, expiresAt: new Date(Date.now() - 1000).toISOString() });
    // 过期检查基于 options.now 与文件变化，重新写入后缓存失效
    await assert.rejects(loadQoderCredentials({
      configDir: cliDir.directory, desktopDir: desktop.directory, now: Date.now() + 2000, keychainPassword: () => DESKTOP_PASSWORD,
    }), /已过期|桌面版/);
  } finally { cliDir.dispose(); desktop.dispose(); }
});

test("桌面版缓存命中时仍在到期边界拒绝登录且不写回凭据", async () => {
  const cliDir = fixture();
  const desktop = desktopFixture();
  try {
    const expiresAt = 2_000_000_000_999;
    writeDesktopAuth(desktop.directory, { ...DESKTOP_USER, expiresAt: new Date(expiresAt).toISOString() });
    const file = path.join(desktop.directory, "auth.v1.dat");
    const content = fs.readFileSync(file);
    const stat = fs.statSync(file);
    let reads = 0;
    const options = {
      configDir: cliDir.directory, desktopDir: desktop.directory,
      keychainPassword: () => { reads++; return DESKTOP_PASSWORD; },
    };
    const first = await loadQoderCredentials({ ...options, now: expiresAt - 2_000 });
    assert.equal(first?.accountUid, DESKTOP_USER.user.id);
    const beforeExpiry = await loadQoderCredentials({ ...options, now: expiresAt - 1 });
    assert.equal(beforeExpiry, first, "毫秒到期边界前仍复用有效缓存");
    for (const now of [expiresAt, expiresAt + 1]) {
      await assert.rejects(loadQoderCredentials({ ...options, now }), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /桌面版登录已过期/);
        assert.match(error.message, /重新登录/);
        assert.ok(!error.message.includes(DESKTOP_USER.token));
        return true;
      });
    }
    assert.equal(reads, 1, "缓存到期检查不重复读取钥匙串");
    assert.deepEqual(fs.readFileSync(file), content);
    assert.equal(fs.statSync(file).mtimeMs, stat.mtimeMs);
  } finally { cliDir.dispose(); desktop.dispose(); }
});

test("同地域桌面认证目录切换时不复用大小和修改时间相同的缓存", async () => {
  const cliDir = fixture();
  const firstDesktop = desktopFixture();
  const secondDesktop = desktopFixture();
  try {
    writeDesktopAuth(firstDesktop.directory, DESKTOP_USER);
    writeDesktopAuth(secondDesktop.directory, { ...DESKTOP_USER, token: "synthetic-desktop-other-token" });
    const firstFile = path.join(firstDesktop.directory, "auth.v1.dat");
    const secondFile = path.join(secondDesktop.directory, "auth.v1.dat");
    const timestamp = new Date(1_000_000_000_000);
    fs.utimesSync(firstFile, timestamp, timestamp);
    fs.utimesSync(secondFile, timestamp, timestamp);
    assert.equal(fs.statSync(firstFile).size, fs.statSync(secondFile).size);
    assert.equal(fs.statSync(firstFile).mtimeMs, fs.statSync(secondFile).mtimeMs);
    const options = { configDir: cliDir.directory, keychainPassword: () => DESKTOP_PASSWORD };
    const first = await loadQoderCredentials({ ...options, desktopDir: firstDesktop.directory });
    const second = await loadQoderCredentials({ ...options, desktopDir: secondDesktop.directory });
    assert.equal(first?.accessToken, DESKTOP_USER.token);
    assert.equal(second?.accessToken, "synthetic-desktop-other-token");
    assert.equal(second?.authDirectory, secondDesktop.directory);
  } finally { cliDir.dispose(); firstDesktop.dispose(); secondDesktop.dispose(); }
});

test("QODER_FORCE_DESKTOP 强制只读桌面版登录，CLI 登录不参与", async () => {
  const cliDir = fixture();
  const desktop = desktopFixture();
  try {
    fs.writeFileSync(path.join(cliDir.auth, "machine_id"), MACHINE);
    fs.writeFileSync(path.join(cliDir.auth, "user"), encrypted(USER));
    writeDesktopAuth(desktop.directory, DESKTOP_USER);
    const forced = await loadQoderCredentials({
      configDir: cliDir.directory, desktopDir: desktop.directory,
      env: { QODER_FORCE_DESKTOP: "true" }, keychainPassword: () => DESKTOP_PASSWORD,
    });
    assert.equal(forced?.accountUid, "synthetic-desktop-account", "强制模式下凭据来自桌面版");
    const off = await loadQoderCredentials({
      configDir: cliDir.directory, desktopDir: desktop.directory,
      env: { QODER_FORCE_DESKTOP: "0" }, keychainPassword: () => { throw new Error("不应读取钥匙串"); },
    });
    assert.equal(off?.accessToken, USER.security_oauth_token, "未强制时仍走 CLI");
  } finally { cliDir.dispose(); desktop.dispose(); }
});

test("qoderRegionCredentialsPresent 覆盖 CLI 与桌面任一登录", () => {
  const cliDir = fixture();
  const desktop = desktopFixture();
  try {
    assert.equal(qoderRegionCredentialsPresent("cn", cliDir.directory, desktop.directory), false);
    fs.writeFileSync(path.join(cliDir.auth, "machine_id"), MACHINE);
    fs.writeFileSync(path.join(cliDir.auth, "user"), encrypted(USER));
    assert.equal(qoderRegionCredentialsPresent("cn", cliDir.directory, desktop.directory), true, "CLI 登录即可见");
    fs.unlinkSync(path.join(cliDir.auth, "user"));
    assert.equal(qoderRegionCredentialsPresent("cn", cliDir.directory, desktop.directory), false);
    writeDesktopAuth(desktop.directory, DESKTOP_USER);
    assert.equal(qoderRegionCredentialsPresent("cn", cliDir.directory, desktop.directory), true, "桌面登录同样可见");
    assert.equal(qoderRegionCredentialsPresent("cn", cliDir.directory, null), false, "desktopDir=null 显式禁用桌面检测");
  } finally { cliDir.dispose(); desktop.dispose(); }
});

test("Qoder CLI 与桌面版检测相互独立，可分别标记登录来源", () => {
  const cliDir = fixture();
  const desktop = desktopFixture();
  try {
    assert.equal(qoderCliCredentialsPresent("intl", cliDir.directory), false);
    assert.equal(qoderDesktopCredentialsPresent("intl", desktop.directory), false);
    fs.writeFileSync(path.join(cliDir.auth, "user"), encrypted(USER));
    assert.equal(qoderCliCredentialsPresent("intl", cliDir.directory), true, "CLI 文件齐全即为已登录");
    assert.equal(qoderDesktopCredentialsPresent("intl", desktop.directory), false, "CLI 登录不能标记为桌面版");
    writeDesktopAuth(desktop.directory, DESKTOP_USER);
    assert.equal(qoderDesktopCredentialsPresent("intl", desktop.directory), true, "桌面版文件齐全即为已登录");
    assert.equal(qoderDesktopCredentialsPresent("intl", null), false, "desktopDir=null 显式禁用桌面检测");
  } finally { cliDir.dispose(); desktop.dispose(); }
});

test("qoderActiveSources 每个地域只返回实际生效来源", () => {
  const intlCli = fixture();
  const cnCli = fixture();
  const intlDesktop = desktopFixture();
  const cnDesktop = desktopFixture();
  try {
    const options = {
      intlConfigDir: intlCli.directory, cnConfigDir: cnCli.directory,
      intlDesktopDir: intlDesktop.directory, cnDesktopDir: cnDesktop.directory,
      home: "/synthetic/home",
    };
    assert.deepEqual(qoderActiveSources(options), []);
    // 两个地域的 CLI 与桌面版都齐全：仍只返回 CLI，避免展示未实际使用的来源。
    fs.writeFileSync(path.join(intlCli.auth, "user"), encrypted(USER));
    fs.writeFileSync(path.join(cnCli.auth, "user"), encrypted(USER));
    writeDesktopAuth(intlDesktop.directory, DESKTOP_USER);
    writeDesktopAuth(cnDesktop.directory, DESKTOP_USER);
    assert.deepEqual(qoderActiveSources(options), ["CLI-INTL", "CLI-CN"]);
    // 国际版 CLI 缺失时回退桌面版，国内版仍保持 CLI。
    fs.unlinkSync(path.join(intlCli.auth, "user"));
    assert.deepEqual(qoderActiveSources(options), ["DESKTOP-INTL", "CLI-CN"]);
    // 强制桌面模式跳过 CLI。
    assert.deepEqual(qoderActiveSources({ ...options, env: { QODER_FORCE_DESKTOP: "1" } }),
      ["DESKTOP-INTL", "DESKTOP-CN"]);
  } finally {
    intlCli.dispose(); cnCli.dispose(); intlDesktop.dispose(); cnDesktop.dispose();
  }
});
