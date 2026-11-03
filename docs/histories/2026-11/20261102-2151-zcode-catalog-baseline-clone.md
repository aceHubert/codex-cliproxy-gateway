## [2026-11-02 21:51] | Task: 统一 zcode 厂商目录为基线整包克隆合成

### 🤖 Execution Context
* **Agent ID**: `ZCode`
* **Base Model**: `GLM-5.3`
* **Runtime**: `ZCode Desktop`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `fix/zcode-startplan-catalog`

### 📥 User Query
> 所有 plugin 都应该以基线整包克隆 + 自定义替换。
> （背景排查：codebuddy 通道 425 工具全量可用，zcode 通道只有 15 个工具，差异定位到
> `buildZcodeVendorCatalog` 走 `minimalModelEntry` 极简基底，未继承 `tool_mode`/
> `multi_agent_version`/`use_responses_lite` 等 Codex 行为字段。）

### 🛠 Changes Overview
**Scope:** packages/zcode（目录合成）、test/（断言重写）

**Key Actions:**
- **[合成策略拉齐]**: `buildZcodeVendorCatalog` 从「`minimalModelEntry` 极简基底 +
  宿主 `synthesizeModelEntry` 厂商预设命中」改为「`getCodexBaselineEntry()` 基线整包
  克隆（当前 gpt-6-luna）+ z.ai 厂商预设逐字段替换」，与 agy/qoder/zen/codebuddy
  四个插件的本地克隆模式一致；不再依赖宿主服务，纯内存合成。
- **[实验工具集恢复基线]**: 删除 `vendor_models.json` 四个 z.ai 条目的
  `experimental_supported_tools: []` 中和，继承基线
  `["send_user_message_async", "clock"]`（clock 随 additional_tools 命名空间下发，
  与 codebuddy 通道对齐）；moonshotai/deepseek 分组不动。
- **[断言重写]**: `test/zcode-catalog.test.ts` 原「不继承 GPT 设置」断言
  （`service_tiers`/`additional_speed_tiers`/`supports_image_detail_original` 为
  undefined）改为断言基线继承（`tool_mode`/`multi_agent_version`/
  `use_responses_lite`/`experimental_supported_tools`/`service_tiers` 等于基线值）
  + 预设替换值保持（`base_instructions: ""`）。

### 🧠 Design Intent (Why)
同一次会话里的对照实验证实：客户端按网关下发的 catalog 能力字段组装工具集——
codebuddy（基线克隆条目）拿到 additional_tools 四组（functions/clock/collaboration/
mcp__cua_repl）+ 407 个 MCP 工具、首轮上下文 ~30k；zcode（极简条目）只有 15 个
工具、首轮 ~7k，用户 MCP 服务器完全不被组装。基线继承让 zcode 会话获得完整工具
体验（`functions.exec` 为 custom 工具、客户端本地执行，无上游依赖），厂商预设仍
是唯一"自定义替换"层（真实窗口、reasoning 档位、空值中和）。同时本次排查把
tech-debt-tracker 2026-09-12 行"客户端是否采信 `supports_search_tool` 仍未定论"
定论为：**采信**（zcode 显式 true → tool_search 被声明进请求；codebuddy 基线 true →
同样声明）。

风险与后续：
1. `tool_search` 仍会声明并被 `planResponsesTools` 兜底 drop + system 通告（既有行为，
   声明面扩大后通告仍每轮一条）。
2. `use_responses_lite: true` 继承后 GLM 会话的客户端请求形态变化未真机验证
   （codebuddy 同字段下端到端正常，作为先例）。
3. clock/send_user_message_async 恢复组装后经 namespace 路径声明，真机表现待验收
   （codebuddy 通道 `clock__curr_time` 可用为先例）。

### 📊 Change Stats
> 数据来自工作区 `git diff`（未提交，待人工验收）。

- **Files changed:** 3
- **Insertions:** +38
- **Deletions:** -29

| File | +Added | -Removed |
| --- | ---: | ---: |
| `packages/zcode/src/catalog.ts` | +24 | -20 |
| `test/zcode-catalog.test.ts` | +14 | -5 |
| `packages/models/vendor_models.json` | +0 | -4 |

### 📁 Files Modified
- `packages/zcode/src/catalog.ts`
- `test/zcode-catalog.test.ts`
- `packages/models/vendor_models.json`

### ✅ Verification
- `bun run build:packages` ✅
- `bun run typecheck` ✅
- `bun run test`：1278 pass / 0 fail ✅
- 网关已重启，等待用户在 Codex Desktop 真机验收（新会话应看到 ~425 工具与
  additional_tools 工具组；zcode-catalog.json 落盘条目应含 `tool_mode` 等基线字段）。
