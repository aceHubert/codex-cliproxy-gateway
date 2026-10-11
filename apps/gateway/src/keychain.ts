import { execFileSync } from "node:child_process";
import os from "node:os";
import type { StdioOptions } from "node:child_process";
import { resolvePaths } from "./paths.ts";
import { deleteUpstreamApiKey, readUpstreamApiKey, saveUpstreamApiKey } from "./credentials-store.ts";

export const KEYCHAIN_SERVICE = "codex-cliproxy-gateway";

/**
 * 上游 API key 的 Keychain 服务名：默认实例沿用历史槽位（存量安装零迁移），
 * 其他实例加与 launchd label 相同的主目录哈希后缀——不同实例的密钥互不覆盖，
 * 非默认实例也绝不回退读取默认槽位。
 */
export function keychainService(): string {
  return KEYCHAIN_SERVICE + resolvePaths().instanceSuffix;
}

export function keychainAccount(): string {
  return process.env.USER || os.userInfo().username;
}

function security(args: string[], stdio: StdioOptions = ["ignore", "pipe", "pipe"]): string {
  return execFileSync("/usr/bin/security", args, {
    encoding: "utf8",
    stdio,
  }).trim();
}

function saveApiKeyInKeychain(apiKey: string, account: string, service: string, execute: KeychainExecutor): void {
  execute([
    "add-generic-password",
    "-U",
    "-a",
    account,
    "-s",
    service,
    "-w",
    apiKey,
  ]);
}

function readApiKeyFromKeychain(optional: boolean, account: string, service: string, execute: KeychainExecutor): string {
  try {
    return execute([
      "find-generic-password",
      "-a",
      account,
      "-s",
      service,
      "-w",
    ]);
  } catch {
    if (optional) return "";
    throw new Error(`Upstream API key was not found in macOS Keychain (service: ${service})`);
  }
}

function deleteApiKeyFromKeychain(account: string, service: string, execute: KeychainExecutor): void {
  try {
    execute([
      "delete-generic-password",
      "-a",
      account,
      "-s",
      service,
    ]);
  } catch {
    // 卸载可重复执行，槽位已不存在时无需报错。
  }
}

/** 上游 API key 的存取后端：save 覆盖写、read 缺失时的 optional 豁免、delete 幂等。 */
export interface ApiKeyStore {
  save(apiKey: string): void;
  read(optional?: boolean): string;
  delete(): void;
}

/** 可注入的 Keychain 执行器，供测试记录调用而不接触系统凭据。 */
export type KeychainExecutor = (args: string[]) => string;

/**
 * 平台分派工厂：darwin 走 macOS Keychain，其余平台（linux 等）走 credentials.json 文件后端。
 * platform、credentialsFile 与 Keychain 执行器可注入，测试不必触碰系统凭据；
 * 生产调用方统一走下方的 saveApiKey/readApiKey/deleteApiKey 便捷包装。
 */
export function createApiKeyStore(
  platform: NodeJS.Platform = process.platform,
  credentialsFile: string = resolvePaths().credentialsFile,
  executeKeychain: KeychainExecutor = security,
): ApiKeyStore {
  if (platform === "darwin") {
    // 存储对象创建时固定槽位，后续异步调用切换实例或用户环境也不会串槽。
    const account = keychainAccount();
    const service = keychainService();
    return {
      save: (apiKey) => saveApiKeyInKeychain(apiKey, account, service, executeKeychain),
      read: (optional = false) => readApiKeyFromKeychain(optional, account, service, executeKeychain),
      delete: () => deleteApiKeyFromKeychain(account, service, executeKeychain),
    };
  }
  return {
    save: (apiKey) => saveUpstreamApiKey(credentialsFile, apiKey),
    read: (optional = false) => readUpstreamApiKey(credentialsFile, optional),
    delete: () => deleteUpstreamApiKey(credentialsFile),
  };
}

export function saveApiKey(apiKey: string): void {
  createApiKeyStore().save(apiKey);
}

export function readApiKey(optional = false): string {
  return createApiKeyStore().read(optional);
}

export function deleteApiKey(): void {
  createApiKeyStore().delete();
}
