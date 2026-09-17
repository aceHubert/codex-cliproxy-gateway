import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import {
  FALLBACK_CLIENT_VERSION,
  parseCodexVersion,
  readCachedClientVersion,
  resolveCodexClientVersion,
} from "../src/codex-version.ts";

test("parseCodexVersion extracts the version from codex --version output", () => {
  assert.equal(parseCodexVersion("codex-cli 0.153.4"), "0.153.4");
  assert.equal(parseCodexVersion("codex-cli 0.153.4\n"), "0.153.4");
  assert.equal(parseCodexVersion("codex 1.2.3 (build 7)"), "1.2.3");
  assert.equal(parseCodexVersion("no version here"), undefined);
});

function withCacheFile(contents: string | undefined, run: (file: string) => void): void {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-version-"));
  const file = path.join(directory, "models_cache.json");
  if (contents !== undefined) fs.writeFileSync(file, contents);
  try {
    run(file);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test("readCachedClientVersion reads the client version recorded by the gateway", () => {
  withCacheFile(JSON.stringify({ client_version: "0.149.0", fetched_at: "2026-09-11T00:00:00Z" }), (file) => {
    assert.equal(readCachedClientVersion(file), "0.149.0");
  });
});

test("readCachedClientVersion rejects unusable caches", () => {
  // 0.0.0 是历史遗留的失效标记；缺失/非法值同样不能当成真实版本用下去。
  withCacheFile(JSON.stringify({ client_version: "0.0.0" }), (file) => {
    assert.equal(readCachedClientVersion(file), undefined);
  });
  withCacheFile(JSON.stringify({ client_version: "unknown" }), (file) => {
    assert.equal(readCachedClientVersion(file), undefined);
  });
  withCacheFile(JSON.stringify({ fetched_at: "2026-09-11T00:00:00Z" }), (file) => {
    assert.equal(readCachedClientVersion(file), undefined);
  });
  withCacheFile("{ not json", (file) => {
    assert.equal(readCachedClientVersion(file), undefined);
  });
  withCacheFile(undefined, (file) => {
    assert.equal(readCachedClientVersion(file), undefined);
  });
});

test("resolveCodexClientVersion prefers the gateway-recorded version over the PATH binary", () => {
  // PATH 上的 codex 可能是另一个安装（更旧或更新的全局 CLI），网关记的自报版本更贴近真实消费者。
  withCacheFile(JSON.stringify({ client_version: "0.149.0" }), (file) => {
    assert.equal(resolveCodexClientVersion(file, () => "0.153.4", {}), "0.149.0");
  });
});

test("resolveCodexClientVersion falls back to the codex --version probe when the cache is unusable", () => {
  // 尚未有 /models 请求（首次安装）：网关还没记下任何版本。
  withCacheFile(JSON.stringify({ client_version: "0.0.0" }), (file) => {
    assert.equal(resolveCodexClientVersion(file, () => "0.153.4", {}), "0.153.4");
  });
  withCacheFile(undefined, (file) => {
    assert.equal(resolveCodexClientVersion(file, () => "0.153.4", {}), "0.153.4");
  });
});

test("resolveCodexClientVersion falls back to 0.0.0 when nothing can be probed", () => {
  withCacheFile(undefined, (file) => {
    assert.equal(resolveCodexClientVersion(file, () => undefined, {}), FALLBACK_CLIENT_VERSION);
  });
});

test("resolveCodexClientVersion prefers the explicit CODEX_CLIPROXY_CLIENT_VERSION", () => {
  withCacheFile(JSON.stringify({ client_version: "0.149.0" }), (file) => {
    const env = { CODEX_CLIPROXY_CLIENT_VERSION: "1.2.3" };
    assert.equal(resolveCodexClientVersion(file, () => "0.153.4", env), "1.2.3");
  });
});

test("resolveCodexClientVersion rejects a malformed CODEX_CLIPROXY_CLIENT_VERSION", () => {
  withCacheFile(undefined, (file) => {
    const env = { CODEX_CLIPROXY_CLIENT_VERSION: "codex-cli 0.153.4" };
    assert.throws(
      () => resolveCodexClientVersion(file, () => "0.153.4", env),
      /CODEX_CLIPROXY_CLIENT_VERSION must be a version like 0\.153\.4/,
    );
  });
});
