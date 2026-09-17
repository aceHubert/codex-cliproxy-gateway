import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { atomicWrite } from "./toml.ts";

export const LAUNCHD_LABEL = "codex-cliproxy-gateway";
export const WEBUI_LAUNCHD_LABEL = "codex-cliproxy-webui";

interface LaunchAgentOptions {
  bunPath: string;
  cliPath: string;
  configPath: string;
  codexHome: string;
  /** stdout 与 stderr 都指向它：进程日志只有一个文件，stderr 不再另开。 */
  logPath: string;
  plistPath: string;
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

export function renderLaunchAgent({ bunPath, cliPath, configPath, codexHome, logPath }: Omit<LaunchAgentOptions, "plistPath">): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  ${plistArray([bunPath, cliPath, "serve", "--config", configPath])}
  <key>EnvironmentVariables</key>
  <dict>
    <key>CODEX_HOME</key>
    <string>${xmlEscape(codexHome)}</string>
  </dict>
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

function launchctl(args: string[], ignoreError = false): string {
  try {
    return execFileSync("/bin/launchctl", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    if (ignoreError) return "";
    throw error;
  }
}

/**
 * Web UI 的 LaunchAgent：RunAtLoad/KeepAlive 均为 false——默认不启动，登录时不自启，
 * 崩溃也不拉起；由 `codex-cliproxy web --daemon` 写入并 kickstart 按需运行，stop/uninstall 经
 * bootout 回收。与网关 agent 共用一套写入/启动语义，但生命周期完全独立。
 */
/** Web UI agent 复用 web 命令，通过内部环境标记仅运行服务，始终绑定默认安装配置。 */
export function renderWebUiAgent({ bunPath, cliPath, codexHome, logPath }: Pick<LaunchAgentOptions, "bunPath" | "cliPath" | "codexHome" | "logPath">): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${WEBUI_LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  ${plistArray([bunPath, cliPath, "web"])}
  <key>EnvironmentVariables</key>
  <dict>
    <key>CODEX_HOME</key>
    <string>${xmlEscape(codexHome)}</string>
    <key>CODEX_CLIPROXY_UI_SERVICE</key>
    <string>1</string>
  </dict>
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

/** 写入 Web UI agent 并立即启动（先卸载旧定义，保证按本次写入的 plist 运行）。 */
export function startWebUiLaunchAgent(plistPath: string, options: Pick<LaunchAgentOptions, "bunPath" | "cliPath" | "codexHome" | "logPath">): void {
  fs.mkdirSync(path.dirname(plistPath), { recursive: true });
  atomicWrite(plistPath, renderWebUiAgent(options), 0o644);
  const domain = launchDomain();
  launchctl(["bootout", domain, plistPath], true);
  launchctl(["bootstrap", domain, plistPath]);
  launchctl(["kickstart", `${domain}/${WEBUI_LAUNCHD_LABEL}`]);
}

function launchDomain(): string {
  return `gui/${process.getuid?.() ?? process.geteuid?.() ?? 0}`;
}

export function installLaunchAgent(options: LaunchAgentOptions): void {
  fs.mkdirSync(path.dirname(options.plistPath), { recursive: true });
  atomicWrite(options.plistPath, renderLaunchAgent(options), 0o644);
  const domain = launchDomain();
  launchctl(["bootout", domain, options.plistPath], true);
  launchctl(["bootstrap", domain, options.plistPath]);
  launchctl(["kickstart", "-k", `${domain}/${LAUNCHD_LABEL}`]);
}

export function uninstallLaunchAgent(plistPath: string): void {
  const domain = launchDomain();
  launchctl(["bootout", domain, plistPath], true);
  fs.rmSync(plistPath, { force: true });
}

export function startLaunchAgent(plistPath: string): void {
  if (!fs.existsSync(plistPath)) throw new Error("Gateway LaunchAgent is not installed");
  const domain = launchDomain();
  if (!launchAgentStatus()) launchctl(["bootstrap", domain, plistPath]);
  launchctl(["kickstart", `${domain}/${LAUNCHD_LABEL}`]);
}

export function stopLaunchAgent(plistPath: string): void {
  launchctl(["bootout", launchDomain(), plistPath], true);
}

export function restartLaunchAgent(plistPath: string): void {
  const domain = launchDomain();
  if (launchAgentStatus()) launchctl(["kickstart", "-k", `${domain}/${LAUNCHD_LABEL}`]);
  else startLaunchAgent(plistPath);
}

/**
 * 回滚专用：丢弃 launchd 当前已加载的任务定义，强制按磁盘上的 plist 重新加载并启动。
 * `restartLaunchAgent` 在任务已加载时只做 kickstart——按已加载（可能是刚写入的）
 * 定义重启进程，回滚时恢复到磁盘的旧 plist 不会重新生效。
 */
export function reloadLaunchAgent(plistPath: string): void {
  const domain = launchDomain();
  launchctl(["bootout", domain, plistPath], true);
  launchctl(["bootstrap", domain, plistPath]);
  launchctl(["kickstart", `${domain}/${LAUNCHD_LABEL}`]);
}

export function launchAgentStatus(): string | null {
  const domain = launchDomain();
  try {
    return launchctl(["print", `${domain}/${LAUNCHD_LABEL}`]);
  } catch {
    return null;
  }
}
