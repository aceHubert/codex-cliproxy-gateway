import assert from "node:assert/strict";
import {
  AGY_TIERS, agyRequestEffort, resolveAgyModel, type AgyModelReasoning,
} from "@agent-proxy/agy/catalog";
import test from "./host-test.ts";

test("agy 推理档位词汇表包含五个独立级别", () => {
  assert.deepEqual(AGY_TIERS, ["low", "medium", "high", "xhigh", "max"]);
});

test("agy reasoning.effort 优先，缺少 reasoning 对象时读取 reasoning_effort", () => {
  assert.equal(agyRequestEffort({
    reasoning: { effort: "xhigh" }, reasoning_effort: "low",
  }), "xhigh");
  assert.equal(agyRequestEffort({ reasoning_effort: "max" }), "max");
  assert.equal(agyRequestEffort({ reasoning: {}, reasoning_effort: "xhigh" }), "xhigh");
  assert.equal(agyRequestEffort({ reasoning: { effort: "high" } }), "high");
});

test("agy effort 归一化 minimal 为 low，xhigh 与 max 保持不同", () => {
  assert.deepEqual(resolveAgyModel("fixed-model", "minimal"), {
    model: "fixed-model", thinkingLevel: "low",
  });
  assert.deepEqual(resolveAgyModel("fixed-model", "xhigh"), {
    model: "fixed-model", thinkingLevel: "xhigh",
  });
  assert.deepEqual(resolveAgyModel("fixed-model", "max"), {
    model: "fixed-model", thinkingLevel: "max",
  });
});

test("agy 未知能力按 effort 同名透传，不从模型后缀猜测档位变体", () => {
  assert.deepEqual(resolveAgyModel("ordinary-model-high", "xhigh"), {
    model: "ordinary-model-high", thinkingLevel: "xhigh",
  });
  assert.deepEqual(resolveAgyModel("ordinary-model-max", "max"), {
    model: "ordinary-model-max", thinkingLevel: "max",
  });
  assert.deepEqual(resolveAgyModel("ordinary-model-high", "unsupported"), {
    model: "ordinary-model-high",
  });
});

test("agy 固定模型不附加 thinkingLevel", () => {
  for (const effort of ["low", "medium", "high", "xhigh", "max", "minimal"]) {
    assert.deepEqual(resolveAgyModel("fixed-model", effort, { kind: "fixed" }), {
      model: "fixed-model",
    }, `effort=${effort}`);
  }
});

test("agy 参数型模型按支持级别还原 thinkingLevel", () => {
  const profile: AgyModelReasoning = { kind: "parameter", levels: ["low", "high", "max"] };
  assert.deepEqual(resolveAgyModel("parameter-model", "minimal", profile), {
    model: "parameter-model", thinkingLevel: "low",
  });
  assert.deepEqual(resolveAgyModel("parameter-model", "high", profile), {
    model: "parameter-model", thinkingLevel: "high",
  });
  assert.deepEqual(resolveAgyModel("parameter-model", "xhigh", profile), {
    model: "parameter-model",
  }, "未声明 xhigh 时不发送该参数");
  assert.deepEqual(resolveAgyModel("parameter-model", "max", profile), {
    model: "parameter-model", thinkingLevel: "max",
  });
});

test("agy 参数型模型的 levels 未知时同名透传，空 levels 时不发送", () => {
  assert.deepEqual(resolveAgyModel("unknown-levels-model", "xhigh", { kind: "parameter" }), {
    model: "unknown-levels-model", thinkingLevel: "xhigh",
  });
  assert.deepEqual(resolveAgyModel("no-levels-model", "max", { kind: "parameter", levels: [] }), {
    model: "no-levels-model",
  });
});

test("agy 变体型模型用目录映射还原不规则真实模型 ID", () => {
  const profile: AgyModelReasoning = {
    kind: "variants",
    variants: {
      low: "gemini-flash-fast",
      medium: "gemini-flash",
      high: "gemini-flash-thinking",
      xhigh: "gemini-hydrogen-pro",
      max: "gemini-ultra-long-context",
    },
    defaultLevel: "medium",
  };
  assert.deepEqual(resolveAgyModel("gemini-family", "low", profile), {
    model: "gemini-flash-fast",
  });
  assert.deepEqual(resolveAgyModel("gemini-family", "xhigh", profile), {
    model: "gemini-hydrogen-pro",
  });
  assert.deepEqual(resolveAgyModel("gemini-family", "max", profile), {
    model: "gemini-ultra-long-context",
  }, "max 精确命中，不视作 xhigh 别名");
});

test("agy 变体型模型的缺失或未知 effort 使用声明的默认模型", () => {
  const profile: AgyModelReasoning = {
    kind: "variants",
    variants: { low: "irregular-fast-id", medium: "irregular-default-id" },
    defaultLevel: "medium",
  };
  assert.deepEqual(resolveAgyModel("family", undefined, profile), { model: "irregular-default-id" });
  assert.deepEqual(resolveAgyModel("family", "xhigh", profile), { model: "irregular-default-id" });
  assert.deepEqual(resolveAgyModel("family", "max", profile), { model: "irregular-default-id" });
  assert.deepEqual(resolveAgyModel("family", "minimal", profile), { model: "irregular-fast-id" });
});

test("agy 变体型模型缺少声明的默认变体时给出目录刷新指引", () => {
  assert.throws(
    () => resolveAgyModel("family", "xhigh", {
      kind: "variants", variants: { low: "only-low" }, defaultLevel: "medium",
    }),
    /缺少默认变体，请刷新模型目录/,
  );
});

test("agy 原型属性和未知 effort 不会被当作有效级别", () => {
  for (const effort of ["toString", "constructor", "__proto__", "unknown"]) {
    assert.deepEqual(resolveAgyModel("model", effort), { model: "model" }, `effort=${effort}`);
    assert.deepEqual(resolveAgyModel("family", effort, {
      kind: "variants", variants: { medium: "family-default" }, defaultLevel: "medium",
    }), { model: "family-default" }, `effort=${effort}`);
  }
});
