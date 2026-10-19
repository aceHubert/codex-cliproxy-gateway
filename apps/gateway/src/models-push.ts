import fs from "node:fs";
import type { GatewayConfig, ModelEntry } from "./types.ts";
import { filterExcludedModels } from "./catalog.ts";
import { isInstalledPluginModel } from "./gateway-composition.ts";
import { atomicWrite } from "./toml.ts";

/** 推送备份文件的时间戳（YYYYMMDDhhmmss，与 install 的 config.toml 备份同格式）。 */
export function pushTimestamp(date = new Date()): string {
  return date.toISOString().replace(/[-:]/g, "").slice(0, 15).replace("T", "");
}

/**
 * 备份并写入：内容与磁盘一致时跳过（不产生备份），否则先把原文件复制为
 * `<file>.bak-agent-proxy-<时间戳>` 再原子替换。调用方保证 file 已存在。
 */
export function writeIfChanged(file: string, contents: string): string | undefined {
  if (fs.existsSync(file) && fs.readFileSync(file, "utf8") === contents) return undefined;
  const backup = `${file}.bak-agent-proxy-${pushTimestamp()}`;
  fs.copyFileSync(file, backup);
  atomicWrite(file, contents);
  return backup;
}

/**
 * 按序写入多个文件（各自值未变则跳过且不产生备份）；任一步失败时把本批已写入
 * 的文件从各自的写前备份恢复，保持多文件一致。成功路径与逐个 writeIfChanged
 * 完全相同。调用方保证所有 file 均已存在。
 */
export function writeAllOrRollback(entries: ReadonlyArray<{ file: string; contents: string }>): string[] {
  const written: Array<{ file: string; backup: string }> = [];
  try {
    for (const { file, contents } of entries) {
      const backup = writeIfChanged(file, contents);
      if (backup !== undefined) written.push({ file, backup });
    }
  } catch (error) {
    const unrestored: string[] = [];
    for (const { file, backup } of written) {
      try {
        fs.copyFileSync(backup, file);
      } catch {
        unrestored.push(file);
      }
    }
    if (unrestored.length === 0) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${message}; failed to restore: ${unrestored.join(", ")} (their backups remain beside the files)`);
  }
  return written.map((item) => item.backup);
}

/** 模型条目的 reasoning 档位（supported_reasoning_levels 的 effort 名，保序去重）。 */
export function modelReasoningEfforts(entry: ModelEntry): string[] {
  const raw: unknown = entry.supported_reasoning_levels;
  if (!Array.isArray(raw)) return [];
  const efforts: string[] = [];
  for (const item of raw) {
    const effort = typeof item === "string"
      ? item
      : item && typeof item === "object" && typeof (item as Record<string, unknown>).effort === "string"
        ? (item as Record<string, unknown>).effort
        : undefined;
    if (typeof effort === "string" && effort && !efforts.includes(effort)) efforts.push(effort);
  }
  return efforts;
}

/** 模型条目的上下文窗口（context_window 优先，其次 max_context_window；无效值视为缺失）。 */
export function modelContextWindow(entry: ModelEntry): number | undefined {
  for (const key of ["context_window", "max_context_window"] as const) {
    const value = entry[key];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  }
  return undefined;
}

/** 模型条目的输入模态（仅认 text/image；缺省视为纯文本）。 */
export function modelInputModalities(entry: ModelEntry): string[] {
  const raw: unknown = entry.input_modalities;
  if (!Array.isArray(raw)) return ["text"];
  const modalities = raw.filter((item): item is string => item === "text" || item === "image");
  return modalities.length > 0 ? [...new Set(modalities)] : ["text"];
}

/** 单个客户端工具推送目标的执行结果：summary 一行汇总，notes 为其后的附注行。 */
export interface ModelPushOutcome {
  summary: string;
  notes: string[];
}

/**
 * 客户端工具推送目标契约。assertInstalled 只判定「本机是否安装」（未安装抛
 * 说明错误）；「已安装但缺受管 provider」属于配置指引，由 push 内抛出。
 */
export interface ModelPushTarget {
  readonly id: string;
  assertInstalled(): void;
  push(models: readonly ModelEntry[]): ModelPushOutcome;
}

export interface ModelPushOptions {
  /** 目标子集（逗号分隔 id，大小写不敏感）；缺省推送全部已知目标。 */
  targetOption?: string;
  /** collectCompatibleModels 的快照条目与失败来源（采集已在调用方完成）。 */
  entries: readonly ModelEntry[];
  failures: readonly string[];
  config: GatewayConfig;
  targets: readonly ModelPushTarget[];
}

/**
 * `models --push` 的统一落地：应用 excludedModels（作用域限本地插件模型）后把
 * 清单逐目标写入。推送镜像的是"网关当前实际可用"：某插件目录不可用（如本机登录
 * 缺失）时其模型本就调不通，降级为警告后继续（与 models 无参视图口径一致）；
 * 清单为空仍中止。单目标失败不影响其余目标，全部执行完后若有失败再以非零退出汇总。
 */
export async function pushModelsToTargets(options: ModelPushOptions): Promise<void> {
  for (const failure of options.failures) {
    console.log(`WARNING: ${failure}; its models are not included in this push.`);
  }
  const scoped = filterExcludedModels(
    { models: [...options.entries] },
    options.config.excludedModels,
    isInstalledPluginModel,
  ).models;
  if (scoped.length === 0) {
    throw new Error(
      "model push aborted; no local adapter models to push"
      + " (enable an adapter via config --zcode on / --codebuddy on / … and refresh its catalog first)",
    );
  }

  const known = options.targets.map((target) => target.id);
  const requested = options.targetOption === undefined
    ? known
    : [...new Set(options.targetOption.split(",").map((id) => id.trim().toLowerCase()).filter(Boolean))];
  if (requested.length === 0) throw new Error("--push requires at least one target name (or no value to push every target)");
  const selected = requested.map((id) => {
    const target = options.targets.find((candidate) => candidate.id === id);
    if (!target) throw new Error(`unknown --push target "${id}"; available targets: ${known.join(", ")}`);
    return target;
  });

  const failed: string[] = [];
  for (const target of selected) {
    try {
      target.assertInstalled();
      const outcome = target.push(scoped);
      console.log(outcome.summary);
      for (const note of outcome.notes) console.log(`  ${note}`);
    } catch (error) {
      failed.push(target.id);
      const message = error instanceof Error ? error.message : String(error);
      console.log(`WARNING: ${target.id} push failed: ${message}`);
    }
  }
  if (failed.length > 0) throw new Error(`model push failed for: ${failed.join(", ")} (see warnings above)`);
}
