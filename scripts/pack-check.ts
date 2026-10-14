import { copyFile, mkdtemp, mkdir, rm } from "node:fs/promises";
import { constants } from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

const root = path.resolve(import.meta.dir, "..");
const temporary = await mkdtemp(path.join(os.tmpdir(), "agent-proxy-pack-"));
async function run(command: string[], cwd: string): Promise<void> {
  const child = Bun.spawn(command, { cwd, stdout: "inherit", stderr: "inherit" });
  const timer = setTimeout(() => child.kill(), 60_000);
  try {
    if (await child.exited !== 0) throw new Error(`产物检查失败：${command[0]}`);
  } finally { clearTimeout(timer); }
}
async function smokeDefault(consumer: string): Promise<void> {
  const received: Record<string, unknown>[] = [];
  const receivedHeaders: Headers[] = [];
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    assert.equal(new URL(request.url).pathname, "/v1/responses");
    received.push(await request.json() as Record<string, unknown>);
    receivedHeaders.push(request.headers);
    return Response.json({ id: "packed-default", object: "response", output: [] });
  } });
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = reservation.port!;
  reservation.stop(true);
  const instance = path.join(consumer, "instance");
  await mkdir(instance);
  const configFile = path.join(instance, "smoke.json");
  const manifest = await Bun.file(path.join(consumer, "node_modules/@agent-proxy/gateway/package.json")).json();
  await Bun.write(configFile, JSON.stringify({
    configVersion: manifest.version, host: "127.0.0.1", port, mountPath: "/v1", prefix: "cliproxy/",
    officialBaseUrl: "https://official.invalid/v1", upstreamBaseUrl: `http://127.0.0.1:${upstream.port}/v1`,
    catalogPath: path.join(instance, "catalog.json"), zcode: false, codebuddy: false, qoder: false, agy: false, opencodeZen: false,
  }));
  await Bun.write(path.join(instance, "catalog.json"), JSON.stringify({ models: [] }));
  const server = Bun.spawn([process.execPath, path.join(consumer, "node_modules/.bin/agent-proxy"), "serve", "--config", configFile], {
    cwd: consumer, env: { ...process.env, HOME: instance, USER: "agent-proxy-pack-smoke", CODEX_CLIPROXY_HOME: instance }, stdout: "pipe", stderr: "pipe",
  });
  const timer = setTimeout(() => server.kill(), 60_000);
  try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { ready = (await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(500) })).ok; } catch {}
      if (ready) break;
      if (server.exitCode !== null) throw new Error(`打包网关启动失败：${await new Response(server.stderr).text()}`);
      await Bun.sleep(100);
    }
    assert.ok(ready, "打包 default 网关必须在隔离实例启动");
    const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: "POST", headers: { "content-type": "application/json", authorization: "Bearer smoke-chatgpt-oauth", "chatgpt-account-id": "smoke-account", "x-api-key": "smoke-client-key" }, body: JSON.stringify({ model: "cliproxy/pack-model", input: "ping", stream: false }),
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json() as { id: string }).id, "packed-default");
    assert.equal(received.length, 1);
    assert.equal(received[0]!.model, "pack-model");
    assert.equal(received[0]!.input, "ping");
    assert.equal(receivedHeaders[0]!.get("authorization"), null);
    assert.equal(receivedHeaders[0]!.get("chatgpt-account-id"), null);
    assert.equal(receivedHeaders[0]!.get("x-api-key"), null);
    for (const route of ["/ui", "/ui/api/config", "/outside"]) {
      assert.equal((await fetch(`http://127.0.0.1:${port}${route}`)).status, 404);
    }
    assert.equal(received.length, 1, "本地 404 不得触达上游");
    const status = Bun.spawn([process.execPath, path.join(consumer, "node_modules/.bin/agent-proxy"), "status"], {
      cwd: consumer, env: { ...process.env, HOME: instance, USER: "agent-proxy-pack-smoke", CODEX_CLIPROXY_HOME: instance }, stdout: "pipe", stderr: "pipe",
    });
    assert.equal(await status.exited, 0);
    assert.equal((JSON.parse(await new Response(status.stdout).text()) as { installed: boolean }).installed, false);
  } finally { clearTimeout(timer); server.kill(); await server.exited; upstream.stop(true); }
}
try {
  const list = Bun.spawnSync([path.join(root, "node_modules/.bin/lerna"), "list", "--all", "--json", "--loglevel", "silent"], { cwd: root, stdout: "pipe", stderr: "inherit" });
  if (list.exitCode !== 0) throw new Error("无法读取 workspace 包清单。");
  const workspaces = JSON.parse(new TextDecoder().decode(list.stdout)) as { name: string; version: string; location: string }[];
  if (workspaces.length !== 9) throw new Error(`期望九个 workspace，实际 ${workspaces.length} 个。`);
  const packages: typeof workspaces = [];
  for (const pkg of workspaces) {
    const manifest = await Bun.file(path.join(pkg.location, "package.json")).json();
    if (!manifest.private) packages.push(pkg);
    else assert.equal(pkg.name, "@agent-proxy/models", "仅共享模型包不发布");
  }
  if (packages.length !== 8) throw new Error(`期望八个公开产品包，实际 ${packages.length} 个。`);
  const dependencies: Record<string, string> = {};
  for (const pkg of packages) {
    const destination = path.join(temporary, pkg.name.split("/")[1]);
    await mkdir(destination);
    // 本地 Bun 打包模拟 Lerna 发布的临时许可证处理，不留下构建副本。
    const license = path.join(pkg.location, "LICENSE");
    let temporaryLicense = false;
    try {
      try {
        await copyFile(path.join(root, "LICENSE"), license, constants.COPYFILE_EXCL);
        temporaryLicense = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      await run([process.execPath, "pm", "pack", "--destination", destination], pkg.location);
    } finally {
      if (temporaryLicense) await rm(license, { force: true });
    }
    const archives = [...new Bun.Glob("*.tgz").scanSync({ cwd: destination, absolute: true })];
    if (archives.length !== 1) throw new Error(`${pkg.name} 缺少唯一打包产物。`);
    const archive = archives[0]!;
    const archivedLicense = Bun.spawnSync(["tar", "-xOf", archive, "package/LICENSE"], { stdout: "pipe", stderr: "inherit" });
    if (archivedLicense.exitCode !== 0) throw new Error(`${pkg.name} 发布包缺少许可证。`);
    assert.equal(new TextDecoder().decode(archivedLicense.stdout), await Bun.file(path.join(root, "LICENSE")).text());
    const archivedReadme = Bun.spawnSync(["tar", "-xOf", archive, "package/README.md"], { stdout: "pipe", stderr: "inherit" });
    assert.equal(archivedReadme.exitCode, 0, `${pkg.name} 发布包缺少 README.md`);
    assert.equal(new TextDecoder().decode(archivedReadme.stdout), await Bun.file(path.join(pkg.location, "README.md")).text(), `${pkg.name} 发布包介绍必须与源码一致`);
    const extracted = Bun.spawnSync(["tar", "-xOf", archive, "package/package.json"], { stdout: "pipe", stderr: "inherit" });
    if (extracted.exitCode !== 0) throw new Error(`${pkg.name} 打包 manifest 无法读取。`);
    const content = new TextDecoder().decode(extracted.stdout);
    if (content.includes("workspace:")) throw new Error(`${pkg.name} 包含未转换的 workspace 依赖。`);
    const manifest = JSON.parse(content) as { dependencies?: Record<string, string>; optionalDependencies?: Record<string, string>; peerDependencies?: Record<string, string> };
    for (const runtime of [manifest.dependencies, manifest.optionalDependencies, manifest.peerDependencies]) {
      assert(!runtime?.["@agent-proxy/models"], `${pkg.name} 发布 manifest 不得依赖私有模型包`);
    }
    const listing = Bun.spawnSync(["tar", "-tzf", archive], { stdout: "pipe", stderr: "inherit" });
    assert.equal(listing.exitCode, 0);
    for (const file of new TextDecoder().decode(listing.stdout).split("\n").filter(file => /\.(?:[cm]?js|d\.ts)$/.test(file))) {
      const source = Bun.spawnSync(["tar", "-xOf", archive, file], { stdout: "pipe", stderr: "inherit" });
      assert.equal(source.exitCode, 0);
      assert(!/(["'])@agent-proxy\/models(?:\/[^"']*)?\1/.test(new TextDecoder().decode(source.stdout)), `${pkg.name} 发布代码或声明引用私有模型包：${file}`);
    }
    dependencies[pkg.name] = `file:${archive}`;
  }
  const consumer = path.join(temporary, "consumer");
  await mkdir(consumer);
  // 未发布的新包用本地 tarball 覆盖所有传递引用，打包 manifest 仍必须保留可发布版本。
  const compiler = await Bun.file(path.join(root, "node_modules/typescript/package.json")).json();
  const bunTypes = await Bun.file(path.join(root, "node_modules/@types/bun/package.json")).json();
  await Bun.write(path.join(consumer, "package.json"), JSON.stringify({ private: true, type: "module", dependencies, overrides: dependencies, devDependencies: { typescript: compiler.version, "@types/bun": bunTypes.version } }));
  await run([process.execPath, "install", "--ignore-scripts"], consumer);
  assert.equal(await Bun.file(path.join(consumer, "node_modules/@agent-proxy/models/package.json")).exists(), false, "独立消费者不安装私有模型包");
  await Bun.write(path.join(consumer, "types-smoke.ts"), `
    import type { GatewayPlugin, HostServices } from "@agent-proxy/plugin-api";
    import type { ZcodeDependencies } from "@agent-proxy/zcode";
    import type { CodebuddyDependencies } from "@agent-proxy/codebuddy";
    import type { QoderDependencies } from "@agent-proxy/qoder";
    import type { AgyDependencies } from "@agent-proxy/agy";
    import type { OpencodeZenDependencies } from "@agent-proxy/opencode-zen";
    import { convertRequest, createClientResponse } from "@agent-proxy/llm-bridge";
    import type { BridgeProtocol, ToolIdentityMap } from "@agent-proxy/llm-bridge";
    export type PublishedApi = [GatewayPlugin, HostServices, ZcodeDependencies, CodebuddyDependencies, QoderDependencies, AgyDependencies, OpencodeZenDependencies, BridgeProtocol, ToolIdentityMap, ReturnType<typeof convertRequest>, Awaited<ReturnType<typeof createClientResponse>>];
  `);
  await run([process.execPath, path.join(consumer, "node_modules/typescript/bin/tsc"), "--noEmit", "--strict", "--module", "Preserve", "--moduleResolution", "Bundler", "--target", "ES2024", "--types", "bun", "types-smoke.ts"], consumer);
  for (const pkg of packages.filter(pkg => pkg.name !== "@agent-proxy/gateway")) {
    await run([process.execPath, "--eval", `await import(${JSON.stringify(pkg.name)})`], consumer);
  }
  await run([process.execPath, path.join(consumer, "node_modules/.bin/agent-proxy"), "--help"], consumer);
  // 仅注入真实的宿主目录运算；插件与预设必须全部来自已安装的发布产物。
  const hostCatalog = await Bun.build({
    entrypoints: [path.join(root, "apps/gateway/src/catalog.ts")], target: "bun", format: "esm",
    outdir: consumer, naming: "host-catalog.js",
  });
  if (!hostCatalog.success) throw new AggregateError(hostCatalog.logs, "消费者目录主机 fixture 构建失败。");
  await run([process.execPath, "--eval", `
    import assert from "node:assert/strict";
    import { withHostServices } from "@agent-proxy/plugin-api";
    import * as catalog from "./host-catalog.js";
    await withHostServices({ catalog }, async () => {
      const agy = await import("@agent-proxy/agy/catalog");
      const codebuddy = await import("@agent-proxy/codebuddy/catalog");
      const qoder = await import("@agent-proxy/qoder/catalog");
      const opencode = await import("@agent-proxy/opencode-zen/catalog");
      const zcode = await import("@agent-proxy/zcode/catalog");
      const cases = [
        [agy.buildAgyCatalog(agy.parseAgyCatalogData({ models: { "packed-agy": { displayName: "Packed AGY", supportsImages: true } } })), "agy/packed-agy"],
        [codebuddy.buildCodebuddyCatalog({ models: [{ id: "packed-codebuddy", name: "Packed CodeBuddy", supportsToolCall: true }], pickerIds: ["packed-codebuddy"] }, "intl-cli"), "packed-codebuddy"],
        [qoder.buildQoderCatalog([{ key: "packed-qoder", display_name: "Packed Qoder", is_vl: true, is_reasoning: false }]), "qoder-intl/packed-qoder"],
        [opencode.buildOpencodeZenCatalog(["packed-opencode"]), "opencode-zen/packed-opencode"],
      ];
      for (const [result, slug] of cases) {
        assert.equal(result.models.length, 1);
        assert.equal(result.models[0].slug, slug);
        assert.equal(result.models[0].prefer_websockets, false);
        assert.ok(result.models[0].base_instructions, "合成条目保留真实模型基底与 agent 提示词");
      }
      const vendors = zcode.buildZcodeVendorCatalog();
      assert.ok(vendors.models.length > 0, "私有厂商预设随发布包提供");
      assert.ok(vendors.models.some(entry => entry.slug.startsWith("glm-")));
      assert.ok(vendors.models.every(entry => entry.supports_search_tool === true));
    });
    console.log("五家独立发布产物模型目录合成冒烟通过。");
  `], consumer);
  await run([process.execPath, "--eval", `
    import assert from "node:assert/strict";
    const input = { input: "ping" };
    const cases = [
      (await import("@agent-proxy/zcode/request")).translateZcodeRequest(input, "glm-5.3").body,
      (await import("@agent-proxy/codebuddy/request")).translateCodebuddyRequest(input, "gpt-5.6-luna").body,
      (await import("@agent-proxy/qoder/request")).translateQoderRequest(input, "qfmodel").body,
      (await import("@agent-proxy/agy/request")).translateAgyRequest(input, "gemini-3.8-flash").wrapper,
      (await import("@agent-proxy/opencode-zen/convert")).convertOpencodeZenRequest("responses", "chat", input).body,
    ];
    for (const body of cases) assert.ok(JSON.stringify(body).includes("ping"));
    const upstream = new Response([
      'data: {"id":"smoke","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"pong"},"finish_reason":null}]}',
      'data: {"id":"smoke","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
      'data: [DONE]',
    ].join("\\n\\n") + "\\n\\n", { headers: { "content-type": "text/event-stream" } });
    const response = await (await import("@agent-proxy/codebuddy/response")).createCodebuddyResponse("responses", upstream, { model: "codebuddy/gpt-5.6-luna", tools: new Map(), stream: true });
    const stream = await response.text();
    assert.ok(stream.includes("response.completed"));
    assert.ok(stream.includes("pong"));
    console.log("五家本地产物 Responses 基线转换冒烟通过。");
  `], consumer);
  await smokeDefault(consumer);
  console.log("八个公开产物、私包内联、workspace 版本转换、CLI/default、五家目录及 Responses 冒烟检查通过。");
} finally { await rm(temporary, { recursive: true, force: true }); }
