import { execFileSync } from "node:child_process";
import os from "node:os";
import type { StdioOptions } from "node:child_process";
import { resolvePaths } from "./paths.ts";
import { deleteUpstreamApiKey, readUpstreamApiKey, saveUpstreamApiKey } from "./credentials-store.ts";

export const KEYCHAIN_SERVICE = "codex-cliproxy-gateway";

export function keychainAccount(): string {
  return process.env.USER || os.userInfo().username;
}

function security(args: string[], stdio: StdioOptions = ["ignore", "pipe", "pipe"]): string {
  return execFileSync("/usr/bin/security", args, {
    encoding: "utf8",
    stdio,
  }).trim();
}

function saveApiKeyInKeychain(apiKey: string): void {
  security([
    "add-generic-password",
    "-U",
    "-a",
    keychainAccount(),
    "-s",
    KEYCHAIN_SERVICE,
    "-w",
    apiKey,
  ]);
}

function readApiKeyFromKeychain(optional = false): string {
  try {
    return security([
      "find-generic-password",
      "-a",
      keychainAccount(),
      "-s",
      KEYCHAIN_SERVICE,
      "-w",
    ]);
  } catch {
    if (optional) return "";
    throw new Error("Upstream API key was not found in macOS Keychain");
  }
}

function deleteApiKeyFromKeychain(): void {
  try {
    security([
      "delete-generic-password",
      "-a",
      keychainAccount(),
      "-s",
      KEYCHAIN_SERVICE,
    ]);
  } catch {
    // Idempotent uninstall.
  }
}

/** 上游 API key 的存取后端：save 覆盖写、read 缺失时的 optional 豁免、delete 幂等。 */
export interface ApiKeyStore {
  save(apiKey: string): void;
  read(optional?: boolean): string;
  delete(): void;
}

/**
 * 平台分派工厂：darwin 走 macOS Keychain，其余平台（linux 等）走 credentials.json 文件后端。
 * platform 与 credentialsFile 可注入，保证在 macOS 开发机上也能覆盖文件后端分支；
 * 生产调用方统一走下方的 saveApiKey/readApiKey/deleteApiKey 便捷包装。
 */
export function createApiKeyStore(
  platform: NodeJS.Platform = process.platform,
  credentialsFile: string = resolvePaths().credentialsFile,
): ApiKeyStore {
  if (platform === "darwin") {
    return {
      save: saveApiKeyInKeychain,
      read: readApiKeyFromKeychain,
      delete: deleteApiKeyFromKeychain,
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
