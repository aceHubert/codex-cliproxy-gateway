import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { atomicWrite } from "./toml.ts";

export const LAUNCHD_LABEL = "codex-cliproxy-gateway";

interface LaunchAgentOptions {
  bunPath: string;
  cliPath: string;
  configPath: string;
  stdoutLog: string;
  stderrLog: string;
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

export function renderLaunchAgent({ bunPath, cliPath, configPath, stdoutLog, stderrLog }: Omit<LaunchAgentOptions, "plistPath">): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  ${plistArray([bunPath, cliPath, "serve", "--config", configPath])}
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${xmlEscape(stdoutLog)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(stderrLog)}</string>
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

export function launchAgentStatus(): string | null {
  const domain = launchDomain();
  try {
    return launchctl(["print", `${domain}/${LAUNCHD_LABEL}`]);
  } catch {
    return null;
  }
}
