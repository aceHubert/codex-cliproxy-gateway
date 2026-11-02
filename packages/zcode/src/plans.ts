import fs from "node:fs";
import path from "node:path";

/** ZCode billing/balance 返回的可用模型能力。 */
export interface ZcodeBillingPlanModels {
  planId: string;
  name: string;
  status: string;
  modelIds: readonly string[];
}

/** ZCode 客户端用于把 billing 计划归入 Start Plan 的字符串规则。 */
export function isZcodeStartPlanIdentity(planId: unknown, name: unknown): boolean {
  const id = typeof planId === "string" ? planId.trim().toLowerCase() : "";
  const label = typeof name === "string" ? name.trim().toLowerCase() : "";
  // billing 端的 start-plan 实例通常由 plan_id 标识；name 仅作为兜底。
  // 两个字段都为空时沿用客户端的默认归类，但仍由调用方单独校验 active 状态。
  return !id && !label || id.includes("start-plan") || label.includes("start plan");
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function modelIds(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  const ids = value.flatMap((capability) => {
    if (typeof capability !== "string" || !capability.startsWith("model:")) return [];
    const id = capability.slice("model:".length).trim();
    return id && /^[\x20-\x7e]+$/.test(id) ? [id] : [];
  });
  const seen = new Set<string>();
  return ids.filter((id) => {
    const key = id.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * 从 billing/balance 的原始 JSON 中提取当前有效 Start Plan 实例的模型能力。
 *
 * 这里只消费公开的套餐元数据，不保留 balances、token 或任何凭据；未知字段和
 * 非模型 capability 会被忽略。个人/团队 Coding Plan 不从此接口推断，调用方仍需把
 * planId 映射到已解析的本地 Start provider。
 */
export function parseZcodeBillingPlans(value: unknown): ZcodeBillingPlanModels[] {
  const root = record(value) && record(value.data) ? value.data : value;
  const plans = record(root) && Array.isArray(root.plans) ? root.plans : [];
  return plans.flatMap((plan): ZcodeBillingPlanModels[] => {
    if (!record(plan)) return [];
    const status = typeof plan.status === "string" ? plan.status.trim() : "";
    const planId = typeof plan.plan_id === "string" ? plan.plan_id.trim() : "";
    const name = typeof plan.name === "string" ? plan.name.trim() : "";
    if (status !== "active" || !isZcodeStartPlanIdentity(plan.plan_id, plan.name)
      || !planId || !name || !Array.isArray(plan.entitlements)) return [];
    const models = plan.entitlements.flatMap((entitlement) =>
      record(entitlement) ? modelIds(entitlement.capabilities) : []);
    const seen = new Set<string>();
    const unique = models.filter((id) => {
      const key = id.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return unique.length ? [{ planId, name, status, modelIds: unique }] : [];
  });
}

/** 汇总多个有效套餐的模型能力，按模型 ID 大小写不敏感去重。 */
export function mergeZcodeBillingModelIds(plans: readonly ZcodeBillingPlanModels[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const plan of plans) for (const id of plan.modelIds) {
    const key = id.toLowerCase();
    if (!seen.has(key)) { seen.add(key); result.push(id); }
  }
  return result;
}

/**
 * 宿主日志尾部扫描窗口：ZCode 宿主分钟级追加 billing 记录，1MB 覆盖全天记录量；
 * 窗口外更早的记录不参与判定（视为无信号，保持现状）。有界读取，避免整文件扫描。
 */
const HOST_LOG_TAIL_BYTES = 1024 * 1024;

/** 当天日志文件名（宿主按本地时区日期滚动，与 LocalQuotaBar 实证路径一致）。 */
function hostLogFileName(date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}.log`;
}

/** 只读文件尾部；返回文本与是否发生截断，文件缺失或不可读返回 undefined。 */
function readFileTail(file: string, bytes: number): { text: string; truncated: boolean } | undefined {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size === 0) return undefined;
    const length = Math.min(stat.size, bytes);
    const buffer = Buffer.alloc(length);
    const fd = fs.openSync(file, "r");
    try {
      fs.readSync(fd, buffer, 0, length, stat.size - length);
    } finally {
      fs.closeSync(fd);
    }
    return { text: buffer.toString("utf8"), truncated: length < stat.size };
  } catch {
    return undefined;
  }
}

/** 宿主日志里 Start Plan 记录的 providerId 形态：builtin:<family>-start-plan 或 account:<family>-start-plan。 */
function isStartPlanLogProviderID(providerID: unknown, family: string): boolean {
  if (typeof providerID !== "string") return false;
  const lowered = providerID.trim().toLowerCase();
  return lowered === `builtin:${family}-start-plan` || lowered === `account:${family}-start-plan`;
}

/**
 * 读取 `~/.zcode/v2/logs/<当天>.log` 尾部最后一条 Start Plan 的 billing/balance 响应。
 * ZCode 宿主进程周期性拉取 billing 并把完整 payload 落盘（权威的权益判定结果，与
 * LocalQuotaBar 同源），这里只消费该公开元数据，不触碰凭据。返回 undefined 表示当天
 * 无可用信号（宿主未运行、日志缺失或尾部窗口内无匹配行），调用方应保持现状。
 */
export function latestZcodeStartPlanBillingPayload(home: string, family: string): unknown {
  const tail = readFileTail(path.join(home, "v2", "logs", hostLogFileName()), HOST_LOG_TAIL_BYTES);
  if (!tail) return undefined;
  const lines = tail.text.split("\n");
  // 窗口截断时首行必是被拦腰截断的半行，丢弃；其余行倒序找最新记录。
  for (let index = lines.length - 1; index >= (tail.truncated ? 1 : 0); index--) {
    const line = lines[index]!;
    const marker = line.indexOf("billing/balance");
    if (marker < 0) continue;
    const body = line.indexOf("{", marker);
    if (body < 0) continue;
    let record: unknown;
    try {
      record = JSON.parse(line.slice(body));
    } catch {
      continue;
    }
    if (!record || typeof record !== "object" || Array.isArray(record)) continue;
    const fields = record as Record<string, unknown>;
    if (!isStartPlanLogProviderID(fields.providerId, family)) continue;
    if (fields.payload === undefined || fields.payload === null) continue;
    return fields.payload;
  }
  return undefined;
}

/**
 * 由宿主日志判定 Start Plan 当前是否仍有有效权益实例：
 * - 记录存在且能解析出 active 且带模型能力的计划 → true（发布免费档目录）；
 * - 记录存在但解析为空（计划到期后宿主拉到空 plans/balances）→ false（撤下条目）；
 * - 无记录（undefined）→ 不干预，沿用「条目常驻、上游 405/3012 拒绝」的现状。
 */
export function zcodeStartPlanEntitledFromLog(home: string, family: string): boolean | undefined {
  const payload = latestZcodeStartPlanBillingPayload(home, family);
  if (payload === undefined) return undefined;
  return parseZcodeBillingPlans(payload).length > 0;
}
