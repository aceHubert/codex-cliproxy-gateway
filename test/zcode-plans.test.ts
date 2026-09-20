import test from "node:test";
import assert from "node:assert/strict";
import { isZcodeStartPlanIdentity, mergeZcodeBillingModelIds, parseZcodeBillingPlans } from "../src/zcode/plans.ts";

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
