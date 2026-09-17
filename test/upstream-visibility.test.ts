import test from "node:test";
import assert from "node:assert/strict";
import {
  compileModelOverrides,
  fetchCliProxyCatalog,
  fetchUpstreamCatalog,
} from "../src/catalog.ts";

test("上游统一目录排除 visibility 为 hide 的 CLIProxy 模型", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => Response.json({ models: [
    { slug: "hidden-model", visibility: "hide" },
    { slug: "listed-model", visibility: "list" },
    { slug: "default-model" },
    { slug: "other-model", visibility: "hidden" },
  ] })) as unknown as typeof fetch;

  try {
    const catalog = await fetchUpstreamCatalog(
      "http://127.0.0.1:8317/v1",
      "",
      "cliproxy",
      "2.0.0",
    );

    assert.deepEqual(
      catalog.models.map((model) => model.slug),
      ["listed-model", "default-model", "other-model"],
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("CLIProxy 底层目录拉取保留 visibility 为 hide 的原始条目", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => Response.json({ models: [
    { slug: "hidden-model", visibility: "hide" },
    { slug: "visible-model", visibility: "list" },
  ] })) as unknown as typeof fetch;

  try {
    const catalog = await fetchCliProxyCatalog("http://127.0.0.1:8317/v1", "", "2.0.0");
    assert.deepEqual(
      catalog.models.map((model) => model.slug),
      ["hidden-model", "visible-model"],
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("new-api 合成后排除快照和覆盖规则标记为 hide 的模型", async () => {
  const snapshot = { models: [
    { slug: "gpt-5.5", visibility: "list", context_window: 272000 },
    { slug: "snapshot-hidden", visibility: "hide", context_window: 128000 },
    { slug: "snapshot-visible", visibility: "list", context_window: 128000 },
  ] };
  const overrides = compileModelOverrides({
    openai: [
      { name: "rule-hidden", visibility: "hide", context_window: 200000 },
      { name: "rule-visible", visibility: "list", context_window: 200000 },
    ],
  }, "test visibility rules");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => Response.json({ data: [
    { id: "snapshot-hidden" },
    { id: "snapshot-visible" },
    { id: "rule-hidden" },
    { id: "rule-visible" },
    { id: "fallback-visible" },
  ] })) as unknown as typeof fetch;

  try {
    const catalog = await fetchUpstreamCatalog(
      "https://newapi.example.com/v1",
      "sk-test",
      "newapi",
      "0.0.0",
      { snapshot, overrides },
    );

    assert.deepEqual(
      catalog.models.map((model) => model.slug),
      ["fallback-visible", "rule-visible", "snapshot-visible"],
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("上游原始目录非空但全部 hide 时统一目录返回空列表", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => Response.json({ models: [
      { slug: "cliproxy-hidden", visibility: "hide" },
    ] })) as unknown as typeof fetch;
    assert.deepEqual(
      await fetchUpstreamCatalog("http://127.0.0.1:8317/v1", "", "cliproxy", "2.0.0"),
      { models: [] },
    );

    globalThis.fetch = (async () => Response.json({ data: [
      { id: "newapi-hidden" },
    ] })) as unknown as typeof fetch;
    assert.deepEqual(
      await fetchUpstreamCatalog(
        "https://newapi.example.com/v1",
        "sk-test",
        "newapi",
        "0.0.0",
        { snapshot: { models: [{ slug: "newapi-hidden", visibility: "hide" }] } },
      ),
      { models: [] },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("上游原始目录为空时仍保留原有错误", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => Response.json({ models: [] })) as unknown as typeof fetch;
    await assert.rejects(
      fetchUpstreamCatalog("http://127.0.0.1:8317/v1", "", "cliproxy", "2.0.0"),
      /returned no models/,
    );

    globalThis.fetch = (async () => Response.json({ data: [] })) as unknown as typeof fetch;
    await assert.rejects(
      fetchUpstreamCatalog(
        "https://newapi.example.com/v1",
        "sk-test",
        "newapi",
        "0.0.0",
        { snapshot: { models: [{ slug: "gpt-5.5", visibility: "list" }] } },
      ),
      /returned no models/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
