import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import vendorModels from "../models/vendor_models.json";
import {
  buildZcodeVendorCatalog,
  createZcodeCatalog,
  isZcodeModel,
  mergeZcodeCatalog,
  writeZcodeServedCatalog,
  zcodeModelPlan,
  zcodeUpstreamModel,
} from "../src/zcode/catalog.ts";
import type { ZcodeFamily, ZcodeProviderSnapshot, ZcodeSelection } from "../src/zcode/config.ts";

const IDS = vendorModels["z.ai"].map((entry) => entry.name);
function snapshot(
  family: ZcodeFamily = "zai",
  modelIds: readonly string[] = IDS,
  plan: ZcodeSelection["kind"] = "api-key",
): ZcodeProviderSnapshot {
  const providerID = plan === "start-plan" ? `builtin:${family}-start-plan`
    : plan === "api-key" ? `${family}-test` : `builtin:${family}-coding-plan`;
  return { family, providerID, plan, modelIds, apiKey: "test-private-business-key",
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
function read(file: string): { content_hash: string; models: { slug: string }[] } {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

test("ZCode 厂商目录由内置预设纯内存合成，不落盘", { timeout: 60_000 }, () => {
  fixture((file) => {
    const catalog = buildZcodeVendorCatalog();
    assert.deepEqual(catalog.models.map((entry) => entry.slug), IDS);
    assert.equal(fs.existsSync(file), false, "厂商全量目录不依赖磁盘缓存");
    assert.deepEqual(buildZcodeVendorCatalog(), catalog, "重复合成结果稳定");
    assert.notEqual(buildZcodeVendorCatalog(), catalog, "每次返回独立对象");
  });
});

test("ZCode 厂商覆盖规则生效且不继承 GPT 设置或宣告 WebSocket", { timeout: 60_000 }, () => {
  fixture((_file, root) => {
    const overrides = path.join(root, "overrides.json");
    write(overrides, { "z.ai": [{ name: IDS[0], description: "test-before", context_window: 123456 }] });
    const first = buildZcodeVendorCatalog(overrides);
    assert.equal(first.models[0]!.description, "test-before");
    assert.equal(first.models[0]!.context_window, 123456);

    write(overrides, {
      "z.ai": [{ name: IDS[0], description: "test-after", context_window: 234567, prefer_websockets: true, supports_search_tool: true }],
      openai: [{ name: "gpt-*", base_instructions: "test-GPT-only-instruction", service_tiers: ["test-GPT-only-tier"] }],
    });
    const changed = buildZcodeVendorCatalog(overrides);
    assert.equal(changed.models[0]!.description, "test-after");
    assert.equal(changed.models[0]!.context_window, 234567);
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

test("ZCode 对外目录按当前套餐落盘，内容不变时不重复写盘", { timeout: 60_000 }, () => {
  fixture((file) => {
    const vendor = buildZcodeVendorCatalog();
    const coding = createZcodeCatalog(snapshot("zai", [IDS[0]]), vendor);
    assert.equal(writeZcodeServedCatalog(file, coding), true);
    assert.deepEqual(read(file).models.map((model) => model.slug), [`zcode/${IDS[0]}`]);
    assert.ok(read(file).content_hash);

    // 固定旧时间，避免依赖文件系统时间分辨率或测试 sleep。
    fs.utimesSync(file, new Date("2001-01-01T00:00:00Z"), new Date("2001-01-01T00:00:00Z"));
    const modified = fs.statSync(file).mtimeMs;
    assert.equal(writeZcodeServedCatalog(file, coding), false);
    assert.equal(fs.statSync(file).mtimeMs, modified, "内容未变化不得改写文件");

    // 套餐切换后目录文件随之收敛，不再包含旧套餐模型。
    const start = createZcodeCatalog(snapshot("zai", [IDS[1]]), vendor);
    assert.equal(writeZcodeServedCatalog(file, start), true);
    assert.deepEqual(read(file).models.map((model) => model.slug), [`zcode/${IDS[1]}`]);
  });
});

test("ZCode 配置失效时对外目录落空，不留旧套餐模型", { timeout: 60_000 }, () => {
  fixture((file) => {
    const vendor = buildZcodeVendorCatalog();
    writeZcodeServedCatalog(file, createZcodeCatalog(snapshot("zai", [IDS[0]]), vendor));
    assert.equal(read(file).models.length, 1);
    assert.equal(writeZcodeServedCatalog(file, { models: [] }), true);
    assert.deepEqual(read(file).models, []);
  });
});

test("两种渠道复用同一厂商目录，统一 zcode/ 前缀且套餐只取大小写无关交集", { timeout: 60_000 }, () => {
  fixture(() => {
    const vendor = buildZcodeVendorCatalog();
    const zai = createZcodeCatalog(snapshot("zai", [IDS[0].toUpperCase(), "test-unsupported-id"]), vendor);
    const bigmodel = createZcodeCatalog(snapshot("bigmodel", [IDS[1].toUpperCase()]), vendor);
    assert.deepEqual(zai.models.map((entry) => entry.slug), [`zcode/${IDS[0]}`]);
    assert.deepEqual(bigmodel.models.map((entry) => entry.slug), [`zcode/${IDS[1]}`]);
    assert.equal(zai.models[0]!.context_window, vendor.models[0]!.context_window);
    assert.equal(bigmodel.models[0]!.context_window, vendor.models[1]!.context_window);
    assert.deepEqual(vendor.models.map((entry) => entry.slug), IDS, "厂商目录不因套餐变化被改写");
    assert.deepEqual(createZcodeCatalog(snapshot("zai", []), vendor), { models: [] });
    assert.deepEqual(createZcodeCatalog(snapshot("bigmodel", ["test-unsupported-id"]), vendor), { models: [] });
  });
});

test("ZCode 套餐筛选使用 slug 不使用 entry.name 或显示别名", { timeout: 60_000 }, () => {
  fixture(() => {
    const vendor = buildZcodeVendorCatalog();
    const renamed = { models: vendor.models.map((entry) => ({ ...entry, name: "test-display-alias", display_name: "另一个显示名" })) };
    assert.equal(createZcodeCatalog(snapshot("zai", ["test-display-alias"]), renamed).models.length, 0);
    assert.equal(createZcodeCatalog(snapshot("zai", [IDS[0].toUpperCase()]), renamed).models[0]!.slug, `zcode/${IDS[0]}`);
  });
});

test("ZCode 上游模型保留配置原始拼写，旧厂商前缀与套餐外模型均拒绝", { timeout: 60_000 }, () => {
  const original = IDS[0].toUpperCase();
  const selected = snapshot("zai", [original, "test-unsupported-id"]);
  assert.equal(zcodeUpstreamModel(`zcode/${IDS[0]}`, selected), original);
  assert.equal(zcodeUpstreamModel(`ZCODE/${original}`, selected), original);
  assert.equal(zcodeUpstreamModel(`z.ai/${IDS[0]}`, selected), undefined);
  assert.equal(zcodeUpstreamModel(`bigmodel/${IDS[0]}`, selected), undefined);
  assert.equal(zcodeUpstreamModel("zcode/test-unsupported-id", selected), undefined);
  assert.equal(zcodeUpstreamModel(`zcode/${IDS[1]}`, selected), undefined);
  assert.equal(zcodeUpstreamModel(`cliproxy/zcode/${IDS[0]}`, selected), undefined);
  assert.equal(zcodeUpstreamModel(IDS[0], selected), undefined);
  // 渠道由套餐快照决定，统一命名空间下两种渠道都能解析同一模型。
  assert.equal(zcodeUpstreamModel(`zcode/${IDS[0]}`, snapshot("bigmodel", [original])), original);
});

test("套餐段必须与快照连接形态一致：会话只能用所选套餐的模型拼写", { timeout: 60_000 }, () => {
  const original = IDS[0].toUpperCase();
  const start = snapshot("zai", [original], "start-plan");
  assert.equal(zcodeUpstreamModel(`zcode-start-plan/${IDS[0]}`, start), original);
  // 套餐段与快照不符（个人/团队/自定义/免费互串）一律拒绝。
  assert.equal(zcodeUpstreamModel(`zcode/${IDS[0]}`, start), undefined);
  assert.equal(zcodeUpstreamModel(`zcode-individual-coding-plan/${IDS[0]}`, start), undefined);
  assert.equal(zcodeUpstreamModel(`zcode-start-plan/${IDS[0]}`, snapshot("zai", [original])), undefined);
  assert.equal(zcodeUpstreamModel(`zcode-start-plan/${IDS[0]}`, snapshot("zai", [original], "individual-coding-plan")), undefined);
  assert.equal(zcodeUpstreamModel(`zcode-team-coding-plan/${IDS[0]}`, snapshot("zai", [original], "team-coding-plan")), original);
  assert.equal(zcodeUpstreamModel(`zcode-individual-coding-plan/${IDS[0]}`, snapshot("zai", [original], "individual-coding-plan")), original);
});

test("对外模型 ID 解析套餐作用域，未声明的 zcode- 段不属于任何套餐", () => {
  assert.equal(zcodeModelPlan(`zcode/${IDS[0]}`), "api-key");
  assert.equal(zcodeModelPlan(`ZCODE-START-PLAN/${IDS[0]}`), "start-plan");
  assert.equal(zcodeModelPlan(`zcode-individual-coding-plan/${IDS[0]}`), "individual-coding-plan");
  assert.equal(zcodeModelPlan(`zcode-team-coding-plan/${IDS[0]}`), "team-coding-plan");
  assert.equal(zcodeModelPlan(`zcode-unknown-plan/${IDS[0]}`), undefined);
  assert.equal(zcodeModelPlan(`z.ai/${IDS[0]}`), undefined);
  assert.equal(zcodeModelPlan(IDS[0]), undefined);
  // 命名空间判定同时覆盖裸前缀与套餐段，未声明的段仍进入网关后按 404 处理。
  assert.equal(isZcodeModel(`zcode/${IDS[0]}`), true);
  assert.equal(isZcodeModel(`zcode-team-coding-plan/${IDS[0]}`), true);
  assert.equal(isZcodeModel(`zcode-unknown-plan/${IDS[0]}`), true);
  assert.equal(isZcodeModel("zcode"), false);
  assert.equal(isZcodeModel(`z.ai/${IDS[0]}`), false);
});

test("目录按套餐作用域生成前缀与显示名分组", { timeout: 60_000 }, () => {
  fixture(() => {
    const vendor = buildZcodeVendorCatalog();
    const individual = createZcodeCatalog(snapshot("zai", [IDS[0]], "individual-coding-plan"), vendor);
    const team = createZcodeCatalog(snapshot("bigmodel", [IDS[0]], "team-coding-plan"), vendor);
    const start = createZcodeCatalog(snapshot("zai", [IDS[1]], "start-plan"), vendor);
    const custom = createZcodeCatalog(snapshot("zai", [IDS[0]]), vendor);
    assert.deepEqual(individual.models.map((entry) => entry.slug), [`zcode-individual-coding-plan/${IDS[0]}`]);
    assert.deepEqual(team.models.map((entry) => entry.slug), [`zcode-team-coding-plan/${IDS[0]}`]);
    assert.deepEqual(start.models.map((entry) => entry.slug), [`zcode-start-plan/${IDS[1]}`]);
    assert.deepEqual(custom.models.map((entry) => entry.slug), [`zcode/${IDS[0]}`]);
    assert.equal(individual.models[0]!.display_name, `GLM-5.3 (ZCode个人)`);
    assert.equal(team.models[0]!.display_name, `GLM-5.3 (ZCode团队)`);
    assert.equal(start.models[0]!.display_name, `GLM-5.3-Flash (ZCode免费)`);
    assert.equal(custom.models[0]!.display_name, `GLM-5.3 (ZCode)`);
  });
});

test("ZCode 合并只保留 zcode/ 顶层命名空间，上游厂商条目与 cliproxy/z.ai 原样保留", { timeout: 60_000 }, () => {
  const official = { slug: "gpt-test", priority: 10 };
  const proxy = { slug: `cliproxy/z.ai/${IDS[0]}`, priority: 20 };
  const vendor = { slug: `z.ai/${IDS[0]}`, priority: 30 };
  const base = { models: [official, proxy, vendor, { slug: `zcode/${IDS[1]}` }] };
  const added = { models: [{ slug: `zcode/${IDS[0]}`, description: "当前套餐" }] };
  const merged = mergeZcodeCatalog(base, added);
  assert.deepEqual(merged.models.map((entry) => entry.slug), [official.slug, proxy.slug, vendor.slug, added.models[0]!.slug]);
  assert.equal(merged.models[0], official);
  assert.equal(merged.models[1], proxy);
  assert.equal(merged.models[2], vendor);
  assert.equal(merged.models[3]!.description, "当前套餐");
  assert.ok(merged.models[3]!.priority! > vendor.priority);
  assert.equal(base.models.length, 4);
  assert.equal(added.models[0]!.description, "当前套餐");
  assert.deepEqual(mergeZcodeCatalog(base, { models: [] }).models, [official, proxy, vendor]);
});

test("ZCode 对外目录不携带配置凭证", { timeout: 60_000 }, () => {
  fixture((file) => {
    const vendor = buildZcodeVendorCatalog();
    const selected = snapshot();
    const publicCatalog = createZcodeCatalog(selected, vendor);
    writeZcodeServedCatalog(file, publicCatalog);
    for (const contents of [fs.readFileSync(file, "utf8"), JSON.stringify(publicCatalog)]) {
      for (const secret of [selected.apiKey, selected.providerID, selected.baseURL, String(selected.expiresAt),
        "apiKey", "access_token", "refresh_token", "zcodejwttoken"]) {
        assert.equal(contents.includes(secret), false, `目录不能包含 ${secret}`);
      }
    }
  });
});
