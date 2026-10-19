import test from "./host-test.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createZcodePushTarget, pushZcodeModels, resolveZcodeClientPaths, synthesizeZcodeModelDefinition } from "../apps/gateway/src/zcode-client-sync.ts";
import type { ModelEntry } from "../apps/gateway/src/types.ts";

/** 用户自建 provider（含名为 cliproxy 的条目）的哨兵 ID：推送前后必须一字不动。 */
const USER_PROVIDER_ID = "11111111-1111-1111-1111-111111111111";

interface ZcodeFixture {
  home: string;
  configFile: string;
  providerConfigFile: string;
  cleanup: () => void;
}

/** 与真实 ~/.zcode/v2 同构的最小夹具：一个用户自建 cliproxy provider，无受管条目。 */
function makeZcodeFixture(): ZcodeFixture {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccp-zcode-push-"));
  const paths = resolveZcodeClientPaths({ ZCODE_HOME: home, HOME: home });
  fs.mkdirSync(paths.v2, { recursive: true });
  // 供应商显示顺序名单（UI 按它渲染供应商列表）。
  fs.writeFileSync(path.join(paths.v2, "model-provider-display-order.json"), JSON.stringify({
    providerIds: ["zai-api", USER_PROVIDER_ID], updatedAt: 1,
  }));
  fs.writeFileSync(paths.configFile, JSON.stringify({
    provider: {
      [USER_PROVIDER_ID]: {
        name: "cliproxy",
        kind: "openai-compatible",
        options: { apiKey: "user-key", apiKeyRequired: true, baseURL: "https://gateway.example/v1" },
        source: "custom",
        models: { "stale-model": { limit: { context: 1000 } } },
      },
    },
  }, null, 2));
  fs.writeFileSync(paths.providerConfigFile, JSON.stringify({
    schemaVersion: 1,
    config: {
      providerOrder: ["zai-api", USER_PROVIDER_ID],
      providerConfigRules: { providerRules: [
        { providerId: "zai-api", providerName: "zai-api", config: { group: "standard", personalModelIds: ["glm-5.3"], modelOrder: ["glm-5.3"] } },
        { providerId: USER_PROVIDER_ID, providerName: "cliproxy", config: {
          group: "standard-personal",
          access: { apiKey: "user-key", type: "api-key" },
          api: { type: "openai-chat-completions", baseUrl: "https://gateway.example/v1" },
          personalModelIds: ["stale-model"],
          modelOrder: ["stale-model"],
        } },
      ] },
      modelConfigRules: {
        providerModelRules: [
          { modelId: "glm-5.3", providerId: "zai-api", config: { properties: { contextWindow: 1000 } } },
          { modelId: "stale-model", providerId: USER_PROVIDER_ID, config: { properties: { contextWindow: 1000 } } },
        ],
        manualProviderModelRules: [],
      },
    },
  }, null, 2));
  return {
    home,
    configFile: paths.configFile,
    providerConfigFile: paths.providerConfigFile,
    cleanup: () => fs.rmSync(home, { recursive: true, force: true }),
  };
}

const PUSH_ENTRIES: ModelEntry[] = [
  { slug: "opencode-zen/grok-code-free", display_name: "Grok Code", context_window: 1000000,
    supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }], default_reasoning_level: "high",
    input_modalities: ["text"] },
  { slug: "agy/gemini-4-argon", display_name: "Gemini 4 Argon" },
  { slug: "keep-me" },
  { slug: "zcode/glm-5.3" },
  { slug: "zcode-individual-coding-plan/glm-5.3-flash" },
];

function readJson(file: string): Record<string, any> {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function pushOptions(home: string) {
  return { config: { host: "127.0.0.1", port: 8320 }, env: { ZCODE_HOME: home, HOME: home } };
}

/** 找到受管 provider 的 rule（现行显示名 AgentProxy）；用户 provider 名固定为 cliproxy。 */
function managedRule(providerDoc: Record<string, any>): any {
  return providerDoc.config.providerConfigRules.providerRules.find((item: any) => item.providerName === "AgentProxy");
}

test("pushZcodeModels 自动创建受管 agent-proxy provider 并按 ID 全量替换", () => {
  const fixture = makeZcodeFixture();
  try {
    const target = createZcodePushTarget(pushOptions(fixture.home));
    const outcome = target.push(PUSH_ENTRIES);

    const providerDoc = readJson(fixture.providerConfigFile);
    const rule = managedRule(providerDoc);
    assert.ok(rule, "应自动创建 providerName 为 AgentProxy 的 rule");
    assert.equal(rule.providerName, "AgentProxy");
    const managedId: string = rule.providerId;
    // 受管 rule 的连接形态；apiKey 为占位。
    assert.equal(rule.config.api.type, "anthropic-messages");
    assert.equal(rule.config.api.baseUrl, "http://127.0.0.1:8320");
    assert.equal(rule.config.access.type, "api-key");
    assert.equal(rule.config.access.apiKey, "EMPTY");
    // rule 带 UI 分组（缺失该字段的供应商不显示）。
    assert.equal(rule.config.group, "standard-personal");
    // zcode 插件模型被剔除、deletedModels 被跳过；顺序取网关目录顺序。
    assert.deepEqual(rule.config.modelOrder, ["opencode-zen/grok-code-free", "agy/gemini-4-argon", "keep-me"]);
    assert.deepEqual(rule.config.personalModelIds, rule.config.modelOrder);
    // providerOrder 追加受管 ID，原有顺序不动；display-order 名单同样追加（UI 按它渲染供应商列表）。
    assert.deepEqual(providerDoc.config.providerOrder, ["zai-api", USER_PROVIDER_ID, managedId]);
    const displayOrder = readJson(path.join(fixture.home, "v2", "model-provider-display-order.json"));
    assert.deepEqual(displayOrder.providerIds, ["zai-api", USER_PROVIDER_ID, managedId]);

    const configDoc = readJson(fixture.configFile);
    const entry = configDoc.provider[managedId];
    assert.equal(entry.name, "AgentProxy");
    assert.equal(entry.kind, "anthropic");
    assert.equal(entry.options.baseURL, "http://127.0.0.1:8320");
    assert.deepEqual(Object.keys(entry.models).sort(), ["agy/gemini-4-argon", "keep-me", "opencode-zen/grok-code-free"]);
    assert.deepEqual(entry.models["keep-me"], {
      name: "keep-me",
      modalities: { input: ["text"], output: ["text"] },
      zcode: { modalitiesConfigured: true, modified: true },
    });

    // 用户自建 cliproxy provider 全字段一字不动（rule、models、providerModelRules）。
    const userRule = providerDoc.config.providerConfigRules.providerRules.find((item: any) => item.providerId === USER_PROVIDER_ID);
    assert.deepEqual(userRule.config.modelOrder, ["stale-model"]);
    assert.deepEqual(configDoc.provider[USER_PROVIDER_ID].models, { "stale-model": { limit: { context: 1000 } } });
    const ruleIds = providerDoc.config.modelConfigRules.providerModelRules.map((item: any) => `${item.providerId}:${item.modelId}`);
    assert.ok(ruleIds.includes(`${USER_PROVIDER_ID}:stale-model`));
    assert.ok(!ruleIds.some((id: string) => id.startsWith(`${USER_PROVIDER_ID}:`) && id !== `${USER_PROVIDER_ID}:stale-model`));

    assert.match(outcome.summary, /\+3 added, -0 removed, 0 unchanged/);
    for (const file of [fixture.configFile, fixture.providerConfigFile]) {
      assert.ok(fs.readdirSync(path.dirname(file)).some((name) => name.startsWith(`${path.basename(file)}.bak-agent-proxy-`)),
        `${file} 应有写前备份`);
    }
  } finally {
    fixture.cleanup();
  }
});

test("pushZcodeModels 为有无上下文窗口的模型写入 ZCode 运行时图片能力", () => {
  const fixture = makeZcodeFixture();
  try {
    const models: ModelEntry[] = [
      { slug: "workbuddy-intl/gpt-6-luna", context_window: 1000000, input_modalities: ["text", "image"] },
      { slug: "workbuddy-intl/hy4-preview", input_modalities: ["text", "image"] },
      { slug: "codebuddy-cn/text-only", input_modalities: ["text"] },
      { slug: "agy/unknown-modalities" },
    ];
    pushZcodeModels(models, pushOptions(fixture.home));
    const providerDoc = readJson(fixture.providerConfigFile);
    const managedId = managedRule(providerDoc).providerId;
    const rules = providerDoc.config.modelConfigRules.providerModelRules.filter((item: any) => item.providerId === managedId);
    assert.deepEqual(rules.map((item: any) => ({ id: item.modelId, properties: item.config.properties })), [
      { id: models[0]!.slug, properties: { contextWindow: 1000000, inputFormat: { supportsImage: true } } },
      { id: models[1]!.slug, properties: { inputFormat: { supportsImage: true } } },
      { id: models[2]!.slug, properties: { inputFormat: { supportsImage: false } } },
      { id: models[3]!.slug, properties: { inputFormat: { supportsImage: false } } },
    ]);
    const definitions = readJson(fixture.configFile).provider[managedId].models;
    assert.deepEqual(definitions[models[0]!.slug].modalities.input, ["text", "image"]);
  } finally {
    fixture.cleanup();
  }
});

test("pushZcodeModels 全量重建存量模型能力并清理受管手动规则，保留其他 provider 和幂等性", () => {
  const fixture = makeZcodeFixture();
  try {
    const options = pushOptions(fixture.home);
    const models: ModelEntry[] = [
      { slug: "workbuddy-intl/gpt-6-luna", context_window: 1000000, input_modalities: ["text", "image"] },
      { slug: "codebuddy-cn/text-only", context_window: 200000, input_modalities: ["text"] },
    ];
    pushZcodeModels(models, options);
    const providerDoc = readJson(fixture.providerConfigFile);
    const managedId = managedRule(providerDoc).providerId;
    const unrelatedRules = providerDoc.config.modelConfigRules.providerModelRules.filter((item: any) => item.providerId !== managedId);
    unrelatedRules.push({ providerId: USER_PROVIDER_ID, modelId: models[0]!.slug,
      config: { properties: { inputFormat: { supportsImage: false } } } });
    providerDoc.config.modelConfigRules.providerModelRules = [
      ...unrelatedRules,
      { providerId: managedId, modelId: models[0]!.slug.toUpperCase(), config: {
        enabled: false,
        properties: { contextWindow: 123456, supportsToolCall: true, inputFormat: { supportsPdf: true, supportsVideo: false } },
        optionSpecs: { reasoningLevel: { default: "high" } },
      } },
      { providerId: managedId, modelId: models[1]!.slug, config: {
        properties: { contextWindow: 200000, inputFormat: { supportsImage: true } },
      } },
    ];
    const manualRules = [{ providerId: USER_PROVIDER_ID, modelId: models[0]!.slug,
      config: { properties: { inputFormat: { supportsImage: false } } } }];
    providerDoc.config.modelConfigRules.manualProviderModelRules = [
      ...manualRules,
      { providerId: managedId, modelId: models[0]!.slug, config: { properties: { inputFormat: { supportsImage: false } } } },
      { providerId: managedId, modelId: "old-model", config: { properties: { contextWindow: 999 } } },
    ];
    fs.writeFileSync(fixture.providerConfigFile, JSON.stringify(providerDoc, null, 2));
    const configDoc = readJson(fixture.configFile);
    const userProvider = structuredClone(configDoc.provider[USER_PROVIDER_ID]);
    configDoc.provider[managedId].models = {
      [models[0]!.slug.toUpperCase()]: { name: "旧视觉名称", modalities: { input: ["text"] }, obsolete: true },
      [models[1]!.slug]: { name: "旧文本名称", limit: { context: 999 },
        modalities: { input: ["text", "image"] }, reasoning: { enabled: true }, obsolete: true },
      "old-model": { name: "旧模型" },
    };
    fs.writeFileSync(fixture.configFile, JSON.stringify(configDoc, null, 2));

    pushZcodeModels(models, options);
    const after = readJson(fixture.providerConfigFile);
    const rules = after.config.modelConfigRules.providerModelRules;
    assert.deepEqual(rules.filter((item: any) => item.providerId !== managedId), unrelatedRules);
    assert.deepEqual(after.config.modelConfigRules.manualProviderModelRules, manualRules);
    const vision = rules.find((item: any) => item.providerId === managedId && item.modelId === models[0]!.slug);
    assert.deepEqual(vision.config, {
      properties: { contextWindow: 1000000, inputFormat: { supportsImage: true } },
    });
    assert.deepEqual(rules.filter((item: any) => item.providerId === managedId).map((item: any) => item.modelId),
      models.map((model) => model.slug), "标准 ID 全量替换旧 ID，且不产生重复规则");
    const text = rules.find((item: any) => item.providerId === managedId && item.modelId === models[1]!.slug);
    assert.equal(text.config.properties.inputFormat.supportsImage, false, "纯文本模型覆盖旧的图片声明");
    const afterConfig = readJson(fixture.configFile);
    assert.deepEqual(afterConfig.provider[managedId].models,
      Object.fromEntries(models.map((model) => [model.slug, synthesizeZcodeModelDefinition(model)])),
      "图片能力升级、降级、名称和旧扩展字段均按最新目录全量重建");
    assert.deepEqual(afterConfig.provider[USER_PROVIDER_ID], userProvider);

    const snapshot = fs.readFileSync(fixture.providerConfigFile, "utf8");
    const configSnapshot = fs.readFileSync(fixture.configFile, "utf8");
    const backups = fs.readdirSync(path.dirname(fixture.providerConfigFile)).filter((name) => name.includes(".bak-agent-proxy-"));
    const repeated = pushZcodeModels(models, options);
    assert.match(repeated.summary, /already up to date/);
    assert.equal(fs.readFileSync(fixture.providerConfigFile, "utf8"), snapshot);
    assert.equal(fs.readFileSync(fixture.configFile, "utf8"), configSnapshot);
    assert.deepEqual(fs.readdirSync(path.dirname(fixture.providerConfigFile)).filter((name) => name.includes(".bak-agent-proxy-")), backups);
  } finally {
    fixture.cleanup();
  }
});

test("pushZcodeModels 二次推送幂等且不回写用户改过的 baseURL", () => {
  const fixture = makeZcodeFixture();
  try {
    const target = createZcodePushTarget(pushOptions(fixture.home));
    target.push(PUSH_ENTRIES);
    // 用户把受管 provider 改指公网域名：后续同步只改模型清单，连接字段不回写。
    const configDoc = readJson(fixture.configFile);
    const managedId = managedRule(readJson(fixture.providerConfigFile)).providerId;
    configDoc.provider[managedId].options.baseURL = "https://gateway.example";
    fs.writeFileSync(fixture.configFile, JSON.stringify(configDoc, null, 2));

    const second = target.push([{ slug: "opencode-zen/grok-code-free" }]);
    assert.match(second.summary, /1 models pushed/);
    const after = readJson(fixture.configFile);
    assert.equal(after.provider[managedId].options.baseURL, "https://gateway.example");
    assert.deepEqual(Object.keys(after.provider[managedId].models), ["opencode-zen/grok-code-free"]);

    const v2 = path.dirname(fixture.configFile);
    const backups = fs.readdirSync(v2).filter((name) => name.includes(".bak-agent-proxy-"));
    const providerSnapshot = fs.readFileSync(fixture.providerConfigFile, "utf8");
    const configSnapshot = fs.readFileSync(fixture.configFile, "utf8");
    const third = target.push([{ slug: "opencode-zen/grok-code-free" }]);
    assert.match(third.summary, /already up to date/);
    assert.equal(fs.readFileSync(fixture.providerConfigFile, "utf8"), providerSnapshot);
    assert.equal(fs.readFileSync(fixture.configFile, "utf8"), configSnapshot);
    assert.equal(fs.readdirSync(v2).filter((name) => name.includes(".bak-agent-proxy-")).length, backups.length);
  } finally {
    fixture.cleanup();
  }
});

test("pushZcodeModels 未安装时报可执行错误", () => {
  const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), "ccp-zcode-empty-"));
  try {
    const target = createZcodePushTarget({ config: { host: "127.0.0.1", port: 8320 }, env: { ZCODE_HOME: path.join(emptyHome, "absent") } });
    assert.throws(() => target.assertInstalled(), /ZCode is not installed/);
  } finally {
    fs.rmSync(emptyHome, { recursive: true, force: true });
  }
});

test("pushZcodeModels 在剔除 zcode 插件模型且受管清单为空时中止", () => {
  const fixture = makeZcodeFixture();
  try {
    const options = pushOptions(fixture.home);
    // 纯 zcode 插件模型直接在目标层剔除后为空。
    assert.throws(
      () => pushZcodeModels([{ slug: "zcode/glm-5.3" }], options),
      /no models remain after excluding ZCode plugin models/,
    );
    // 用户在 ZCode 界面删除过受管 provider 的全部模型：deletedModels 拦截后同样中止。
    pushZcodeModels([{ slug: "opencode-zen/grok-code-free" }], options);
    const configDoc = readJson(fixture.configFile);
    const managedId = managedRule(readJson(fixture.providerConfigFile)).providerId;
    configDoc.provider[managedId].zcode = { deletedModels: ["opencode-zen/grok-code-free"] };
    fs.writeFileSync(fixture.configFile, JSON.stringify(configDoc, null, 2));
    assert.throws(
      () => pushZcodeModels([{ slug: "opencode-zen/grok-code-free" }], options),
      /hidden by ZCode deletedModels/,
    );
  } finally {
    fixture.cleanup();
  }
});

test("synthesizeZcodeModelDefinition 缺啥省啥、不臆造字段", () => {
  assert.deepEqual(synthesizeZcodeModelDefinition({ slug: "bare" }), {
    name: "bare",
    modalities: { input: ["text"], output: ["text"] },
    zcode: { modalitiesConfigured: true, modified: true },
  });
  // 显示名取 display_name（UI 模型列表渲染 name，缺失时只显示 ID）。
  assert.equal(synthesizeZcodeModelDefinition({ slug: "x", display_name: "X Pro" }).name, "X Pro");
  // 默认档位不在档位列表内时回退到最后一档，避免引用不存在的档位。
  const fallback = synthesizeZcodeModelDefinition({ slug: "x", supported_reasoning_levels: ["low", "high"], default_reasoning_level: "ultra" });
  assert.deepEqual(fallback.reasoning, { enabled: true, variants: ["low", "high"], defaultVariant: "high" });
});

test("pushZcodeModels 识别存量 agent-proxy 命名并升级显示名（模型清单原位更新）", () => {
  const fixture = makeZcodeFixture();
  try {
    const options = pushOptions(fixture.home);
    // 先推一次建立受管条目，再把 providerName 降回早期版本的 "agent-proxy" 模拟存量。
    createZcodePushTarget(options).push(PUSH_ENTRIES);
    const providerDoc = readJson(fixture.providerConfigFile);
    const legacy = providerDoc.config.providerConfigRules.providerRules.find((item: any) => item.providerName === "AgentProxy");
    legacy.providerName = "agent-proxy";
    fs.writeFileSync(fixture.providerConfigFile, JSON.stringify(providerDoc, null, 2));

    createZcodePushTarget(options).push([{ slug: "opencode-zen/grok-code-free" }]);
    const after = readJson(fixture.providerConfigFile);
    const upgraded = after.config.providerConfigRules.providerRules.find((item: any) => item.providerName === "AgentProxy");
    assert.ok(upgraded, "存量 agent-proxy 应被识别并升级为 AgentProxy（同一 providerId 原位更新）");
    assert.equal(upgraded.providerId, legacy.providerId);
    assert.deepEqual(upgraded.config.modelOrder, ["opencode-zen/grok-code-free"]);
  } finally {
    fixture.cleanup();
  }
});

test("pushZcodeModels 按当前目录重建显示名并移除过时上下文和推理配置", () => {
  const fixture = makeZcodeFixture();
  try {
    const options = pushOptions(fixture.home);
    const target = createZcodePushTarget(options);
    target.push(PUSH_ENTRIES);
    // 模拟旧目录与用户修改留下的定义，重新推送后全部以当前目录为准。
    const configDoc = readJson(fixture.configFile);
    const providerDoc = readJson(fixture.providerConfigFile);
    const managedId = managedRule(providerDoc).providerId;
    configDoc.provider[managedId].models["agy/gemini-4-argon"] = { limit: { context: 1000 }, reasoning: { enabled: true } };
    configDoc.provider[managedId].models["keep-me"].name = "用户自定义名";
    const oldRule = providerDoc.config.modelConfigRules.providerModelRules.find(
      (item: any) => item.providerId === managedId && item.modelId === "agy/gemini-4-argon",
    );
    oldRule.config.properties = { contextWindow: 1000, inputFormat: { supportsImage: true } };
    delete providerDoc.config.modelConfigRules.manualProviderModelRules;
    fs.writeFileSync(fixture.configFile, JSON.stringify(configDoc, null, 2));
    fs.writeFileSync(fixture.providerConfigFile, JSON.stringify(providerDoc, null, 2));

    target.push(PUSH_ENTRIES);
    const after = readJson(fixture.configFile).provider[managedId];
    assert.equal(after.models["agy/gemini-4-argon"].name, "Gemini 4 Argon");
    assert.equal(after.models["keep-me"].name, "keep-me", "已有 name 由当前目录替换");
    assert.deepEqual(after.models["agy/gemini-4-argon"], synthesizeZcodeModelDefinition(PUSH_ENTRIES[1]!));
    const afterRules = readJson(fixture.providerConfigFile).config.modelConfigRules;
    assert.deepEqual(afterRules.providerModelRules.find(
      (item: any) => item.providerId === managedId && item.modelId === "agy/gemini-4-argon",
    ).config.properties, { inputFormat: { supportsImage: false } }, "目录没有上下文时清除旧上下文");
    assert.ok(!("manualProviderModelRules" in afterRules), "缺少手动规则数组时不强制创建");
  } finally {
    fixture.cleanup();
  }
});
