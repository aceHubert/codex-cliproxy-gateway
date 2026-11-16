import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createZcodeConfigCache, ZcodeConfigError } from "@agent-proxy/zcode/config";
import test from "./host-test.ts";

test("凭据解密错误在个人身份、Key、OAuth、项目指针、团队及Start Plan正常缓存入口明确失败", async () => {
  const pointer = `project-key-location:v1:${encodeURIComponent(JSON.stringify(["https://api.z.ai", "zai", "user-a", null, 1, "non-team"]))}`;
  const profile = JSON.stringify({ user_id: "user-a" });
  const bad = "enc:v1:broken-private-ciphertext";
  const cases: { plan: "individual-coding-plan" | "team-coding-plan" | "start-plan"; credentials: Record<string, string> }[] = [
    { plan: "individual-coding-plan", credentials: { "oauth:zai:access_token": "fixture-oauth", "oauth:zai:user_info": bad } },
    { plan: "individual-coding-plan", credentials: { "oauth:zai:access_token": "fixture-oauth", "oauth:zai:user_info": profile, "account-provider:coding-plan:account:zai-individual-coding-plan:account:user-a:api-key": bad } },
    { plan: "individual-coding-plan", credentials: { "oauth:zai:access_token": bad, "oauth:zai:user_info": profile } },
    { plan: "individual-coding-plan", credentials: { "oauth:zai:access_token": "fixture-oauth", "oauth:zai:user_info": profile, [pointer]: bad } },
    { plan: "team-coding-plan", credentials: { "oauth:zai:access_token": bad } },
    { plan: "start-plan", credentials: { zcodejwttoken: bad } },
  ];
  for (const { plan, credentials } of cases) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-credential-errors-"));
    const providerID = plan === "start-plan" ? "builtin:zai-start-plan" : "builtin:zai-coding-plan";
    fs.writeFileSync(path.join(home, "setting.json"), JSON.stringify({ providerFamilyDomain: "zai", providerFamilyConnectionSelections: { zai: { kind: plan, productId: "product", organizationId: "org", projectId: "project" } } }));
    fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ provider: { [providerID]: { options: { apiKey: "mirror-key", baseURL: "https://api.z.ai/api/anthropic" }, models: ["GLM-5.3"] } } }));
    fs.writeFileSync(path.join(home, "credentials.json"), JSON.stringify(credentials));
    let networkCalls = 0;
    const cache = createZcodeConfigCache(home, { plan, refreshOnStart: false, fetch: Object.assign(async () => { networkCalls++; throw new Error("不应启动发现或签发"); }, { preconnect: fetch.preconnect }) });
    try {
      await assert.rejects(cache.get(), (error: unknown) => {
        assert.ok(error instanceof ZcodeConfigError);
        assert.match(error.message, /解密失败/);
        assert.doesNotMatch(error.message, /broken-private-ciphertext/);
        return true;
      });
      assert.equal(networkCalls, 0);
    } finally {
      cache.close();
      fs.rmSync(home, { recursive: true, force: true });
    }
  }
});
