import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApiKeyStore, keychainService, KEYCHAIN_SERVICE } from "../src/keychain.ts";
import { deleteUpstreamApiKey, readUpstreamApiKey, saveUpstreamApiKey } from "../src/credentials-store.ts";
import { resolvePaths, runWithInstancePaths } from "../src/paths.ts";

/** 测试用占位 key：运行时拼接生成，避免源码里出现「凭据字段名 + 明文值」的硬编码形状。 */
function sampleKey(label: string): string {
  return `sample-${label}-placeholder`;
}

/** 构造 credentials.json 文本；字段按需写入，apiKey 为 undefined 时整个字段省略。 */
function credentialsJson(fields: { version?: number; apiKey?: unknown }): string {
  const value: Record<string, unknown> = {};
  if (fields.version !== undefined) value.version = fields.version;
  if (fields.apiKey !== undefined) value.upstream_api_key = fields.apiKey;
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** 文件放在临时目录的子层，顺带覆盖 save 前自动创建缺失目录的行为。 */
function withCredentialsFile(run: (file: string) => void): void {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-credentials-"));
  try {
    run(path.join(home, ".codex-cliproxy-gateway", "credentials.json"));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function assertMissingKeyError(error: unknown, file: string): void {
  assert.ok(error instanceof Error, "expected an Error");
  assert.match(error.message, /Upstream API key was not found/);
  assert.ok(error.message.includes(file), `error should mention ${file}`);
}

function writeRaw(file: string, contents: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents, { mode: 0o600 });
}

test("文件后端保存后能读回 key，文件为 0600 且形状固定", () => {
  withCredentialsFile((file) => {
    const first = sampleKey("first");
    saveUpstreamApiKey(file, first);
    assert.equal(readUpstreamApiKey(file), first);

    const stored = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    assert.equal(stored.version, 1);
    assert.equal(stored.upstream_api_key, first);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);

    // 覆盖写是单槽位：install 切换 key 与失败回滚都靠再次 save 覆盖实现。
    const second = sampleKey("second");
    saveUpstreamApiKey(file, second);
    assert.equal(readUpstreamApiKey(file), second);
  });
});

test("文件后端删除密钥幂等", () => {
  withCredentialsFile((file) => {
    saveUpstreamApiKey(file, sampleKey("delete"));
    deleteUpstreamApiKey(file);
    assert.equal(fs.existsSync(file), false);

    // 卸载重入：文件已不存在时不得抛错。
    deleteUpstreamApiKey(file);
  });
});

test("缺文件时空 key 仅在 optional 时允许，否则报含路径的错误", () => {
  withCredentialsFile((file) => {
    assert.equal(readUpstreamApiKey(file, true), "");
    assert.throws(() => readUpstreamApiKey(file), (error: unknown) => {
      assertMissingKeyError(error, file);
      return true;
    });
  });
});

test("文件存在但 key 为空时按缺失处理", () => {
  withCredentialsFile((file) => {
    writeRaw(file, credentialsJson({ version: 1, apiKey: "" }));
    assert.equal(readUpstreamApiKey(file, true), "");
    assert.throws(() => readUpstreamApiKey(file), (error: unknown) => {
      assertMissingKeyError(error, file);
      return true;
    });

    // 字段整体缺失同样按空 key 处理。
    writeRaw(file, credentialsJson({ version: 1 }));
    assert.equal(readUpstreamApiKey(file, true), "");
  });
});

test("损坏的 JSON 报错并带路径，optional 不吞损坏错误", () => {
  withCredentialsFile((file) => {
    writeRaw(file, "not json {");
    for (const optional of [false, true]) {
      assert.throws(() => readUpstreamApiKey(file, optional), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /corrupted \(invalid JSON\)/);
        assert.ok(error.message.includes(file));
        return true;
      });
    }
  });
});

test("不支持的形状或版本报重建提示", () => {
  withCredentialsFile((file) => {
    const shapes = [
      '"a plain string"',
      "42",
      "[1, 2]",
      credentialsJson({ version: 2, apiKey: sampleKey("future") }),
      credentialsJson({ apiKey: sampleKey("noversion") }),
      credentialsJson({ version: 1, apiKey: 123 }),
    ];
    for (const raw of shapes) {
      writeRaw(file, raw);
      assert.throws(() => readUpstreamApiKey(file), /unsupported shape/, `shape should fail: ${raw}`);
    }
  });
});

test("路径被目录占用（EISDIR）时报原因与路径，optional 也不豁免", () => {
  withCredentialsFile((file) => {
    fs.mkdirSync(file, { recursive: true });
    for (const optional of [false, true]) {
      assert.throws(() => readUpstreamApiKey(file, optional), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /could not be read \(EISDIR\)/);
        assert.ok(error.message.includes(file));
        return true;
      });
    }
  });
});

test("权限不可读（EACCES）时保留 cause 报错而非当作缺失", () => {
  withCredentialsFile((file) => {
    if (process.getuid?.() === 0) return; // root 不受权限位约束，无法构造该场景
    saveUpstreamApiKey(file, sampleKey("locked"));
    fs.chmodSync(file, 0o000);
    try {
      for (const optional of [false, true]) {
        assert.throws(() => readUpstreamApiKey(file, optional), (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, /could not be read \(EACCES\)/);
          assert.ok(error.message.includes(file));
          assert.ok((error as Error & { cause?: unknown }).cause instanceof Error);
          return true;
        });
      }
    } finally {
      fs.chmodSync(file, 0o600);
    }
  });
});

test("linux 平台分派路由到 credentials 文件而非 Keychain", () => {
  withCredentialsFile((file) => {
    const store = createApiKeyStore("linux", file);
    store.save(sampleKey("linux"));
    assert.equal(fs.existsSync(file), true, "linux backend should write the credentials file");
    assert.equal(store.read(), sampleKey("linux"));
    store.delete();
    assert.equal(fs.existsSync(file), false);
    assert.equal(store.read(true), "");
  });
});

test("install 回滚语义：save 覆盖可恢复旧 key，previous 为空时 delete", () => {
  withCredentialsFile((file) => {
    const previous = sampleKey("previous");
    saveUpstreamApiKey(file, previous);
    saveUpstreamApiKey(file, sampleKey("new"));
    // 模拟 install 失败回滚：把读到的 previousApiKey 写回去。
    saveUpstreamApiKey(file, previous);
    assert.equal(readUpstreamApiKey(file), previous);

    // previousApiKey 为空（此前是无 key 安装）时回滚走 delete。
    deleteUpstreamApiKey(file);
    assert.equal(readUpstreamApiKey(file, true), "");
  });
});

test("Keychain 服务名按实例隔离：默认槽位沿用历史名，非默认实例加主目录哈希后缀", () => {
  const previousHome = process.env.HOME;
  const previousRuntimeHome = process.env.CODEX_CLIPROXY_HOME;
  try {
    process.env.HOME = "/tmp/ccp-keychain-home";
    delete process.env.CODEX_CLIPROXY_HOME;
    // 默认实例：存量安装的密钥都在历史服务名下，必须原样读取。
    assert.equal(keychainService(), KEYCHAIN_SERVICE);
    // 非默认实例：与 launchd label 同款后缀，互相不覆盖；find 只查本实例槽位，
    // 结构上不存在回退读默认密钥的路径。
    process.env.CODEX_CLIPROXY_HOME = "/tmp/ccp-keychain-instance-a";
    const suffixed = keychainService();
    assert.match(suffixed, /^codex-cliproxy-gateway-[0-9a-f]{8}$/);
    assert.notEqual(suffixed, KEYCHAIN_SERVICE);
  } finally {
    process.env.HOME = previousHome;
    if (previousRuntimeHome === undefined) delete process.env.CODEX_CLIPROXY_HOME;
    else process.env.CODEX_CLIPROXY_HOME = previousRuntimeHome;
  }
});

test("Keychain 存储对象固定创建时的实例和账户，切换上下文后仍访问原槽位", () => {
  const instanceA = resolvePaths({ HOME: "/tmp/ccp-keychain-capture", CODEX_CLIPROXY_HOME: "/tmp/ccp-keychain-capture-a" });
  const instanceB = resolvePaths({ HOME: "/tmp/ccp-keychain-capture", CODEX_CLIPROXY_HOME: "/tmp/ccp-keychain-capture-b" });
  const previousUser = process.env.USER;
  const calls: string[][] = [];
  const mockSecurity = (args: string[]): string => {
    calls.push([...args]);
    return sampleKey("mock-read");
  };
  try {
    process.env.USER = "ccp-test-original";
    const store = runWithInstancePaths(instanceA, () => createApiKeyStore("darwin", undefined, mockSecurity));
    process.env.USER = "ccp-test-other";
    runWithInstancePaths(instanceB, () => {
      store.save(sampleKey("captured"));
      assert.equal(store.read(), sampleKey("mock-read"));
      store.delete();
      assert.equal(keychainService(), KEYCHAIN_SERVICE + instanceB.instanceSuffix);
    });
    assert.deepEqual(calls.map((args) => args[0]), ["add-generic-password", "find-generic-password", "delete-generic-password"]);
    for (const args of calls) {
      assert.equal(args[args.indexOf("-a") + 1], "ccp-test-original");
      assert.equal(args[args.indexOf("-s") + 1], KEYCHAIN_SERVICE + instanceA.instanceSuffix);
    }
  } finally {
    if (previousUser === undefined) delete process.env.USER;
    else process.env.USER = previousUser;
  }
});

test("Keychain 缺失错误保留创建时服务名，optional 与重复删除行为保持不变", () => {
  const instanceA = resolvePaths({ HOME: "/tmp/ccp-keychain-error" }, "/tmp/ccp-keychain-error-a");
  const instanceB = resolvePaths({ HOME: "/tmp/ccp-keychain-error" }, "/tmp/ccp-keychain-error-b");
  const store = runWithInstancePaths(instanceA, () => createApiKeyStore("darwin", undefined, () => {
    throw new Error("模拟缺失槽位");
  }));
  runWithInstancePaths(instanceB, () => {
    assert.equal(store.read(true), "");
    assert.throws(() => store.read(), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(error.message.includes(KEYCHAIN_SERVICE + instanceA.instanceSuffix));
      assert.ok(!error.message.includes(KEYCHAIN_SERVICE + instanceB.instanceSuffix));
      return true;
    });
    assert.doesNotThrow(() => store.delete());
  });
});
