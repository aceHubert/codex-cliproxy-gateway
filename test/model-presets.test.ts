import assert from "node:assert/strict";
import test from "node:test";
import type { ModelEntry } from "@agent-proxy/plugin-api";
import {
  CODEX_BASELINE_SLUG,
  codexBaselineEntry,
  getCodexBaselineEntry,
  getCodexModelSnapshot,
  getVendorModelPresets,
} from "@agent-proxy/models";
import codexModels from "@agent-proxy/models/codex_client_models.json";
import vendorModels from "@agent-proxy/models/vendor_models.json";

test("私有模型包无需主机上下文即可提供完整预设", () => {
  const snapshot = getCodexModelSnapshot();
  assert.deepEqual(snapshot, codexModels);
  assert.deepEqual(getVendorModelPresets(), vendorModels);
  assert.ok(snapshot.models.every(model => typeof model.slug === "string" && model.slug.length > 0));
  assert.equal(new Set(snapshot.models.map(model => model.slug)).size, snapshot.models.length);
  // 基底条目必须是快照成员（getCodexBaselineEntry 返回克隆，按 slug 判成员）；
  // 快照仍含首选基底（gpt-6-luna）时优先命中它。
  const baseline = getCodexBaselineEntry();
  assert.ok(snapshot.models.some(model => model.slug === baseline.slug));
  if (snapshot.models.some(model => model.slug === CODEX_BASELINE_SLUG)) {
    assert.equal(baseline.slug, CODEX_BASELINE_SLUG);
  }
});

test("codexBaselineEntry 优先返回指定基底条目", () => {
  const luna = { slug: "gpt-6-luna" } as ModelEntry;
  const astra = { slug: "gpt-6-astra" } as ModelEntry;
  assert.equal(codexBaselineEntry([astra, luna]), luna);
  assert.equal(codexBaselineEntry([astra, luna], "gpt-6-astra"), astra);
});

test("codexBaselineEntry 在指定基底缺失时回退快照首条", () => {
  const astra = { slug: "gpt-6-astra" } as ModelEntry;
  const luna = { slug: "gpt-5.6-luna" } as ModelEntry;
  assert.equal(codexBaselineEntry([astra, luna]), astra);
});

test("codexBaselineEntry 拒绝空快照并说明期望基底", () => {
  assert.throws(() => codexBaselineEntry([]), /无法确定目录合成基底/);
  assert.throws(() => codexBaselineEntry([], "gpt-5.6-sol"), /gpt-5\.6-sol/);
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
