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
