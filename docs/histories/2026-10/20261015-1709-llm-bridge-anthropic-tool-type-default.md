# [2026-10-15 17:09] | Task: 修复 Anthropic 无 type 工具缺省成 custom 导致的 responses 配对 400

### 🤖 Execution Context
* **Agent ID**: `zcode`
* **Base Model**: `zai-api/GLM-5.3`
* **Runtime**: `ZCode CLI`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `codex/llm-bridge-conversion`

### 📥 User Query
> 读会话 sess_cc001716（ZCode 用 muse-spark 问 "meta muse 有什么最新更新功能？"），
> 是转换出问题了吗，上游 400 了 → 确认后要求修复。

### 🛠 Changes Overview
**Scope:** packages/llm-bridge（转换核心）、test（转换测试）

**Key Actions:**
- **[诊断]**: 第一轮请求 200 正常（模型发起 2 个 tool_use），挂的是第二轮回放工具
  历史：上游 400 `No function call found for function call output with call_id ...`。
  生产网关最小复现确认（muse-spark 必现同错、space-bunny 的 chat 目标正常）。
- **[主修]**: `anthropicSourceToPrepared` 的工具声明缺省 `type` 从 `"custom"` 改为
  `"function"`——Anthropic 常规工具声明没有 type 字段（ZCode 110 个工具全部如此），
  旧缺省把所有常规工具当 custom：真实 `input_schema` 被换成 `{input:string}` 占位、
  历史 tool_use 发射成 `custom_tool_call`（input 还被序列化成垃圾值）。
- **[加固]**: `applyResponsesExtras` 还原 custom_tool_call 时，其配对的
  `function_call_output` 同步还原为 `custom_tool_call_output`——上游按类型配对调用
  与输出，交叉配对即 400。
- **[测试]**: 新增 2 个转换测试（无 type 缺省 function：真实 schema 保留 +
  function_call/function_call_output 类型配对；显式 custom：调用与输出成对还原）。

### 🧠 Design Intent (Why)
缺省 custom 是 HEAD 已提交行为，影响所有「Anthropic 客户端 × responses 协议模型」
组合（当前即 muse-spark 家族）的任意工具调用第二轮回放；chat 目标不区分 custom 故
不受影响，掩盖了问题。真正需要 custom 语义的客户端会显式声明 `type:"custom"`，
缺省走 function 才与协议事实一致。输出配对加固消除 custom_tool_call ×
function_call_output 的交叉配对隐患。

### 📊 Change Stats
> 注：两文件在本任务前已带分支未提交改动；本任务净增量 request.ts +28/-4、测试 +73。

- **Files changed:** 2
- **Insertions:** +101
- **Deletions:** -4

| File | +Added | -Removed |
| --- | ---: | ---: |
| `packages/llm-bridge/src/request.ts` | +28 | -4 |
| `test/llm-bridge-convert.test.ts` | +73 | -0 |

### 📁 Files Modified
- `packages/llm-bridge/src/request.ts`
- `test/llm-bridge-convert.test.ts`

### 已知边界（未处理，记录在案）
- Anthropic 显式 custom 工具的历史 `tool_use.input` 按规范是自由文本字符串，桥接
  历史解析仍只接受 JSON 对象（字符串 input 会明确报错）；当前无客户端走该路径，
  如需支持要配合「声明先于历史解析」的重排。
- 触发本次回放的诱因之一是模型侧输出不合规（WebSearch 参数 `blocked_domains`
  传了字符串 `"[]"` 被 ZCode 本地 schema 校验拒绝），与网关无关。
