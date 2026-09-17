import fs from "node:fs";
import path from "node:path";

type JsonObject = Record<string, unknown>;

interface JsonSchema {
  type?: "object" | "array" | "string" | "number" | "integer" | "boolean";
  required?: string[];
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  pattern?: string;
  format?: "uri";
  uniqueItems?: boolean;
  enum?: (string | number)[];
}

const CONFIG_SCHEMA = JSON.parse(fs.readFileSync(
  path.resolve(import.meta.dir, "../schemas/gateway-config.schema.json"),
  "utf8",
)) as JsonSchema;
const PACKAGE_JSON = JSON.parse(fs.readFileSync(
  path.resolve(import.meta.dir, "../package.json"),
  "utf8",
)) as { version?: unknown };

export const GATEWAY_CONFIG_SCHEMA_URL =
  "https://raw.githubusercontent.com/aceHubert/codex-cliproxy/main/schemas/gateway-config.schema.json";
export const GATEWAY_CONFIG_VERSION = String(PACKAGE_JSON.version ?? "unknown");

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface LegacyFieldMigration {
  /** 旧字段名（config.json 历史键）。 */
  old: string;
  /** 新字段名。 */
  next: string;
  /** 旧值类型判定：不合法（如被手改成其他类型）时不迁移，交由 schema 软告警。 */
  valid: (value: unknown) => boolean;
  /** 结构迁移时提取新字段值；普通更名直接保留原值。 */
  convert?: (value: unknown) => unknown;
}

/**
 * 配置兼容迁移表：历史字段更名只需在此登记一条，读取归一化（loadGatewayConfig）
 * 与命令前置的文件级迁移（syncGatewayConfigFile 删除旧键 + 审计）都会自动生效。
 */
export const LEGACY_FIELD_MIGRATIONS: readonly LegacyFieldMigration[] = [
  { old: "cliproxyBaseUrl", next: "upstreamBaseUrl", valid: (value) => typeof value === "string" },
  { old: "cpaOnly", next: "upstreamOnly", valid: (value) => typeof value === "boolean" },
  { old: "upstream_type", next: "upstreamType", valid: (value) => typeof value === "string" },
  {
    old: "zai",
    next: "zcode",
    valid: (value) => isJsonObject(value) && typeof value.enabled === "boolean",
    convert: (value) => (value as JsonObject).enabled,
  },
];

/**
 * 读取配置时把旧字段值补齐为新键（就地修改，保留旧键供文件级迁移判断）；
 * 迁移只发生在新键缺失且旧值类型合法时，绝不覆盖用户已写的新值。
 */
export function migrateLegacyConfig(config: JsonObject): JsonObject {
  for (const { old, next, valid, convert } of LEGACY_FIELD_MIGRATIONS) {
    if (config[next] === undefined && valid(config[old])) {
      config[next] = convert ? convert(config[old]) : config[old];
    }
  }
  return config;
}

export function mergeMissingConfig(
  current: JsonObject,
  additions: JsonObject,
  prefix = "",
): { config: JsonObject; added: string[] } {
  const config = { ...current };
  const added: string[] = [];
  for (const [key, value] of Object.entries(additions)) {
    const keyPath = prefix ? `${prefix}.${key}` : key;
    if (!Object.hasOwn(config, key)) {
      config[key] = structuredClone(value);
      added.push(keyPath);
    } else if (isJsonObject(config[key]) && isJsonObject(value)) {
      const nested = mergeMissingConfig(config[key], value, keyPath);
      config[key] = nested.config;
      added.push(...nested.added);
    }
  }
  return { config, added };
}

function matchesType(value: unknown, type: NonNullable<JsonSchema["type"]>): boolean {
  if (type === "object") return isJsonObject(value);
  if (type === "array") return Array.isArray(value);
  if (type === "integer") return typeof value === "number" && Number.isInteger(value);
  return typeof value === type;
}

function validate(value: unknown, schema: JsonSchema, location: string, warnings: string[]): void {
  if (schema.type && !matchesType(value, schema.type)) {
    warnings.push(`${location} should be ${schema.type}`);
    return;
  }
  if (schema.enum && !schema.enum.includes(value as string | number)) {
    warnings.push(`${location} should be one of ${schema.enum.join(", ")}`);
    return;
  }
  if (isJsonObject(value)) {
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key)) warnings.push(`${location}.${key} is required`);
    }
    for (const [key, childSchema] of Object.entries(schema.properties ?? {})) {
      if (Object.hasOwn(value, key)) validate(value[key], childSchema, `${location}.${key}`, warnings);
    }
  }
  if (Array.isArray(value)) {
    if (schema.items) {
      value.forEach((item, index) => validate(item, schema.items!, `${location}[${index}]`, warnings));
    }
    if (schema.uniqueItems && new Set(value.map((item) => JSON.stringify(item))).size !== value.length) {
      warnings.push(`${location} should not contain duplicates`);
    }
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) warnings.push(`${location} should be >= ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) warnings.push(`${location} should be <= ${schema.maximum}`);
  }
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) warnings.push(`${location} should not be empty`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) warnings.push(`${location} has an invalid format`);
    if (schema.format === "uri") {
      try {
        new URL(value);
      } catch {
        warnings.push(`${location} should be a valid URI`);
      }
    }
  }
}

export function gatewayConfigWarnings(value: unknown): string[] {
  const warnings: string[] = [];
  validate(value, CONFIG_SCHEMA, "$", warnings);
  return warnings;
}
