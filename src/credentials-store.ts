import fs from "node:fs";
import { atomicWrite } from "./toml.ts";

/** credentials.json 的形状版本；将来增加凭据字段时递增版本并在读取侧迁移。 */
const CREDENTIALS_FILE_VERSION = 1;

interface CredentialsFile {
  version: number;
  upstream_api_key?: string;
}

/**
 * 非 darwin 平台的密钥后端：上游 API key 以明文存入 credentials.json（0600、原子写）。
 * 平台分派见 keychain.ts；这里实现为接受路径的纯函数，测试直接注入临时文件路径。
 */

export function saveUpstreamApiKey(file: string, apiKey: string): void {
  atomicWrite(file, `${JSON.stringify({ version: CREDENTIALS_FILE_VERSION, upstream_api_key: apiKey }, null, 2)}\n`);
}

/**
 * 读取上游 API key。`optional` 只豁免「文件不存在（ENOENT）/ key 为空」（loopback 部署
 * 允许无 key）；其余读取失败（路径被目录占用、权限不可读等）与损坏错误一律带路径和
 * 原因抛出，绝不静默当作缺失，否则网关会带着空 Authorization 启动、把鉴权失败推迟到
 * 上游才暴露。
 */
export function readUpstreamApiKey(file: string, optional = false): string {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
    if (code === "ENOENT") {
      if (optional) return "";
      throw new Error(
        `Upstream API key was not found: ${file} is missing. Run install again, or create it as {"version":${CREDENTIALS_FILE_VERSION},"upstream_api_key":"<key>"}`,
      );
    }
    throw new Error(
      `Credentials file ${file} could not be read (${code ?? "unknown error"}); make sure the path is a readable file, or delete it and run install again`,
      { cause: error },
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Credentials file ${file} is corrupted (invalid JSON); delete it and run install again`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw corruptedShape(file);
  }
  const credentials = parsed as CredentialsFile;
  if (
    credentials.version !== CREDENTIALS_FILE_VERSION
    || (credentials.upstream_api_key !== undefined && typeof credentials.upstream_api_key !== "string")
  ) {
    throw corruptedShape(file);
  }
  const apiKey = credentials.upstream_api_key ?? "";
  if (!apiKey && !optional) {
    throw new Error(
      `Upstream API key was not found: ${file} has an empty upstream_api_key. Run install again or fill in the key`,
    );
  }
  return apiKey;
}

function corruptedShape(file: string): Error {
  return new Error(
    `Credentials file ${file} has an unsupported shape (expected {"version":${CREDENTIALS_FILE_VERSION},"upstream_api_key":"..."}); delete it and run install again`,
  );
}

/** 幂等删除：与 Keychain 后端的卸载语义一致，文件不存在时静默成功。 */
export function deleteUpstreamApiKey(file: string): void {
  fs.rmSync(file, { force: true });
}
