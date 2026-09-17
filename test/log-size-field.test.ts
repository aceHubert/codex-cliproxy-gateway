import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isValidRequestLogCount, LOG_SIZE_UNITS, parseLogSizeField, splitLogSize } from "../src/ui/log-size-field.ts";
import { applyWebUiConfigPatch, parseMaxLogSize } from "../src/config-update.ts";
import { resolvePaths } from "../src/paths.ts";
import { GATEWAY_CONFIG_VERSION } from "../src/config.ts";

test("日志上限零值提交数字，非零值提交带单位字符串", () => {
  assert.deepEqual(LOG_SIZE_UNITS, ["KB", "MB"]);
  for (const unit of LOG_SIZE_UNITS) {
    assert.deepEqual(parseLogSizeField("0", unit), { bytes: 0, payload: 0 });
    assert.equal(parseLogSizeField("1024", unit)?.payload, `1024${unit}`);
    assert.equal(parseLogSizeField("1024.001", unit), null);
    assert.equal(parseLogSizeField("1025", unit), null);
  }
  assert.deepEqual(parseLogSizeField("10", "MB"), { bytes: 10485760, payload: "10MB" });
  assert.deepEqual(parseLogSizeField("1.5", "KB"), { bytes: 1536, payload: "1.5KB" });
  for (const value of ["", " ", "-1", "-0.1", "abc", "Infinity", "NaN", "1e100"]) {
    assert.equal(parseLogSizeField(value, "MB"), null, value);
  }
});

test("已有日志上限回显并再次提交时保留字节精度", () => {
  assert.deepEqual(splitLogSize(1), { value: "0.0009765625", unit: "KB" });
  assert.deepEqual(splitLogSize(1024 ** 3), { value: "1024", unit: "MB" });
  for (const bytes of [0, 1, 1023, 1024, 1536, 1048577, 10 * 1024 ** 2, 1024 ** 3]) {
    const field = splitLogSize(bytes);
    const parsed = parseLogSizeField(field.value, field.unit);
    assert.ok(parsed);
    assert.equal(parsed.bytes, bytes);
    assert.equal(parseMaxLogSize(String(parsed.payload)), bytes);
  }
});

test("请求日志保留数只允许 0～1000 的整数", () => {
  for (const value of ["0", "1", "999", "1000"]) assert.equal(isValidRequestLogCount(value), true);
  for (const value of ["-1", "1001", "0.5", "1.5", "", " ", "NaN", "Infinity", "1e2"]) {
    assert.equal(isValidRequestLogCount(value), false, value);
  }
});

test("配置保存接受数字零并拒绝负数，失败时保留已有配置", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccp-log-size-"));
  const paths = resolvePaths({ HOME: home });
  fs.mkdirSync(paths.runtimeHome, { recursive: true });
  fs.writeFileSync(paths.gatewayConfig, JSON.stringify({
    configVersion: GATEWAY_CONFIG_VERSION,
    host: "127.0.0.1", port: 8320, mountPath: "/v1", prefix: "cliproxy/",
    officialBaseUrl: "https://official.example/v1", upstreamBaseUrl: "http://127.0.0.1:8317/v1",
    catalogPath: paths.catalogFile, maxGatewayLogBytes: 10485760, zcode: false,
  }));
  try {
    assert.equal(applyWebUiConfigPatch(paths, { maxGatewayLogBytes: 0 }).config.maxGatewayLogBytes, 0);
    const original = fs.readFileSync(paths.gatewayConfig, "utf8");
    for (const value of [-1, "-1MB", "", true, 10]) {
      assert.throws(() => applyWebUiConfigPatch(paths, { maxGatewayLogBytes: value }));
      assert.equal(fs.readFileSync(paths.gatewayConfig, "utf8"), original);
    }
    assert.equal(applyWebUiConfigPatch(paths, { maxGatewayLogBytes: "1.5KB" }).config.maxGatewayLogBytes, 1536);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
