import { validateZcodeConfig } from "@agent-proxy/zcode";
import { validateCodebuddyAccount, validateCodebuddyConfig } from "@agent-proxy/codebuddy";
import { validateQoderConfig } from "@agent-proxy/qoder";
import { validateAgyConfig } from "@agent-proxy/agy";
import { validateOpencodeZenConfig } from "@agent-proxy/opencode-zen";
import { AGENT_DEFAULTS, agentConfigEnabled } from "./config.ts";
import type { GatewayConfig } from "./types.ts";

const validators = {
  zcode: validateZcodeConfig,
  codebuddy: validateCodebuddyConfig,
  qoder: validateQoderConfig,
  agy: validateAgyConfig,
  opencodeZen: validateOpencodeZenConfig,
} satisfies Record<keyof typeof AGENT_DEFAULTS, (config: GatewayConfig) => void>;

/** 开关归网关所有；仅校验将要装配的插件，关闭时仍检查账号配置的合法性。 */
export function validateConfiguredPlugins(config: GatewayConfig): void {
  const keys = Object.keys(AGENT_DEFAULTS) as Array<keyof typeof AGENT_DEFAULTS>;
  for (const key of keys) {
    if (config[key] !== undefined && typeof config[key] !== "boolean") {
      throw new Error(`${key} 必须为 boolean`);
    }
  }
  validateCodebuddyAccount(config.codebuddyAccount);
  for (const key of keys) {
    if (agentConfigEnabled(config, key)) validators[key](config);
  }
}
