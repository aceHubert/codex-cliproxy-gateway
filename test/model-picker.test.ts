import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ModelPicker, retainAvailableModelIds } from "../src/ui/ModelPicker.tsx";

test("模型选择首次渲染即展示当前配置，不依赖上游目录或网络请求", () => {
  const html = renderToStaticMarkup(createElement(ModelPicker, {
    selectedModels: ["vendor/saved-model", "retired-upstream-model"],
    onChange: () => { throw new Error("首次展示不应修改模型选择"); },
    onAuthExpired: () => { throw new Error("首次展示不应请求认证"); },
  }));

  assert.match(html, /vendor\/saved-model/);
  assert.match(html, /retired-upstream-model/);
  assert.match(html, /移除模型/);
  assert.match(html, /从上游拉取/);
  assert.doesNotMatch(html, /type="checkbox"/);
});

test("未选择模型时展示明确空态，仍可从上游拉取", () => {
  const html = renderToStaticMarkup(createElement(ModelPicker, {
    selectedModels: [],
    onChange: () => {},
    onAuthExpired: () => {},
  }));

  assert.match(html, /未选择模型/);
  assert.match(html, /从上游拉取/);
  assert.doesNotMatch(html, /移除模型/);
});

test("拉取目录后只保留仍在上游的已选模型", () => {
  assert.deepEqual(retainAvailableModelIds(
    ["glm-5.3", "retired-model", "kimi-k2", "glm-5.3"],
    [
      { slug: "glm-5.3", displayName: "GLM-5.3" },
      { slug: "kimi-k2", displayName: "Kimi K2" },
      { slug: "new-model", displayName: "New Model" },
    ],
  ), ["glm-5.3", "kimi-k2"]);
});
