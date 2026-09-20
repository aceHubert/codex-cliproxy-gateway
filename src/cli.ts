import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import bytes from "bytes";
import {
  GATEWAY_CONFIG_SCHEMA_URL,
  GATEWAY_CONFIG_VERSION,
  gatewayConfigWarnings,
  isJsonObject,
  mergeMissingConfig,
  LEGACY_FIELD_MIGRATIONS,
  migrateLegacyConfig,
} from "./config.ts";
import { realPathOrResolve, resolvePaths, catalogFileFor, managedCatalogFiles, LEGACY_STDERR_LOG } from "./paths.ts";
import {
  patchRootToml,
  restoreRootTomlKeys,
  atomicWrite,
  readRootTomlString,
  hasRootTomlKey,
} from "./toml.ts";
import { saveApiKey, readApiKey, deleteApiKey } from "./keychain.ts";
import { fetchUpstreamCatalog, invalidateModelsCache } from "./catalog.ts";
import { resolveCodexClientVersion } from "./codex-version.ts";
import { chooseModels, selectedModelsFromCatalog } from "./models.ts";
import {
  configuredUpstreamType,
  loadModelOverrideRules,
  newapiCatalogOptions,
  rebuildCatalog,
  upstreamClientVersion,
} from "./upstream-catalog.ts";
import { isLoopbackUrl, startGateway } from "./gateway.ts";
import { ensureUiToken, isLoopbackHost, startWebUiServer, webUiContextForInstance, webUiPort } from "./webui.ts";
import { clearPendingRestart, parseMaxLogSize, parseMaxRequestLogs, sanitizeUrlValue } from "./config-update.ts";
export { parseMaxLogSize, parseMaxRequestLogs } from "./config-update.ts";
import { validateZcodeConfig, zcodeEnabled } from "./zcode/index.ts";
import { codebuddyEnabled, validateCodebuddyConfig } from "./codebuddy/index.ts";
import { loadRealtimeProviderMode } from "./realtime.ts";
import { capGatewayLog, logConfigChange } from "./process-log.ts";
import type { ConfigChange } from "./process-log.ts";
import { stopCodexAppServers } from "./app-server.ts";
import {
  installLaunchAgent,
  uninstallLaunchAgent,
  startLaunchAgent,
  startWebUiLaunchAgent,
  stopLaunchAgent,
  restartLaunchAgent,
  reloadLaunchAgent,
  launchAgentStatus,
} from "./launchd.ts";
import type {
  CliOptions,
  GatewayConfig,
  ModelCatalog,
  ResolvedPaths,
  UpstreamType,
} from "./types.ts";

const DEFAULTS = {
  host: "127.0.0.1",
  port: 8320,
  mountPath: "/v1",
  prefix: "cliproxy/",
  officialBaseUrl: "https://chatgpt.com/backend-api/codex",
  upstreamBaseUrl: "http://127.0.0.1:8317/v1",
  upstreamType: "cliproxy",
  requestLogging: false,
  maxRequestLogs: 0,
  maxGatewayLogBytes: 0,
  upstreamOnly: false,
  zcode: false,
  codebuddy: false,
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
  /** 配置已写入但网关重启未成功；下一次写配置或 models --sync 会再次重启。 */
  pendingRestart?: boolean;
}

const MANAGED_CONFIG_KEYS = [
  "openai_base_url",
  "model_catalog_json",
  "experimental_realtime_ws_base_url",
  "experimental_realtime_webrtc_call_base_url",
];

function usage() {
  console.log(`codex-cliproxy - Bun gateway for Codex Desktop and CLI

Usage:
  codex-cliproxy install [options] [--upstream-only] [--restart-codex]
  codex-cliproxy uninstall [--restart-codex]
  codex-cliproxy start|stop
  codex-cliproxy restart [--restart-codex]
  codex-cliproxy serve [--config PATH]
  codex-cliproxy models [--sync] [--upstream-only] [--select SELECTOR] [--restart-codex]
  codex-cliproxy config [--zcode on|off] [--codebuddy on|off] [--codebuddy-region auto|cn|intl] [--log on|off] [--max-request-logs N] [--max-log-size SIZE]
  codex-cliproxy web
  codex-cliproxy status

Install options:
  --upstream-url URL   third-party upstream URL; default: ${DEFAULTS.upstreamBaseUrl}
                        (--cliproxy-url is a deprecated alias)
  --upstream-type TYPE third-party upstream: cliproxy (default) uses its Codex
                        catalog; newapi synthesizes the catalog from its
                        OpenAI /models list
  --port PORT          default: ${DEFAULTS.port}
  --prefix PREFIX      default: ${DEFAULTS.prefix}
  --official-url URL   default: existing openai_base_url or official Codex
  --key-env NAME       read the API key from this environment variable
                        (default: API_KEY)
  --select SELECTOR     model numbers/ranges, IDs/globs, all, or none
  --upstream-only       use only the third-party upstream's models with their
                        original IDs (--cpa-only is a deprecated alias)
  --model-merge-json URL  GitHub repository or HTTP(S) models.json URL
  --restart-codex       stop Codex app-server after config.toml is updated
  --yes                 update an existing installation in place without asking

  Re-running install when an installation already exists updates it in place
  after confirmation: it merges the new options into config.json, rebuilds the
  catalog, rewrites the managed config.toml keys, and restarts the gateway.
  Refusing leaves the existing installation untouched.

Models:
  models                list models currently shown through CLIProxy
  models --sync         refresh models in dynamic split routing
  models --sync --upstream-only
                        switch to a static upstream-only catalog with original model IDs
  --select SELECTOR     model numbers/ranges, IDs/globs, all, or none
  --model-merge-json URL  update the cached models.json override
  --restart-codex       stop Codex app-server after sync to refresh the model picker;
                        active tasks may error and require recovery or reopening

Config:
  config                print the current gateway settings
  config --zcode on|off toggle ZCode Responses-to-Anthropic compatibility
  config --codebuddy on|off
                        toggle CodeBuddy/WorkBuddy Responses compatibility
  config --codebuddy-region auto|cn|intl
                        prefer CodeBuddy credentials from a region; auto uses
                        the most recently refreshed login
  config --log on|off   toggle request logging
  config --max-request-logs N
                        max request log files kept across the directory; 0 (default) means unlimited
  config --max-log-size SIZE
                        size cap for the gateway.log process log (stdout, stderr,
                        config audit, and per-request summaries; e.g. 512KB,
                        10MB, or 1M); overflow copies to gateway-<timestamp>.log
                        (5 newest backups kept) and truncates the live file in
                        place; 0 (default) means unlimited
  options may be combined; every change restarts the gateway automatically

Routing:
  cliproxy/*  -> CLIProxyAPI; prefix stripped and auth replaced
  everything else -> official Codex backend; OAuth header preserved
  --upstream-only -> every model uses the upstream with its original ID
  --upstream-type newapi -> same routing, but the upstream is an OpenAI-compatible
  new-api gateway whose catalog is synthesized locally at models --sync
  CPA Responses WebSocket is always bridged to CLIProxy; the upstream decides
  per request whether to accept it or fall back to HTTP/SSE.

Web UI:
  web [--start]       run the web ui in the foreground (default): check the
                      gateway (start it if needed), serve the ui on its own
                      port (gateway port + 1), and open the browser;
                      Ctrl-C stops the ui
  web --daemon        start the web ui in the background via launchd, then
                      open the browser and return to the shell
  web [--status | --stop | --restart]
                      inspect, stop, or restart the background ui service
                      only (the gateway is never touched)
  access is loopback-only and token-gated; stopping/uninstalling the gateway also
  stops the web ui
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
    if (["help", "sync", "upstream-only", "cpa-only", "restart-codex", "yes", "start", "daemon", "status", "stop", "restart"].includes(key)) {
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
  const script = 'read -r -s -p "Upstream API key: " key; printf "\\n%s" "$key"';
  return execFileSync("/bin/bash", ["-c", script], {
    encoding: "utf8",
    stdio: ["inherit", "pipe", "inherit"],
  }).trim();
}

/**
 * 已存在安装时原地更新的确认提示：读一行 stdin，y/Y 开头视为同意。
 * EOF、读失败或其余输入一律视为拒绝，绝不静默覆盖现有安装。
 */
function confirmInstallOverwrite(): boolean {
  console.log("An existing installation was found. Install will update its configuration");
  console.log("in place (config, catalog, managed config.toml keys) and restart the gateway.");
  process.stdout.write("Continue? [y/N] ");
  const buffer = Buffer.alloc(256);
  let bytes = 0;
  try {
    while (bytes < buffer.length) {
      const read = fs.readSync(0, buffer, bytes, buffer.length - bytes, null);
      if (read <= 0) break; // EOF / stdin 不可用
      bytes += read;
      if (buffer.subarray(0, bytes).includes(0x0a)) break;
    }
  } catch {
    bytes = 0; // 非 TTY 读失败按拒绝处理
  }
  return /^y/i.test(buffer.subarray(0, bytes).toString("utf8").trim());
}

function stringOption(options: CliOptions, key: string): string | undefined {
  const value = options[key];
  return typeof value === "string" ? value : undefined;
}

/** --upstream-only 开关（旧别名 --cpa-only 仍接受）。 */
function upstreamOnlyOption(options: CliOptions): boolean {
  return options["upstream-only"] === true || options["cpa-only"] === true;
}

/** --upstream-type 取值校验：非法值直接报错，避免拼写错误被静默当作 cliproxy。 */
export function parseUpstreamTypeOption(value: string | undefined): UpstreamType | undefined {
  if (value === undefined) return undefined;
  if (value !== "cliproxy" && value !== "newapi") {
    throw new Error(`--upstream-type expects cliproxy or newapi, got "${value}"`);
  }
  return value;
}

function upstreamLabel(config: GatewayConfig): string {
  return configuredUpstreamType(config) === "newapi" ? "new-api" : "CLIProxy";
}

/** 显式空选择：必须在读取上游目录前识别，避免为了清空选择而访问上游。 */
function isSelectNone(selector: string | undefined): boolean {
  return selector?.trim().toLowerCase() === "none";
}

function getInstallApiKey(baseUrl: string, keyEnv?: string): string {
  const envName = keyEnv || "API_KEY";
  const value = (Object.hasOwn(process.env, envName)
    ? process.env[envName] || ""
    : readSecretFromTerminal()).trim();
  if (!value && !isLoopbackUrl(baseUrl)) {
    throw new Error("Upstream API key may be empty only for a loopback URL");
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
  // 历史字段更名（见 LEGACY_FIELD_MIGRATIONS）在此补齐为新键；文件级迁移见 syncGatewayConfigFile。
  migrateLegacyConfig(value);
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
    ...managedCatalogFiles(paths),
    path.join(paths.runtimeHome, "catalog-metadata.json"),
    paths.modelMergeFile,
    paths.stdoutLog,
    path.join(paths.runtimeHome, "webui.log"),
    // 旧安装的独立 stderr 日志：现已合并进 gateway.log，卸载时一并清掉残留。
    path.join(paths.runtimeHome, LEGACY_STDERR_LOG),
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

  // 进程日志只剩 gateway.log（stdout 与 stderr 合并），启动失败时它的尾部就是诊断入口；
  // 这里不再单独读 stderr 文件，避免展示旧安装残留的过期内容。
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
  upstreamOnly: boolean,
): void {
  config.upstreamOnly = upstreamOnly;
  config.catalogPath = catalogFileFor(paths, configuredUpstreamType(config));
}

/** 审计只跟踪这些字段；其余键（如 $schema、configVersion）不属于用户可见配置。 */
const AUDITED_FIELDS = [
  "zcode",
  "codebuddy",
  "codebuddyRegion",
  "upstreamOnly",
  "requestLogging",
  "logDir",
  "maxRequestLogs",
  "maxGatewayLogBytes",
  "port",
  "prefix",
  "officialBaseUrl",
  "upstreamBaseUrl",
  "upstreamType",
  "catalogPath",
  "model_merge_json",
  "selectedModels",
] as const;

function diffConfig(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): ConfigChange[] {
  return AUDITED_FIELDS.flatMap((field) =>
    JSON.stringify(before[field] ?? null) === JSON.stringify(after[field] ?? null)
      ? []
      : [{ field, before: before[field] ?? null, after: after[field] ?? null }]);
}

/** 审计写入网关进程日志 gateway.log，单文件追加，不依赖 requestLogging 与 maxRequestLogs。 */
function recordConfigAudit(
  command: string,
  config: GatewayConfig,
  before: Record<string, unknown>,
  paths: ResolvedPaths,
  extraChanges: ConfigChange[] = [],
): void {
  const changes = [...diffConfig(before, config as unknown as Record<string, unknown>), ...extraChanges]
    .map((change) => ({
      field: change.field,
      before: sanitizeUrlValue(change.before),
      after: sanitizeUrlValue(change.after),
    }));
  logConfigChange(paths.stdoutLog, { command, changes }, config.maxGatewayLogBytes ?? 0);
}

/**
 * config.toml 的 model_catalog_json 增删：upstream-only 指向当前上游的目录文件，split 模式移除。
 * models --sync 共用，含非受管值守卫；任何受管目录文件（含其他上游类型的）都允许改写指向。
 */
export function applyModelCatalogToml(
  source: string,
  upstreamOnly: boolean,
  paths: ResolvedPaths,
  catalogFile: string,
): { patchedToml: string; previousCatalog: string | null } {
  const configuredCatalog = readRootTomlString(source, "model_catalog_json");
  const legacyCatalogFile = path.join(paths.codexHome, "cliproxy-catalog.json");
  if (configuredCatalog && ![...managedCatalogFiles(paths), legacyCatalogFile].includes(configuredCatalog)) {
    throw new Error(`Refusing to replace unmanaged model_catalog_json: ${configuredCatalog}`);
  }
  // 键存在但值不可解析（多行字符串等写法）时显式拒绝，绝不当作缺失后覆盖或删除。
  if (configuredCatalog === undefined && hasRootTomlKey(source, "model_catalog_json")) {
    throw new Error("model_catalog_json exists but its value cannot be parsed; fix ~/.codex/config.toml manually");
  }
  const patchedToml = upstreamOnly
    ? patchRootToml(source, { model_catalog_json: catalogFile })
    : restoreRootTomlKeys(source, "", ["model_catalog_json"]);
  return { patchedToml, previousCatalog: configuredCatalog ?? null };
}

/** 重启网关并在 state.json 留 pendingRestart 标记：失败后重跑同一命令会自动重试。 */
async function restartGatewayOnce(paths: ResolvedPaths, config: GatewayConfig): Promise<void> {
  const markPending = (pending: boolean): void => {
    if (!fs.existsSync(paths.stateFile)) return;
    const state = loadJson<InstallState>(paths.stateFile);
    state.pendingRestart = pending;
    writeJson(paths.stateFile, state);
  };
  markPending(true);
  try {
    restartLaunchAgent(paths.launchAgent);
    await waitForHealth(`http://${config.host}:${config.port}/healthz`);
  } catch (error) {
    // 标记保留：重跑同一命令或 codex-cliproxy restart 都会补上这次重启。
    throw error;
  }
  markPending(false);
}

/** 上次配置写入后重启未成功时，先补一次重启再继续当前操作。 */
async function retryPendingRestart(paths: ResolvedPaths, config: GatewayConfig): Promise<void> {
  if (!fs.existsSync(paths.stateFile) || !fs.existsSync(paths.launchAgent)) return;
  const state = loadJson<InstallState>(paths.stateFile);
  if (state.pendingRestart !== true) return;
  await restartGatewayOnce(paths, config);
  console.log("Gateway restarted to apply previously saved configuration.");
}

/** config.toml 变更后可选停止旧 app-server，由 Codex 自行拉起新进程重读配置。 */
async function refreshCodexAppServer(): Promise<void> {
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

/**
 * 回滚后应探测的 healthz 地址：已回写旧配置时用恢复后的 host/port，
 * 否则磁盘上仍是新配置，沿用候选 host/port。
 */
export function restoredHealthUrl(
  previous: Record<string, unknown> | undefined,
  next: { host: string; port: number },
): string {
  const host = typeof previous?.host === "string" && previous.host ? previous.host : next.host;
  const rawPort = previous?.port;
  const port = typeof rawPort === "number" && Number.isInteger(rawPort) && rawPort > 0
    ? rawPort
    : next.port;
  return `http://${host}:${port}/healthz`;
}

/** 安装失败的最终错误：原始错误为主，diagnostics 与 LaunchAgent 恢复问题只附加。 */
export function composeInstallFailureMessage(
  message: string,
  options: { diagnostics?: string; restoreIssues?: string[] } = {},
): string {
  const parts = [message];
  if (options.diagnostics) parts.push(options.diagnostics);
  if (options.restoreIssues && options.restoreIssues.length > 0) {
    parts.push(`launch agent restore incomplete: ${options.restoreIssues.join("; ")}`);
  }
  return parts.join("; ");
}

async function install(options: CliOptions): Promise<void> {
  requireMacOS();
  requireBun();
  const upstreamOnly = upstreamOnlyOption(options);
  const paths = resolvePaths();
  const switching = fs.existsSync(paths.stateFile);

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
  const upstreamUrl = stringOption(options, "upstream-url") ?? stringOption(options, "cliproxy-url");
  if (upstreamUrl) overrides.upstreamBaseUrl = upstreamUrl.replace(/\/+$/, "");
  const upstreamType = parseUpstreamTypeOption(stringOption(options, "upstream-type"));
  if (upstreamType) overrides.upstreamType = upstreamType;
  if (modelMergeJson) overrides.model_merge_json = modelMergeJson;
  // 已存在安装：确认（或 --yes）后原地更新；拒绝则不改动任何文件。
  if (switching && options.yes !== true) {
    if (!process.stdin.isTTY) {
      console.log("An installation already exists; rerun with --yes to update it in place.");
      return;
    }
    const changes = [
      upstreamUrl ? `upstream ${upstreamUrl}` : null,
      upstreamType ? `type ${upstreamType}` : null,
      port !== undefined ? `port ${port}` : null,
    ].filter(Boolean).join(", ");
    if (changes) console.log(`Will change: ${changes}.`);
    if (!confirmInstallOverwrite()) {
      console.log("Install aborted; the existing installation was left unchanged.");
      return;
    }
  }
  const { config } = mergedGatewayConfig(
    paths,
    currentGatewayConfig,
    overrides,
    (existingBaseUrl || DEFAULTS.officialBaseUrl).replace(/\/+$/, ""),
  );
  config.configVersion = GATEWAY_CONFIG_VERSION;
  applyRoutingMode(config, paths, upstreamOnly);
  const installSelector = stringOption(options, "select");
  // 先保留原有的受管 model_catalog_json 守卫；真正是否写入要等选择结果确定。
  applyModelCatalogToml(
    currentToml,
    upstreamOnly && !isSelectNone(installSelector),
    paths,
    config.catalogPath,
  );
  const apiKey = getInstallApiKey(config.upstreamBaseUrl, stringOption(options, "key-env"));
  const { modelsConfigFile, rules } = await loadModelOverrideRules(paths, config, Boolean(modelMergeJson));

  // 目录文件按上游类型分开；原地更新时若该类型的目录已存在且用户未显式要求重选
  // （--select / --model-merge-json），则复用现有目录，只校验密钥、改配置并重启。
  const explicitSelect = stringOption(options, "select") !== undefined;
  const reuseCatalog = switching
    && !explicitSelect
    && !Boolean(modelMergeJson)
    && fs.existsSync(config.catalogPath);

  let selectedModels: string[];
  const selectNone = isSelectNone(installSelector);
  const proxyCatalog: ModelCatalog = selectNone
    ? { models: [] }
    : await fetchUpstreamCatalog(
      config.upstreamBaseUrl,
      apiKey,
      configuredUpstreamType(config),
      upstreamClientVersion(paths, configuredUpstreamType(config)),
      newapiCatalogOptions(configuredUpstreamType(config), rules),
    );
  if (selectNone) {
    selectedModels = [];
    console.log(`${upstreamLabel(config)} model catalog fetch skipped by --select none.`);
  } else {
    console.log(`${upstreamLabel(config)} authentication verified; ${proxyCatalog.models.length} models found.`);
    selectedModels = reuseCatalog
      ? configuredSelectedModels(paths, config)
      : await chooseModels({
        availableModels: proxyCatalog.models,
        currentSelection: Array.isArray(config.selectedModels) ? config.selectedModels : undefined,
        selector: stringOption(options, "select"),
        requireNonEmpty: upstreamOnly,
      });
  }
  if (!selectNone && reuseCatalog) {
    console.log(`Reusing the existing ${upstreamLabel(config)} catalog; model selection unchanged.`);
  } else if (!selectNone) {
    console.log(`Selected ${selectedModels.length} ${upstreamLabel(config)} models.`);
  }
  config.selectedModels = selectedModels;
  const { patchedToml: modelCatalogToml } = applyModelCatalogToml(
    currentToml,
    upstreamOnly && selectedModels.length > 0,
    paths,
    config.catalogPath,
  );

  // 切换模式不动纯净备份；旧密钥/旧 state 先留底，失败时恢复。
  const previousState = switching ? fs.readFileSync(paths.stateFile, "utf8") : undefined;
  const previousApiKey = switching ? readApiKey(true) : undefined;
  const configBackup = switching ? undefined : backupConfig(paths.configToml);
  let launchInstalled = false;
  // LaunchAgent 的恢复责任从开始替换 plist 时即成立：installLaunchAgent 内部会先覆盖
  // plist 并 bootout 原服务，若 bootstrap/kickstart 抛错，launchInstalled 尚未置位，
  // 但旧 plist 已被覆盖、原服务已停止——先留底原内容与加载态，失败时回写并拉回服务。
  const previousPlist = fs.existsSync(paths.launchAgent) ? fs.readFileSync(paths.launchAgent, "utf8") : undefined;
  const previousServiceLoaded = previousPlist !== undefined && launchAgentStatus() !== null;
  let launchTouched = false;
  let tomlUnchanged = false;

  try {
    if (apiKey) saveApiKey(apiKey);
    else deleteApiKey();
    if (reuseCatalog) {
      console.log("Existing catalog reused; skipping rebuild.");
    } else {
      const catalogResult = await rebuildCatalog(
        paths,
        config,
        proxyCatalog.models.filter((model) => selectedModels.includes(model.slug)),
        modelsConfigFile,
      );
      console.log(upstreamOnly
        ? `Upstream-only catalog synced: ${catalogResult.proxyCount} models.`
        : `Dynamic CLIProxy overlay synced: ${catalogResult.proxyCount} models.`);
    }

    writeGatewayConfig(paths.gatewayConfig, config);

    const gatewayBaseUrl = `http://${config.host}:${config.port}${config.mountPath}`;
    const patchedToml = managedCodexServiceToml(modelCatalogToml, gatewayBaseUrl);
    // 网关 host/port/mount 与 upstreamOnly 未变时 config.toml 的受管键已指向本网关，
    // 无需重写（patchRootToml 对相同值产物一致，可用字符串相等判断）。
    tomlUnchanged = patchedToml === currentToml;
    if (!tomlUnchanged) atomicWrite(paths.configToml, patchedToml);

    if (switching) {
      // 保留首次安装的纯净备份：只有实际重写了 config.toml 且其未被手改过才推进 hash，
      // 保证后续 uninstall 的整文件还原语义不变（与 models --sync 一致）。
      const state = loadJson<InstallState>(paths.stateFile);
      state.version = 4;
      state.gatewayBaseUrl = gatewayBaseUrl;
      state.config = config;
      if (!tomlUnchanged && hash(currentToml) === state.installedConfigHash) {
        state.installedConfigHash = hash(patchedToml);
      }
      writeJson(paths.stateFile, state);
    } else {
      writeJson(paths.stateFile, {
        version: 4,
        installedAt: new Date().toISOString(),
        configBackup: configBackup!,
        installedConfigHash: hash(patchedToml),
        gatewayBaseUrl,
        config,
      });
    }

    const cliPath = fs.realpathSync(process.argv[1]);
    launchTouched = true;
    installLaunchAgent({
      bunPath: process.execPath,
      cliPath,
      configPath: paths.gatewayConfig,
      codexHome: paths.codexHome,
      logPath: paths.stdoutLog,
      plistPath: paths.launchAgent,
    });
    launchInstalled = true;

    await waitForHealth(`http://${config.host}:${config.port}/healthz`);
    if (!upstreamOnly) invalidateModelsCache(paths.modelsCacheFile);
    recordConfigAudit(switching ? "install (in-place)" : "install", config, currentGatewayConfig, paths);

  } catch (error) {
    const diagnostics = launchInstalled ? gatewayStartupDiagnostics(paths) : "";
    const restoreIssues: string[] = [];
    if (switching) {
      // 原地更新失败：把 config.toml/config.json/密钥/state/LaunchAgent 全部恢复到尝试前
      // 内容；服务在本阶段未被重启，若启动过则尽力用恢复后的配置拉回。
      if (!tomlUnchanged) atomicWrite(paths.configToml, currentToml);
      if (previousApiKey) saveApiKey(previousApiKey);
      else deleteApiKey();
      if (previousGatewayConfig !== undefined) atomicWrite(paths.gatewayConfig, previousGatewayConfig);
      if (previousState !== undefined) atomicWrite(paths.stateFile, previousState);
      if (launchTouched) {
        try {
          if (previousPlist !== undefined) {
            atomicWrite(paths.launchAgent, previousPlist, 0o644);
            // launchd 里已加载的是新任务定义：kickstart 只会按它重启，必须
            // bootout + bootstrap 才能让恢复到磁盘的旧 plist 重新生效；旧任务
            // 本就未加载时只需卸载新任务，回到安装前的未加载状态。
            if (previousServiceLoaded) reloadLaunchAgent(paths.launchAgent);
            else stopLaunchAgent(paths.launchAgent);
          } else {
            restartLaunchAgent(paths.launchAgent);
          }
        } catch (restoreError) {
          restoreIssues.push(restoreError instanceof Error ? restoreError.message : String(restoreError));
        }
        try {
          // 已回写旧配置时探测恢复后的 host/port；未回写则磁盘上仍是新配置。
          await waitForHealth(restoredHealthUrl(
            previousGatewayConfig !== undefined ? currentGatewayConfig : undefined,
            config,
          ));
        } catch (healthError) {
          restoreIssues.push(healthError instanceof Error ? healthError.message : String(healthError));
        }
      }
    } else {
      if (launchTouched) {
        if (previousPlist !== undefined) {
          atomicWrite(paths.launchAgent, previousPlist, 0o644);
          // 安装尝试已 bootout 原服务：若它之前处于加载态，按旧 plist 重新加载拉回；
          // 本就未加载的残留 plist 只恢复文件并卸载新任务，不凭空拉起服务。
          if (previousServiceLoaded) reloadLaunchAgent(paths.launchAgent);
          else stopLaunchAgent(paths.launchAgent);
        } else {
          uninstallLaunchAgent(paths.launchAgent);
        }
      }
      restoreBackup(paths.configToml, configBackup!);
      deleteApiKey();
      removeManagedRuntimeFiles(paths);
      if (previousGatewayConfig !== undefined) atomicWrite(paths.gatewayConfig, previousGatewayConfig);
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(composeInstallFailureMessage(message, { diagnostics, restoreIssues }));
  }

  if (switching) {
    console.log(`Installation updated in place. Gateway: http://${config.host}:${config.port}${config.mountPath}`);
  } else {
    console.log(`Installed. Gateway: http://${config.host}:${config.port}${config.mountPath}`);
  }
  console.log("Codex ChatGPT OAuth was not modified.");
  if (options["restart-codex"] === true) await refreshCodexAppServer();
  else if (upstreamOnly) console.log("Upstream-only catalog configured; fully quit and reopen Codex Desktop, or reinstall with --restart-codex.");
  else console.log("Fully quit and reopen Codex Desktop, or reinstall with --restart-codex.");
}

async function uninstall(options: CliOptions): Promise<void> {
  requireMacOS();
  const paths = resolvePaths();
  if (!fs.existsSync(paths.stateFile)) throw new Error("No managed installation found");
  const state = loadJson<InstallState>(paths.stateFile);

  uninstallLaunchAgent(paths.launchAgent);
  // Web UI 是独立 LaunchAgent：卸载时一并回收其任务与 plist（未安装时静默忽略）。
  uninstallLaunchAgent(paths.webUiLaunchAgent);
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
  if (options["restart-codex"] === true) await refreshCodexAppServer();
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
    console.log(`  ${config.upstreamOnly === true ? "" : config.prefix}${model}`);
  }
}

async function models(options: CliOptions): Promise<void> {
  const restartCodex = options["restart-codex"] === true;
  // 模式由 flag 显式选择：带 --upstream-only（旧别名 --cpa-only）即 upstream-only，不带即 split 动态目录。
  const upstreamOnly = upstreamOnlyOption(options);
  const selector = stringOption(options, "select");
  const modelMergeJson = stringOption(options, "model-merge-json");
  const paths = resolvePaths();
  if (!fs.existsSync(paths.gatewayConfig)) throw new Error("Gateway is not installed");
  const config = loadGatewayConfig(paths.gatewayConfig);
  const auditBefore: Record<string, unknown> = { ...config } as unknown as Record<string, unknown>;
  const previousCpaOnly = config.upstreamOnly === true;
  const previousCatalogPath = config.catalogPath;
  if (modelMergeJson) config.model_merge_json = modelMergeJson;
  const currentSelection = configuredSelectedModels(paths, config);

  if (options.sync !== true) {
    printCurrentModels(config, currentSelection);
    return;
  }

  applyRoutingMode(config, paths, upstreamOnly);
  const source = fs.existsSync(paths.configToml) ? fs.readFileSync(paths.configToml, "utf8") : "";
  const legacyCatalogFile = path.join(paths.codexHome, "cliproxy-catalog.json");
  // 同步前先拒绝非受管 model_catalog_json，避免后续模型覆盖文件下载产生半更新。
  applyModelCatalogToml(source, upstreamOnly && !isSelectNone(selector), paths, config.catalogPath);
  const { modelsConfigFile, rules } = await loadModelOverrideRules(paths, config, Boolean(modelMergeJson));
  const selectNone = isSelectNone(selector);
  const proxyCatalog: ModelCatalog = selectNone
    ? { models: [] }
    : await fetchUpstreamCatalog(
      config.upstreamBaseUrl,
      readApiKey(isLoopbackUrl(config.upstreamBaseUrl)),
      configuredUpstreamType(config),
      upstreamClientVersion(paths, configuredUpstreamType(config)),
      newapiCatalogOptions(configuredUpstreamType(config), rules),
    );
  let selectedModels: string[];
  if (selectNone) {
    selectedModels = [];
    console.log(`${upstreamLabel(config)} model catalog fetch skipped by --select none.`);
  } else {
    console.log(`${upstreamLabel(config)} authentication verified; ${proxyCatalog.models.length} models found.`);
    selectedModels = await chooseModels({
      availableModels: proxyCatalog.models,
      currentSelection,
      selector,
      requireNonEmpty: upstreamOnly,
    });
  }
  const { patchedToml, previousCatalog } = applyModelCatalogToml(
    source,
    upstreamOnly && selectedModels.length > 0,
    paths,
    config.catalogPath,
  );

  const selectedProxyModels = proxyCatalog.models.filter((model) => selectedModels.includes(model.slug));
  const result = await rebuildCatalog(
    paths,
    config,
    selectedProxyModels,
    modelsConfigFile,
  );
  config.selectedModels = selectedModels;
  writeGatewayConfig(paths.gatewayConfig, config);

  if (patchedToml !== source) atomicWrite(paths.configToml, patchedToml);
  if (previousCatalog === legacyCatalogFile) fs.rmSync(legacyCatalogFile, { force: true });
  if (fs.existsSync(paths.stateFile)) {
    const state = loadJson<InstallState>(paths.stateFile);
    state.version = 4;
    state.config = config;
    if (hash(source) === state.installedConfigHash) state.installedConfigHash = hash(patchedToml);
    writeJson(paths.stateFile, state);
  }
  recordConfigAudit("models --sync", config, auditBefore, paths, patchedToml === source ? [] : [{
    field: "model_catalog_json (config.toml)",
    before: previousCatalog,
    after: upstreamOnly && selectedModels.length > 0 ? config.catalogPath : null,
  }]);
  if (!upstreamOnly) invalidateModelsCache(paths.modelsCacheFile);

  const routingChanged = previousCpaOnly !== upstreamOnly
    || previousCatalogPath !== config.catalogPath;
  if (routingChanged && fs.existsSync(paths.launchAgent)) {
    await restartGatewayOnce(paths, config);
    console.log("Gateway restarted to apply the routing mode.");
  } else {
    await retryPendingRestart(paths, config);
  }

  if (upstreamOnly) {
    console.log(`Upstream-only catalog synced: ${result.proxyCount} selected models.`);
  } else {
    console.log(`CPA catalog synced for dynamic split routing: ${result.proxyCount} selected models.`);
  }
  printCurrentModels(config, selectedModels);
  if (!restartCodex) {
    if (upstreamOnly) {
      console.log("Upstream-only catalog configured; restart Codex to load it, or rerun with --restart-codex.");
    } else if (previousCatalog !== null) {
      console.log("Dynamic split routing configured; restart Codex to leave upstream-only mode, or rerun with --restart-codex.");
    } else {
      console.log("Dynamic catalog synced; Codex refreshes /models periodically, but the current model picker may require --restart-codex.");
    }
    return;
  }

  await refreshCodexAppServer();
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
    upstreamOnly: config?.upstreamOnly === true,
    upstreamType: config?.upstreamType ?? "cliproxy",
    codexClientVersion: resolveCodexClientVersion(paths.upstreamModelsCacheFile),
  }, null, 2));
}

function serve(options: CliOptions): void {
  requireBun();
  const paths = resolvePaths();
  // 真实路径比较：软链到默认 config.json 时仍按生产实例写日志、清 pendingRestart。
  const configPath = realPathOrResolve(stringOption(options, "config") || paths.gatewayConfig);
  if (!fs.existsSync(configPath)) throw new Error(`Gateway config not found: ${configPath}`);
  const config = loadGatewayConfig(configPath);
  const isProductionInstance = configPath === realPathOrResolve(paths.gatewayConfig);
  // 只有默认配置对应的生产实例才写 gateway.log：--config 的临时实例输出留在终端，
  // 不碰生产进程日志（也不会把临时实例的请求摘要混进去）。
  const processLog = isProductionInstance
    ? { file: paths.stdoutLog, maxBytes: config.maxGatewayLogBytes ?? 0 }
    : undefined;
  startGateway(
    config,
    loadRealtimeProviderMode(paths.configToml),
    paths.upstreamModelsCacheFile,
    { codexModelsCacheFile: paths.modelsCacheFile },
    processLog,
    { codexModelsCacheFile: paths.modelsCacheFile },
  );
  // 本进程已带着当前配置启动：此前置位的 pendingRestart 已完成使命，清掉它，
  // 避免下一次命令被误补一次重启；临时实例不动生产 state。
  if (isProductionInstance) clearPendingRestart(paths.stateFile);
  // 启动横幅、stderr、配置审计与请求摘要都追加进同一个 gateway.log，启动时检查一次大小，
  // 超限备份并原地清空（copy-truncate，launchd 持有的 fd 不受影响）；运行期每次写入
  // 请求摘要时还会再按同一上限判断一次。
  if (processLog) capGatewayLog(processLog.file, processLog.maxBytes);
}

/** 探测 UI 端口是否已有 Web UI 在服务（端口不通视为未运行；有响应且 ok 才算我们的 UI）。 */
async function fetchWebUi(port: number): Promise<Response | undefined> {
  try {
    return await fetch(`http://127.0.0.1:${port}/ui`, { signal: AbortSignal.timeout(1_000) });
  } catch {
    return undefined;
  }
}

async function isWebUiRunning(port: number): Promise<boolean> {
  const response = await fetchWebUi(port);
  return response !== undefined && response.ok;
}

async function waitForWebUi(port: number, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isWebUiRunning(port)) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Web UI did not come up on port ${port} within ${timeoutMs / 1000}s`);
}

/** Web UI 进程日志：LaunchAgent 的 stdout/stderr 都指向它，体量极小。 */
function webUiLogPath(paths: ResolvedPaths): string {
  return path.join(paths.runtimeHome, "webui.log");
}

/**
 * 前台运行 Web UI 服务：`web` 的后台服务模式与用户面前台启动共用。
 * launchd 停止（bootout）与手动 Ctrl-C 都以 SIGTERM/SIGINT
 * 到达：关停监听后干净退出。openBrowser 为真时打印带令牌的地址并用系统浏览器打开
 * （LaunchAgent 场景为假，避免后台进程拉起浏览器）。
 */
function runWebUiForeground(paths: ResolvedPaths, config: GatewayConfig, openBrowser: boolean): void {
  const ctx = webUiContextForInstance(paths.gatewayConfig, paths);
  const server = startWebUiServer(config, ctx);
  if (!server) throw new Error("Web UI requires a loopback gateway host");
  const shutdown = (): void => {
    server.stop(true);
    process.exit(0);
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  console.log(`web ui listening on ${server.url}ui`);
  if (openBrowser) {
    const url = `http://127.0.0.1:${webUiPort(config)}/ui?token=${encodeURIComponent(ensureUiToken(paths.uiTokenFile))}`;
    console.log(url);
    execFileSync("/usr/bin/open", [url], { stdio: "ignore" });
  }
}

/** 检查网关（未运行则启动）并等待 healthz 就绪；web 命令默认路径的第一步。 */
async function ensureGatewayRunning(paths: ResolvedPaths, config: GatewayConfig): Promise<void> {
  const base = `http://${config.host}:${config.port}`;
  try {
    const response = await fetch(`${base}/healthz`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  } catch {
    startLaunchAgent(paths.launchAgent);
    await waitForHealth(`${base}/healthz`);
    console.log("Gateway started.");
  }
}

/** 经 LaunchAgent 拉起（或重启后拉起）Web UI，并等待端口就绪。 */
async function startWebUiService(paths: ResolvedPaths, config: GatewayConfig): Promise<void> {
  startWebUiLaunchAgent(paths.webUiLaunchAgent, {
    bunPath: process.execPath,
    cliPath: fs.realpathSync(process.argv[1]),
    codexHome: paths.codexHome,
    logPath: webUiLogPath(paths),
  });
  await waitForWebUi(webUiPort(config));
}

/**
 * web 命令：默认（及 `--start`）前台启动——检查网关（未运行则启动）后在前台运行
 * UI 服务并打开浏览器，Ctrl-C 停止；`--daemon` 后台启动——经 LaunchAgent 拉起后打开
 * 浏览器，终端立即释放。dev:ui（CODEX_CLIPROXY_UI_DEV=1）复用本命令启动 UI API，
 * 但 Vite 还要接着占用终端，因此始终走后台路径。
 * 子选项只作用于 UI 服务本身，不动网关：`--status` 查看运行状态，`--stop` 停止，
 * `--restart` 先停再起。
 */
async function webCommand(options: CliOptions): Promise<void> {
  // 模式互斥校验先于平台/安装检查：参数拼错的反馈与运行环境无关。
  const modes = ["start", "daemon", "status", "stop", "restart"].filter((flag) => options[flag] === true);
  if (modes.length > 1) {
    throw new Error(`--${modes[0]} and --${modes[1]} cannot be combined; pick one`);
  }
  // LaunchAgent 复用 web 入口：只运行服务，避免递归后台启动、触碰网关或打开浏览器。
  if (process.env.CODEX_CLIPROXY_UI_SERVICE === "1") {
    requireBun();
    const paths = resolvePaths();
    if (!fs.existsSync(paths.gatewayConfig)) {
      throw new Error(`Gateway config not found: ${paths.gatewayConfig}`);
    }
    const config = loadGatewayConfig(paths.gatewayConfig);
    if (!isLoopbackHost(config.host)) {
      throw new Error(`Web UI requires a loopback gateway host, got ${config.host}`);
    }
    runWebUiForeground(paths, config, false);
    return;
  }
  requireMacOS();
  const paths = resolvePaths();
  if (!fs.existsSync(paths.stateFile)) throw new Error("Gateway is not installed");
  const config = loadGatewayConfig(paths.gatewayConfig);
  if (!isLoopbackHost(config.host)) {
    throw new Error(`Web UI requires a loopback gateway host, got ${config.host}`);
  }
  const uiPort = webUiPort(config);

  if (options.status === true) {
    if (await isWebUiRunning(uiPort)) {
      console.log(`Web UI is running at http://127.0.0.1:${uiPort}/ui`);
    } else {
      console.log("Web UI is not running");
      console.log("Start and open it with: codex-cliproxy web --daemon");
    }
    return;
  }
  if (options.stop === true) {
    stopLaunchAgent(paths.webUiLaunchAgent);
    console.log("Web UI stopped.");
    return;
  }
  if (options.restart === true) {
    stopLaunchAgent(paths.webUiLaunchAgent);
    await startWebUiService(paths, config);
    console.log(`Web UI restarted at http://127.0.0.1:${uiPort}/ui`);
    return;
  }

  await ensureGatewayRunning(paths, config);
  const devMode = process.env.CODEX_CLIPROXY_UI_DEV === "1";
  // dev:ui 需要命令返回让 Vite 接管终端，一律走 LaunchAgent 后台路径。
  if (options.daemon === true || devMode) {
    if (!(await isWebUiRunning(uiPort))) {
      await startWebUiService(paths, config);
      console.log("Web UI started.");
    }
    if (devMode) {
      console.log(`Web UI API is ready at http://127.0.0.1:${uiPort}/ui/api`);
      return;
    }
  } else {
    // 前台启动：端口已被后台服务占用时 Bun.serve 会抛晦涩的端口冲突，先给出可执行的修复方式。
    if (await isWebUiRunning(uiPort)) {
      throw new Error(
        `Web UI is already running on port ${uiPort}; stop it first with: codex-cliproxy web --stop`,
      );
    }
    runWebUiForeground(paths, config, true);
    return;
  }
  const url = `http://127.0.0.1:${uiPort}/ui?token=${encodeURIComponent(ensureUiToken(paths.uiTokenFile))}`;
  console.log(url);
  execFileSync("/usr/bin/open", [url], { stdio: "ignore" });
}

/** on/off 参数统一解析；大小写不敏感，缺值或非法值都在这里报错。 */
function onOffValue(options: CliOptions, key: string): boolean | undefined {
  const value = options[key];
  if (value === undefined) return undefined;
  if (value === true) throw new Error(`--${key} requires on or off`);
  const normalized = String(value).toLowerCase();
  if (normalized !== "on" && normalized !== "off") {
    throw new Error(`--${key} expects on or off, got "${value}"`);
  }
  return normalized === "on";
}

/**
 * config 命令：无参数只打印当前设置；传入任何配置项时都写盘并重启网关，
 * 让运行中的进程重新加载完整配置，不对比目标值是否已匹配。
 */
async function configCommand(options: CliOptions): Promise<void> {
  const zcodeTarget = onOffValue(options, "zcode");
  const codebuddyTarget = onOffValue(options, "codebuddy");
  const codebuddyRegionOption = stringOption(options, "codebuddy-region");
  const logTarget = onOffValue(options, "log");
  const maxLogsOption = stringOption(options, "max-request-logs");
  const maxLogSizeOption = stringOption(options, "max-log-size");
  const paths = resolvePaths();
  if (!fs.existsSync(paths.gatewayConfig)) throw new Error("Gateway is not installed");
  const config = loadGatewayConfig(paths.gatewayConfig);
  const auditBefore: Record<string, unknown> = { ...config } as unknown as Record<string, unknown>;

  if (zcodeTarget === undefined && codebuddyTarget === undefined && codebuddyRegionOption === undefined && logTarget === undefined && maxLogsOption === undefined && maxLogSizeOption === undefined) {
    const zcodeActive = zcodeEnabled(config);
    const codebuddyActive = codebuddyEnabled(config);
    console.log(JSON.stringify({
      upstreamOnly: config.upstreamOnly === true,
      zcode: zcodeActive,
      // upstream-only 下开关保存但不生效；单独报出原始值，避免配置与运行时看起来脱节。
      ...(config.zcode === true && !zcodeActive ? { zcodeConfigured: true } : {}),
      codebuddy: codebuddyActive,
      ...(config.codebuddy === true && !codebuddyActive ? { codebuddyConfigured: true } : {}),
      codebuddyRegion: config.codebuddyRegion ?? "auto",
      requestLogging: config.requestLogging === true,
      logDir: config.logDir || paths.logDir,
      maxRequestLogs: config.maxRequestLogs ?? 0,
      maxGatewayLogBytes: config.maxGatewayLogBytes ?? 0,
      catalogPath: config.catalogPath,
      selectedModels: Array.isArray(config.selectedModels) ? config.selectedModels.length : 0,
    }, null, 2));
    return;
  }

  requireMacOS();
  const applied: string[] = [];
  if (zcodeTarget !== undefined) {
    config.zcode = zcodeTarget;
    const zcodeActive = zcodeEnabled(config);
    applied.push(zcodeTarget && !zcodeActive
      ? "ZCode compatibility saved but inactive: upstream-only mode treats ZCode as disabled."
      : `ZCode compatibility ${zcodeTarget ? "enabled" : "disabled"}.`);
  }
  if (codebuddyTarget !== undefined) {
    config.codebuddy = codebuddyTarget;
    const codebuddyActive = codebuddyEnabled(config);
    applied.push(codebuddyTarget && !codebuddyActive
      ? "CodeBuddy compatibility saved but inactive: upstream-only mode treats CodeBuddy as disabled."
      : `CodeBuddy compatibility ${codebuddyTarget ? "enabled" : "disabled"}.`);
  }
  if (codebuddyRegionOption !== undefined) {
    const normalized = codebuddyRegionOption.trim().toLowerCase();
    if (normalized !== "auto" && normalized !== "cn" && normalized !== "intl") {
      throw new Error(`--codebuddy-region expects auto, cn, or intl, got "${codebuddyRegionOption}"`);
    }
    config.codebuddyRegion = normalized;
    applied.push(`CodeBuddy region preference set to ${normalized}.`);
  }
  if (maxLogsOption !== undefined) {
    config.maxRequestLogs = parseMaxRequestLogs(maxLogsOption);
    applied.push(`Max log files per group set to ${
      config.maxRequestLogs === 0 ? "unlimited" : config.maxRequestLogs
    }.`);
  }
  if (maxLogSizeOption !== undefined) {
    config.maxGatewayLogBytes = parseMaxLogSize(maxLogSizeOption);
    applied.push(`Gateway log size cap set to ${
      config.maxGatewayLogBytes === 0 ? "unlimited" : bytes.format(config.maxGatewayLogBytes)
    }.`);
  }
  if (logTarget !== undefined) {
    config.requestLogging = logTarget;
    if (logTarget) config.logDir ||= paths.logDir;
    applied.push(`Request logging ${logTarget ? "enabled" : "disabled"}.`);
  }
  // 与 Web UI 同一规则：组合校验先于写盘与重启，失败时保留原配置和运行中的服务
  // （否则保存成功、新进程却被 validate*Config 拒绝启动，网关直接不可用）。
  validateZcodeConfig(config);
  validateCodebuddyConfig(config);
  writeGatewayConfig(paths.gatewayConfig, config);
  if (fs.existsSync(paths.stateFile)) {
    const state = loadJson<InstallState>(paths.stateFile);
    state.config = config;
    writeJson(paths.stateFile, state);
  }
  recordConfigAudit("config", config, auditBefore, paths);

  if (fs.existsSync(paths.launchAgent)) {
    await restartGatewayOnce(paths, config);
    console.log("Gateway restarted to apply the new configuration.");
  } else {
    console.log("Gateway LaunchAgent is not installed; configuration saved without restart.");
  }
  for (const line of applied) console.log(line);
  if (logTarget) console.log(`Request logs will be written to: ${config.logDir}`);
}

async function controlGateway(
  action: "start" | "stop" | "restart",
  restartCodex = false,
): Promise<void> {
  requireMacOS();
  const paths = resolvePaths();
  if (!fs.existsSync(paths.stateFile)) throw new Error("Gateway is not installed");

  if (action === "stop") {
    stopLaunchAgent(paths.launchAgent);
    // Web UI 是独立服务：网关停止时一并回收（未安装时 bootout 静默忽略）。
    stopLaunchAgent(paths.webUiLaunchAgent);
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
    await restartGatewayOnce(paths, config);
  }

  if (action === "start") await waitForHealth(`http://${config.host}:${config.port}/healthz`);
  console.log(`Gateway ${action === "start" ? "started" : "restarted"}.`);
  if (restartCodex) await refreshCodexAppServer();
}

export function syncGatewayConfigFile(paths: ResolvedPaths, configFile = paths.gatewayConfig): void {
  if (!fs.existsSync(configFile)) return;

  const raw = loadJson<unknown>(configFile);
  if (!isJsonObject(raw)) throw new Error(`Gateway config must be a JSON object: ${configFile}`);
  const before = structuredClone(raw);
  const current = migrateLegacyConfig(raw) as unknown as GatewayConfig;
  const explicitChanges: ConfigChange[] = [];
  let dirty = false;
  // websocket 开关已移除：CPA WebSocket 由上游按请求判断，老配置里的残留键一并清理。
  if ("websocket" in current) {
    explicitChanges.push({
      field: "websocket (removed)",
      before: (current as unknown as Record<string, unknown>).websocket ?? null,
      after: null,
    });
    delete (current as unknown as Record<string, unknown>).websocket;
    dirty = true;
  }
  // 历史字段更名（见 LEGACY_FIELD_MIGRATIONS）：读取时已补齐新键（loadGatewayConfig），
  // 这里移除旧键并记录审计，让配置文件只保留受管的新字段。
  for (const { old: oldKey, next: newKey } of LEGACY_FIELD_MIGRATIONS) {
    if (oldKey in current) {
      const record = current as unknown as Record<string, unknown>;
      explicitChanges.push({
        field: `${oldKey} -> ${newKey}`,
        before: record[oldKey] ?? null,
        after: record[newKey] ?? null,
      });
      delete record[oldKey];
      dirty = true;
    }
  }
  const legacyCatalogPath = current.catalogPath === path.join(paths.codexHome, "cliproxy-catalog.json");
  if (legacyCatalogPath) {
    current.catalogPath = paths.catalogFile;
    dirty = true;
  }

  // 同版本只补本次新增开关，不改变其他可选字段原有的缺省和审计语义。
  if (current.configVersion === GATEWAY_CONFIG_VERSION) {
    if (!Object.hasOwn(current, "zcode")) {
      current.zcode = false;
      dirty = true;
    }
    if (!Object.hasOwn(current, "codebuddy")) {
      current.codebuddy = false;
      dirty = true;
    }
    if (dirty) {
      writeGatewayConfig(configFile, current);
      if (configFile === paths.gatewayConfig && fs.existsSync(paths.stateFile)) {
        const state = loadJson<InstallState>(paths.stateFile);
        state.config = current;
        writeJson(paths.stateFile, state);
      }
      recordConfigAudit("config sync", current, before, paths, explicitChanges);
    }
    warnGatewayConfig(configFile, current);
    return;
  }

  const merged = mergedGatewayConfig(
    paths,
    current as unknown as Record<string, unknown>,
  );
  merged.config.configVersion = GATEWAY_CONFIG_VERSION;
  if (before.configVersion !== merged.config.configVersion) {
    explicitChanges.push({
      field: "configVersion",
      before: before.configVersion ?? null,
      after: merged.config.configVersion,
    });
  }
  writeGatewayConfig(configFile, merged.config);

  if (configFile === paths.gatewayConfig && fs.existsSync(paths.stateFile)) {
    const state = loadJson<InstallState>(paths.stateFile);
    state.version = 4;
    state.config = merged.config;
    writeJson(paths.stateFile, state);
  }
  recordConfigAudit("config sync", merged.config as unknown as GatewayConfig, before, paths, explicitChanges);
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

/** 各命令接受的选项；白名单外的 --key 一律报错，避免拼写错误被静默忽略后部分生效。 */
const COMMAND_OPTIONS: Record<string, string[]> = {
  install: ["upstream-url", "cliproxy-url", "upstream-type", "port", "prefix", "official-url", "key-env", "select", "upstream-only", "cpa-only", "model-merge-json", "restart-codex", "yes"],
  uninstall: ["restart-codex"],
  restart: ["restart-codex"],
  serve: ["config"],
  models: ["sync", "upstream-only", "cpa-only", "select", "restart-codex", "model-merge-json"],
  config: ["zcode", "codebuddy", "codebuddy-region", "log", "max-request-logs", "max-log-size"],
  web: ["start", "daemon", "status", "stop", "restart"],
};

export async function runCli(args: string[]): Promise<void> {
  const { positional, options } = parseArgs(args);
  const command = positional[0];
  if (!command || command === "help" || options.help) {
    usage();
    return;
  }
  if (positional.length > 1) throw new Error(`Unexpected argument: ${positional[1]}`);
  // web 专属模式 flag 先于通用白名单报错： misplaced 时给出「只属于 web」的明确提示。
  for (const webFlag of ["start", "daemon", "status", "stop", "restart"]) {
    if (options[webFlag] === true && command !== "web") {
      throw new Error(`--${webFlag} is only supported by the web command`);
    }
  }
  const allowedOptions = COMMAND_OPTIONS[command] ?? [];
  for (const key of Object.keys(options)) {
    if (!allowedOptions.includes(key)) {
      throw new Error(`Unknown option --${key} for command "${command}"`);
    }
  }
  if (command === "models" && options["restart-codex"] === true && options.sync !== true) {
    throw new Error("--restart-codex requires models --sync");
  }
  if (command === "models" && stringOption(options, "model-merge-json") && options.sync !== true) {
    throw new Error("--model-merge-json requires models --sync");
  }
  const upstreamType = stringOption(options, "upstream-type");
  if (upstreamType !== undefined) parseUpstreamTypeOption(upstreamType);
  if (upstreamOnlyOption(options)
    && command !== "install"
    && (command !== "models" || options.sync !== true)) {
    throw new Error("--upstream-only (or its deprecated alias --cpa-only) is only supported by install or models --sync");
  }
  if (options.log !== undefined && command !== "config") {
    throw new Error("--log is only supported by the config command");
  }
  if (["start", "stop", "restart", "serve", "models", "config", "status", "web"].includes(command)) {
    syncGatewayConfig(command, options);
  }

  switch (command) {
    case "install":
      await install(options);
      break;
    case "uninstall":
      await uninstall(options);
      break;
    case "start":
    case "stop":
    case "restart":
      await controlGateway(command, command === "restart" && options["restart-codex"] === true);
      break;
    case "serve":
      serve(options);
      break;
    case "models":
      await models(options);
      break;
    case "config":
      await configCommand(options);
      break;
    case "web":
      await webCommand(options);
      break;
    case "status":
      await status();
      break;
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}
