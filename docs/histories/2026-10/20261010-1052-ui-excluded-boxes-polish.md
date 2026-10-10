## [2026-10-10 10:52] | Task: 排除输入框合并验证与 placeholder/描述/i18n 变量打磨

### 🤖 Execution Context
* **Agent ID**: `zcode`
* **Base Model**: `glm-5.3-flash`
* **Runtime**: `ZCode CLI`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `feature/opencode-zen`

### 📥 User Query
> 把这两个框合并成一个，由接口自动把 workbuddy*/ codebuddy*/都补充上（附截图：两框并排）
> 然后把placeholder 修改例如的模型 agy 如 gpt-*、zcode 如 glm-5.2-*、qoder 如 qwen-3.7-*、opencode zen 如 mimo-*
> 排除该组下的描述精简为：排除该组下的这些模型：每行一个模型名（不带前缀）。
> placeholder 直接写死就好了，翻译传变量
> i18n 不支持传变量吗，怎么是使用的replace?
> react 不是有i18n package 支持吗？

### 🛠 Changes Overview
**Scope:** webui（本轮）；两框问题经核实为运行中网关进程持有旧后端，代码在上一轮已合并，无新改动。

**Key Actions:**
- **[两框核实]**: 截图中 CodeBuddy/WorkBuddy 两框并排来自「新 UI + 旧后端进程」组合——webui 的 `/ui` HTML 每次请求从磁盘读取（重建即新样式），而 API 分组逻辑在网关进程启动时加载；当前构建产物与测试均已断言 5 组（codebuddy 单组双前缀）。重启网关进程即恢复一框，本轮无代码改动。
- **[placeholder]**: 改为按分组示例（zcode glm-5.2-*、codebuddy gemini-2.5-flash、qoder qwen-3.7-*、agy gpt-*、opencode-zen mimo-*）；示例模型为不参与翻译的常量，写死在 ConfigPage 的 `EXCLUDED_GROUP_EXAMPLES`，文案模板进 i18n（`excludedGroupPlaceholder: "每行一个模型名，如 {example}"`）。
- **[描述精简]**: `descExcludedGroup` 缩为「排除该组下的这些模型：每行一个模型名（不带前缀）。」（中英同步）。
- **[i18n 变量支持]**: `t` 升级为 `(key, vars?)` 签名，新增 `formatTemplate` 做 `{name}` 占位符插值（缺失变量原样保留）；`useI18n` 的 useCallback 与默认 context 同步。LogsPage 的 `pagerStatus` 由三连 `replaceAll` 迁移到 `t(key, vars)`，统一插值惯例。
- **[i18n 方案权衡]**: 评估 react-i18next / react-intl：本 UI 是内建单页（~300KB 内联 HTML、仅中英两语言、零外部运行时依赖），AGENTS.md 约束避免仅服务单一调用点的依赖；~200 个文案键迁移无功能收益，维持手写词典 + formatTemplate。

### 🧠 Design Intent (Why)
用户看到的两框是部署态问题而非代码问题，需要给出明确成因与恢复方式（重启网关）。placeholder 示例按产品区分能直观提示各端的模型命名风格（通配写法）；示例模型名不是文案，不进翻译词典，走「模板进 i18n、变量写死传参」。`t` 原生支持变量后，插值成为 i18n 模块的内建能力而不是各调用点的 replaceAll 样板。

### 📊 Change Stats
> 数据来自 `git diff --shortstat` / `git diff --numstat`（工作区未提交变更，累计三轮：zen 排除、合并双框、本轮打磨）。

- **Files changed:** 13
- **Insertions:** +278
- **Deletions:** -131

| File | +Added | -Removed |
| --- | ---: | ---: |
| `README.md` | +13 | -13 |
| `schemas/gateway-config.schema.json` | +1 | -1 |
| `src/cli.ts` | +8 | -10 |
| `src/config-update.ts` | +29 | -26 |
| `src/gateway.ts` | +9 | -2 |
| `src/ui/ConfigPage.tsx` | +28 | -26 |
| `src/ui/LogsPage.tsx` | +1 | -4 |
| `src/ui/api.ts` | +5 | -4 |
| `src/ui/i18n.tsx` | +20 | -17 |
| `src/ui/styles.css` | +3 | -3 |
| `test/model-exclude-gateway.test.ts` | +88 | -4 |
| `test/model-exclude.test.ts` | +84 | -18 |
| `test/opencode-zen-gateway.test.ts` | +5 | -4 |

### 📁 Files Modified
- `src/ui/ConfigPage.tsx`
- `src/ui/LogsPage.tsx`
- `src/ui/i18n.tsx`

### 🧪 Verification
- `bun run check` 全绿：typecheck 通过，827 tests / 0 fail，UI 重建成功。
- 临时预览实例 + DOM 快照验证：CodeBuddy/WorkBuddy 行单框、五框 placeholder 各自示例（glm-5.2-* / gemini-2.5-flash / qwen-3.7-* / gpt-* / mimo-*）、精简描述生效；验证后预览进程与临时目录已清理。
