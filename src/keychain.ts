import { execFileSync } from "node:child_process";
import os from "node:os";
import type { StdioOptions } from "node:child_process";

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

export function saveApiKey(apiKey: string): void {
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

export function readApiKey(): string {
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
    throw new Error("CLIProxy API key was not found in macOS Keychain");
  }
}

export function deleteApiKey(): void {
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
