import type { ZcodeFamily } from "./config.ts";
import { decryptZcodeCredential } from "./credential-cipher.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function decryptedText(value: unknown, env: NodeJS.ProcessEnv): string {
  if (typeof value !== "string" || !value.trim()) return "";
  try {
    return decryptZcodeCredential(value, env).trim();
  } catch {
    return "";
  }
}

/** 个人 Coding Plan 优先读取当前账号身份对应的 account-provider 缓存 Key。 */
export function readZcodeIndividualApiKey(
  credentials: Record<string, unknown>,
  family: ZcodeFamily,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const oauthProvider = family === "zai" ? "zai" : "zhipu";
  try {
    const profile: unknown = JSON.parse(decryptedText(credentials[`oauth:${oauthProvider}:user_info`], env));
    const accountIdentity = isRecord(profile) && typeof profile.id === "string" ? profile.id.trim() : "";
    if (!accountIdentity) return "";
    const provider = encodeURIComponent(`account:${family}-individual-coding-plan`);
    const key = `account-provider:coding-plan:${provider}:account:${encodeURIComponent(accountIdentity)}:api-key`;
    return decryptedText(credentials[key], env);
  } catch {
    return "";
  }
}
