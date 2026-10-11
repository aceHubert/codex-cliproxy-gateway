import { createDecipheriv, createHash } from "node:crypto";
import os from "node:os";

const ENCRYPTED_PREFIX = "enc:v1:";
const CIPHER_ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

function invalid(message: string): never {
  throw new Error(message);
}

function credentialSecret(env: NodeJS.ProcessEnv): string {
  if (env.ZCODE_CREDENTIAL_SECRET) return env.ZCODE_CREDENTIAL_SECRET;
  let username = "unknown";
  try { username = os.userInfo().username; } catch { /* 与 ZCode 保持一致，失败时使用 unknown。 */ }
  return `zcode-credential-fallback:${os.platform()}:${os.homedir()}:${username}`;
}

/** ZCode 使用机器派生密钥加密 credentials.json；解密结果只留在当前调用栈内。 */
export function decryptZcodeCredential(value: string, env: NodeJS.ProcessEnv = process.env): string {
  if (!value.startsWith(ENCRYPTED_PREFIX)) return value;
  const parts = value.slice(ENCRYPTED_PREFIX.length).split(".");
  const [iv, authTag, ciphertext] = parts;
  if (parts.length !== 3 || !iv || !authTag || !ciphertext) invalid("ZCode 凭据密文格式无效");
  const ivBuffer = Buffer.from(iv, "base64url");
  const authTagBuffer = Buffer.from(authTag, "base64url");
  const ciphertextBuffer = Buffer.from(ciphertext, "base64url");
  if (ivBuffer.length !== IV_LENGTH) invalid("ZCode 凭据 IV 无效");
  if (authTagBuffer.length !== AUTH_TAG_LENGTH) invalid("ZCode 凭据认证标签无效");
  const decipher = createDecipheriv(
    CIPHER_ALGORITHM,
    createHash("sha256").update(credentialSecret(env)).digest(),
    ivBuffer,
  );
  decipher.setAuthTag(authTagBuffer);
  try {
    return Buffer.concat([decipher.update(ciphertextBuffer), decipher.final()]).toString("utf8");
  } catch {
    invalid("ZCode 凭据解密失败");
  }
}
