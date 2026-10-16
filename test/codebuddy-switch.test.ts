import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "./host-test.ts";
import { codebuddyCommand } from "../apps/gateway/src/cli.ts";
import { GATEWAY_CONFIG_SCHEMA_URL, GATEWAY_CONFIG_VERSION } from "../apps/gateway/src/config.ts";
import { resolvePaths, runWithInstancePaths } from "../apps/gateway/src/paths.ts";
import type { GatewayConfig } from "../apps/gateway/src/types.ts";

type SelectKey = "down" | "enter" | "cancel";

async function assertUnchangedSelection(account: string | undefined, keys: SelectKey[]): Promise<void> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cb-switch-noop-"));
  // 所有实例路径均由虚拟环境解析，不修改进程 HOME，也不接触真实安装。
  const paths = resolvePaths({ HOME: home, CODEX_HOME: path.join(home, ".codex") });
  const authDirectory = path.join(home, "auth");
  const printed: string[] = [];
  const oldLog = console.log;
  const oldWrite = process.stdout.write;
  try {
    fs.mkdirSync(paths.runtimeHome, { recursive: true });
    fs.mkdirSync(paths.codexHome, { recursive: true });
    fs.mkdirSync(authDirectory);
    const config: GatewayConfig = {
      $schema: GATEWAY_CONFIG_SCHEMA_URL,
      configVersion: GATEWAY_CONFIG_VERSION,
      host: "127.0.0.1", port: 8320, mountPath: "/v1", prefix: "cliproxy/",
      officialBaseUrl: "https://official.invalid/v1", upstreamBaseUrl: "https://upstream.invalid/v1",
      catalogPath: paths.catalogFile, logDir: paths.logDir,
      zcode: false, codebuddy: true, qoder: false, agy: false, opencodeZen: false,
      ...(account === undefined ? {} : { codebuddyAccount: account }),
    };
    fs.writeFileSync(paths.gatewayConfig, `${JSON.stringify(config)}\n`);
    fs.writeFileSync(paths.stateFile, `${JSON.stringify({ version: 4, config })}\n`);
    fs.writeFileSync(paths.stdoutLog, "既有审计记录\n");
    fs.writeFileSync(paths.modelsCacheFile, '{"models":[{"slug":"existing-model"}]}\n');

    const token = `header.${Buffer.from(JSON.stringify({ iss: "https://www.codebuddy.ai/auth/realms/copilot" })).toString("base64url")}.sig`;
    for (const [nickname, lastRefreshTime] of [["Alpha", 1_000], ["Beta", 5_000]] as const) {
      fs.writeFileSync(path.join(authDirectory, `${nickname.toLowerCase()}.info`), JSON.stringify({
        account: { uid: `uid-${nickname}`, nickname, enterpriseId: "" },
        auth: {
          accessToken: token, refreshToken: token, domain: "www.codebuddy.ai",
          expiresAt: Date.now() + 90 * 24 * 3600 * 1000, lastRefreshTime,
        },
      }));
    }
    const files = [paths.gatewayConfig, paths.stateFile, paths.stdoutLog, paths.modelsCacheFile];
    const snapshots = files.map((file) => ({ content: fs.readFileSync(file, "utf8"), inode: fs.statSync(file).ino }));
    console.log = (value?: unknown) => { printed.push(String(value)); };
    process.stdout.write = ((value: string | Uint8Array) => {
      printed.push(String(value));
      return true;
    }) as typeof process.stdout.write;
    let keyIndex = 0;
    await runWithInstancePaths(paths, () => codebuddyCommand({
      interactive: true,
      authDirectory,
      keySource: {
        read: async () => keys[keyIndex++] ?? "cancel",
        close: () => {},
      },
    }));

    for (const [index, file] of files.entries()) {
      assert.equal(fs.readFileSync(file, "utf8"), snapshots[index]!.content, `${path.basename(file)} 内容必须不变`);
      assert.equal(fs.statSync(file).ino, snapshots[index]!.inode, `${path.basename(file)} 不应被原子替换`);
    }
    const output = printed.join("\n");
    assert.match(output, /CodeBuddy account unchanged; nothing to save\./);
    assert.doesNotMatch(output, /restarted|configuration saved/i);
    assert.match(output, /Auto\(Beta \/ intl\)/, "最近刷新的 Beta 必须折叠进 Auto，Alpha 仍可单独选择");
    if (account === undefined) {
      const storedConfig = JSON.parse(fs.readFileSync(paths.gatewayConfig, "utf8")) as Record<string, unknown>;
      assert.equal(Object.hasOwn(storedConfig, "codebuddyAccount"), false, "缺省 Auto 不应补写账号字段");
    }
  } finally {
    console.log = oldLog;
    process.stdout.write = oldWrite;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test("codebuddy --switch 重复选择显式 Auto 不写配置、状态、审计或缓存", { skip: process.platform !== "darwin", timeout: 60_000 }, async () => {
  await assertUnchangedSelection("auto", ["enter"]);
});

test("codebuddy --switch 缺省 Auto 再选 Auto 不补写字段或重启", { skip: process.platform !== "darwin", timeout: 60_000 }, async () => {
  await assertUnchangedSelection(undefined, ["enter"]);
});

test("codebuddy --switch 重复选择已锁定账号不写配置、状态、审计或缓存", { skip: process.platform !== "darwin", timeout: 60_000 }, async () => {
  // Beta 作为最近登录折叠进 Auto；向下选择仍可单独列出的已锁定 Alpha。
  await assertUnchangedSelection("intl-cli:uid-Alpha", ["down", "enter"]);
});
