## [2026-10-09 22:53] | Task: 补齐 OpenCode Zen 的模型排除作用域与 Web 分组编辑

### 🤖 Execution Context
* **Agent ID**: `zcode`
* **Base Model**: `glm-5.3-flash`
* **Runtime**: `ZCode CLI`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `feature/opencode-zen`

### 📥 User Query
> 把opencode zen的模型exclide 的web设置补充上

### 🛠 Changes Overview
**Scope:** gateway / config-update / webui / cli / docs

**Key Actions:**
- **[排除作用域]**: `isLocalAdapterModel` 纳入 `isZenModel`——zen 模型进入 excludedModels 的目录过滤与转发前 404 拦截作用域（上一轮 b330771 的「Zen 不新增排除组」取舍按用户要求反转）。
- **[chat 入口补漏]**: `/chat/completions` 的 zen 拦截发生在通用排除检查之前，被排除的 zen 模型在该分支就地 404，不再漏拦转发。
- **[Web 分组]**: `ADAPTER_EXCLUDED_GROUPS` 新增 `opencode-zen` 组（endpoint `opencodeZen`、固定前缀 `opencode-zen/`，无家族通配形态）；Web UI 在 OpenCode Zen 开关行下渲染分组输入框，文案中英文补齐。
- **[CLI]**: `collectCompatibleModels` 不再按 `includeUpstream` 排除 zen——排除选择器（`models --exclude` 交互勾选）与普通列表同样列出已启用的 zen 模型；`--exclude` 帮助文本补 `opencode-zen/` 前缀。
- **[文档与 schema]**: README 排除模型章节、`schemas/gateway-config.schema.json` 的 excludedModels 描述同步六产品作用域。

### 🧠 Design Intent (Why)
用户要求在 Web 设置里补上 opencode-zen 的模型排除。此前 zen 被刻意留在排除作用域外（合并排除功能时保留 Zen 与实例隔离），本次把 zen 纳入与其他兼容端同权的作用域：分组定义复用现有按产品归一的机制（zen 是固定单前缀，直接 `groupDefinition("opencodeZen", "opencode-zen/")`），目录过滤与两个推理入口的拦截都由 `isLocalAdapterModel` 一处扩展自动生效，仅 chat/completions 分支需要显式补拦。

### 📊 Change Stats
> 数据来自 `git diff --shortstat` / `git diff --numstat`（工作区未提交变更）。

- **Files changed:** 11
- **Insertions:** +187
- **Deletions:** -46

| File | +Added | -Removed |
| --- | ---: | ---: |
| `README.md` | +13 | -13 |
| `schemas/gateway-config.schema.json` | +1 | -1 |
| `src/cli.ts` | +8 | -10 |
| `src/config-update.ts` | +7 | -3 |
| `src/gateway.ts` | +9 | -2 |
| `src/ui/ConfigPage.tsx` | +2 | -0 |
| `src/ui/api.ts` | +1 | -1 |
| `src/ui/i18n.tsx` | +2 | -0 |
| `test/model-exclude-gateway.test.ts` | +88 | -4 |
| `test/model-exclude.test.ts` | +51 | -8 |
| `test/opencode-zen-gateway.test.ts` | +5 | -4 |

### 📁 Files Modified
- `README.md`
- `schemas/gateway-config.schema.json`
- `src/cli.ts`
- `src/config-update.ts`
- `src/gateway.ts`
- `src/ui/ConfigPage.tsx`
- `src/ui/api.ts`
- `src/ui/i18n.tsx`
- `test/model-exclude-gateway.test.ts`
- `test/model-exclude.test.ts`
- `test/opencode-zen-gateway.test.ts`

### 🧪 Verification
- `bun run check` 全绿：typecheck 通过，827 tests / 0 fail，UI（dist/ui/index.html）与 CLI（dist/index.js）构建成功。
- 新增测试：zen 分组定义与展开/回显往返、`opencode-zen/` 前缀写入校验、zen 模型进入排除选择器、zen 排除模型在 `/v1/models` 撤下且 chat/responses 双入口 404 拦截（未排除模型继续转发）。
- 更新旧行为锚点：`opencode-zen-gateway.test.ts` 两个「Zen 不参与排除」用例改为「排除只命中点名模型、选择器包含 Zen」。
