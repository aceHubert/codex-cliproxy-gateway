## [2026-10-09 09:48] | Task: Web UI 补齐 OpenCode Zen 兼容开关

### 🤖 Execution Context
* **Agent ID**: `zcode`
* **Base Model**: `GLM-5.3 (account:zai-individual-coding-plan)`
* **Runtime**: `ZCode CLI`
* **Git User**: `hubert`
* **Branch**: `main`

### 📥 User Query
> web 上面还没有配置 opencode-zen 兼容？

### 🛠 Changes Overview
**Scope:** `src/ui/`（React 前端）、`test/webui.test.ts`、`docs/exec-plans/tech-debt-tracker.md`

**Key Actions:**
- **[api.ts]**: `UiConfig.editable` 与 `UiConfigChanges` 补 `opencodeZen` 布尔字段（后端 `/ui/api/config` 的 GET/POST 在 10-08 已支持，本次补前端类型）。
- **[ConfigPage.tsx]**: 表单态、dirty 比较、保存 changes 与开关卡片接线；卡片按 agy 模式渲染（upstream-only 下禁用并提示），区别是 zen 无本机凭据依赖（公共鉴权），**无条件显示**而非按本机探测显隐；加载时兼容未带该字段的后端（升级窗口期缺省关闭）。
- **[i18n.tsx]** + **[ConfigPage.tsx]**（文案定稿，第三轮用户反馈扩展到全部五个适配器卡片）：
  - upstream-only 提示（`*DisabledHint`）曾按反馈整体删除、后按后续反馈完整还原（与 desc 精简互不影响，仅 upstream-only 模式下渲染）；
  - desc 统一为「启用 xxx。」句式（第四轮反馈定稿），去掉「Responses 入口」措辞、「网关不刷新令牌 / 网关不会刷新或写回凭据」类描述与 upstream-only 不生效说明；
  - opencodeZen 的鉴权说明（公共鉴权 / OPENCODE_API_KEY）保留为第二行独立描述（第五轮反馈：是换行显示，不是删除）。
- **[webui.test.ts]**: config GET 断言 `editable.opencodeZen` 缺省 false；POST 应用 `opencodeZen: true`（applied 顺序、落盘值）与非法值 `"on"` → 400 /boolean/。
- **[opencode-zen-gateway.test.ts]**: 补 `OPENCODE_API_KEY` 环境变量覆盖测试（未设置回落 `Bearer public`、请求时读取即时生效、依赖注入 key 优先），该功能自 10-08 起存在但此前无测试覆盖。
- **[tech-debt-tracker.md]**: 移除「Web UI 暂无 opencodeZen 开关卡片」债项（保留指纹数据时效等其余项）。

### 🧠 Design Intent (Why)
10-08 首期落地时 UI 只做了 API 层（editable/patch），开关卡片记为技术债；本次按 agy 卡片的既有模式补齐，使 Web UI 与 CLI `config --opencode-zen on|off` 能力对齐。zen 不消费本机凭据，卡片显隐不依赖 `detected` 探测——这是与 zcode/codebuddy/qoder/agy 四个卡片唯一的结构差异。

### 📊 Change Stats
> 数据来自 `git diff --numstat`（本任务未暂存部分，含同日用户反馈修正轮）。

- **Files changed:** 5
- **Insertions:** +71（含未跟踪测试文件内的 +20）
- **Deletions:** -3

| File | +Added | -Removed |
| --- | ---: | ---: |
| `src/ui/ConfigPage.tsx` | +33 | 0 |
| `src/ui/i18n.tsx` | +8（文案两轮修正，行数持平） | 0 |
| `src/ui/api.ts` | +3 | 0 |
| `test/webui.test.ts` | +7 | -3 |
| `test/opencode-zen-gateway.test.ts` | +20 | 0 |

（另有 `docs/exec-plans/tech-debt-tracker.md` 文档更新与本文记录。）

### 📁 Files Modified
- `src/ui/api.ts`、`src/ui/ConfigPage.tsx`、`src/ui/i18n.tsx`
- `test/webui.test.ts`
- `docs/exec-plans/tech-debt-tracker.md`

### ✅ Verification
- `bun run check` 全绿（tsc 严格模式 + 全量测试 + UI 重建）。
- 开关链路闭环：UI 卡片 → `postUiConfig({opencodeZen})` → `applyWebUiConfigPatch`（白名单、布尔校验、组合校验、审计、state 同步、按需重启调度）→ config.json。
- `OPENCODE_API_KEY` 覆盖行为由单测固定（回落 public / 环境变量生效 / 注入优先）。
