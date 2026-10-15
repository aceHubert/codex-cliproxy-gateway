# [2026-10-15 15:36] | Task: llm-bridge 剥离 Codex 信封历史项，修复真实 Codex 经 zen 转发 502

### 🤖 Execution Context
* **Agent ID**: `zcode`
* **Base Model**: `zai-api/GLM-5.3`
* **Runtime**: `ZCode CLI`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `codex/llm-bridge-conversion`

### 📥 User Query
> 继续（承接会话确定性派生任务的收尾真机验证）

### 🛠 Changes Overview
**Scope:** packages/llm-bridge（request.ts）、test/llm-bridge-convert.test.ts；相关调研结论记于 docs/opencode2-zen-free-models-gateway-research.md 修正段

**Key Actions:**
- **[发现]**: 会话派生修复后的真机收尾验证中，`codex exec` 经网关调 zen 模型持续 502（curl 模拟一直 200）。gateway.log 定位：`BridgeConversionError: 不支持的 Responses history 项类型 additional_tools`——Codex 0.162.1 在 MCP 工具中途挂载时向 input 历史发送 `additional_tools` 信封项，本分支 AI SDK 引擎底座的桥接转换器不认识该类型，请求进转换即挂（与会话/指纹修复无关的在途缺口）。
- **[对齐语义]**: 网关自身 Responses 路径（gateway.ts）对 `additional_tools`（顶层字段与历史项）和 `compaction_trigger`（历史项）的既有语义是按信封剥离；桥接层的 history 循环补同语义分支——丢弃并记录 note，中途增补的工具声明不并入本轮 tools（与网关行为一致）。
- **[测试]**: 新增「Codex 信封项剥离」用例（信封项不产生消息、不并入 tools、双 note 落账、不抛错）；`bun run check` 1130/1130 通过。
- **[真机闭环]**: 网关重启后 `codex exec -c model=opencode-zen/space-bunny-free` 返回 `gateway-ok`（15,539 tokens）——真实 Codex 客户端经网关调 zen 免费模型全链路打通。

### 🧠 Design Intent (Why)
`additional_tools` 是 Codex 的工具增补信封（MCP 服务器在会话中途就绪时进入 input 历史），不是消息历史；转换层把它当未知历史项报错会让所有挂载 MCP 的真实会话在 zen 转发路径上全军覆没，而 curl 手工模拟（不带该信封）测不出来。剥离而非合并声明：与网关自身路径的既有保守语义一致（本轮不告知中途工具，模型按本轮声明行事），且历史里的既有调用按名注册仍可回放。

### 📊 Change Stats
> 数据来自 `git diff --numstat`（工作区 vs HEAD）。

- **Files changed:** 2
- **Insertions:** +33
- **Deletions:** -0

| File | +Added | -Removed |
| --- | ---: | ---: |
| `packages/llm-bridge/src/request.ts` | +8 | -0 |
| `test/llm-bridge-convert.test.ts` | +25 | -0 |

### 📁 Files Modified
- `packages/llm-bridge/src/request.ts`
- `test/llm-bridge-convert.test.ts`
