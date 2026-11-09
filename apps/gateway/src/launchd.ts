import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { atomicWrite } from "./toml.ts";

export const LAUNCHD_LABEL = "agent-proxy-gateway";
export const WEBUI_LAUNCHD_LABEL = "agent-proxy-webui";
/** 项目更名前的历史服务名；仅用于存量安装的识别、收养与清理迁移。 */
export const LEGACY_LAUNCHD_LABEL = "codex-cliproxy-gateway";
export const LEGACY_WEBUI_LAUNCHD_LABEL = "codex-cliproxy-webui";

/** 网关 LaunchAgent 的服务 label：默认实例沿用历史值，其他实例加主目录哈希后缀。 */
export function gatewayServiceLabel(instanceSuffix: string): string {
  return `${LAUNCHD_LABEL}${instanceSuffix}`;
}

/** Web UI LaunchAgent 的服务 label，派生规则与网关 label 一致。 */
export function webUiServiceLabel(instanceSuffix: string): string {
  return `${WEBUI_LAUNCHD_LABEL}${instanceSuffix}`;
}

/** 更名前的网关服务 label，后缀派生规则与新 label 一致。 */
export function legacyGatewayServiceLabel(instanceSuffix: string): string {
  return `${LEGACY_LAUNCHD_LABEL}${instanceSuffix}`;
}

/** 更名前的 Web UI 服务 label。 */
export function legacyWebUiServiceLabel(instanceSuffix: string): string {
  return `${LEGACY_WEBUI_LAUNCHD_LABEL}${instanceSuffix}`;
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
  // 更名前的旧 webui 任务可能仍在加载，先回收避免两个定义并存。
  launchctl(["bootout", `${domain}/${legacyLabelForLabel(options.label, "webui")}`], true);
  launchctl(["bootout", domain, plistPath], true);
  launchctl(["bootstrap", domain, plistPath]);
  launchctl(["kickstart", `${domain}/${options.label}`]);
}

function launchDomain(): string {
  return `gui/${process.getuid?.() ?? process.geteuid?.() ?? 0}`;
}

export interface LegacyLaunchAgentPaths {
  /** 新命名的 plist 路径（paths.launchAgent / paths.webUiLaunchAgent）。 */
  gatewayPlist: string;
  webUiPlist: string;
  /** 更名前的 plist 路径。 */
  legacyGatewayPlist: string;
  legacyWebUiPlist: string;
  /** 实例后缀：旧 label 的回收目标与新 label 使用同一派生规则。 */
  instanceSuffix: string;
}

/**
 * 服务命名迁移：把旧命名的 plist 改名到新文件名，纯文件级操作——内容原样保留
 * （内部 Label 仍为旧值，由本次 install / web 流程重写），不 bootout、不触碰已加载
 * 任务，拒绝安装或中途失败都不影响在跑服务。旧 label 任务的回收由 installLaunchAgent
 * 的按路径 bootout 在提交点完成。幂等：新文件已存在时不改名。
 */
export function adoptLegacyLaunchAgents(options: LegacyLaunchAgentPaths): string[] {
  const renamed: string[] = [];
  for (const [legacy, next] of [[options.legacyGatewayPlist, options.gatewayPlist], [options.legacyWebUiPlist, options.webUiPlist]] as const) {
    if (!fs.existsSync(legacy) || fs.existsSync(next)) continue;
    fs.renameSync(legacy, next);
    renamed.push(next);
  }
  return renamed;
}

/** 卸载清理：回收旧命名时代的任务与 plist 文件，语义与 uninstallLaunchAgent 一致。 */
export function removeLegacyLaunchAgents(
  options: Pick<LegacyLaunchAgentPaths, "legacyGatewayPlist" | "legacyWebUiPlist" | "instanceSuffix">,
  execute: LaunchctlExecutor = launchctl,
): void {
  const domain = launchDomain();
  execute(["bootout", `${domain}/${legacyGatewayServiceLabel(options.instanceSuffix)}`], true);
  execute(["bootout", `${domain}/${legacyWebUiServiceLabel(options.instanceSuffix)}`], true);
  for (const plistPath of [options.legacyGatewayPlist, options.legacyWebUiPlist]) {
    execute(["bootout", domain, plistPath], true);
    fs.rmSync(plistPath, { force: true });
  }
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

/** 读取 plist 内声明的 Label；解析失败回退到当前命名，供失败恢复按真实 label 拉回服务。 */
export function plistServiceLabel(source: string, fallback: string): string {
  return plistString(source, "Label") ?? fallback;
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
  if (plistString(before, "Label") !== WEBUI_LAUNCHD_LABEL && plistString(before, "Label") !== LEGACY_WEBUI_LAUNCHD_LABEL
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
  // 探测/重载/拉起都按 plist 内声明的真实 Label：迁移对象可能是更名前的旧 Label，
  // 且 launchd 中的任务按 bootstrap 时的路径注册——按路径 bootout 卸载不到从旧路径
  // 注册的同 Label 任务，须补一次按 Label 回收。
  const serviceLabel = plistServiceLabel(before, WEBUI_LAUNCHD_LABEL);
  return () => {
    const domain = launchDomain();
    let status: string | undefined;
    try { status = execute(["print", `${domain}/${serviceLabel}`]); } catch { /* 未加载的服务保持未加载。 */ }
    const running = status !== undefined && /\bstate\s*=\s*running\b/.test(status);
    const backup = `${options.plistPath}.bak-agent-proxy-migration-${randomUUID()}`;
    fs.copyFileSync(options.plistPath, backup, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(backup, mode);
    let touched = false;
    const reload = (): void => {
      execute(["bootout", domain, options.plistPath], true);
      execute(["bootout", `${domain}/${serviceLabel}`], true);
      if (status !== undefined) {
        execute(["bootstrap", domain, options.plistPath]);
        if (running) execute(["kickstart", `${domain}/${serviceLabel}`]);
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

/** 从（可能是更名前安装的）label 推导同实例的旧命名 label；非本产品命名原样返回。 */
export function legacyLabelForLabel(label: string, kind: "gateway" | "webui" = "gateway"): string {
  const current = kind === "gateway" ? LAUNCHD_LABEL : WEBUI_LAUNCHD_LABEL;
  const legacy = kind === "gateway" ? LEGACY_LAUNCHD_LABEL : LEGACY_WEBUI_LAUNCHD_LABEL;
  return label.startsWith(current) ? legacy + label.slice(current.length) : label;
}

export function installLaunchAgent(options: LaunchAgentOptions): void {
  fs.mkdirSync(path.dirname(options.plistPath), { recursive: true });
  atomicWrite(options.plistPath, renderLaunchAgent(options), 0o644);
  const domain = launchDomain();
  launchctl(["bootout", domain, options.plistPath], true);
  // 收养只改名不卸载：旧 label 任务仍按旧路径注册，按路径 bootout 找不到它，
  // 必须按 label 回收，否则新旧两个 KeepAlive 服务并存抢占网关端口。
  launchctl(["bootout", `${domain}/${legacyLabelForLabel(options.label)}`], true);
  launchctl(["bootstrap", domain, options.plistPath]);
  launchctl(["kickstart", "-k", `${domain}/${options.label}`]);
}

export function uninstallLaunchAgent(plistPath: string): void {
  const domain = launchDomain();
  launchctl(["bootout", domain, plistPath], true);
  fs.rmSync(plistPath, { force: true });
}

/** 读取 plist 内声明的真实 Label：收养后、重装完成前的 plist 内还是旧 label。 */
function loadedPlistLabel(plistPath: string, fallback: string): string {
  return plistServiceLabel(fs.existsSync(plistPath) ? fs.readFileSync(plistPath, "utf8") : "", fallback);
}

export function startLaunchAgent(plistPath: string, label: string): void {
  if (!fs.existsSync(plistPath)) throw new Error("Gateway LaunchAgent is not installed");
  const domain = launchDomain();
  // 判定与拉起都按真实 Label：plist 内是旧 label 时按新 label 判定「未加载」，
  // 会对同一旧 label 重复 bootstrap 报 Input/output error。
  const actual = loadedPlistLabel(plistPath, label);
  if (!launchAgentStatus(actual)) launchctl(["bootstrap", domain, plistPath]);
  launchctl(["kickstart", `${domain}/${actual}`]);
}

export function stopLaunchAgent(plistPath: string): void {
  const domain = launchDomain();
  launchctl(["bootout", domain, plistPath], true);
  // 任务按 bootstrap 时的路径注册：改名前的 plist 文件改名后，按路径 bootout 找不到
  // 从旧路径注册的任务，须再按 plist 内声明的 Label 回收一次。
  if (fs.existsSync(plistPath)) {
    const actual = plistServiceLabel(fs.readFileSync(plistPath, "utf8"), "");
    if (actual) launchctl(["bootout", `${domain}/${actual}`], true);
  }
}

export function restartLaunchAgent(plistPath: string, label: string): void {
  const domain = launchDomain();
  if (launchAgentStatus(label)) launchctl(["kickstart", "-k", `${domain}/${label}`]);
  else startLaunchAgent(plistPath, label);
}

/**
 * 回滚专用：丢弃 launchd 当前已加载的任务定义，强制按磁盘上的 plist 重新加载并启动。
 * `restartLaunchAgent` 在任务已加载时只做 kickstart——按已加载（可能是刚写入的）
 * 定义重启进程，回滚时恢复到磁盘的旧 plist 不会重新生效。bootout 同时按路径与按
 * Label 执行：前者回收从本路径 bootstrap 的新任务，后者兜底回收按旧路径注册的旧任务。
 */
export function reloadLaunchAgent(plistPath: string, label: string): void {
  const domain = launchDomain();
  launchctl(["bootout", domain, plistPath], true);
  launchctl(["bootout", `${domain}/${label}`], true);
  launchctl(["bootstrap", domain, plistPath]);
  const actual = loadedPlistLabel(plistPath, label);
  launchctl(["kickstart", `${domain}/${actual}`]);
}

export function launchAgentStatus(label: string): string | null {
  const domain = launchDomain();
  try {
    return launchctl(["print", `${domain}/${label}`]);
  } catch {
    return null;
  }
}
