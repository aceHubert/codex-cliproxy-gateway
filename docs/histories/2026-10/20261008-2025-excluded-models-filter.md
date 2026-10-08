# [2026-10-08 20:25] | Task: 实施排除模型配置（excludedModels）

### 🤖 Execution Context
* **Agent ID**: `zcode`
* **Base Model**: `GLM-5.3（account:zai-individual-coding-plan/GLM-5.3）`
* **Runtime**: `ZCode CLI（独立 git worktree）`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `feature/model-exclude`（自 `main@adfc248` 创建的 worktree `../codex-cliproxy-model-exclude`）

### 📥 User Query
> 按 `docs/exec-plans/active/excluded-models-filter.md` 创建 worktree 实施计划；验收使用 `/v1/models?client_version` 口径。

### 🛠 Changes Overview
**Scope:** src/（gateway、catalog、cli、config-update、webui、ui）、schemas/、test/

**Key Actions:**
- **[配置与 Schema]**：`GatewayConfig`/`schemas/gateway-config.schema.json` 新增 `excludedModels: string[]`（默认 `[]`），`config-update.ts` 提供 `parseExcludedModels`（去空、大小写去重、拒绝裸 `*`）并纳入 Web UI patch 白名单。
- **[匹配引擎]**：`catalog.ts` 新增 `compileModelFilter`/`filterExcludedModels`——前缀族（`codebuddy-intl/`）、轻量 glob（`qoder-cn/*`）、精确 ID 三种形态，大小写不敏感。
- **[网关过滤与拦截]**：`gateway.ts` 在所有适配器与上游目录合并完成后统一过滤 `/models`（含 `client_version` 的 Codex 原始目录形态）；推理类 POST 命中被排除模型时在适配器分派与通用路由两处 404 拦截（`x-codex-cliproxy-gateway: model-excluded`），不向未启用上游转发。
- **[CLI]**：`models --exclude` 无参进入终端交互勾选（全部兼容模型、旧精确规则预勾选、前缀族/通配规则保留），带参按逗号/空白拆分追加，`none`/空串清空；写盘复用 `writeConfigAndRestart`（审计 + 失效 models_cache + 热重启），支持 `--restart-codex`；`models` 无参输出新增活跃兼容模型（完整 ID + 显示名）与排除规则清单。
- **[Web UI]**：配置页新增排除模型多行文本框（每行一条规则，`src/ui/excluded-models-field.ts` 纯函数 + i18n 中英文案），保存后服务端失效 Codex 目录缓存并照常调度网关重启。

### 🧠 Design Intent (Why)
多兼容上游（ZCode/CodeBuddy/Qoder/Agy/CLIProxy）合并后目录可达上百条，Codex 模型选择器臃肿且 cn/intl 同名易混。按计划的第一性原则：过滤只做在「合并后的单一出口」，不侵入任何适配器；以带厂商前缀的完整模型 ID 为过滤核心键消除二义性；CLI/Web 交互遵循 KISS（单一 `--exclude` 参数 + 多行文本框）。

### 📊 Change Stats
> 数据来自 `git diff --cached --shortstat/--numstat`（相对 main@adfc248）；本历史文件自身不计入下表。

- **Files changed:** 18
- **Insertions:** +1260
- **Deletions:** -18

| File | +Added | -Removed |
| --- | ---: | ---: |
| `src/cli.ts` | +221 | -12 |
| `src/gateway.ts` | +30 | -1 |
| `src/catalog.ts` | +47 | -0 |
| `src/config-update.ts` | +35 | -0 |
| `src/models.ts` | +10 | -4 |
| `src/types.ts` | +7 | -0 |
| `src/webui.ts` | +8 | -0 |
| `src/ui/ConfigPage.tsx` | +29 | -1 |
| `src/ui/api.ts` | +4 | -0 |
| `src/ui/i18n.tsx` | +4 | -0 |
| `src/ui/styles.css` | +24 | -0 |
| `src/ui/excluded-models-field.ts` | +11 | -0 |
| `schemas/gateway-config.schema.json` | +10 | -0 |
| `test/model-exclude.test.ts` | +323 | -0 |
| `test/model-exclude-gateway.test.ts` | +299 | -0 |
| `docs/exec-plans/completed/excluded-models-filter.md` | +129 | -0 |
| `docs/exec-plans/tech-debt-tracker.md` | +1 | -0 |

### 📁 Files Modified
- `src/types.ts`、`schemas/gateway-config.schema.json`、`src/catalog.ts`、`src/config-update.ts`
- `src/gateway.ts`、`src/cli.ts`、`src/models.ts`
- `src/webui.ts`、`src/ui/{ConfigPage.tsx,api.ts,i18n.tsx,styles.css,excluded-models-field.ts}`（`dist/ui/` 为构建产物，不入库）
- `test/model-exclude.test.ts`、`test/model-exclude-gateway.test.ts`（新增）
- `docs/exec-plans/active/excluded-models-filter.md → completed/`、`docs/exec-plans/tech-debt-tracker.md`

### ✅ Validation
- `bun run check`（typecheck + 688 tests + build）全绿，其中新增 22 个用例覆盖：匹配引擎三形态、parseExcludedModels 归一/拒绝、`/v1/models?client_version` 两种形态过滤、404 拦截零上游转发（动态/官方/upstream-only/agy 适配器）、CLI 追加/清空/交互预勾选与规则保留、Web UI 读写与缓存失效。
- 真实进程冒烟：`serve --config` 隔离实例上 `GET /v1/models?client_version=0.150.0` 精确剔除 `gamma`（精确规则）与 `qoder-cn/qoder-code`（前缀族）；`POST /v1/responses {model:"gamma"}` 返回 404 + 修复指引；CLI `models` / `--exclude …` / `--exclude none` / 裸 `*` 拒绝均按预期。

### 🔗 References
- 执行计划（已归档）：`docs/exec-plans/completed/excluded-models-filter.md`
- 技术债（upstream-only 直通分支拦截边界）：`docs/exec-plans/tech-debt-tracker.md` 2026-10-08 行

### 🔁 Review 修复（同日第二轮）

用户 review 指出四个缺口，均已修复并补测试：

1. **README 缺文档**：「选择与刷新模型」新增「排除模型（excludedModels）」小节（CLI 三种用法、三种规则形态表、生效链路），`--restart-codex` 支持列表与 Web 界面能力描述同步更新。
2. **`config` 无参回显缺排除项**：JSON 摘要新增 `excludedModels`（直接回显规则数组；规则条数少且即观测对象，与 `selectedModels` 的计数语义区分）。
3. **组合参数静默忽略**：`models --exclude` 显式拒绝 `--select`（`--sync`/`--upstream-only`/`--model-merge-json` 已有前置守卫），新增测试断言四种组合均在写盘前报错且配置保持原样。
4. **主仓库残留**：删除主工作区 `docs/exec-plans/active/excluded-models-filter.md` 未跟踪副本（归档版已在分支 `completed/` 下）；`.omo/`、`.zcodeignore`、`active/openai-chat-completions-endpoint.md` 属其他在途工作，未触碰。

新增测试后全量 `bun run check` 仍全绿（690 tests）。
