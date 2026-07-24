import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { resolvePaths } from "./paths.ts";
import {
  patchRootToml,
  restoreRootTomlKeys,
  atomicWrite,
  readRootTomlString,
} from "./toml.ts";
import { saveApiKey, readApiKey, deleteApiKey } from "./keychain.ts";
import { syncCatalog, fetchCliProxyCatalog, invalidateModelsCache } from "./catalog.ts";
import { chooseModels, selectedModelsFromCatalog } from "./models.ts";
import { startGateway } from "./gateway.ts";
import {
  installLaunchAgent,
  uninstallLaunchAgent,
  startLaunchAgent,
  stopLaunchAgent,
  restartLaunchAgent,
  launchAgentStatus,
} from "./launchd.ts";
import type { CliOptions, GatewayConfig, ModelCatalog, ResolvedPaths } from "./types.ts";

const DEFAULTS = {
  host: "127.0.0.1",
  port: 8320,
  mountPath: "/v1",
  prefix: "cliproxy/",
  officialBaseUrl: "https://chatgpt.com/backend-api/codex",
  cliproxyBaseUrl: "http://127.0.0.1:8317/v1",
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

const MANAGED_CONFIG_KEYS = ["openai_base_url", "model_catalog_json"];

function usage() {
  console.log(`codex-cliproxy - Bun gateway for Codex Desktop and CLI

Usage:
  codex-cliproxy install [options]
  codex-cliproxy uninstall
  codex-cliproxy start|stop|restart
  codex-cliproxy serve [--config PATH]
  codex-cliproxy models [--sync] [--select SELECTOR]
  codex-cliproxy status

Install options:
  --cliproxy-url URL   default: ${DEFAULTS.cliproxyBaseUrl}
  --port PORT          default: ${DEFAULTS.port}
  --prefix PREFIX      default: ${DEFAULTS.prefix}
  --official-url URL   default: existing openai_base_url or official Codex
  --key-env NAME       read the API key from this environment variable
  --select SELECTOR     model numbers/ranges, exact IDs, all, or none

Models:
  models                list models currently shown through CLIProxy
  models --sync         fetch CLIProxy models, choose again, and rebuild catalog

Routing:
  cliproxy/*  -> CLIProxyAPI; prefix stripped and auth replaced
  everything else -> official Codex backend; OAuth header preserved
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
    if (["help", "sync"].includes(key)) {
      options[key] = true;
      continue;
    }
    const next = args[i + 1];
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

function getInstallApiKey(keyEnv?: string): string {
  const key = keyEnv ? process.env[keyEnv] : process.env.CLIPROXY_API_KEY;
  const value = key || readSecretFromTerminal();
  if (!value) throw new Error("CLIProxy API key is empty");
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

function gatewayConfig(paths: ResolvedPaths, overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    ...DEFAULTS,
    ...overrides,
    catalogPath: paths.catalogFile,
  };
}

async function install(options: CliOptions): Promise<void> {
  requireMacOS();
  requireBun();
  const paths = resolvePaths();
  if (fs.existsSync(paths.stateFile)) throw new Error("Already installed; run uninstall first");

  const portValue = stringOption(options, "port");
  const port = portValue ? Number(portValue) : DEFAULTS.port;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid port");
  const currentToml = fs.existsSync(paths.configToml) ? fs.readFileSync(paths.configToml, "utf8") : "";
  const existingBaseUrl = readRootTomlString(currentToml, "openai_base_url");
  const config = gatewayConfig(paths, {
    port,
    prefix: stringOption(options, "prefix") || DEFAULTS.prefix,
    officialBaseUrl: (stringOption(options, "official-url") || existingBaseUrl || DEFAULTS.officialBaseUrl).replace(/\/+$/, ""),
    cliproxyBaseUrl: (stringOption(options, "cliproxy-url") || DEFAULTS.cliproxyBaseUrl).replace(/\/+$/, ""),
  });
  const apiKey = getInstallApiKey(stringOption(options, "key-env"));

  const proxyCatalog = await fetchCliProxyCatalog(config.cliproxyBaseUrl, apiKey);
  const availableModels = proxyCatalog.models.map((model) => model.slug);
  console.log(`CLIProxy authentication verified; ${availableModels.length} models found.`);
  const selectedModels = await chooseModels({
    availableModels,
    selector: stringOption(options, "select"),
    requireNonEmpty: true,
  });
  config.selectedModels = selectedModels;
  console.log(`Selected ${selectedModels.length} CLIProxy models.`);

  fs.mkdirSync(paths.runtimeHome, { recursive: true });
  const configBackup = backupConfig(paths.configToml);
  let launchInstalled = false;

  try {
    saveApiKey(apiKey);
    const catalogResult = await syncCatalog({
      codexHome: paths.codexHome,
      catalogFile: paths.catalogFile,
      proxyModels: proxyCatalog.models.filter((model) => selectedModels.includes(model.slug)),
      prefix: config.prefix,
    });
    console.log(`Catalog synced: ${catalogResult.nativeCount} native + ${catalogResult.proxyCount} CLIProxy models.`);
    console.log(`Model cache invalidated: ${catalogResult.cacheFile}`);

    writeJson(paths.gatewayConfig, config);

    const originalToml = currentToml;
    const gatewayBaseUrl = `http://${config.host}:${config.port}${config.mountPath}`;
    const patchedToml = patchRootToml(originalToml, {
      openai_base_url: gatewayBaseUrl,
      model_catalog_json: paths.catalogFile,
    });
    atomicWrite(paths.configToml, patchedToml);

    writeJson(paths.stateFile, {
      version: 2,
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
      stdoutLog: paths.stdoutLog,
      stderrLog: paths.stderrLog,
      plistPath: paths.launchAgent,
    });
    launchInstalled = true;

    await waitForHealth(`http://${config.host}:${config.port}/healthz`);

    console.log(`Installed. Gateway: ${gatewayBaseUrl}`);
    console.log("Codex ChatGPT OAuth was not modified. Fully quit and reopen Codex Desktop.");
  } catch (error) {
    const diagnostics = launchInstalled ? gatewayStartupDiagnostics(paths) : "";
    if (launchInstalled) uninstallLaunchAgent(paths.launchAgent);
    restoreBackup(paths.configToml, configBackup);
    fs.rmSync(paths.catalogFile, { force: true });
    deleteApiKey();
    fs.rmSync(paths.runtimeHome, { recursive: true, force: true });
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
  if (hash(currentToml) === state.installedConfigHash) {
    restoreBackup(paths.configToml, state.configBackup);
  } else {
    const backupToml = fs.readFileSync(state.configBackup.backup, "utf8");
    atomicWrite(paths.configToml, restoreRootTomlKeys(currentToml, backupToml, MANAGED_CONFIG_KEYS));
  }
  fs.rmSync(paths.catalogFile, { force: true });
  deleteApiKey();
  const cache = invalidateModelsCache(paths.codexHome);
  fs.rmSync(paths.runtimeHome, { recursive: true, force: true });

  console.log("Uninstalled. Managed config.toml values were restored; the generated catalog was removed.");
  console.log(`Model cache invalidated: ${cache.cacheFile}`);
  console.log("Codex auth.json was never changed.");
}

function configuredSelectedModels(paths: ResolvedPaths, config: GatewayConfig): string[] {
  if (Array.isArray(config.selectedModels)) return config.selectedModels;
  if (!fs.existsSync(paths.catalogFile)) return [];
  try {
    return selectedModelsFromCatalog(loadJson<ModelCatalog>(paths.catalogFile), config.prefix);
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
    console.log(`  ${config.prefix}${model}`);
  }
}

async function models(options: CliOptions): Promise<void> {
  const paths = resolvePaths();
  if (!fs.existsSync(paths.gatewayConfig)) throw new Error("Gateway is not installed");
  const config = loadJson<GatewayConfig>(paths.gatewayConfig);
  const currentSelection = configuredSelectedModels(paths, config);

  if (options.sync !== true) {
    printCurrentModels(config, currentSelection);
    return;
  }

  const apiKey = readApiKey();
  const proxyCatalog = await fetchCliProxyCatalog(config.cliproxyBaseUrl, apiKey);
  const availableModels = proxyCatalog.models.map((model) => model.slug);
  console.log(`CLIProxy authentication verified; ${availableModels.length} models found.`);
  const selectedModels = await chooseModels({
    availableModels,
    currentSelection,
    selector: stringOption(options, "select"),
    requireNonEmpty: false,
  });

  const result = await syncCatalog({
    codexHome: paths.codexHome,
    catalogFile: paths.catalogFile,
    proxyModels: proxyCatalog.models.filter((model) => selectedModels.includes(model.slug)),
    prefix: config.prefix,
  });
  config.selectedModels = selectedModels;
  writeJson(paths.gatewayConfig, config);

  console.log(`Catalog synced: ${result.nativeCount} native + ${result.proxyCount} selected CLIProxy models.`);
  console.log(`Model cache invalidated: ${result.cacheFile}`);
  printCurrentModels(config, selectedModels);
  console.log("Fully quit and reopen Codex Desktop to reload the startup catalog.");
}

async function status(): Promise<void> {
  const paths = resolvePaths();
  const installed = fs.existsSync(paths.stateFile);
  const service = process.platform === "darwin" ? launchAgentStatus() : null;
  const source = fs.existsSync(paths.configToml) ? fs.readFileSync(paths.configToml, "utf8") : "";
  const configuredBaseUrl = readRootTomlString(source, "openai_base_url");
  const configuredCatalog = readRootTomlString(source, "model_catalog_json");
  let health = "unreachable";
  if (installed) {
    const state = loadJson<InstallState>(paths.stateFile);
    try {
      const response = await fetch(`http://${state.config.host}:${state.config.port}/healthz`);
      if (response.ok) health = "ok";
    } catch {}
  }
  console.log(JSON.stringify({
    installed,
    serviceLoaded: Boolean(service),
    health,
    openaiBaseUrl: configuredBaseUrl,
    modelCatalogJson: configuredCatalog,
    authJsonModified: false,
    modelsCachePresent: fs.existsSync(path.join(paths.codexHome, "models_cache.json")),
  }, null, 2));
}

function serve(options: CliOptions): void {
  requireBun();
  const paths = resolvePaths();
  const configPath = stringOption(options, "config") || paths.gatewayConfig;
  if (!fs.existsSync(configPath)) throw new Error(`Gateway config not found: ${configPath}`);
  startGateway(loadJson<GatewayConfig>(configPath));
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

  if (action === "start") startLaunchAgent(paths.launchAgent);
  else restartLaunchAgent(paths.launchAgent);

  const state = loadJson<InstallState>(paths.stateFile);
  await waitForHealth(`http://${state.config.host}:${state.config.port}/healthz`);
  console.log(`Gateway ${action === "start" ? "started" : "restarted"}.`);
}

export async function runCli(args: string[]): Promise<void> {
  const { positional, options } = parseArgs(args);
  const command = positional[0];
  if (!command || command === "help" || options.help) {
    usage();
    return;
  }
  if (positional.length > 1) throw new Error(`Unexpected argument: ${positional[1]}`);

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
    case "status":
      await status();
      break;
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}
