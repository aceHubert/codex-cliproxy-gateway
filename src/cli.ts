import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  GATEWAY_CONFIG_SCHEMA_URL,
  GATEWAY_CONFIG_VERSION,
  gatewayConfigWarnings,
  isJsonObject,
  mergeMissingConfig,
} from "./config.ts";
import { resolvePaths } from "./paths.ts";
import {
  patchRootToml,
  restoreRootTomlKeys,
  atomicWrite,
  readRootTomlString,
} from "./toml.ts";
import { saveApiKey, readApiKey, deleteApiKey } from "./keychain.ts";
import {
  fetchCliProxyCatalog,
  invalidateModelsCache,
  resolveModelMergeJson,
  syncCatalog,
} from "./catalog.ts";
import { chooseModels, selectedModelsFromCatalog } from "./models.ts";
import { isLoopbackUrl, startGateway } from "./gateway.ts";
import { loadRealtimeProviderMode } from "./realtime.ts";
import { stopCodexAppServers } from "./app-server.ts";
import {
  installLaunchAgent,
  uninstallLaunchAgent,
  startLaunchAgent,
  stopLaunchAgent,
  restartLaunchAgent,
  launchAgentStatus,
} from "./launchd.ts";
import type {
  CliOptions,
  GatewayConfig,
  ModelCatalog,
  ResolvedPaths,
} from "./types.ts";

const DEFAULTS = {
  host: "127.0.0.1",
  port: 8320,
  mountPath: "/v1",
  prefix: "cliproxy/",
  officialBaseUrl: "https://chatgpt.com/backend-api/codex",
  cliproxyBaseUrl: "http://127.0.0.1:8317/v1",
  requestLogging: false,
  maxRequestLogs: 0,
  websocket: false,
  cpaOnly: false,
} satisfies Omit<GatewayConfig, "catalogPath" | "selectedModels">;

interface BackupRecord {
  existed: boolean;
  backup: string;
}

interface InstallState {
  version: number;
  installedAt: string;
  configBackup: BackupRecord;
  installedConfigHash: string;
  gatewayBaseUrl: string;
  config: GatewayConfig;
}

const MANAGED_CONFIG_KEYS = [
  "openai_base_url",
  "model_catalog_json",
  "experimental_realtime_ws_base_url",
  "experimental_realtime_webrtc_call_base_url",
];
const DEFAULT_MODELS_FILE = path.resolve(import.meta.dir, "../models.json");

function usage() {
  console.log(`codex-cliproxy - Bun gateway for Codex Desktop and CLI

Usage:
  codex-cliproxy install [options]
  codex-cliproxy uninstall
  codex-cliproxy start|stop|restart
  codex-cliproxy serve [--config PATH]
  codex-cliproxy models [--sync] [--cpa-only] [--websocket] [--select SELECTOR] [--restart-codex]
  codex-cliproxy log on|off
  codex-cliproxy status

Install options:
  --cliproxy-url URL   default: ${DEFAULTS.cliproxyBaseUrl}
  --port PORT          default: ${DEFAULTS.port}
  --prefix PREFIX      default: ${DEFAULTS.prefix}
  --official-url URL   default: existing openai_base_url or official Codex
  --key-env NAME       read the API key from this environment variable
  --select SELECTOR     model numbers/ranges, exact IDs, all, none; use pass to reuse the previous selection
  --model-merge-json URL  GitHub repository or HTTP(S) models.json URL

Models:
  models                list models currently shown through CLIProxy
  models --sync         refresh CLIProxy models and use dynamic official models
  --cpa-only            use a static CPA-only catalog with original model IDs
  --websocket           enable CPA Responses WebSocket; requires --sync
  --model-merge-json URL  update the cached models.json override
  --restart-codex       stop Codex app-server after sync to refresh the model picker;
                        active tasks may error and require recovery or reopening

Routing:
  cliproxy/*  -> CLIProxyAPI; prefix stripped and auth replaced
  everything else -> official Codex backend; OAuth header preserved
  --cpa-only -> every model uses CLIProxyAPI with its original ID
`);
}

function parseArgs(args: string[]): { positional: string[]; options: CliOptions } {
  const positional: string[] = [];
  const options: CliOptions = {};
  for (let i = 0; i < args.length; i += 1) {
    const value = args[i];
    if (!value.startsWith("--")) {
      positional.push(value);
      continue;
    }
    const key = value.slice(2);
    if (["help", "sync", "cpa-only", "websocket", "restart-codex"].includes(key)) {
      options[key] = true;
      continue;
    }
    const next = args[i + 1];
    if (key === "select" && (next === undefined || next.startsWith("--"))) {
      options.select = true;
      continue;
    }
    if (next === undefined || next.startsWith("--")) throw new Error(`--${key} requires a value`);
    options[key] = next;
    i += 1;
  }
  return { positional, options };
}

function requireMacOS() {
  if (process.platform !== "darwin") {
    throw new Error("Automated install/uninstall currently supports macOS only");
  }
}

function requireBun() {
  if (typeof Bun === "undefined") {
    throw new Error("Run this command with Bun");
  }
}

function readSecretFromTerminal() {
  const script = 'read -r -s -p "CLIProxy API key: " key; printf "\\n%s" "$key"';
  return execFileSync("/bin/bash", ["-c", script], {
    encoding: "utf8",
    stdio: ["inherit", "pipe", "inherit"],
  }).trim();
}

function stringOption(options: CliOptions, key: string): string | undefined {
  const value = options[key];
  return typeof value === "string" ? value : undefined;
}

function getInstallApiKey(baseUrl: string, keyEnv?: string): string {
  const envName = keyEnv || "CLIPROXY_API_KEY";
  const value = (Object.hasOwn(process.env, envName)
    ? process.env[envName] || ""
    : readSecretFromTerminal()).trim();
  if (!value && !isLoopbackUrl(baseUrl)) {
    throw new Error("CLIProxy API key may be empty only for a loopback URL");
  }
  return value;
}

function timestamp() {
  return new Date().toISOString().replace(/[-:]/g, "").slice(0, 15).replace("T", "");
}

function backupConfig(file: string): BackupRecord {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const existed = fs.existsSync(file);
  const backup = `${file}.bak-cliproxy-gateway-${timestamp()}`;
  if (existed) fs.copyFileSync(file, backup);
  else fs.writeFileSync(backup, "", { mode: 0o600 });
  return { existed, backup };
}

function hash(contents: string): string {
  return createHash("sha256").update(contents).digest("hex");
}

function restoreBackup(file: string, record: BackupRecord): void {
  if (record.existed) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.copyFileSync(record.backup, file);
  } else {
    fs.rmSync(file, { force: true });
  }
}

function loadJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, "utf8")) as T;
}

function writeJson(file: string, value: unknown): void {
  atomicWrite(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function formatErrorLog(
  error: unknown,
  at = new Date(),
  options: { label?: string; stack?: boolean } = {},
): string {
  const name = error instanceof Error ? error.name : "Error";
  const message = error instanceof Error ? error.message : String(error);
  const label = options.label ? `${options.label}: ` : "";
  let stack = "";
  if (options.stack && error instanceof Error && error.stack) {
    // stack 首行通常是 "Name: message"，与消息行重复，只保留调用位置。
    const frames = error.stack.split(/\r?\n/);
    if (frames[0]?.trim() === `${name}: ${message}`) frames.shift();
    stack = `\n${frames.join("\n")}`;
  }
  const lines = `${label}${name}: ${message}${stack}`
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .join("\n");
  return `--${at.toISOString()}--\n${lines}`;
}

function warnGatewayConfig(file: string, value: unknown): void {
  for (const warning of gatewayConfigWarnings(value)) {
    console.warn(`Warning: ${file}: ${warning}`);
  }
}

function loadGatewayConfig(file: string): GatewayConfig {
  const value = loadJson<unknown>(file);
  if (!isJsonObject(value)) throw new Error(`Gateway config must be a JSON object: ${file}`);
  return value as unknown as GatewayConfig;
}

function writeGatewayConfig(file: string, value: GatewayConfig): void {
  warnGatewayConfig(file, value);
  writeJson(file, value);
}

export function removeManagedRuntimeFiles(
  paths: ResolvedPaths,
  options: { preserveGatewayConfig?: boolean } = {},
): void {
  for (const file of [
    ...(options.preserveGatewayConfig ? [] : [paths.gatewayConfig]),
    paths.stateFile,
    paths.catalogFile,
    path.join(paths.runtimeHome, "catalog-metadata.json"),
    paths.modelMergeFile,
    paths.stdoutLog,
    paths.stderrLog,
  ]) {
    fs.rmSync(file, { force: true });
  }
}

async function waitForHealth(url: string, attempts = 100): Promise<void> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await Bun.sleep(300);
  }
  throw new Error(
    `Gateway health check failed: ${lastError instanceof Error ? lastError.message : "unknown error"}`,
  );
}

function gatewayStartupDiagnostics(paths: ResolvedPaths): string {
  const status = launchAgentStatus();
  const details: string[] = [];
  if (status) {
    const state = status.match(/\bstate = ([^\n]+)/)?.[1]?.trim();
    const exitCode = status.match(/\blast exit code = ([^\n]+)/)?.[1]?.trim();
    details.push(`LaunchAgent state: ${state || "loaded"}`);
    if (exitCode) details.push(`last exit code: ${exitCode}`);
  } else {
    details.push("LaunchAgent is not loaded");
  }

  if (fs.existsSync(paths.stderrLog)) {
    const stderr = fs.readFileSync(paths.stderrLog, "utf8").trim().slice(-2000);
    if (stderr) details.push(`gateway stderr: ${stderr}`);
  }
  return details.join("; ");
}

function gatewayDefaults(paths: ResolvedPaths, officialBaseUrl = DEFAULTS.officialBaseUrl): GatewayConfig {
  return {
    $schema: GATEWAY_CONFIG_SCHEMA_URL,
    configVersion: GATEWAY_CONFIG_VERSION,
    ...DEFAULTS,
    officialBaseUrl,
    catalogPath: paths.catalogFile,
    logDir: paths.logDir,
  };
}

export function applyRoutingMode(
  config: GatewayConfig,
  paths: ResolvedPaths,
  cpaOnly: boolean,
  websocket = false,
): void {
  config.cpaOnly = cpaOnly;
  config.websocket = websocket;
  config.catalogPath = paths.catalogFile;
}

function mergedGatewayConfig(
  paths: ResolvedPaths,
  current: Record<string, unknown>,
  overrides: Partial<GatewayConfig> = {},
  officialBaseUrl = DEFAULTS.officialBaseUrl,
): { config: GatewayConfig; added: string[] } {
  const merged = mergeMissingConfig(
    current,
    gatewayDefaults(paths, officialBaseUrl) as unknown as Record<string, unknown>,
  );
  if (merged.config.catalogPath === path.join(paths.codexHome, "cliproxy-catalog.json")) {
    merged.config.catalogPath = paths.catalogFile;
  }
  return {
    config: Object.assign(merged.config, overrides) as unknown as GatewayConfig,
    added: merged.added,
  };
}

export function managedCodexServiceToml(source: string, gatewayBaseUrl: string): string {
  return patchRootToml(source, {
    openai_base_url: gatewayBaseUrl,
    experimental_realtime_ws_base_url: gatewayBaseUrl,
    experimental_realtime_webrtc_call_base_url: gatewayBaseUrl,
  });
}

export function managedCodexToml(source: string, gatewayBaseUrl: string): string {
  return managedCodexServiceToml(
    restoreRootTomlKeys(source, "", ["model_catalog_json"]),
    gatewayBaseUrl,
  );
}

async function rebuildCatalog(
  paths: ResolvedPaths,
  config: GatewayConfig,
  proxyModels: ModelCatalog["models"],
  refreshModelMerge = false,
) {
  const modelsConfigFile = await resolveModelMergeJson(
    paths.modelMergeFile,
    DEFAULT_MODELS_FILE,
    config.model_merge_json,
    refreshModelMerge,
  );
  const result = await syncCatalog({
    catalogFile: config.catalogPath,
    modelsConfigFile,
    proxyModels,
  });
  fs.rmSync(path.join(paths.runtimeHome, "catalog-metadata.json"), { force: true });
  return result;
}

async function install(options: CliOptions): Promise<void> {
  requireMacOS();
  requireBun();
  const paths = resolvePaths();
  if (fs.existsSync(paths.stateFile)) throw new Error("Already installed; run uninstall first");

  const portValue = stringOption(options, "port");
  const port = portValue ? Number(portValue) : undefined;
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) {
    throw new Error("Invalid port");
  }
  const currentToml = fs.existsSync(paths.configToml) ? fs.readFileSync(paths.configToml, "utf8") : "";
  const existingBaseUrl = readRootTomlString(currentToml, "openai_base_url");
  const modelMergeJson = stringOption(options, "model-merge-json");
  const previousGatewayConfig = fs.existsSync(paths.gatewayConfig)
    ? fs.readFileSync(paths.gatewayConfig, "utf8")
    : undefined;
  const currentGatewayConfig = previousGatewayConfig === undefined
    ? {}
    : loadGatewayConfig(paths.gatewayConfig) as unknown as Record<string, unknown>;
  const overrides: Partial<GatewayConfig> = {};
  if (port !== undefined) overrides.port = port;
  const prefix = stringOption(options, "prefix");
  if (prefix) overrides.prefix = prefix;
  const officialUrl = stringOption(options, "official-url");
  if (officialUrl) overrides.officialBaseUrl = officialUrl.replace(/\/+$/, "");
  const cliproxyUrl = stringOption(options, "cliproxy-url");
  if (cliproxyUrl) overrides.cliproxyBaseUrl = cliproxyUrl.replace(/\/+$/, "");
  if (modelMergeJson) overrides.model_merge_json = modelMergeJson;
  const { config } = mergedGatewayConfig(
    paths,
    currentGatewayConfig,
    overrides,
    (existingBaseUrl || DEFAULTS.officialBaseUrl).replace(/\/+$/, ""),
  );
  config.configVersion = GATEWAY_CONFIG_VERSION;
  applyRoutingMode(config, paths, false);
  const apiKey = getInstallApiKey(config.cliproxyBaseUrl, stringOption(options, "key-env"));

  const proxyCatalog = await fetchCliProxyCatalog(
    config.cliproxyBaseUrl,
    apiKey,
    "0.0.0",
  );
  const availableModels = proxyCatalog.models;
  console.log(`CLIProxy authentication verified; ${availableModels.length} models found.`);
  const selectedModels = await chooseModels({
    availableModels,
    currentSelection: Array.isArray(config.selectedModels) ? config.selectedModels : undefined,
    selector: stringOption(options, "select"),
    requireNonEmpty: true,
  });
  config.selectedModels = selectedModels;
  console.log(`Selected ${selectedModels.length} CLIProxy models.`);

  const configBackup = backupConfig(paths.configToml);
  let launchInstalled = false;

  try {
    if (apiKey) saveApiKey(apiKey);
    else deleteApiKey();
    const catalogResult = await rebuildCatalog(
      paths,
      config,
      proxyCatalog.models.filter((model) => selectedModels.includes(model.slug)),
      Boolean(modelMergeJson),
    );
    console.log(`Dynamic CLIProxy overlay synced: ${catalogResult.proxyCount} models.`);

    writeGatewayConfig(paths.gatewayConfig, config);

    const originalToml = currentToml;
    const gatewayBaseUrl = `http://${config.host}:${config.port}${config.mountPath}`;
    const patchedToml = managedCodexToml(originalToml, gatewayBaseUrl);
    atomicWrite(paths.configToml, patchedToml);

    writeJson(paths.stateFile, {
      version: 4,
      installedAt: new Date().toISOString(),
      configBackup,
      installedConfigHash: hash(patchedToml),
      gatewayBaseUrl,
      config,
    });

    const cliPath = fs.realpathSync(process.argv[1]);
    installLaunchAgent({
      bunPath: process.execPath,
      cliPath,
      configPath: paths.gatewayConfig,
      codexHome: paths.codexHome,
      stdoutLog: paths.stdoutLog,
      stderrLog: paths.stderrLog,
      plistPath: paths.launchAgent,
    });
    launchInstalled = true;

    await waitForHealth(`http://${config.host}:${config.port}/healthz`);
    invalidateModelsCache(paths.modelsCacheFile);

    console.log(`Installed. Gateway: ${gatewayBaseUrl}`);
    console.log("Codex ChatGPT OAuth was not modified. Fully quit and reopen Codex Desktop.");
  } catch (error) {
    const diagnostics = launchInstalled ? gatewayStartupDiagnostics(paths) : "";
    if (launchInstalled) uninstallLaunchAgent(paths.launchAgent);
    restoreBackup(paths.configToml, configBackup);
    deleteApiKey();
    removeManagedRuntimeFiles(paths);
    if (previousGatewayConfig !== undefined) atomicWrite(paths.gatewayConfig, previousGatewayConfig);
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(diagnostics ? `${message}; ${diagnostics}` : message);
  }
}

function uninstall(): void {
  requireMacOS();
  const paths = resolvePaths();
  if (!fs.existsSync(paths.stateFile)) throw new Error("No managed installation found");
  const state = loadJson<InstallState>(paths.stateFile);

  uninstallLaunchAgent(paths.launchAgent);
  const currentToml = fs.existsSync(paths.configToml) ? fs.readFileSync(paths.configToml, "utf8") : "";
  const legacyCatalogFile = path.join(paths.codexHome, "cliproxy-catalog.json");
  const removeLegacyCatalog = readRootTomlString(currentToml, "model_catalog_json") === legacyCatalogFile;
  if (hash(currentToml) === state.installedConfigHash) {
    restoreBackup(paths.configToml, state.configBackup);
  } else {
    const backupToml = fs.readFileSync(state.configBackup.backup, "utf8");
    atomicWrite(paths.configToml, restoreRootTomlKeys(currentToml, backupToml, MANAGED_CONFIG_KEYS));
  }
  if (removeLegacyCatalog) fs.rmSync(legacyCatalogFile, { force: true });
  deleteApiKey();
  invalidateModelsCache(paths.modelsCacheFile);
  removeManagedRuntimeFiles(paths, { preserveGatewayConfig: true });

  console.log("Uninstalled. Managed config.toml values were restored; config.json was preserved.");
  console.log("Codex auth.json was never changed.");
}

function configuredSelectedModels(paths: ResolvedPaths, config: GatewayConfig): string[] {
  if (Array.isArray(config.selectedModels)) return config.selectedModels;
  const catalogFile = config.catalogPath;
  if (!fs.existsSync(catalogFile)) return [];
  try {
    return selectedModelsFromCatalog(loadJson<ModelCatalog>(catalogFile), "")
      .map((model) => config.prefix && model.startsWith(config.prefix)
        ? model.slice(config.prefix.length)
        : model);
  } catch {
    return [];
  }
}

function printCurrentModels(config: GatewayConfig, selectedModels: string[]): void {
  console.log(`Selected CLIProxy models (${selectedModels.length}):`);
  if (selectedModels.length === 0) {
    console.log("  (none)");
    return;
  }
  for (const model of selectedModels) {
    console.log(`  ${config.cpaOnly === true ? "" : config.prefix}${model}`);
  }
}

async function models(options: CliOptions): Promise<void> {
  const restartCodex = options["restart-codex"] === true;
  const cpaOnly = options["cpa-only"] === true;
  const websocket = options.websocket === true;
  const selector = stringOption(options, "select");
  const reuseSelection = options.select === true || selector?.toLowerCase() === "pass";
  const modelMergeJson = stringOption(options, "model-merge-json");
  const paths = resolvePaths();
  if (!fs.existsSync(paths.gatewayConfig)) throw new Error("Gateway is not installed");
  const config = loadGatewayConfig(paths.gatewayConfig);
  const previousCpaOnly = config.cpaOnly === true;
  const previousWebsocket = config.websocket === true;
  const previousCatalogPath = config.catalogPath;
  if (modelMergeJson) config.model_merge_json = modelMergeJson;
  const currentSelection = configuredSelectedModels(paths, config);

  if (options.sync !== true) {
    printCurrentModels(config, currentSelection);
    return;
  }

  applyRoutingMode(config, paths, cpaOnly, websocket);
  if (reuseSelection && cpaOnly) {
    throw new Error("--select without a value is only supported in split mode");
  }
  const source = fs.existsSync(paths.configToml) ? fs.readFileSync(paths.configToml, "utf8") : "";
  const configuredCatalog = readRootTomlString(source, "model_catalog_json");
  const legacyCatalogFile = path.join(paths.codexHome, "cliproxy-catalog.json");
  if (configuredCatalog && ![paths.catalogFile, legacyCatalogFile].includes(configuredCatalog)) {
    throw new Error(`Refusing to replace unmanaged model_catalog_json: ${configuredCatalog}`);
  }
  const apiKey = readApiKey(isLoopbackUrl(config.cliproxyBaseUrl));
  const proxyCatalog = await fetchCliProxyCatalog(
    config.cliproxyBaseUrl,
    apiKey,
    "0.0.0",
  );
  const availableModels = proxyCatalog.models;
  console.log(`CLIProxy authentication verified; ${availableModels.length} models found.`);
  const selectedModels = reuseSelection
    ? availableModels.map((model) => model.slug).filter((model) => currentSelection.includes(model))
    : await chooseModels({
      availableModels,
      currentSelection,
      selector,
      requireNonEmpty: cpaOnly,
    });
  if (reuseSelection && selectedModels.length === 0) {
    throw new Error("No previous local model selection is available; pass --select SELECTOR");
  }

  const selectedProxyModels = proxyCatalog.models.filter((model) => selectedModels.includes(model.slug));
  const result = await rebuildCatalog(
    paths,
    config,
    selectedProxyModels,
    Boolean(modelMergeJson),
  );
  config.selectedModels = selectedModels;
  writeGatewayConfig(paths.gatewayConfig, config);

  const patchedToml = cpaOnly
    ? patchRootToml(source, { model_catalog_json: paths.catalogFile })
    : restoreRootTomlKeys(source, "", ["model_catalog_json"]);
  if (patchedToml !== source) atomicWrite(paths.configToml, patchedToml);
  if (configuredCatalog === legacyCatalogFile) fs.rmSync(legacyCatalogFile, { force: true });
  if (fs.existsSync(paths.stateFile)) {
    const state = loadJson<InstallState>(paths.stateFile);
    state.version = 4;
    state.config = config;
    if (hash(source) === state.installedConfigHash) state.installedConfigHash = hash(patchedToml);
    writeJson(paths.stateFile, state);
  }
  const routingChanged = previousCpaOnly !== cpaOnly
    || previousWebsocket !== config.websocket
    || previousCatalogPath !== config.catalogPath;
  if (routingChanged && fs.existsSync(paths.launchAgent)) {
    restartLaunchAgent(paths.launchAgent);
    console.log("Gateway restarted to apply the routing mode.");
  }
  if (!cpaOnly) invalidateModelsCache(paths.modelsCacheFile);

  if (cpaOnly) {
    console.log(`CPA-only catalog synced: ${result.proxyCount} selected models.`);
  } else {
    console.log(`CPA catalog synced for dynamic split routing: ${result.proxyCount} selected models.`);
  }
  printCurrentModels(config, selectedModels);
  if (!restartCodex) {
    if (cpaOnly) {
      console.log("CPA-only catalog configured; restart Codex to load it, or rerun with --restart-codex.");
    } else if (configuredCatalog === legacyCatalogFile || configuredCatalog === paths.catalogFile) {
      console.log("Dynamic split routing configured; restart Codex to leave CPA-only mode, or rerun with --restart-codex.");
    } else {
      console.log("Dynamic catalog synced; Codex refreshes /models periodically, but the current model picker may require --restart-codex.");
    }
    return;
  }

  console.log("Stopping Codex app-server may interrupt active turns. This command does not start a replacement process.");
  const stopResult = await stopCodexAppServers();
  for (const result of stopResult.results) console.log(`Codex app-server PID ${result.pid}: ${result.status}`);
  console.log("The Codex App may relaunch app-server; reopen the model picker or start a new session if the UI stays stale.");
  if (stopResult.scan === "unknown") throw new Error(`Codex app-server state is unknown: ${stopResult.error}`);
  if (stopResult.results.length === 0) console.log("No matching current-user Codex app-server process was found.");
  if (stopResult.results.some(({ status }) => status !== "stopped")) {
    throw new Error("One or more Codex app-server processes were not stopped");
  }
}

async function status(): Promise<void> {
  const paths = resolvePaths();
  const installed = fs.existsSync(paths.stateFile);
  const config = fs.existsSync(paths.gatewayConfig) ? loadGatewayConfig(paths.gatewayConfig) : undefined;
  const service = process.platform === "darwin" ? launchAgentStatus() : null;
  const source = fs.existsSync(paths.configToml) ? fs.readFileSync(paths.configToml, "utf8") : "";
  const configuredBaseUrl = readRootTomlString(source, "openai_base_url");
  const configuredCatalog = readRootTomlString(source, "model_catalog_json");
  const configuredRealtimeWsBaseUrl = readRootTomlString(source, "experimental_realtime_ws_base_url");
  const configuredRealtimeWebrtcCallBaseUrl = readRootTomlString(
    source,
    "experimental_realtime_webrtc_call_base_url",
  );
  let health = "unreachable";
  if (installed) {
    const state = loadJson<InstallState>(paths.stateFile);
    const healthConfig = config ?? state.config;
    try {
      const response = await fetch(`http://${healthConfig.host}:${healthConfig.port}/healthz`);
      if (response.ok) health = "ok";
    } catch {}
  }
  console.log(JSON.stringify({
    installed,
    serviceLoaded: Boolean(service),
    health,
    openaiBaseUrl: configuredBaseUrl,
    experimentalRealtimeWsBaseUrl: configuredRealtimeWsBaseUrl,
    experimentalRealtimeWebrtcCallBaseUrl: configuredRealtimeWebrtcCallBaseUrl,
    modelCatalogJson: configuredCatalog,
    authJsonModified: false,
    cachedCatalogPath: config?.catalogPath ?? paths.catalogFile,
    cachedCatalogPresent: fs.existsSync(config?.catalogPath ?? paths.catalogFile),
    cpaOnly: config?.cpaOnly === true,
    websocket: config?.websocket === true,
  }, null, 2));
}

function serve(options: CliOptions): void {
  requireBun();
  const paths = resolvePaths();
  const configPath = stringOption(options, "config") || paths.gatewayConfig;
  if (!fs.existsSync(configPath)) throw new Error(`Gateway config not found: ${configPath}`);
  startGateway(
    loadGatewayConfig(configPath),
    loadRealtimeProviderMode(paths.configToml),
  );
}

async function logToggle(enabled: boolean): Promise<void> {
  requireMacOS();
  const paths = resolvePaths();
  if (!fs.existsSync(paths.gatewayConfig)) throw new Error("Gateway is not installed");
  const config = loadGatewayConfig(paths.gatewayConfig);
  config.requestLogging = enabled;
  config.logDir ||= paths.logDir;
  writeGatewayConfig(paths.gatewayConfig, config);

  // Update state.json if it exists
  if (fs.existsSync(paths.stateFile)) {
    const state = loadJson<InstallState>(paths.stateFile);
    state.config = config;
    writeJson(paths.stateFile, state);
  }

  restartLaunchAgent(paths.launchAgent);
  const state = loadJson<InstallState>(paths.stateFile);
  await waitForHealth(`http://${state.config.host}:${state.config.port}/healthz`);
  console.log(`Request logging ${enabled ? "enabled" : "disabled"}. Gateway restarted.`);
  if (enabled) console.log(`Request logs will be written to: ${config.logDir}`);
}

async function controlGateway(action: "start" | "stop" | "restart"): Promise<void> {
  requireMacOS();
  const paths = resolvePaths();
  if (!fs.existsSync(paths.stateFile)) throw new Error("Gateway is not installed");

  if (action === "stop") {
    stopLaunchAgent(paths.launchAgent);
    console.log("Gateway stopped.");
    return;
  }

  const config = loadGatewayConfig(paths.gatewayConfig);
  if (action === "start") {
    startLaunchAgent(paths.launchAgent);
  } else {
    const source = fs.existsSync(paths.configToml) ? fs.readFileSync(paths.configToml, "utf8") : "";
    const gatewayBaseUrl = `http://${config.host}:${config.port}${config.mountPath}`;
    const patchedToml = managedCodexServiceToml(source, gatewayBaseUrl);
    if (patchedToml !== source) atomicWrite(paths.configToml, patchedToml);
    const state = loadJson<InstallState>(paths.stateFile);
    if (hash(source) === state.installedConfigHash) state.installedConfigHash = hash(patchedToml);
    state.gatewayBaseUrl = gatewayBaseUrl;
    state.config = config;
    writeJson(paths.stateFile, state);
    restartLaunchAgent(paths.launchAgent);
  }

  await waitForHealth(`http://${config.host}:${config.port}/healthz`);
  console.log(`Gateway ${action === "start" ? "started" : "restarted"}.`);
}

async function logCommand(positional: string[]): Promise<void> {
  const sub = positional[1];
  if (sub === "on") return logToggle(true);
  if (sub === "off") return logToggle(false);
  throw new Error('Usage: codex-cliproxy log on|off');
}

export function syncGatewayConfigFile(paths: ResolvedPaths, configFile = paths.gatewayConfig): void {
  if (!fs.existsSync(configFile)) return;

  const current = loadGatewayConfig(configFile);
  const legacyCatalogPath = current.catalogPath === path.join(paths.codexHome, "cliproxy-catalog.json");
  if (legacyCatalogPath) current.catalogPath = paths.catalogFile;
  if (current.configVersion === GATEWAY_CONFIG_VERSION) {
    if (legacyCatalogPath) {
      writeGatewayConfig(configFile, current);
      if (configFile === paths.gatewayConfig && fs.existsSync(paths.stateFile)) {
        const state = loadJson<InstallState>(paths.stateFile);
        state.config = current;
        writeJson(paths.stateFile, state);
      }
    }
    warnGatewayConfig(configFile, current);
    return;
  }

  const merged = mergedGatewayConfig(
    paths,
    current as unknown as Record<string, unknown>,
  );
  merged.config.configVersion = GATEWAY_CONFIG_VERSION;
  writeGatewayConfig(configFile, merged.config);

  if (configFile === paths.gatewayConfig && fs.existsSync(paths.stateFile)) {
    const state = loadJson<InstallState>(paths.stateFile);
    state.version = 4;
    state.config = merged.config;
    writeJson(paths.stateFile, state);
  }
  const additions = merged.added.filter((key) => key !== "configVersion");
  console.log(`Config synced to ${GATEWAY_CONFIG_VERSION}.${additions.length > 0
    ? ` Added: ${additions.join(", ")}.`
    : ""}`);
}

function syncGatewayConfig(command: string, options: CliOptions): void {
  const paths = resolvePaths();
  syncGatewayConfigFile(
    paths,
    command === "serve" ? stringOption(options, "config") || paths.gatewayConfig : paths.gatewayConfig,
  );
}

export async function runCli(args: string[]): Promise<void> {
  const { positional, options } = parseArgs(args);
  const command = positional[0];
  if (!command || command === "help" || options.help) {
    usage();
    return;
  }
  if (positional.length > 1 && command !== "log") throw new Error(`Unexpected argument: ${positional[1]}`);
  if (command === "models" && options["restart-codex"] === true && options.sync !== true) {
    throw new Error("--restart-codex requires models --sync");
  }
  if (command === "models" && stringOption(options, "model-merge-json") && options.sync !== true) {
    throw new Error("--model-merge-json requires models --sync");
  }
  if (options["cpa-only"] === true && (command !== "models" || options.sync !== true)) {
    throw new Error("--cpa-only requires models --sync");
  }
  if (options.websocket === true && (command !== "models" || options.sync !== true)) {
    throw new Error("--websocket requires models --sync");
  }
  if (command !== "models"
    && (options.select === true || stringOption(options, "select")?.toLowerCase() === "pass")) {
    throw new Error("--select pass requires models --sync");
  }
  if (command === "log" && !["on", "off"].includes(positional[1] || "")) {
    throw new Error('Usage: codex-cliproxy log on|off');
  }
  if (["start", "stop", "restart", "serve", "models", "log", "status"].includes(command)) {
    syncGatewayConfig(command, options);
  }

  switch (command) {
    case "install":
      await install(options);
      break;
    case "uninstall":
      uninstall();
      break;
    case "start":
    case "stop":
    case "restart":
      await controlGateway(command);
      break;
    case "serve":
      serve(options);
      break;
    case "models":
      await models(options);
      break;
    case "log":
      await logCommand(positional);
      break;
    case "status":
      await status();
      break;
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}
