import type { ZcodeFamily } from "./config.ts";
import { decryptZcodeCredential } from "./credential-cipher.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * 个人 Coding Plan 的账号身份与 Key 解析结果。
 * - absent：没有任何 user_info，允许旧安装回退 config 镜像；
 * - available：账号身份和对应 Key 都可用；
 * - unavailable：身份存在但损坏，或当前账号的 Key 缺失/不可解密，禁止回退。
 */
export type ZcodeIndividualCredential =
  | { state: "absent" }
  | { state: "available"; identity: string; apiKey: string }
  | { state: "unavailable"; identity?: string };

/** 读取当前账号身份对应的个人 Coding Plan Key。 */
export function readZcodeIndividualCredential(
  credentials: Record<string, unknown>,
  family: ZcodeFamily,
  env: NodeJS.ProcessEnv = process.env,
): ZcodeIndividualCredential {
  const rawProfile = credentials[`oauth:${family}:user_info`];
  if (rawProfile === undefined || rawProfile === null) return { state: "absent" };
  if (typeof rawProfile !== "string" || !rawProfile.trim()) return { state: "unavailable" };
  let profile: unknown;
  try {
    profile = JSON.parse(decryptZcodeCredential(rawProfile, env));
  } catch {
    return { state: "unavailable" };
  }
  // ZCode 3.14 的 user_info 使用 `user_id`；部分旧布局/接口写 `id`，
  // 再兜底 email 只用于识别账号变化，不参与 Key 名拼接之外的任何输出。
  const accountIdentity = isRecord(profile)
    ? [profile.id, profile.user_id, profile.email]
      .find((value): value is string => typeof value === "string" && Boolean(value.trim()))
      ?.trim() ?? ""
    : "";
  if (!accountIdentity) return { state: "unavailable" };
  const provider = `account:${family}-individual-coding-plan`;
  const key = credentials[`account-provider:coding-plan:${provider}:account:${encodeURIComponent(accountIdentity)}:api-key`];
  if (typeof key !== "string" || !key.trim()) return { state: "unavailable", identity: accountIdentity };
  try {
    const apiKey = decryptZcodeCredential(key, env).trim();
    return apiKey ? { state: "available", identity: accountIdentity, apiKey } : { state: "unavailable", identity: accountIdentity };
  } catch {
    return { state: "unavailable", identity: accountIdentity };
  }
}
