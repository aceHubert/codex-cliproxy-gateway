# [2026-09-13 23:23] | Task: 图片识别降级脱敏覆盖转义形式并先于截断

## 🤖 Execution Context

* **Agent ID**: `zcode`
* **Base Model**: `builtin:zai-coding-plan/GLM-5.3`
* **Runtime**: `ZCode CLI`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `codex/codex-api`

## 📥 User Query

> [P1] 图片识别降级仍可泄漏凭据 — src/zcode.ts:218、src/zcode-vision.ts:176。已复现两种绕过：错误正文使用合法 JSON \/ 转义时，客户端可还原完整假密钥；先截断正文再脱敏时，44 字符假密钥泄漏前 43 字符。两者都进入 completed 响应旁白及 tool_result。需要在截断前脱敏，并覆盖结构化错误的转义形式。
> （用户另问泄漏的是不是 GLM 图片上传 CDN 的密钥、失败是否降级给后面的 agent——答复：均不是。风险点是 ZCode/z.ai API key 本身；CDN 上传是 z.ai 服务端行为。降级也不转给别的 agent，而是把失败说明回填给同一上游模型续跑，旁白同时发给客户端——泄漏点即客户端侧旁白。）

## 🛠 Changes Overview

**Scope:** codex-cliproxy-gateway（src/zcode.ts、src/zcode-vision.ts）

**Key Actions:**

- **[zcode.ts]** `redact` 强化：逐字符生成四种**互斥**转义形式（裸字符、`\\{1,4}`+字符、`\\{1,4}u`+十六进制大小写）的确定性正则一次性遮蔽——覆盖 `\/`、`\uXXXX` 与多层反斜杠；保留原 4 层 `JSON.stringify` 变体循环兜底。首版 `(?:\\{0,4}(?:C|\\uHHHH…))` 写法因前缀与 `\u` 形态共享首字符产生灾难性回溯（测试挂死 7 分钟），已重写并单独验证 5000 连续反斜杠对抗输入 ≤2ms。
- **[zcode-vision.ts]** `ZcodeExecutorOptions.redact` 注入：执行信封对上游错误正文**先脱敏完整文本、后 `slice(0, 200)` 截断**，杜绝 key 跨截断边界留下可还原前缀。
- **[zcode.ts]** 续跑腿（`nextUpstream`）的错误正文同样先 `redact` 后截断（原依赖最终失败事件 sanitizeError 的事后脱敏，同样存在截断绕过）。

## 🧠 Design Intent (Why)

F2 首版的 `redact` 只枚举 `JSON.stringify` 嵌套变体，漏掉 `\/`、`\uXXXX` 转义——合法 JSON 错误正文以此形式回显 key 时客户端反序列化即可还原；且 `zcode-vision.ts` 构造错误消息时先截断后脱敏，key 跨 200 字符边界时留下前缀片段。修复原则：脱敏必须发生在文本形态完整时（截断/再编码之前），转义匹配用互斥形式枚举保证正则确定性（无指数回溯）。

## 📊 Change Stats

> `git diff --numstat`（含前序任务基线的累计值，本任务增量约：zcode.ts +11/-5、zcode-vision.ts +8/-1、测试 +62）。

- **Files changed:** 3
- **Insertions:** +120（累计口径）

| File | +Added | -Removed |
| --- | ---: | ---: |
| `src/zcode.ts` | +11（增量） | -5（增量） |
| `src/zcode-vision.ts` | +8 | -1 |
| `test/zcode-gateway.test.ts` | +62（增量） | -0 |

## 📁 Files Modified

- `src/zcode.ts`、`src/zcode-vision.ts`
- `test/zcode-gateway.test.ts`
- `docs/exec-plans/completed/codex-review-fixes.md`（F2 补充说明）

## 验证

- `bun run typecheck` 通过；`bun run check` 全绿（typecheck + 308 tests + build）。
- 正则单独验证：raw / `\/` / `\uXXXX`（大小写）/ `\\/` 全部脱敏，5000 反斜帘 + 部分 key 前缀对抗输入 ≤2ms 无回溯。
- 新增回归：`zcode-gateway.test.ts`「跨截断边界的 key 同样脱敏」（190 字符填充使 key 跨 200 边界）与「遮蔽 JSON 转义形式的 key」（`\/` + `\u002f` 混合转义正文）。
