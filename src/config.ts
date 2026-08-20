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
