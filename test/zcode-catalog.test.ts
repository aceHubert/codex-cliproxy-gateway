import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import vendorModels from "../models/vendor_models.json";
import { createZcodeCatalog, loadZcodeCatalogCache, mergeZcodeCatalog, zcodeUpstreamModel } from "../src/zcode/catalog.ts";
import type { ZcodeFamily, ZcodeProviderSnapshot } from "../src/zcode/config.ts";

const IDS = vendorModels["z.ai"].map((entry) => entry.name);
function snapshot(family: ZcodeFamily = "zai", modelIds: readonly string[] = IDS): ZcodeProviderSnapshot {
  return { family, modelIds, providerID: `builtin:${family}-start-plan`, apiKey: "test-private-business-key",
    baseURL: "https://api.z.ai/api/anthropic", expiresAt: 4_000_000_000_000 };
}
function fixture(run: (file: string, root: string) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-catalog-test-"));
  try { run(path.join(root, "cache", "zcode-catalog.json"), root); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
}
function write(file: string, value: unknown): void {
  fs.writeFileSync(file, JSON.stringify(value));
}

test("ZCode 首次生成共享裸 ID 厂商缓存，重复加载保留内容及 mtime", { timeout: 60_000 }, () => {
  fixture((file) => {
    assert.equal(fs.existsSync(file), false);
    const initial = loadZcodeCatalogCache(file);
    assert.deepEqual(initial.models.map((entry) => entry.slug), IDS);
    assert.equal(fs.existsSync(file), true);
    const before = fs.readFileSync(file, "utf8");
    assert.ok(JSON.parse(before).source_hash);
    assert.ok(JSON.parse(before).content_hash);
    // 固定旧时间，避免依赖文件系统时间分辨率或测试 sleep。
    fs.utimesSync(file, new Date("2001-01-01T00:00:00Z"), new Date("2001-01-01T00:00:00Z"));
    const modified = fs.statSync(file).mtimeMs;
    assert.deepEqual(loadZcodeCatalogCache(file), initial);
    assert.equal(fs.readFileSync(file, "utf8"), before);
    assert.equal(fs.statSync(file).mtimeMs, modified);
  });
});

test("ZCode 缓存内容被改写、缺失模型、错误哈希及坏 JSON 均重建", { timeout: 60_000 }, () => {
  fixture((file) => {
    const expected = loadZcodeCatalogCache(file);
    const original = fs.readFileSync(file, "utf8");
    for (const alter of [
      (value: any) => { value.models[0].description = "test-tampered"; },
      (value: any) => { value.models.pop(); },
      (value: any) => { value.models[0].slug = "unknown-model"; },
      (value: any) => { value.content_hash = "test-wrong-hash"; },
      (value: any) => { value.source_hash = "test-stale-source"; },
    ]) {
      const changed = JSON.parse(original);
      alter(changed);
      write(file, changed);
      assert.deepEqual(loadZcodeCatalogCache(file), expected);
      assert.equal(fs.readFileSync(file, "utf8"), original);
    }
    fs.writeFileSync(file, "{broken-json");
    assert.deepEqual(loadZcodeCatalogCache(file), expected);
    assert.equal(fs.readFileSync(file, "utf8"), original);
  });
});

test("ZCode 厂商覆盖规则变化重建缓存且不继承 GPT 设置或宣告搜索与 WebSocket", { timeout: 60_000 }, () => {
  fixture((file, root) => {
    const overrides = path.join(root, "overrides.json");
    write(overrides, { "z.ai": [{ name: IDS[0], description: "test-before", context_window: 123456 }] });
    const first = loadZcodeCatalogCache(file, overrides);
    const beforeHash = JSON.parse(fs.readFileSync(file, "utf8")).source_hash;
    assert.equal(first.models[0].description, "test-before");
    assert.equal(first.models[0].context_window, 123456);
    write(overrides, {
      "z.ai": [{ name: IDS[0], description: "test-after", context_window: 234567, prefer_websockets: true, supports_search_tool: true }],
      openai: [{ name: "gpt-*", base_instructions: "test-GPT-only-instruction", service_tiers: ["test-GPT-only-tier"] }],
    });
    const changed = loadZcodeCatalogCache(file, overrides);
    assert.notEqual(JSON.parse(fs.readFileSync(file, "utf8")).source_hash, beforeHash);
    assert.equal(changed.models[0].description, "test-after");
    assert.equal(changed.models[0].context_window, 234567);
    for (const entry of changed.models) {
      assert.equal(entry.prefer_websockets, false);
      assert.equal(entry.supports_search_tool, true);
      assert.equal(entry.base_instructions, "");
      assert.equal(entry.service_tiers, undefined);
      assert.equal(entry.additional_speed_tiers, undefined);
      assert.equal(entry.supports_image_detail_original, undefined);
      assert.equal(JSON.stringify(entry).includes("test-GPT-only"), false);
    }
  });
});

test("ZCode 目录重建时过期 Codex 目录缓存，复用缓存时保持原样", { timeout: 60_000 }, () => {
  fixture((file, root) => {
    const codexCache = path.join(root, "models_cache.json");
    const seed = (fetchedAt: string) => fs.writeFileSync(codexCache, JSON.stringify({
      fetched_at: fetchedAt, client_version: "0.154.0", models: [{ slug: "gpt-test" }],
    }));
    const read = () => JSON.parse(fs.readFileSync(codexCache, "utf8"));
    seed("2026-09-12T09:37:23Z");
    loadZcodeCatalogCache(file, undefined, codexCache);
    assert.equal(read().fetched_at, "2000-01-01T00:00:00Z", "首次生成目录必须让 Codex 重新拉取");
    assert.equal(read().client_version, "0.0.0");
    assert.deepEqual(read().models, [{ slug: "gpt-test" }], "只过期时间戳与版本，保留已缓存目录");

    seed("2026-09-12T10:00:00Z");
    loadZcodeCatalogCache(file, undefined, codexCache);
    assert.equal(read().fetched_at, "2026-09-12T10:00:00Z", "目录未变时不得重复过期");

    const tampered = JSON.parse(fs.readFileSync(file, "utf8"));
    tampered.content_hash = "test-wrong-hash";
    write(file, tampered);
    loadZcodeCatalogCache(file, undefined, codexCache);
    assert.equal(read().fetched_at, "2000-01-01T00:00:00Z", "缓存被改写重建后同样过期");
  });
});

test("Z.ai 与 Bigmodel 复用同一裸 ID 缓存，套餐只取大小写无关交集", { timeout: 60_000 }, () => {
  fixture((file) => {
    const cached = loadZcodeCatalogCache(file);
    const before = fs.readFileSync(file, "utf8");
    const zai = createZcodeCatalog(snapshot("zai", [IDS[0].toUpperCase(), "test-unsupported-id"]), cached);
    const bigmodel = createZcodeCatalog(snapshot("bigmodel", [IDS[1].toUpperCase()]), cached);
    assert.deepEqual(zai.models.map((entry) => entry.slug), [`z.ai/${IDS[0]}`]);
    assert.deepEqual(bigmodel.models.map((entry) => entry.slug), [`bigmodel/${IDS[1]}`]);
    assert.equal(zai.models[0].context_window, cached.models[0].context_window);
    assert.equal(bigmodel.models[0].context_window, cached.models[1].context_window);
    assert.deepEqual(cached.models.map((entry) => entry.slug), IDS);
    assert.equal(fs.readFileSync(file, "utf8"), before);
    assert.deepEqual(createZcodeCatalog(snapshot("zai", []), cached), { models: [] });
    assert.deepEqual(createZcodeCatalog(snapshot("bigmodel", ["test-unsupported-id"]), cached), { models: [] });
  });
});

test("ZCode 套餐筛选使用 slug 不使用 entry.name 或显示别名", { timeout: 60_000 }, () => {
  fixture((file) => {
    const cached = loadZcodeCatalogCache(file);
    const renamed = { models: cached.models.map((entry) => ({ ...entry, name: "test-display-alias", display_name: "另一个显示名" })) };
    assert.equal(createZcodeCatalog(snapshot("zai", ["test-display-alias"]), renamed).models.length, 0);
    assert.equal(createZcodeCatalog(snapshot("zai", [IDS[0].toUpperCase()]), renamed).models[0].slug, `z.ai/${IDS[0]}`);
  });
});

test("ZCode 上游模型保留配置原始拼写，拒绝错渠道和套餐外模型", { timeout: 60_000 }, () => {
  const original = IDS[0].toUpperCase();
  const selected = snapshot("zai", [original, "test-unsupported-id"]);
  assert.equal(zcodeUpstreamModel(`z.ai/${IDS[0]}`, selected), original);
  assert.equal(zcodeUpstreamModel(`Z.AI/${original}`, selected), original);
  assert.equal(zcodeUpstreamModel(`bigmodel/${IDS[0]}`, selected), undefined);
  assert.equal(zcodeUpstreamModel(`z.ai/${IDS[1]}`, selected), undefined);
  assert.equal(zcodeUpstreamModel("z.ai/test-unsupported-id", selected), undefined);
  assert.equal(zcodeUpstreamModel(`cliproxy/z.ai/${IDS[0]}`, selected), undefined);
  assert.equal(zcodeUpstreamModel(IDS[0], selected), undefined);
  assert.equal(zcodeUpstreamModel(`bigmodel/${IDS[0]}`, snapshot("bigmodel", [original])), original);
});

test("ZCode 合并保留顶层专用命名空间，移除冲突且不影响 cliproxy/z.ai", { timeout: 60_000 }, () => {
  const official = { slug: "gpt-test", priority: 10 };
  const proxy = { slug: `cliproxy/z.ai/${IDS[0]}`, priority: 20 };
  const base = { models: [official, proxy, { slug: `z.ai/${IDS[0]}` }, { slug: `BIGMODEL/${IDS[1]}` }] };
  const added = { models: [{ slug: `z.ai/${IDS[0]}`, description: "当前套餐" }] };
  const merged = mergeZcodeCatalog(base, added);
  assert.deepEqual(merged.models.map((entry) => entry.slug), [official.slug, proxy.slug, added.models[0].slug]);
  assert.equal(merged.models[0], official);
  assert.equal(merged.models[1], proxy);
  assert.equal(merged.models[2].description, "当前套餐");
  assert.ok(merged.models[2].priority! > proxy.priority);
  assert.equal(base.models.length, 4);
  assert.equal(added.models[0].description, "当前套餐");
  assert.deepEqual(mergeZcodeCatalog(base, { models: [] }).models, [official, proxy]);
});

test("ZCode 磁盘共享缓存和对外目录均不携带配置凭证", { timeout: 60_000 }, () => {
  fixture((file) => {
    const cached = loadZcodeCatalogCache(file);
    const selected = snapshot();
    const publicCatalog = createZcodeCatalog(selected, cached);
    for (const contents of [fs.readFileSync(file, "utf8"), JSON.stringify(publicCatalog)]) {
      for (const secret of [selected.apiKey, selected.providerID, selected.baseURL, String(selected.expiresAt),
        "apiKey", "access_token", "refresh_token", "zcodejwttoken"]) {
        assert.equal(contents.includes(secret), false, `目录不能包含 ${secret}`);
      }
    }
  });
});
