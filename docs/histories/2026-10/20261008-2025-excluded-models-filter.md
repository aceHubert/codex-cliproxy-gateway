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

### 🔁 需求迭代（同日第三轮，未提交）

用户调整 Web 端排除模型的编辑形态，改动保留在工作区（按要求未 commit）：

1. **Web 不感知前缀**：删除全局多行文本框，改为「每个兼容端开关下方按前缀分组的输入框」（ZCode 1 组、CodeBuddy 4 组、Qoder 2 组、Agy 1 组、上游 1 组）；用户只填模型名，保存时由网关自动补全该组前缀（`excludedModelGroupsFor` + `expandExcludedModelGroups`，上游组动态路由用 `config.prefix`、upstream-only 用空串）。GET `/ui/api/config` 下发 `excludedGroups/excludedEntries/excludedOther`（`splitExcludedModelsByGroup` 剥前缀；整族与未知前缀规则进 `other` 原样往返），POST 接受 `excludedModelGroups` + `excludedModelOther` 整组替换。
2. **禁止整族排除**：`parseExcludedModels` 严格拒绝裸 `*`、`prefix/` 与 `prefix/*`（提示改用对应端开关）；分组条目拒绝裸 `*` 与「自带前缀的粘贴」；`normalizeExcludedModels` 宽松归一存量整族规则（运行期引擎仍识别），CLI `--exclude` 的 current/merge 走宽松、新输入走严格，存量规则不阻塞编辑。
3. **CLI 同步收紧**：`models --exclude qoder-cn/*` / `qoder-cn/` 现在显式报错；usage 与 README 的规则表重写（整族形态标记为写入拒绝，指向端开关）。
4. **测试**：新增/更新分组 split/expand、upstream-only 裸 ID、非法条目（裸 *、粘贴前缀、未知分组、互斥字段）、存量整族规则兼容（CLI 追加不丢、Web other 往返）等用例；全量 `bun run check` 全绿（696 tests）。

### 🔁 需求迭代二（同日第四轮，未提交）

用户明确排除的作用域：**仅对本地兼容转发有效**。上游（cliproxy/new-api）模型的出现与否由 `models --sync` 的 selectedModels 管理，官方原生模型不参与排除。

- **作用域谓词**：`config-update.ts` 新增 `isLocalAdapterModel`（复用各适配器权威 `is*Model` 谓词，覆盖 `zcode-team-coding-plan/` 套餐前缀与 `codebuddy/`、`qoder/` 旧前缀）与 `isLocalAdapterExclusionPattern`（字面量探测，覆盖 `zcode/glm*`、`zcode-*` 等通配写法、拒绝前导 `*`）。
- **网关**：`filterExcludedModels` 增加 scope 参数，`/models` 过滤与推理 POST 拦截都以 `isLocalAdapterModel` 划界——作用域外（上游/官方）的历史规则不再过滤目录、不再拦截请求；upstream-only 模式下排除整体不生效。
- **写入校验**：`parseExcludedModels` 对作用域外规则（`cliproxy/…`、官方 ID）显式拒绝并指引去 `models --sync`；分组条目额外拒绝含 `/` 的写法（防止 zcode 套餐前缀误拼）。存量作用域外规则走宽松归一，保留在配置与 Web「其他排除规则」中但不生效。
- **分组/交互**：删除上游分组（8 个适配器分组）；CLI 交互勾选列表只收集本地适配器模型（`collectCompatibleModels` 支持 `includeUpstream: false`），TTY 检查提前；usage/README/Schema 同步改为作用域表述。
- **测试**：作用域谓词、分组 8 项、上游规则不过滤不拦截、upstream-only 不受影响、agy 场景下作用域外规则不误伤、CLI 交互仅列本地模型（注入 agy 适配器依赖）等用例更新/新增；全量 `bun run check` 全绿（698 tests）。

### 🔁 需求迭代三（同日第五轮，未提交）

「其他排除规则」框原先仅在 other 非空时渲染，导致 Web 没有任何入口新增分组框表达不了的规则（如 `zcode-team-coding-plan/…` 套餐前缀）。修正：

- **框常驻渲染**（不再依赖 `excludedOther.length > 0`），成为 Web 的完整规则输入口；
- **other 校验收紧到与 CLI 一致**：`expandExcludedModelGroups` 的 other 路径改走 `parseExcludedModels`——拒绝裸 `*`、整族形态与作用域外规则；存量此类规则会在保存时被明确拒绝并指出具体行，需删除（整族改用端开关）后才能保存；
- i18n 文案改为「完整规则输入口」表述；测试同步更新（套餐前缀经 other 往返、整族/作用域外在 other 被拒）；全量 `bun run check` 全绿（698 tests）。

### 🔁 需求迭代四（2026-10-09，未提交）

用户要求排除输入框「一直保留，清空后可继续添加」——补齐最后一个会消失的场景：端行因「未检测到本地配置且开关关闭」整体隐藏时，其分组输入框随之消失。修正：隐藏端的分组输入框以独立行（标签「排除模型（未启用的端）」）常驻渲染，规则可预先添加、端启用后即生效。至此所有排除输入框（8 个分组框 + 完整规则框）均不依赖规则内容、目录状态或端检测而消失，仅在保存/重启进行中短暂禁用。全量 `bun run check` 全绿（698 tests）。

### 🔁 需求迭代五（2026-10-09，未提交）

用户定界：不存在无前缀的排除场景——排除只处理本地代理兼容，每条规则都必须带**确定的适配器前缀**，官方模型与 cliproxy 完全不参与。据此取消「其他排除规则」框（无前缀兜底概念），改为**分组即前缀权威清单**：

- 适配器导出权威前缀清单（`zcodeStaticModelPrefixes`：zcode/ + 个人/团队/免费套餐前缀；`codebuddyModelPrefixes`：产品×地域 4 前缀；qoder 国际/国内；agy），分组从 8 个扩展到 11 个，zcode 套餐模型在自己分组内编辑、无需完整规则输入口。
- 写入校验收紧为「必须以完整适配器前缀开始」：`zcode-*`（不完整前缀）、`gpt-*`、裸模型名、作用域外一律拒绝；通配只允许出现在前缀之后；zcode 的动态 provider 前缀（`zcode-<id>/`）按段内无通配的完整形态接受；旧前缀 `codebuddy/`、`workbuddy/`、`qoder/` 属确定前缀，予以接受。
- `excludedModelOther` 从 Web patch API 移除（分组整组替换 excludedModels，归不进分组的存量规则随保存移除）；GET 的 `excludedOther` 保留仅作诊断，UI 不再渲染。
- UI 删除 other 框与相关表单态，新增 zcode 三档套餐分组文案；README/Schema/usage 同步为「完整前缀必须」表述。全量 `bun run check` 全绿（698 tests）。

### 🔁 需求迭代六（2026-10-09，未提交）

用户确认 Web 保存形态：zcode 不逐档列举套餐前缀，整族收成一个框，保存为 `zcode*/模型名` 的家族通配（一条 glob 同时命中 zcode/、各套餐前缀与动态 provider 前缀；引擎的 glob 匹配天然支持，仅写入校验此前拒绝）。实现：`ExcludedModelGroupDefinition` 增加 `matchPrefixes`（回显拆分识别全部家族前缀，保存统一归一为家族通配形态）；分组回到 8 个；`isLocalAdapterExclusionPattern` 接受 `zcode*/…`（整族形态 `zcode*/` 本身仍被拒）；cn/intl 等用户可感知区分保持独立分组。README/Schema/usage 同步；全量 `bun run check` 全绿（698 tests）。

### 🔁 需求迭代七（2026-10-09，未提交）

用户裁决：Web 用户没有可输入的前缀，cn/intl 地域不可感知（凭据地域跟登录走）——分组按「用户可感知的产品」归一，与 zcode 套餐同一逻辑：**5 个分组框**（ZCode、CodeBuddy、WorkBuddy、Qoder、Antigravity），全部保存为产品级家族通配（`zcode*/`、`codebuddy-*/`、`workbuddy-*/`、`qoder-*/`、`agy/`），`matchPrefixes` 收编各产品的地域/套餐/旧前缀做回显归一。CLI 精确前缀规则仍可写，但 Web 保存会将其归一为产品级通配（保存面放宽为产品粒度，属已接受的设计取舍）。README/Schema/usage/引擎测试（产品通配不越界到其他产品）同步；全量 `bun run check` 全绿（698 tests）。

### 📊 迭代二至七合计变更统计

> 数据来自 `git diff --numstat HEAD`（相对已提交的 4758ec5）。

- Files changed: 17
- Insertions: +916 / Deletions: -186
- 核心面：`src/config-update.ts`（分组归一/作用域/校验）、`src/catalog.ts`（filter scope）、`src/gateway.ts`（作用域拦截）、`src/cli.ts`（CLI 收紧与收集）、`src/webui.ts` + `src/ui/*`（分组编辑 UI）、`README.md`、`schemas/gateway-config.schema.json`、两个测试文件与历史/技术债文档。
