import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { atomicWrite } from "./toml.ts";

export const LAUNCHD_LABEL = "codex-cliproxy-gateway";
export const WEBUI_LAUNCHD_LABEL = "codex-cliproxy-webui";

/** 网关 LaunchAgent 的服务 label：默认实例沿用历史值，其他实例加主目录哈希后缀。 */
export function gatewayServiceLabel(instanceSuffix: string): string {
  return `${LAUNCHD_LABEL}${instanceSuffix}`;
}

/** Web UI LaunchAgent 的服务 label，派生规则与网关 label 一致。 */
export function webUiServiceLabel(instanceSuffix: string): string {
  return `${WEBUI_LAUNCHD_LABEL}${instanceSuffix}`;
}

interface LaunchAgentOptions {
  bunPath: string;
  cliPath: string;
  configPath: string;
  codexHome: string;
  /** stdout 与 stderr 都指向它：进程日志只有一个文件，stderr 不再另开。 */
  logPath: string;
  plistPath: string;
  /** plist 的 Label；必须与启动/重启/状态查询使用的 label 一致（按实例派生）。 */
  label: string;
  /**
   * 非默认实例注入：写入 CODEX_CLIPROXY_HOME，让 launchd 拉起的进程与安装时的
   * CLI 解析到同一运行主目录。默认实例不传（保持历史 plist 形状）。
   */
  runtimeHome?: string;
}

function xmlEscape(value: string): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function plistArray(values: string[]): string {
  return `<array>\n${values.map((value) => `      <string>${xmlEscape(value)}</string>`).join("\n")}\n    </array>`;
}

function environmentVariables(codexHome: string, runtimeHome?: string, webUiService?: string): string {
  return `  <key>EnvironmentVariables</key>
  <dict>
    <key>CODEX_HOME</key>
    <string>${xmlEscape(codexHome)}</string>${
      webUiService ? `
    <key>CODEX_CLIPROXY_UI_SERVICE</key>
    <string>${webUiService}</string>` : ""
    }${
      runtimeHome ? `
    <key>CODEX_CLIPROXY_HOME</key>
    <string>${xmlEscape(runtimeHome)}</string>` : ""
  }
  </dict>`;
}

export function renderLaunchAgent({ bunPath, cliPath, configPath, codexHome, logPath, label, runtimeHome }: Omit<LaunchAgentOptions, "plistPath">): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(label)}</string>
  <key>ProgramArguments</key>
  ${plistArray([bunPath, cliPath, "serve", "--config", configPath])}
  ${environmentVariables(codexHome, runtimeHome)}
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${xmlEscape(logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(logPath)}</string>
</dict>
</plist>
`;
}

/**
 * Web UI 的 LaunchAgent：RunAtLoad/KeepAlive 均为 false——默认不启动，登录时不自启，
 * 崩溃也不拉起；由 `agent-proxy web --daemon` 写入并 kickstart 按需运行，stop/uninstall 经
 * bootout 回收。与网关 agent 共用一套写入/启动语义，但生命周期完全独立。
 */
/** Web UI agent 复用 web 命令，通过内部环境标记仅运行服务，始终绑定本实例的安装配置。 */
export function renderWebUiAgent({ bunPath, cliPath, codexHome, logPath, label, runtimeHome }: Pick<LaunchAgentOptions, "bunPath" | "cliPath" | "codexHome" | "logPath" | "label" | "runtimeHome">): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(label)}</string>
  <key>ProgramArguments</key>
  ${plistArray([bunPath, cliPath, "web"])}
  ${environmentVariables(codexHome, runtimeHome, "1")}
  <key>RunAtLoad</key>
  <false/>
  <key>KeepAlive</key>
  <false/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${xmlEscape(logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(logPath)}</string>
</dict>
</plist>
`;
}

function launchctl(args: string[], ignoreError = false): string {
  try {
    return execFileSync("/bin/launchctl", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    if (ignoreError) return "";
    throw error;
  }
}

/** 写入 Web UI agent 并立即启动（先卸载旧定义，保证按本次写入的 plist 运行）。 */
export function startWebUiLaunchAgent(plistPath: string, options: Pick<LaunchAgentOptions, "bunPath" | "cliPath" | "codexHome" | "logPath" | "label" | "runtimeHome">): void {
  fs.mkdirSync(path.dirname(plistPath), { recursive: true });
  atomicWrite(plistPath, renderWebUiAgent(options), 0o644);
  const domain = launchDomain();
  launchctl(["bootout", domain, plistPath], true);
  launchctl(["bootstrap", domain, plistPath]);
  launchctl(["kickstart", `${domain}/${options.label}`]);
}

function launchDomain(): string {
  return `gui/${process.getuid?.() ?? process.geteuid?.() ?? 0}`;
}

/** 测试注入执行器，迁移验证不得操作真实 launchd。 */
export type LaunchctlExecutor = (args: string[], ignoreError?: boolean) => string;

function decodePlistString(value: string): string {
  return value.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'").replaceAll("&amp;", "&");
}

function plistString(source: string, key: string): string | undefined {
  const value = source.match(new RegExp(`<key>\\s*${key}\\s*</key>\\s*<string>([^<]*)</string>`))?.[1];
  return value === undefined ? undefined : decodePlistString(value);
}

function programArguments(source: string): string[] {
  const array = source.match(/<key>\s*ProgramArguments\s*<\/key>\s*<array>([\s\S]*?)<\/array>/)?.[1];
  return array ? [...array.matchAll(/<string>([^<]*)<\/string>/g)].map((value) => decodePlistString(value[1]!)) : [];
}

export interface ManagedWebUiMigrationOptions {
  plistPath: string;
  gatewayPlistPath: string;
  legacyRuntimeHome: string;
  runtimeHome: string;
  cliPath: string;
  bunPath: string;
}

/** 仅迁移可由旧默认网关服务证明的 Web UI 受管入口，保留额外字段和自定义日志。 */
export function prepareManagedWebUiMigration(
  options: ManagedWebUiMigrationOptions,
  execute: LaunchctlExecutor = launchctl,
): (() => () => void) | undefined {
  if (!fs.existsSync(options.plistPath) || !fs.existsSync(options.gatewayPlistPath)) return undefined;
  const before = fs.readFileSync(options.plistPath, "utf8");
  const gateway = fs.readFileSync(options.gatewayPlistPath, "utf8");
  const args = programArguments(before);
  const gatewayArgs = programArguments(gateway);
  // 环境目录明确指定时保持用户选择，不将该服务作为旧默认实例迁移。
  if (plistString(before, "CODEX_CLIPROXY_HOME") !== undefined) return undefined;
  if (plistString(before, "Label") !== WEBUI_LAUNCHD_LABEL
    || plistString(before, "CODEX_CLIPROXY_UI_SERVICE") !== "1"
    || args.length !== 3 || args[2] !== "web"
    || gatewayArgs[2] !== "serve" || gatewayArgs[3] !== "--config"
    || gatewayArgs[4] !== path.join(options.legacyRuntimeHome, "config.json")
    || args[0] !== gatewayArgs[0] || args[1] !== gatewayArgs[1]
    || !/(?:^|\/)(?:src|dist)\/index\.(?:js|ts)$/.test(args[1]!)) return undefined;
  let after = before.replace(
    /(<key>\s*ProgramArguments\s*<\/key>\s*)<array>[\s\S]*?<\/array>/,
    (_, prefix: string) => `${prefix}${plistArray([options.bunPath, options.cliPath, "web"])}`,
  );
  for (const key of ["StandardOutPath", "StandardErrorPath"]) {
    if (plistString(before, key) !== path.join(options.legacyRuntimeHome, "webui.log")) continue;
    after = after.replace(new RegExp(`(<key>\\s*${key}\\s*</key>\\s*<string>)[^<]*(</string>)`),
      (_, prefix: string, suffix: string) => `${prefix}${xmlEscape(path.join(options.runtimeHome, "webui.log"))}${suffix}`);
  }
  if (after === before) return undefined;
  const mode = fs.statSync(options.plistPath).mode & 0o777;
  return () => {
    const domain = launchDomain();
    let status: string | undefined;
    try { status = execute(["print", `${domain}/${WEBUI_LAUNCHD_LABEL}`]); } catch { /* 未加载的服务保持未加载。 */ }
    const running = status !== undefined && /\bstate\s*=\s*running\b/.test(status);
    const backup = `${options.plistPath}.bak-agent-proxy-migration-${randomUUID()}`;
    fs.copyFileSync(options.plistPath, backup, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(backup, mode);
    let touched = false;
    const reload = (): void => {
      execute(["bootout", domain, options.plistPath], true);
      if (status !== undefined) {
        execute(["bootstrap", domain, options.plistPath]);
        if (running) execute(["kickstart", `${domain}/${WEBUI_LAUNCHD_LABEL}`]);
      }
    };
    const rollback = (): void => {
      atomicWrite(options.plistPath, before, mode);
      if (touched) reload();
      fs.rmSync(backup, { force: true });
    };
    try {
      atomicWrite(options.plistPath, after, mode);
      if (status !== undefined) {
        touched = true;
        reload();
      }
      return rollback;
    } catch (error) {
      try { rollback(); } catch (restoreError) {
        throw new Error(`Web UI migration failed; service restore incomplete: ${String(restoreError)}`, { cause: error });
      }
      throw error;
    }
  };
}

export function installLaunchAgent(options: LaunchAgentOptions): void {
  fs.mkdirSync(path.dirname(options.plistPath), { recursive: true });
  atomicWrite(options.plistPath, renderLaunchAgent(options), 0o644);
  const domain = launchDomain();
  launchctl(["bootout", domain, options.plistPath], true);
  launchctl(["bootstrap", domain, options.plistPath]);
  launchctl(["kickstart", "-k", `${domain}/${options.label}`]);
}

export function uninstallLaunchAgent(plistPath: string): void {
  const domain = launchDomain();
  launchctl(["bootout", domain, plistPath], true);
  fs.rmSync(plistPath, { force: true });
}

export function startLaunchAgent(plistPath: string, label: string): void {
  if (!fs.existsSync(plistPath)) throw new Error("Gateway LaunchAgent is not installed");
  const domain = launchDomain();
  if (!launchAgentStatus(label)) launchctl(["bootstrap", domain, plistPath]);
  launchctl(["kickstart", `${domain}/${label}`]);
}

export function stopLaunchAgent(plistPath: string): void {
  launchctl(["bootout", launchDomain(), plistPath], true);
}

export function restartLaunchAgent(plistPath: string, label: string): void {
  const domain = launchDomain();
  if (launchAgentStatus(label)) launchctl(["kickstart", "-k", `${domain}/${label}`]);
  else startLaunchAgent(plistPath, label);
}

/**
 * 回滚专用：丢弃 launchd 当前已加载的任务定义，强制按磁盘上的 plist 重新加载并启动。
 * `restartLaunchAgent` 在任务已加载时只做 kickstart——按已加载（可能是刚写入的）
 * 定义重启进程，回滚时恢复到磁盘的旧 plist 不会重新生效。
 */
export function reloadLaunchAgent(plistPath: string, label: string): void {
  const domain = launchDomain();
  launchctl(["bootout", domain, plistPath], true);
  launchctl(["bootstrap", domain, plistPath]);
  launchctl(["kickstart", `${domain}/${label}`]);
}

export function launchAgentStatus(label: string): string | null {
  const domain = launchDomain();
  try {
    return launchctl(["print", `${domain}/${label}`]);
  } catch {
    return null;
  }
}
