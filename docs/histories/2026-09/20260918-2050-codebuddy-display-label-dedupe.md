# [2026-09-18 20:50] | Task: CodeBuddy display_name 产品×地域标签与同名模型去重

### 🤖 Execution Context
* **Agent ID**: `codex`
* **Base Model**: `codebuddy/deepseek-v4.1-flash`
* **Runtime**: `Codex Desktop`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `feature/codebuddy`

### 📥 User Query
> codex 中怎么出现了 2 次 codebuddy 一样的模型选择；为什么会生成 2 个文件呢？我只有一个账号应该只有 1 个才会啊；那把前缀更新一个分别为 INTL-W/INTL-C CN-W/CN-C 用于区分；W 表示 work，C 表示 cli；进行一次去重，优先 cli，free，倍率低的；CATALOG_SCHEMA_VERSION 这个为什么还有啊，可以不要了吧。

### 🛠 Changes Overview
**Scope:** codex-cliproxy（`src/codebuddy/` 目录展示层 + 测试 + 执行计划）

**Key Actions:**
- **[catalog]**: display_name 标签由「地域」升级为「地域-产品」——`displayLabel(profile)` 产出 `INTL-C`/`INTL-W`/`CN-C`/`CN-W`（C=CodeBuddy CLI，W=WorkBuddy）；`displayNameWithCredits`、`synthesizeCodebuddyEntry`、`buildCodebuddyCatalog` 的 region 参数改为 profile，`fetchUpstreamCatalog` 传 `credential.profile`。
- **[catalog]**: 新增 `dedupeCodebuddyCatalog`，按裸 ID 合并两个前缀族的同名条目，保留 cli 优先 → 倍率升序（免费 x0 天然最前）→ 倍率缺失排最后的那一条；接入 `mergeCodebuddyCatalog`。
- **[catalog]**: 移除 `CATALOG_SCHEMA_VERSION`——适配器启动即 `refresh()` 强制刷新并绕过 TTL，代码更新必伴随重启，旧缓存本就会按新规则重建，常量冗余；缓存键回归 `{profile, revision, identity}`，键形状变化本身让现有缓存一次性失效。
- **[测试]**: display_name 断言改为产品标签；新增两条去重用例；旧缓存键用例改为断言已移除的 version 字段不再命中；workbuddy 路由用例断言去重只影响展示、请求仍可达。
- **[文档]**: 执行计划第四轮迭代章节补「同名模型去重」与「移除结构版本」决策记录。

### 🧠 Design Intent (Why)
- **单账号也会产出两个目录族**：`families()` 按 profile 去重，而目录存储对 cli/work 两产品各取一次凭据；`forProduct` 在同产品凭据缺失时回退同地域另一产品（只换端点与身份头、沿用 token），于是单份 `intl-cli` 登录同时撑起 `intl-cli` 与 `intl-work` 两个目录族，各写一份 `{codebuddy|workbuddy}-intl-catalog.json`。文件数反映的是「产品×地域接口数」而非账号数。
- **两族并非冗余**：work 端点有 `hy4-preview-f`、`deepseek-v4.1-flash-sg` 等 cli 侧不存在的条目，因此保留两族、只做展示去重。
- **产品标签与去重互补**：标签让单侧独有的同裸 ID 条目仍可辨认（如两侧 Hy4 preview 倍率不同），去重则消除完全重合的重复项。
- **去重不削弱可路由性**：`knownModels` 取去重前的完整 slug 集合，被隐藏的 `workbuddy/` 重名条目仍能正常请求并路由到 WorkBuddy 端点。
- **结构版本号确属冗余**：其唯一职责是合成规则变化时让旧缓存失效，而启动强制刷新已覆盖该场景；保留它反而制造「改了 display_name 必须记得手动加版本」的隐式纪律。

### 📊 Change Stats
> 数据来自本次任务相关文件的 `git diff --numstat`（工作区增量，基线为任务开始前的未提交状态）。

- **Files changed:** 4
- **Insertions:** +473
- **Deletions:** -87

| File | +Added | -Removed |
| --- | ---: | ---: |
| `src/codebuddy/catalog.ts` | +171 | -57 |
| `test/codebuddy-catalog.test.ts` | +217 | -23 |
| `test/codebuddy-gateway.test.ts` | +47 | -1 |
| `docs/exec-plans/completed/codebuddy-proxy-adapter.md` | +38 | -6 |

### 📁 Files Modified
- `src/codebuddy/catalog.ts`
- `test/codebuddy-catalog.test.ts`
- `test/codebuddy-gateway.test.ts`
- `docs/exec-plans/completed/codebuddy-proxy-adapter.md`

### ✅ Verification
- `bun run typecheck` 通过。
- `bun test test/codebuddy-catalog.test.ts test/codebuddy-gateway.test.ts` 通过：40 项 0 失败。
- 真实缓存实测去重：31 条 → 17 条，`workbuddy/hy4-preview-f` 与 `workbuddy/deepseek-v4.1-flash-sg` 等单侧条目保留；新标签示例 `INTL-C/GPT-5.6-Luna (x0.14)`、`INTL-W/GPT-5.6-Luna (x0.14)`。
- `bun test` 全量在沙箱内因 `listen(0)` 报 `EPERM` 失败（与本次改动无关，webui/websocket 用例需绑定本机端口）。
