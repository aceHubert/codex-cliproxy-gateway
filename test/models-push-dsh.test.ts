import test from "./host-test.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML, { isMap, isSeq } from "yaml";
import { buildOpencodeZenCatalog, parseOpencodeZenMetadataResponse } from "@agent-proxy/opencode-zen/catalog";
import { createDshPushTarget, pushDshModels, resolveDshClientPaths, synthesizeDshModel } from "../apps/gateway/src/dsh-client-sync.ts";
import type { ModelEntry } from "../apps/gateway/src/types.ts";

const PROVIDER_KEY = "agent-proxy";

interface DshFixture {
  home: string;
  desktopPatch: string;
  webPatch: string;
  tuiPatch: string;
  cleanup: () => void;
}

const DESKTOP_PATCH = `# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; \`!!js\` expressions allowed).
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: opencode-zen-free-provider
    model: ling-3.1-flash-free
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      cliproxy:
        displayName: cliproxy
        apiKeyEnv: CLIPROXY_API_KEY
        api: openai-completions
        baseURL: https://cliproxy.example/v1
        models:
          - id: manual-extra
            name: Manual Extra
            contextWindow: 1000
- id: locale
  name: "@deepseek-ai/dsh-client-locale"
  config:
    preference: zh
`;

const WEB_PATCH = `# web profile header
- id: web-runtime
  name: "@deepseek-ai/dsh-web-runtime"
  config:
    trustedHosts: !!js "['macpro.example', 'vps-relay.example', ...ctx.webRuntime.trustedHosts]"
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      zai:
        apiKeyEnv: ZAI_API_KEY
        api: openai-completions
        baseURL: https://bigmodel.example/v1
`;

function makeDshFixture(): DshFixture {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccp-dsh-push-"));
  for (const [profile, contents] of [["desktop", DESKTOP_PATCH], ["web", WEB_PATCH], ["tui", "[]\n"]] as const) {
    fs.mkdirSync(path.join(home, "profiles", profile), { recursive: true });
    fs.writeFileSync(path.join(home, "profiles", profile, "cordis.patch.yml"), contents);
  }
  // 哨兵：凭据库与 legacy settings 绝不能被触碰。
  fs.writeFileSync(path.join(home, ".credentials.yaml"), "version: 1\nrefs: {}\nrecords: {}\n");
  fs.writeFileSync(path.join(home, "settings.yaml"), "# legacy\nllm-pi-ai: {}\n");
  return {
    home,
    desktopPatch: path.join(home, "profiles", "desktop", "cordis.patch.yml"),
    webPatch: path.join(home, "profiles", "web", "cordis.patch.yml"),
    tuiPatch: path.join(home, "profiles", "tui", "cordis.patch.yml"),
    cleanup: () => fs.rmSync(home, { recursive: true, force: true }),
  };
}

const PUSH_ENTRIES: ModelEntry[] = [
  { slug: "alpha", display_name: "Alpha", context_window: 1000000,
    supported_reasoning_levels: ["low", "high"], default_reasoning_level: "high", input_modalities: ["text", "image"] },
  { slug: "oc-go/beta", display_name: "Beta" },
  { slug: "zcode/glm-5.3" },
];

function pushOptions(home: string) {
  return { config: { host: "127.0.0.1", port: 8320 }, env: { DSH_HOME: home, HOME: home } };
}

function readPatch(file: string): any[] {
  // parseDocument + toJS：!!js 标签在断言里无需解析，且不触发 parse 的标签告警输出。
  return YAML.parseDocument(fs.readFileSync(file, "utf8")).toJS() as any[];
}

test("pushDshModels 创建受管 agent-proxy provider 并按 ID 全量替换 models", () => {
  const fixture = makeDshFixture();
  try {
    const target = createDshPushTarget(pushOptions(fixture.home));
    const outcome = target.push(PUSH_ENTRIES);

    for (const file of [fixture.desktopPatch, fixture.webPatch]) {
      const entries = readPatch(file);
      const llm = entries.find((entry) => entry.id === "llm-pi-ai");
      const provider = llm.config.providers[PROVIDER_KEY];
      assert.equal(provider.displayName, "AgentProxy");
      assert.equal(provider.api, "anthropic-messages");
      assert.equal(provider.apiKeyEnv, "AGENT_PROXY_API_KEY");
      assert.equal(provider.baseURL, "http://127.0.0.1:8320");
      assert.deepEqual(provider.models.map((model: any) => model.id), ["alpha", "oc-go/beta", "zcode/glm-5.3"]);
      // dsh 无对应网关插件，不做附加剔除：zcode 插件模型也全量写入。
      const alpha = provider.models[0];
      assert.equal(alpha.name, "Alpha");
      assert.equal(alpha.contextWindow, 1000000);
      assert.deepEqual(alpha.input, ["text", "image"]);
      assert.deepEqual(alpha.reasoningEfforts, { low: "low", high: "high" });
      assert.equal("maxTokens" in alpha, false);
      assert.deepEqual(provider.models[1], { id: "oc-go/beta", name: "Beta", input: ["text"] });
    }

    // 用户自建 provider 与其他 patch 条目不动；手动添加的 manual-extra 不进入受管 provider。
    const desktop = readPatch(fixture.desktopPatch);
    const cliproxy = desktop.find((entry) => entry.id === "llm-pi-ai").config.providers.cliproxy;
    assert.deepEqual(cliproxy.models, [{ id: "manual-extra", name: "Manual Extra", contextWindow: 1000 }]);
    assert.equal(desktop.find((entry) => entry.id === "agent-default-model").config.provider, "opencode-zen-free-provider");
    // 空层 profile 与敏感文件一字不动（凭据文件由用户人工维护，工具不读写）。
    assert.equal(fs.readFileSync(fixture.tuiPatch, "utf8"), "[]\n");
    assert.equal(fs.readFileSync(path.join(fixture.home, ".credentials.yaml"), "utf8"), "version: 1\nrefs: {}\nrecords: {}\n");
    assert.equal(fs.readFileSync(path.join(fixture.home, "settings.yaml"), "utf8"), "# legacy\nllm-pi-ai: {}\n");
    assert.ok(fs.readFileSync(fixture.desktopPatch, "utf8").startsWith("# Your patch layer for this dsh profile"));
    const webRaw = fs.readFileSync(fixture.webPatch, "utf8");
    assert.match(webRaw, /trustedHosts: !!js "\['macpro\.example', 'vps-relay\.example', \.\.\.ctx\.webRuntime\.trustedHosts\]"/);
    const webRuntime = readPatch(fixture.webPatch).find((entry) => entry.id === "web-runtime");
    assert.equal(webRuntime.name, "@deepseek-ai/dsh-web-runtime");

    assert.match(outcome.summary, /dsh: 3 models pushed to provider "agent-proxy".*profiles: desktop, web/);
    assert.ok(outcome.notes.some((note) => note.includes(`provider "${PROVIDER_KEY}" created in: desktop, web`)));
    assert.ok(outcome.notes.some((note) => note.includes("OpenCode Zen models end-to-end")));
    for (const file of [fixture.desktopPatch, fixture.webPatch]) {
      assert.ok(fs.readdirSync(path.dirname(file)).some((name) => name.startsWith("cordis.patch.yml.bak-agent-proxy-")),
        `${file} 应有写前备份`);
    }
  } finally {
    fixture.cleanup();
  }
});

test("pushDshModels 幂等且不回写用户改过的 baseURL", () => {
  const fixture = makeDshFixture();
  try {
    const target = createDshPushTarget(pushOptions(fixture.home));
    target.push(PUSH_ENTRIES);
    // 用户把 baseURL 改指公网域名：后续同步只改 models[]，不回写连接字段。
    const raw = fs.readFileSync(fixture.desktopPatch, "utf8");
    fs.writeFileSync(fixture.desktopPatch, raw.replace("http://127.0.0.1:8320", "https://gateway.example"));
    target.push([{ slug: "new-model", display_name: "New" }]);
    const provider = readPatch(fixture.desktopPatch).find((entry) => entry.id === "llm-pi-ai").config.providers[PROVIDER_KEY];
    assert.equal(provider.baseURL, "https://gateway.example");
    assert.deepEqual(provider.models.map((model: any) => model.id), ["new-model"]);

    const backups = fs.readdirSync(path.dirname(fixture.desktopPatch)).filter((name) => name.includes(".bak-agent-proxy-"));
    const snapshot = fs.readFileSync(fixture.desktopPatch, "utf8");
    const again = target.push([{ slug: "new-model", display_name: "New" }]);
    assert.match(again.summary, /already up to date/);
    assert.equal(fs.readFileSync(fixture.desktopPatch, "utf8"), snapshot);
    assert.equal(fs.readdirSync(path.dirname(fixture.desktopPatch)).filter((name) => name.includes(".bak-agent-proxy-")).length, backups.length);
  } finally {
    fixture.cleanup();
  }
});

test("Zen catalog 更新后全量替换 DSH 模型定义并清除旧字段，其他 provider 不变", () => {
  const fixture = makeDshFixture();
  try {
    const metadata = parseOpencodeZenMetadataResponse({ opencode: { models: {
      "glm-5.3-flash-free": { name: "GLM 5.3 Flash Free", limit: { context: 1000000 },
        modalities: { input: ["text", "image", "video", "pdf"] },
        reasoning_options: [{ type: "effort", values: ["low", "max"] }] },
      "cat-jam-free": { name: "Cat Jam Free", modalities: { input: ["text"] } },
    } } });
    const models = buildOpencodeZenCatalog(["glm-5.3-flash-free", "cat-jam-free"], metadata).models;
    const options = pushOptions(fixture.home);
    // 模拟旧目录错标：视觉模型变成纯文本，文本模型曾误标图片。
    pushDshModels([
      { ...models[0]!, input_modalities: ["text"] },
      { ...models[1]!, input_modalities: ["text", "image"] },
    ], options);
    for (const file of [fixture.desktopPatch, fixture.webPatch]) {
      const doc = YAML.parseDocument(fs.readFileSync(file, "utf8"));
      const index = readPatch(file).findIndex((entry) => entry.id === "llm-pi-ai");
      const first = doc.getIn([index, "config", "providers", PROVIDER_KEY, "models", 0]);
      assert.ok(isMap(first));
      first.commentBefore = " 保留模型配置注释";
      first.set("name", "自定义视觉名称");
      first.set("contextWindow", 123456);
      first.set("reasoningEfforts", doc.createNode({ high: "high" }));
      first.set("maxTokens", 1000);
      const input = first.get("input");
      assert.ok(isSeq(input));
      input.flow = true;
      input.comment = " 保留输入配置注释";
      fs.writeFileSync(file, doc.toString());
    }

    pushDshModels(models, options);
    for (const file of [fixture.desktopPatch, fixture.webPatch]) {
      const llm = readPatch(file).find((entry) => entry.id === "llm-pi-ai");
      const provider = llm.config.providers[PROVIDER_KEY];
      assert.deepEqual(provider.models, [
        { id: models[0]!.slug, name: "OP-ZEN/GLM 5.3 Flash Free", contextWindow: 1000000,
          input: ["text", "image"], reasoningEfforts: { low: "low", max: "max" } },
        { id: models[1]!.slug, name: "OP-ZEN/Cat Jam Free", input: ["text"] },
      ]);
      assert.doesNotMatch(fs.readFileSync(file, "utf8"), /保留模型配置注释|保留输入配置注释/);
      const userProvider = llm.config.providers.cliproxy ?? llm.config.providers.zai;
      assert.equal(userProvider.baseURL, file === fixture.desktopPatch ? "https://cliproxy.example/v1" : "https://bigmodel.example/v1");
    }
  } finally {
    fixture.cleanup();
  }
});

test("pushDshModels 相同 catalog 全量重建后保持幂等且不创建备份", () => {
  const fixture = makeDshFixture();
  try {
    const options = pushOptions(fixture.home);
    pushDshModels(PUSH_ENTRIES, options);
    const snapshots = new Map<string, string>();
    const backups = new Map<string, string[]>();
    for (const file of [fixture.desktopPatch, fixture.webPatch]) {
      snapshots.set(file, fs.readFileSync(file, "utf8"));
      backups.set(file, fs.readdirSync(path.dirname(file)).filter((name) => name.includes(".bak-agent-proxy-")));
    }
    const outcome = pushDshModels(PUSH_ENTRIES, options);
    assert.match(outcome.summary, /already up to date/);
    for (const file of [fixture.desktopPatch, fixture.webPatch]) {
      assert.equal(fs.readFileSync(file, "utf8"), snapshots.get(file));
      assert.deepEqual(fs.readdirSync(path.dirname(file)).filter((name) => name.includes(".bak-agent-proxy-")), backups.get(file));
    }
  } finally {
    fixture.cleanup();
  }
});

test("pushDshModels 未安装与无 llm-pi-ai 层时给出可执行错误", () => {
  const missingHome = fs.mkdtempSync(path.join(os.tmpdir(), "ccp-dsh-missing-"));
  try {
    // 未安装：配置根目录不存在（mkdtemp 会建目录，用其下的不存在子路径构造）。
    const absent = createDshPushTarget({ config: { host: "127.0.0.1", port: 8320 }, env: { DSH_HOME: path.join(missingHome, "absent") } });
    assert.throws(() => absent.assertInstalled(), /dsh \(DeepSeek Harness\) is not installed/);
    const target = createDshPushTarget(pushOptions(missingHome));
    // 目录存在（已安装）但没有任何 profile 配过 llm-pi-ai：指引错误。
    fs.mkdirSync(path.join(missingHome, "profiles", "tui"), { recursive: true });
    fs.writeFileSync(path.join(missingHome, "profiles", "tui", "cordis.patch.yml"), "[]\n");
    target.assertInstalled();
    assert.throws(() => target.push(PUSH_ENTRIES), /no profile has an "llm-pi-ai" patch entry/);
    // profiles 目录缺失同样给出指引而非崩溃。
    fs.rmSync(path.join(missingHome, "profiles"), { recursive: true, force: true });
    assert.throws(() => pushDshModels(PUSH_ENTRIES, pushOptions(missingHome)), /profiles directory is missing/);
  } finally {
    fs.rmSync(missingHome, { recursive: true, force: true });
  }
});

test("pushDshModels 拒绝无法解析的 patch 文件", () => {
  const fixture = makeDshFixture();
  try {
    fs.writeFileSync(fixture.webPatch, "- id: llm-pi-ai\n  config: {broken\n");
    assert.throws(
      () => pushDshModels(PUSH_ENTRIES, pushOptions(fixture.home)),
      /is not valid YAML/,
    );
  } finally {
    fixture.cleanup();
  }
});

test("pushDshModels 中途写入失败时回滚本目标已写入的文件", () => {
  const fixture = makeDshFixture();
  try {
    const target = createDshPushTarget(pushOptions(fixture.home));
    const desktopBefore = fs.readFileSync(fixture.desktopPatch, "utf8");
    // web 目录设为只读：其写前备份必然失败；此前已写入的 desktop 应被回滚。
    fs.chmodSync(path.dirname(fixture.webPatch), 0o555);
    assert.throws(() => target.push(PUSH_ENTRIES));
    assert.equal(fs.readFileSync(fixture.desktopPatch, "utf8"), desktopBefore);
  } finally {
    fs.chmodSync(path.dirname(fixture.webPatch), 0o755);
    fixture.cleanup();
  }
});

test("synthesizeDshModel 缺啥省啥、不臆造字段", () => {
  assert.deepEqual(synthesizeDshModel({ slug: "bare" }), { id: "bare", name: "bare", input: ["text"] });
  assert.deepEqual(synthesizeDshModel({ slug: "x", display_name: "X" }), { id: "x", name: "X", input: ["text"] });
});

test("synthesizeDshModel 把 none 档位映射为 off 键并丢弃白名单外档位", () => {
  // zen 目录真实形态：nemotron 的档位含 none（无推理），而 dsh 的合法键没有 none——
  // 未知键会让整个 llm-pi-ai 插件校验失败、全部自定义模型消失（2026-10-16 真机事故）。
  const model = synthesizeDshModel({
    slug: "opencode-zen/nemotron-3.5-super-vl-free",
    supported_reasoning_levels: ["none", "minimal", "low", "medium", "high", "xhigh", "ultra"],
  });
  assert.deepEqual(model.reasoningEfforts, {
    off: "none", minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "xhigh",
  });
  // 仅剩 none 时映射为单一 off；全部不合法时整个省略 reasoningEfforts。
  assert.deepEqual(synthesizeDshModel({ slug: "a", supported_reasoning_levels: ["none"] }).reasoningEfforts, { off: "none" });
  assert.equal("reasoningEfforts" in synthesizeDshModel({ slug: "b", supported_reasoning_levels: ["ultra", "???"] }), false);
});
