import test from "./host-test.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  isZcodeStartPlanIdentity,
  latestZcodeStartPlanBillingPayload,
  mergeZcodeBillingModelIds,
  parseZcodeBillingPlans,
  zcodeStartPlanEntitledFromLog,
} from "@agent-proxy/zcode/plans";

test("Start Plan 依据 plan_id/name 的字符串规则归类", () => {
  assert.equal(isZcodeStartPlanIdentity("zcode-v3-start-plan-wk-0918", "ZCode Weekend Build"), true);
  assert.equal(isZcodeStartPlanIdentity("", "Weekend Start Plan"), true);
  assert.equal(isZcodeStartPlanIdentity("coding-plan-pro", "Coding Plan"), false);
  assert.equal(isZcodeStartPlanIdentity("", ""), true);
});

test("billing plans 只提取 active 套餐的 model capabilities", () => {
  const plans = parseZcodeBillingPlans({ data: { plans: [
    { plan_id: "zcode-start-plan-a", name: "Start", status: "active", entitlements: [
      { capabilities: ["model:GLM-5.3-Flash", "quota:tokens", "model:glm-5.3-flash"] },
    ] },
    { plan_id: "expired", name: "Expired", status: "expired", entitlements: [
      { capabilities: ["model:glm-4"] },
    ] },
    { plan_id: "coding-plan-pro", name: "Coding Plan", status: "active", entitlements: [
      { capabilities: ["model:glm-5"] },
    ] },
    { plan_id: "empty", name: "Empty", status: "active", entitlements: [
      { capabilities: ["quota:tokens"] },
    ] },
  ] } });
  assert.deepEqual(plans, [{ planId: "zcode-start-plan-a", name: "Start", status: "active", modelIds: ["GLM-5.3-Flash"] }]);
  assert.deepEqual(mergeZcodeBillingModelIds(plans), ["GLM-5.3-Flash"]);
});

test("billing model capabilities 支持多个套餐并集且大小写去重", () => {
  const plans = parseZcodeBillingPlans({ plans: [
    { plan_id: "zcode-start-plan-a", name: "A", status: "active", entitlements: [{ capabilities: ["model:glm-5.3", "model:glm-5.3-flash"] }] },
    { plan_id: "zcode-start-plan-b", name: "B", status: "active", entitlements: [{ capabilities: ["model:GLM-5.3-FLASH", "model:glm-4"] }] },
  ] });
  assert.deepEqual(mergeZcodeBillingModelIds(plans), ["glm-5.3", "glm-5.3-flash", "glm-4"]);
});

/** 宿主日志行构造：marker 后的 JSON 是记录体（providerId + payload），与 ZCode 宿主落盘格式一致。 */
function billingLine(providerId: string, payload: unknown): string {
  return `[2026-11-02 14:23:27.121] [info] [host-log] [usage-stats] billing/balance 请求完成 ${JSON.stringify({ providerId, payload })}`;
}

const activeStartPlanPayload = { code: 0, msg: "", data: { plans: [
  { user_plan_id: "upl_1", plan_id: "zcode-v3-start-plan-1030-wk", name: "ZCODE WEEKEND BUILD", status: "active",
    starts_at: 1790000000, ends_at: 1793600000,
    entitlements: [{ entitlement_id: "ent-1", capabilities: ["model:glm-5.3-flash"], show_name: "GLM-5.3-Flash" }] },
], balances: [] } };
const emptyStartPlanPayload = { code: 0, msg: "", data: { server_time: 1793600524, plans: [], balances: [] } };

function withHostLog(lines: readonly string[], run: (home: string) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-plans-log-"));
  try {
    fs.mkdirSync(path.join(root, "v2", "logs"), { recursive: true });
    const now = new Date();
    const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    fs.writeFileSync(path.join(root, "v2", "logs", `${date}.log`), `${lines.join("\n")}\n`);
    run(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("宿主日志最后一条 start-plan billing 记录判定免费档权益", () => {
  // 计划到期：active 记录之后宿主拉到空 plans → 取最后一条 → 无权益。
  withHostLog([
    billingLine("account:zai-start-plan", activeStartPlanPayload),
    billingLine("account:zai-start-plan", emptyStartPlanPayload),
  ], (home) => {
    assert.equal(zcodeStartPlanEntitledFromLog(home, "zai"), false);
  });
  // 新计划开始：空记录之后恢复 active（builtin 前缀同样匹配）→ 有权益，payload 可被解析器消费。
  withHostLog([
    billingLine("account:zai-start-plan", emptyStartPlanPayload),
    billingLine("builtin:zai-start-plan", activeStartPlanPayload),
  ], (home) => {
    assert.equal(zcodeStartPlanEntitledFromLog(home, "zai"), true);
    assert.deepEqual(
      mergeZcodeBillingModelIds(parseZcodeBillingPlans(latestZcodeStartPlanBillingPayload(home, "zai"))),
      ["glm-5.3-flash"],
    );
  });
});

test("渠道不符、非 start-plan 记录或坏 JSON 行都不产生信号", () => {
  withHostLog([billingLine("account:bigmodel-start-plan", emptyStartPlanPayload)], (home) => {
    assert.equal(latestZcodeStartPlanBillingPayload(home, "zai"), undefined);
  });
  withHostLog([billingLine("account:zai-individual", activeStartPlanPayload)], (home) => {
    assert.equal(latestZcodeStartPlanBillingPayload(home, "zai"), undefined);
  });
  withHostLog(["[info] 无关注日志行", `${billingLine("account:zai-start-plan", activeStartPlanPayload).slice(0, 200)} 截断行`], (home) => {
    assert.equal(latestZcodeStartPlanBillingPayload(home, "zai"), undefined);
  });
  const missing = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-plans-log-"));
  try {
    assert.equal(zcodeStartPlanEntitledFromLog(missing, "zai"), undefined, "日志缺失视为无信号");
  } finally {
    fs.rmSync(missing, { recursive: true, force: true });
  }
});

test("日志扫描只看尾部窗口，窗口外的旧记录不参与判定", () => {
  // 1.2MB 无关行把唯一的 active 记录推出 1MB 窗口 → 无信号；随后追加空记录在最尾部 → 无权益。
  const padding = Array.from({ length: 12_000 }, (_, index) => `[info] padding-${index} ${"x".repeat(96)}`);
  withHostLog([billingLine("account:zai-start-plan", activeStartPlanPayload), ...padding], (home) => {
    assert.equal(zcodeStartPlanEntitledFromLog(home, "zai"), undefined, "窗口外旧记录视为无信号");
    const now = new Date();
    const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    fs.appendFileSync(path.join(home, "v2", "logs", `${date}.log`), `${billingLine("account:zai-start-plan", emptyStartPlanPayload)}\n`);
    assert.equal(zcodeStartPlanEntitledFromLog(home, "zai"), false, "窗口内最新记录生效且半行被丢弃");
  });
});
