import assert from "node:assert/strict";
import { resolveZcodeIndividualApiKey } from "@agent-proxy/zcode/individual-project-token";
import test from "./host-test.ts";

test("ZCode 个人项目发现排除团队并优先默认项目，缺少专属 Key 时创建后签发", async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetch: typeof globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith("getCustomerInfo")) {
      return Response.json({ code: 200, data: { organizations: [
        { organizationId: "team-only", projects: [{ projectId: "team-project", projectType: 2 }] },
        { organizationId: "other", projects: [{ projectId: "other-project", projectType: 1 }] },
        { organizationId: "preferred", organizationName: "我的默认机构", projects: [
          { projectId: "first", projectType: 1 },
          { projectId: "chosen", projectName: "默认项目", projectType: 1 },
        ] },
      ] } });
    }
    assert.ok(url.includes("/organization/preferred/projects/chosen/api_keys"));
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer oauth-fixture");
    if (url.endsWith("/access_tokens")) {
      assert.ok(url.endsWith("/created/access_tokens"));
      return Response.json({ code: 200, data: { accessToken: "short-token", expiresIn: 60 } });
    }
    if (init?.method === "POST") {
      assert.deepEqual(JSON.parse(String(init.body)), { name: "zcode-api-key", usageScene: 1 });
      return Response.json({ code: 200, data: { apiKey: "created" } });
    }
    return Response.json({ code: 200, data: [{ apiKey: "unrelated", keyType: 2, name: "custom" }] });
  }) as typeof fetch;
  const token = await resolveZcodeIndividualApiKey("zai", { accessToken: "oauth-fixture", identity: "account", fingerprint: "fixture" }, undefined,
    { fetch, now: () => 1000 });
  assert.deepEqual(token, { apiKey: "short-token", expiresAt: 61000 });
  assert.equal(calls.length, 4);
});
