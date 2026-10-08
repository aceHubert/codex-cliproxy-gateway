import assert from "node:assert/strict";
import test from "node:test";
import { parseQueueStatus } from "../src/qoder/sse.ts";
import { createQueueAwareInfer, QoderQueueError } from "../src/qoder/queue.ts";
import type { QoderInferFn } from "../src/qoder/queue.ts";
import type { QoderCredentials } from "../src/qoder/credentials.ts";

const credential = { region: "intl" as const, clientProfile: "cli" as const, identity: "i", accountUid: "a", authDirectory: "/x",
  machineId: "m", organizationId: "", organizationTags: [], dataPolicyAgreed: true,
  accessToken: "t", expireTime: 9_999_999_999, encryptUserInfo: "i", key: "k" };
const encoder = new TextEncoder();

/** 上游实测的排队信封形态：statusCodeValue=403，body 为多层 {code,message} JSON 字符串。 */
function queueFrame(overrides: Record<string, unknown> = {}): string {
  const inner = JSON.stringify({ isQueued: true, modelKey: "qfmodel", queueCount: 0, queueType: "p3",
    retryAfterSeconds: 30, serviceAvailable: false, waitTime: 30, ...overrides });
  return `data: ${JSON.stringify({ headers: { "Content-Type": ["application/json"] },
    body: JSON.stringify({ code: "403", message: JSON.stringify({ code: "10605", message: inner }) }),
    statusCodeValue: 403, statusCode: "FORBIDDEN" })}\n\n`;
}

const contentFrames = `data: ${JSON.stringify({ statusCodeValue: 200, body: JSON.stringify({ choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }] }) })}\n\n`
  + `data: ${JSON.stringify({ statusCodeValue: 200, body: JSON.stringify({ choices: [], usage: { billable: false } }) })}\n\n`
  + "event: finish\ndata: {}\n\n";

test("parseQueueStatus 拆开多层排队信封并容忍对象 body", () => {
  const envelope = JSON.parse(queueFrame().replace(/^data: /, "")) as Record<string, unknown>;
  assert.deepEqual(parseQueueStatus(envelope), { isQueued: true, serviceAvailable: false,
    retryAfterSeconds: 30, waitTime: 30, queueCount: 0, queueType: "p3" });
  const objectBody = { ...envelope, body: { code: "10605", message: JSON.stringify({ isQueued: false, serviceAvailable: true }) } };
  assert.deepEqual(parseQueueStatus(objectBody), { isQueued: false, serviceAvailable: true });
  // 普通错误与内容信封不能被误判成排队状态。
  assert.equal(parseQueueStatus({ statusCodeValue: 401, body: JSON.stringify({ code: 403, msg: "token expired" }) }), undefined);
  assert.equal(parseQueueStatus({ statusCodeValue: 200, body: JSON.stringify({ choices: [] }) }), undefined);
  assert.equal(parseQueueStatus({}), undefined);
});

function textStream(text: string): Response {
  return new Response(encoder.encode(text), { status: 200, headers: { "content-type": "text/event-stream" } });
}

function inferFrom(sequence: Array<() => Response | Promise<Response>>): QoderInferFn & { calls: () => number } {
  let index = 0;
  let calls = 0;
  const infer = async () => {
    calls++;
    const provider = sequence[Math.min(index++, sequence.length - 1)]!;
    return await provider();
  };
  return Object.assign(infer, { calls: () => calls });
}

const noSleep = async (): Promise<void> => { throw new Error("不应发生等待"); };

test("排队帧被剥离后内容帧完整到达，单块多帧不丢帧", async () => {
  // 排队帧、内容、用量与 finish 放进同一个块，验证窥探器把未解析余量交还下游。
  const infer = inferFrom([() => textStream(queueFrame() + contentFrames)]);
  const queueInfer = createQueueAwareInfer(infer, { sleep: noSleep });
  const upstream = await queueInfer.infer(credential, { body: {}, modelKey: "qfmodel" });
  assert.equal(upstream.status, 200);
  const text = await new Response(upstream.body).text();
  assert.ok(!text.includes("isQueued"), "排队帧不能透传给下游");
  assert.ok(!text.includes("10605"), "排队内部状态不能进入下游");
  assert.ok(text.includes("finish"), "finish 事件必须保留");
  assert.ok(text.includes("billable"), "用量帧必须保留");
  assert.ok(text.includes("ok"));
  assert.equal(infer.calls(), 1);
});

test("首内容帧交接保留余量中跨块的中文与 emoji UTF-8 字节", async () => {
  const extraFrame = `data: ${JSON.stringify({ statusCodeValue: 200,
    body: JSON.stringify({ choices: [{ delta: { content: "中文🚀完成" } }] }) })}\n\n`;
  const source = queueFrame() + contentFrames + extraFrame;
  const bytes = encoder.encode(source);
  for (const character of ["中", "🚀"]) {
    const characterStart = encoder.encode(source.slice(0, source.indexOf(character))).length;
    for (let offset = 1; offset < encoder.encode(character).length; offset++) {
      const boundary = characterStart + offset;
      const infer = inferFrom([() => new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          // 首块含完整排队帧和内容帧，末尾停在后续字符内部。
          controller.enqueue(bytes.subarray(0, boundary));
          controller.enqueue(bytes.subarray(boundary, boundary + 1));
          controller.enqueue(bytes.subarray(boundary + 1));
          controller.close();
        },
      }), { status: 200 })]);
      const queueInfer = createQueueAwareInfer(infer, { sleep: noSleep });
      const upstream = await queueInfer.infer(credential, { body: {}, modelKey: "qfmodel" });
      const actual = new Uint8Array(await upstream.arrayBuffer());
      assert.deepEqual(actual, encoder.encode(contentFrames + extraFrame), `${character} 在第 ${offset} 个字节后分块`);
      const text = new TextDecoder("utf-8", { fatal: true }).decode(actual);
      assert.ok(text.includes("中文🚀完成"));
      assert.ok(!text.includes("isQueued"));
      assert.equal(infer.calls(), 1);
    }
  }
});

test("排队信封立即放弃该流并按 retryAfterSeconds 重试新请求", async () => {
  const infer = inferFrom([
    () => textStream(queueFrame()),
    () => textStream(contentFrames),
  ]);
  const delays: number[] = [];
  let clock = 1_000;
  const queueInfer = createQueueAwareInfer(infer, {
    sleep: async (ms) => { delays.push(ms); clock += ms; },
    now: () => clock,
  });
  const upstream = await queueInfer.infer(credential, { body: {}, modelKey: "qfmodel" });
  assert.ok((await new Response(upstream.body).text()).includes("finish"));
  assert.deepEqual(delays, [30_000], "重试间隔取上游 retryAfterSeconds");
  assert.equal(infer.calls(), 2);
});

test("就绪帧同样触发立即重试，重试间隔被上限约束", async () => {
  const infer = inferFrom([
    () => textStream(queueFrame({ isQueued: false, serviceAvailable: true, retryAfterSeconds: 120 })),
    () => textStream(contentFrames),
  ]);
  const delays: number[] = [];
  let clock = 1_000;
  const queueInfer = createQueueAwareInfer(infer, {
    retryDelayCapMs: 20_000,
    sleep: async (ms) => { delays.push(ms); clock += ms; },
    now: () => clock,
  });
  const upstream = await queueInfer.infer(credential, { body: {}, modelKey: "qfmodel" });
  assert.ok((await new Response(upstream.body).text()).includes("finish"));
  assert.deepEqual(delays, [20_000], "retryAfterSeconds 超过上限时取上限");
  assert.equal(infer.calls(), 2);
});

test("持续排队在总预算内反复重试，耗尽后给出排队受限分类", async () => {
  const infer = inferFrom([() => textStream(queueFrame())]);
  const delays: number[] = [];
  let clock = 1_000;
  const queueInfer = createQueueAwareInfer(infer, {
    totalBudgetMs: 100_000,
    sleep: async (ms) => { delays.push(ms); clock += ms; },
    now: () => clock,
  });
  await assert.rejects(queueInfer.infer(credential, { body: {}, modelKey: "qfmodel" }), (error: unknown) => {
    assert.ok(error instanceof QoderQueueError);
    assert.equal(error.kind, "queued_limited");
    assert.match(error.message, /繁忙|排队/);
    assert.ok(!error.message.includes("isQueued"));
    return true;
  });
  assert.deepEqual(delays, [30_000, 30_000, 30_000, 10_000], "预算内按 30 秒节奏重试，剩余预算只等剩余时长");
  assert.equal(infer.calls(), 5, "预算内共发起 5 次请求");
});

test("上游未给 retryAfterSeconds 时使用最小重试间隔", async () => {
  const infer = inferFrom([
    () => textStream(queueFrame({ retryAfterSeconds: undefined, waitTime: undefined })),
    () => textStream(contentFrames),
  ]);
  const delays: number[] = [];
  let clock = 1_000;
  const queueInfer = createQueueAwareInfer(infer, {
    minRetryDelayMs: 2_000,
    sleep: async (ms) => { delays.push(ms); clock += ms; },
    now: () => clock,
  });
  await queueInfer.infer(credential, { body: {}, modelKey: "qfmodel" });
  assert.deepEqual(delays, [2_000]);
});

test("信号中止会中断重试等待", async () => {
  const controller = new AbortController();
  controller.abort(new DOMException("请求已取消", "AbortError"));
  const infer = inferFrom([() => new Response(null, { status: 200 })]);
  const queueInfer = createQueueAwareInfer(infer);
  await assert.rejects(queueInfer.infer(credential, { body: {}, modelKey: "qfmodel" }, controller.signal), /取消|abort/i);
});

test("心跳注释帧在窥探阶段也会重置外层空闲计时", async () => {
  let beats = 0;
  const infer = inferFrom([() => new Response(new ReadableStream<Uint8Array>({
    async pull(controller) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (beats < 3) { beats++; controller.enqueue(encoder.encode(": keep-alive\n\n")); return; }
      controller.enqueue(encoder.encode(contentFrames));
      controller.close();
    },
  }), { status: 200 })]);
  const queueInfer = createQueueAwareInfer(infer, { sleep: noSleep });
  let keepAlives = 0;
  const upstream = await queueInfer.infer(credential, { body: {}, modelKey: "qfmodel" }, undefined, { keepAlive: () => keepAlives++ });
  assert.ok((await new Response(upstream.body).text()).includes("finish"));
  assert.ok(keepAlives >= 3, "每个帧边界都要触发 keepAlive");
  assert.equal(infer.calls(), 1);
});
