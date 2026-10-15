import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import ts from "typescript";
import { validateConfiguredPlugins } from "../apps/gateway/src/plugin-config.ts";
import type { GatewayConfig } from "../apps/gateway/src/types.ts";

const root = path.resolve(import.meta.dir, "..");

function configFields(file: string, name: string): string[] {
  const source = ts.createSourceFile(file, readFileSync(path.join(root, file), "utf8"), ts.ScriptTarget.ES2024, true);
  const fields: string[] = [];
  function visit(node: ts.Node): void {
    if (ts.isInterfaceDeclaration(node) && node.name.text === name) {
      for (const member of node.members) {
        if (ts.isPropertySignature(member) && member.name) fields.push(member.name.getText(source));
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return fields.sort();
}

test("公共配置、插件增强和网关配置分别拥有字段，过时字段不再进入接口", () => {
  const common = configFields("packages/plugin-api/src/types.ts", "AgentConfig");
  assert.deepEqual(common, ["configVersion", "host", "maxRequestLogs", "port", "requestLogging"]);
  const extensions = {
    zcode: [],
    codebuddy: ["codebuddyAccount"],
    qoder: [],
    agy: ["debug"],
    "opencode-zen": [],
  };
  for (const [plugin, fields] of Object.entries(extensions)) {
    assert.deepEqual(configFields(`packages/${plugin}/src/index.ts`, "AgentConfig"), fields, plugin);
  }
  const gateway = configFields("apps/gateway/src/types.ts", "GatewayConfig");
  const inherited = [...common, ...Object.values(extensions).flat()];
  const obsolete = ["mountPath", "prefix", "officialBaseUrl", "catalogPath", "logDir", "codebuddyRegion"];
  assert.deepEqual(gateway.filter((field) => [...inherited, ...obsolete].includes(field)), []);
  for (const key of ["zcode", "codebuddy", "qoder", "agy", "opencodeZen"]) assert.ok(gateway.includes(key), key);
});

test("发布后的插件增强经网关类型导入生效，任意扩展索引不削弱已声明字段的类型", () => {
  // 虚拟消费方仅导入网关和公共接口，验证网关能加载全部插件的发布声明。
  const file = path.join(root, "__plugin_config_consumer__.ts");
  const invalidFields = ["zcode", "codebuddy", "qoder", "agy", "opencodeZen", "debug", "codebuddyAccount"];
  const source = `
    import type { AgentConfig } from "@agent-proxy/plugin-api";
    import type { GatewayConfig } from "./apps/gateway/src/types.ts";
    import type { CodebuddyRegion } from "@agent-proxy/codebuddy";
    const region: CodebuddyRegion = "cn";
    const gateway: GatewayConfig = { host: "127.0.0.1", port: 8320, upstreamBaseUrl: "https://upstream.invalid", custom: { region } };
    ${["debug", "codebuddyAccount"].map((field) => `
      // @ts-expect-error 插件增强字段必须拒绝数字。
      const agent_${field}: AgentConfig = { host: "127.0.0.1", port: 8320, ${field}: 42 };
    `).join("\n")}
    ${invalidFields.map((field) => `
      // @ts-expect-error 网关继承的插件增强字段必须拒绝数字。
      const gateway_${field}: Partial<GatewayConfig> = { ${field}: 42 };
    `).join("\n")}
    // @ts-expect-error 插件专属类型不能从公共契约导入。
    import type { CodebuddyRegion as PublicRegion } from "@agent-proxy/plugin-api";
  `;
  const options: ts.CompilerOptions = {
    strict: true, noEmit: true, skipLibCheck: true, allowImportingTsExtensions: true,
    target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
  };
  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (name, languageVersion, ...args) => name === file
    ? ts.createSourceFile(name, source, languageVersion, true)
    : getSourceFile(name, languageVersion, ...args);
  const program = ts.createProgram([file], options, host);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.deepEqual(diagnostics.map((entry) => ts.flattenDiagnosticMessageText(entry.messageText, "\n")), []);
});

test("网关统一校验开关，禁用插件不要求环回监听但账号配置仍需合法", () => {
  const disabled: GatewayConfig = {
    host: "0.0.0.0", port: 8320, upstreamBaseUrl: "https://upstream.invalid",
    zcode: false, codebuddy: false, qoder: false, agy: false, opencodeZen: false,
  };
  assert.doesNotThrow(() => validateConfiguredPlugins(disabled));
  assert.throws(() => validateConfiguredPlugins({ ...disabled, codebuddyAccount: "../escape.info" }), /codebuddyAccount/);
  for (const key of ["zcode", "codebuddy", "qoder", "agy", "opencodeZen"] as const) {
    assert.throws(() => validateConfiguredPlugins({ ...disabled, [key]: true }), /环回/, key);
    assert.throws(() => validateConfiguredPlugins({ ...disabled, [key]: "on" }), /boolean/, key);
    const defaults = { ...disabled };
    delete defaults[key];
    assert.throws(() => validateConfiguredPlugins(defaults), /环回/, `${key} 缺省开启`);
  }
});
