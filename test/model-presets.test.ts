import assert from "node:assert/strict";
import test from "node:test";
import { getCodexModelSnapshot, getVendorModelPresets } from "@agent-proxy/models";
import codexModels from "@agent-proxy/models/codex_client_models.json";
import vendorModels from "@agent-proxy/models/vendor_models.json";

test("私有模型包无需主机上下文即可提供完整预设", () => {
  const snapshot = getCodexModelSnapshot();
  assert.deepEqual(snapshot, codexModels);
  assert.deepEqual(getVendorModelPresets(), vendorModels);
  assert.ok(snapshot.models.every(model => typeof model.slug === "string" && model.slug.length > 0));
  assert.equal(new Set(snapshot.models.map(model => model.slug)).size, snapshot.models.length);
  assert.ok(snapshot.models.some(model => model.slug === "gpt-5.5"));
});

test("插件修改 Codex 模型快照不会污染后续调用的内置资源", () => {
  const snapshot = getCodexModelSnapshot();
  const expected = structuredClone(snapshot);
  assert.ok(snapshot.models.length > 1);
  snapshot.models[0]!.slug = "synthetic-mutated";
  snapshot.models.pop();
  assert.deepEqual(getCodexModelSnapshot(), expected);
});

test("插件修改厂商预设不会污染后续调用的内置资源", () => {
  const presets = getVendorModelPresets();
  const expected = structuredClone(presets);
  const models = presets["z.ai"]!;
  assert.ok(models.length > 1);
  models[0]!.name = "synthetic-mutated";
  models.pop();
  delete presets["deepseek"];
  assert.deepEqual(getVendorModelPresets(), expected);
});
