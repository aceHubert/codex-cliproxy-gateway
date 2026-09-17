## [2026-09-13 15:50] | Task: 补齐 analyze_image 代执行的 "Z.ai Built-in Tool" 旁白卡片

### 🤖 Execution Context
* **Agent ID**: `zcode`
* **Base Model**: `GLM-5.3`
* **Runtime**: `ZCode CLI`
* **Git User**: `hubert`
* **Branch**: `codex/codex-api`

### 📥 User Query
> codex://threads/01a099ac-96dd-7e11-89a3-434a7e4d97e8 图片识别成功了，适配成功。但是没有像图片中显示 Z.ai Built-in Tool: analyze image 呢？

### 🛠 Changes Overview
**Scope:** codex-cliproxy（src/zcode-vision.ts、src/zcode-response.ts、test/、README.md）

**Key Actions:**
- **[根因定位]**: 对比 Codex rollout 确认 "Z.ai Built-in Tool: web_search_prime" 卡片不是 Codex 的 UI 组件，而是 z.ai 上游以普通助手 Markdown 流式输出的旁白文本（`**🌐 Z.ai Built-in Tool: …**` + Input 代码块 + `*Executing on server...*`，随后另起一条 `**Output:**\n**…_result_summary:** [...]`）；图片适配把 analyze_image 调用静默吸收，自然没有任何卡片。
- **[旁白复刻]**: `zcode-vision.ts` 新增 `gatewayToolCallNarration`/`gatewayToolResultNarration`，逐字复刻 z.ai 实测形状；`zcode-response.ts` 在吸收调用的 `content_block_stop` 帧同步合成 Input 卡片（执行等待期间即对客户端可见），执行完成后、续跑前合成 Output 卡片。
- **[边界闭合]**: 未续跑（如 `max_tokens` 收尾）时对已旁白的调用补“未执行”Output 卡片，避免 "Executing on server..." 永久悬挂；达到续跑上限的调用保持既有的静默丢弃语义（不旁白）。
- **[验证]**: 更新 3 个续跑测试并新增 2 个（旁白形状、未续跑补说明）；`bun run check` 270 测试/类型/构建全过；重启生产网关（launchd 直接运行 `src/index.ts`）后生效。

### 🧠 Design Intent (Why)
z.ai 的"内置工具卡片"本质是上游输出的普通文本，Codex 只按 Markdown 渲染；网关代执行的 analyze_image 若不主动输出同形状文本，调用过程对用户完全不可见。复刻同一形状让代执行链路与 web_search_prime 在 UI 上完全一致，且 Input 卡片在 `content_block_stop` 帧即流出，等待识别期间用户就能看到 "Executing on server..."。

### 📊 Change Stats
> 数据来自 `git diff --numstat`（未暂存部分，排除本文件与非本任务的 `models/vendor_models.json`）。

- **Files changed:** 5
- **Insertions:** +106
- **Deletions:** -8

| File | +Added | -Removed |
| --- | ---: | ---: |
| `src/zcode-response.ts` | +33 | -3 |
| `src/zcode-vision.ts` | +24 | -0 |
| `test/zcode-response.test.ts` | +27 | -3 |
| `test/zcode-vision.test.ts` | +17 | -0 |
| `README.md` | +5 | -2 |

### 📁 Files Modified
- `src/zcode-vision.ts`
- `src/zcode-response.ts`
- `test/zcode-response.test.ts`
- `test/zcode-vision.test.ts`
- `README.md`
