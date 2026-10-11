import fs from "node:fs";
import { isJsonObject, migrateLegacyConfig } from "./config.ts";
import type { GatewayConfig } from "./types.ts";

/** 读取与迁移配置不依赖业务装配或 agent，供模型重载核心独立消费。 */
export function readGatewayConfigFile(file: string): GatewayConfig {
  const value = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
  if (!isJsonObject(value)) throw new Error(`Gateway config must be a JSON object: ${file}`);
  migrateLegacyConfig(value);
  return value as unknown as GatewayConfig;
}
