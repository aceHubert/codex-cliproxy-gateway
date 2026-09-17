## [2026-09-16 21:49] | Task: Web UI 模型选择 + 拉取模型 + 按 upstreamOnly 分支保存

### 🤖 Execution Context
* **Agent ID**: `zcode`
* **Base Model**: `builtin:zai-coding-plan/GLM-5.3-Flash`
* **Runtime**: `ZCode CLI`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `codex/codex-api`

### 📥 User Query
> 把模型选择可通过 web 设置，参考 cliproxy api 中的设计添加一个拉取模型按钮，保存是根据是不是用的 upstreamOnly true 来弹窗确认是否重启 codex，确认重启，skip 跳过，false 保存后大概 5 分钟模型列表会刷新。配置加在 zcode 配置之前。

### 🛠 Changes Overview
**Scope:** `src/webui.ts`、`src/upstream-catalog.ts`（新增）、`src/config-update.ts`、`src/cli.ts`、`src/ui/*`、`test/webui.test.ts`

**Key Actions:**
- **`src/upstream-catalog.ts`（新模块）**: 把 `cli.ts` 里的 `configuredUpstreamType`/`newapiCatalogOptions`/`upstreamClientVersion`/`loadModelOverrideRules`/`rebuildCatalog`/`DEFAULT_MODELS_FILE`（含内联的 codex_client_models、vendor_models 惰性编译）移成 CLI 与 Web UI 共享模块，并新增 `fetchConfiguredUpstreamCatalog`（解析覆盖规则 → keychain 分派取 key（回环上游允许缺失）→ 按上游类型拉取/合成目录）与 `upstreamKeyOptional`（独立实现，避免 webui → gateway 循环引用）。
- **webui.ts 三个新 UI API**（全部在既有 token/Host/Origin 门禁之内）：
  - `GET /ui/api/upstream/models`：拉取上游全量目录，返回 `{ upstreamType, models:[{slug,displayName}] }`；
  - `POST /ui/api/upstream/models`：`{ selectedModels }` → 校验（字符串数组、去空白、拒绝空项/重复项；upstream-only 拒绝空选择）→ 拉取上游目录 → 校验所选 ID 存在 → `rebuildCatalog` 重建 `catalogPath` 目录文件 → `applySelectedModelsPatch` 写 config/state/审计 → 动态路由模式下 `invalidateModelsCache` 重置官方目录缓存（Codex 约 5 分钟内自动刷新，不重启网关）；
  - `POST /ui/api/codex/restart`：`stopCodexAppServers` 停止当前用户 Codex app-server（Codex 重新拉起后加载新目录）；scan unknown 回 500。
  - 错误统一经 `sanitizeUpstreamMessage` 脱敏（配置的 upstreamBaseUrl 与消息里的绝对 URL 折叠为 origin+路径）；`WebUiContext.upstreamDeps` 提供测试注入点（readKey / stopCodexServers）。
- **config-update.ts**: 新增 `parseSelectedModels` 校验与 `applySelectedModelsPatch`（写 config.json 的 selectedModels、按 instanceOnly 同步 state.json、`webui models` 审计落 gateway.log）。`selectedModels` **不进**通用 `POST /ui/api/config` 白名单——目录文件与配置字段必须同一次保存一起变更，防止「只改字段、目录不同步」的半更新。
- **UI（`src/ui/`）**: ConfigPage 在 `zcode` 字段之前新增「模型选择 / selectedModels」可编辑区：拉取模型按钮（loading/失败提示）、可折叠勾选列表（过滤框、全选/清空、上游已不提供的旧选择以 stale 行保留可取消）；`readonly.selectedModels` 移入 `editable`（card2 的只读折叠列表随之移除，单一展示源）。保存弹窗按脏字段与路由模式分支：仅模型变更 + upstreamOnly → 三键「取消 / 跳过重启 / 保存并重启 Codex」；仅模型变更 + 动态路由 →「取消 / 确认保存」并提示约 5 分钟自动刷新；与其他配置项一起变更时追加网关重启提示。保存序列 = 模型目录重建 → 其余配置（可能触发网关重启轮询恢复）→ 确认过才停 Codex app-server，结果以独立横幅提示。
- **cli.ts**: 仅改为从 `upstream-catalog.ts` 导入共享助手（行为不变，删除本地副本）。
- **zcode 开关联动禁用（复查补充）**: 网关侧 `zcodeEnabled` 在 `upstreamOnly === true` 时本就把 ZCode 入口按禁用处理（开关值保留但不生效），但 UI 此前仍允许自由切换。现 `upstreamOnly` 时 zcode 开关渲染为 `disabled`（压暗、不可点），并追加琥珀色提示「upstream-only 模式下 ZCode 入口被禁用，此开关暂不生效；切回动态路由后可重新开启」。
- **测试**: webui.test.ts 新增 6 例（拉取目录不带 key 且发送真实 client_version、保存重建目录+state+审计+缓存重置、upstream-only 空选择拒绝且不触碰上游、未知 ID/非法负载拒绝且不写盘、上游失败 502 且不泄漏 query/key、codex/restart 注入运行时成功与 unknown 500），并把 `GET /ui/api/config` 断言迁到 `editable.selectedModels`。

### 🧠 Design Intent (Why)
CLI 只有 `models --sync` 能改模型选择，Web UI 此前只读展示。CLIProxyAPI 的管理面板提供「拉取模型 + 勾选」，本任务把同等能力补进内建 UI，但必须不破坏「UI 与模型流量结构性隔离」的安全叙事：UI 进程获得的是**唯一且固定只读**的 `GET {upstreamBaseUrl}/models` 外呼 + 本地目录文件重建，不是任意转发路径；key 只进请求头，URL 一律脱敏后进响应。`selectedModels` 与 `catalogPath` 目录文件是同一次保存的两半（网关按请求重读目录文件、`selectedModels` 只是配置面记录），因此拒绝让通用配置补丁拆开它们。生效路径按路由模式分流：upstream-only 下 Codex 静态加载 `model_catalog_json`，必须重启 app-server（用户弹窗确认：确认→重启、跳过→稍后手动）；动态路由下网关每请求重读目录、重置官方缓存后 Codex 的周期刷新（约 5 分钟）自动生效，无需任何重启。

### 📊 Change Stats
> 数据来自 `git diff --shortstat` / `git diff --numstat`（本次任务工作区相对任务起点暂存区的增量）。

- **Files changed:** 10
- **Insertions:** +964
- **Deletions:** -162

| File | +Added | -Removed |
| --- | ---: | ---: |
| `src/upstream-catalog.ts` | +131 | -0 |
| `src/webui.ts` | +134 | -5 |
| `src/config-update.ts` | +42 | -0 |
| `src/cli.ts` | +9 | -82 |
| `src/ui/ConfigPage.tsx` | +268 | -61 |
| `src/ui/api.ts` | +28 | -1 |
| `src/ui/i18n.tsx` | +44 | -8 |
| `src/ui/styles.css` | +28 | -0 |
| `test/webui.test.ts` | +278 | -3 |
| `AGENTS.md` | +2 | -2 |

### 📁 Files Modified
- `src/upstream-catalog.ts`（新增）
- `src/webui.ts`
- `src/config-update.ts`
- `src/cli.ts`
- `src/ui/ConfigPage.tsx`、`src/ui/api.ts`、`src/ui/i18n.tsx`、`src/ui/styles.css`
- `dist/ui/index.html`（`bun run build:ui` 产物，未提交）
- `test/webui.test.ts`
- `AGENTS.md`
- `docs/histories/2026-09/20260916-2149-webui-model-selection.md`

### ✅ Verification
- `bun run check`：类型检查通过；332 个测试全过（webui 35 例含新增 6 例）；`build:ui` 与 CLI bundle 构建成功。
- 新增测试覆盖：拉取只发一次固定 `/models` 请求且携带 keychain 注入的 key 与 models-cache 记录的 client_version；保存后目录文件/config/state/审计四处一致、动态模式重置官方缓存、upstream-only 拒绝空选择且不重置缓存；错误路径 502 且不泄漏上游 query 与 key。

### 2026-09-17 后续修复：已选模型常驻展示与拉取后应用

**执行上下文：** Codex / GPT-6 / Codex desktop；Git User：`hubert <hubert@lejian.com>`；分支：`codex/codex-api`。

**用户诉求：** 未拉取时也必须看见当前已选模型；参考 CLIProxyAPI 截图，先拉取上游列表、勾选，再应用。

- 提取 `ModelPicker.tsx`：当前选择直接使用配置中的模型 ID 渲染，不依赖上游请求，支持逐项移除及空态；上游已下架的已选 ID 也会保留展示。
- 拉取按钮打开独立的内嵌面板，包含搜索、重新加载、当前筛选结果全选、已添加标记、待添加计数，以及关闭和应用按钮。
- 待添加状态与表单选择分离；关闭丢弃待添加项，应用去重追加至表单并关闭面板，页面保存继续沿用原有路由模式确认与持久化流程。
- 加载及保存阶段禁用相关操作；重新加载清理失效待添加项；请求序号隔离关闭、重开和卸载后的旧响应。
- 更新中英文案、暗色样式与窄屏布局，移除旧的折叠列表及直接勾选修改表单的实现。
- 新增两项首次渲染回归测试，覆盖未拉取时显示已有模型、上游下架 ID 仍可见和空选择展示。

**变更统计：** 相对本次修复起点的暂存区，通过 `git diff --shortstat` / `git diff --numstat`，新增文件通过 `git diff --no-index --numstat /dev/null <file>` 合并统计，不含本历史补记：5 个文件，+663 / -216。

| File | +Added | -Removed |
| --- | ---: | ---: |
| `src/ui/ConfigPage.tsx` | +8 | -160 |
| `src/ui/ModelPicker.tsx` | +318 | -0 |
| `src/ui/i18n.tsx` | +26 | -10 |
| `src/ui/styles.css` | +280 | -46 |
| `test/model-picker.test.ts` | +31 | -0 |

**验证：**
- `bun run check` 通过：336 个测试、类型检查及 UI/CLI 构建通过；`git diff --check` 通过。
- Chrome 开发页实测：刷新后直接显示 15 个已选模型；拉取 55 个模型，其中 15 个标记已添加；搜索与筛选全选正常。
- 勾选后关闭面板仍保留 15 个选择且保存按钮禁用；应用一个新增项后显示 16 个并启用保存；保存弹窗仍提示动态路由约 5 分钟刷新。
- 取消保存并移除测试添加项后恢复原有 15 个选择、保存按钮禁用；没有提交生产配置更改。开发页面保留供用户查看。

### 2026-09-17 已选模型列表紧凑化

- 用户要求已选模型更紧凑，并明确保持每个模型独占一行、不使用 Flex 布局。
- 已选列表及行内容改用 Grid；常规行高从 46px 缩至 30px，行间距从 5px 缩至 3px，移除按钮缩至 24px，长模型名仍可换行。
- 本次仅调整样式，选择、应用与保存行为不变。
- 变更统计来自相对本次起点暂存区的 `git diff --shortstat` / `git diff --numstat`，不含历史补记：`src/ui/styles.css`，1 个文件，+18 / -8。
- 验证：`bun run build:ui` 与 `git diff --check` 通过；Chrome 开发页已确认单列紧凑行布局。

### 2026-09-17 过滤上游隐藏模型

- 用户要求 Web 模型选择与 `models --sync` 都排除 `visibility: "hide"`。
- 在 `fetchUpstreamCatalog` 的统一返回边界过滤，覆盖 CLIProxy 原始目录和 new-api 合成条目；缺省 visibility、`list` 及其他值不受影响，官方目录及其 last-good 缓存不变。
- Web 拉取不再显示隐藏项，保存时拒绝隐藏 ID；CLI 的交互选择和 `--select all` 不包含隐藏项，显式选择隐藏 ID 报错，避免写入配置或模型目录。
- 全部模型被隐藏时返回空可选列表供 Web 展示空态；CLI 继续通过现有无可用模型校验拒绝同步。不会主动删除历史配置中的模型选择。
- 新增共享入口测试，并扩展 Web GET/POST 与 CLI 动态路由、upstream-only 同步测试；同步更新 AGENTS 中的模型目录规则。
- 验证：`bun run check` 通过（344 个测试、类型检查、UI/CLI 构建）；开发页 UI 后端重启后实测拉取显示 52 个模型，`codex-auto-review` 已不在列表中，待添加项为 0。未执行真实模型同步或提交选择。
- 本次变更统计（相对任务起点暂存区，排除其他并行改动及历史补记）：`git diff --shortstat` / `git diff --numstat` 加新增文件的 `--no-index --numstat`，5 个文件，+181 / -7。

| File | +Added | -Removed |
| --- | ---: | ---: |
| `AGENTS.md` | +2 | -0 |
| `src/catalog.ts` | +7 | -3 |
| `test/model-catalog-dynamic.test.ts` | +16 | -3 |
| `test/webui.test.ts` | +12 | -1 |
| `test/upstream-visibility.test.ts` | +144 | -0 |
