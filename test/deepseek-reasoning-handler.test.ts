import test from "node:test";
import fs from "node:fs";
import assert from "node:assert/strict";

type HandlerContext = {
  source: string;
  target: string;
  model: string;
  body: string;
};

const script = fs.readFileSync(
  new URL("../scripts/deepseek_reasoning_content.js", import.meta.url),
  "utf8",
);
const handler = new Function(`${script}\nreturn on_after_auth_request;`)() as (
  context: HandlerContext,
) => HandlerContext;

test("DeepSeek handler only repairs missing tool schema types", () => {
  const codexInput = JSON.stringify({
    input: [{ type: "function_call", call_id: "call-1" }],
  });
  assert.equal(
    handler({ source: "codex", target: "openai", model: "deepseek-v4", body: codexInput }).body,
    codexInput,
  );

  const chatInput = JSON.stringify({
    messages: [{ role: "assistant", tool_calls: [{}] }],
  });
  assert.equal(
    handler({ source: "openai", target: "codex", model: "deepseek-v4", body: chatInput }).body,
    chatInput,
  );

  const schemaInput = JSON.stringify({
    tools: [{ type: "function", function: { parameters: { properties: {} } } }],
  });
  const repaired = handler({
    source: "codex",
    target: "openai",
    model: "deepseek-v4",
    body: schemaInput,
  });
  assert.deepEqual(JSON.parse(repaired.body), {
    tools: [{ type: "function", function: { parameters: { properties: {}, type: "object" } } }],
  });

  const otherModel = handler({
    source: "codex",
    target: "openai",
    model: "gpt-5.6",
    body: schemaInput,
  });
  assert.equal(otherModel.body, schemaInput);
});
