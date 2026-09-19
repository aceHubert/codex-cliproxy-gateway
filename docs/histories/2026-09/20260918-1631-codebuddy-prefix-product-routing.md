# [2026-09-18 16:31] | Task: CodeBuddy/WorkBuddy 前缀→产品路由与多凭据目录扫描

### 🤖 Execution Context
* **Agent ID**: `zcode`
* **Base Model**: `builtin:zai-coding-plan/GLM-5.3`
* **Runtime**: `ZCode CLI`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `feature/codebuddy`

### 📥 User Query
> 两个都登录了国内或国际时任选凭据即可；`codebuddy/` 与 `workbuddy/` 前缀仍要区分——workbuddy 必须走 IDE 上游接口不能走 cli；缓存文件按产品×地域命名（`codebuddy/workbuddy-intl/cn-catalog.json`）；display_name 加 `<INTL/CN>/` 前缀且去掉 `OBC/`。

### 🛠 Changes Overview
**Scope:** codex-cliproxy（`src/codebuddy/` 第二轮迭代 + webui 探测 + 测试 + 执行计划更新）

**Key Actions:**
- **[credentials]**: 单固定文件 → 认证目录扫描全部 `*.info`；按 profile 分组、同 profile 取最近刷新；新增 `forProduct(product)` 选取接口——活动地域由最近刷新的登录决定，同产品凭据优先、缺失时同地域另一产品回退（token 沿用、接口换成请求前缀的产品）；单文件损坏/未知域名/符号链接只跳过并带文件名报错。每次选取前重扫（目录内仅几个 KB 级文件，正确性不依赖 fs.watch 事件时机，watch 退化为提前触发）。
- **[index]**: 前缀决定产品接口——`codebuddyModelProduct` 把 `codebuddy/`→cli 端点+CLI 身份头、`workbuddy/`→IDE 端点+WorkBuddy 身份头；日志 `family` 由请求前缀决定（不再由凭据 profile 推导）；适配器目录凭据清单按 cli/work 两产品各选一份，某产品无登录时跳过其目录族。
- **[catalog]**: 每个产品×地域接口独立 `/v3/config` 拉取 + 双指纹 + TTL + last-good 回退；两前缀族合并进 `/v1/models`；磁盘缓存按 `{codebuddy|workbuddy}-{cn|intl}-catalog.json` 命名（旧单文件弃用）；display_name 改为 `INTL/模型名 (x倍率)`、`CN/模型名 (free)`（无 OBC 前缀）；`CATALOG_SCHEMA_VERSION` 5 令旧缓存整体失效。
- **[webui]**: `codebuddyCredentialsPresent` 改为目录级 `.info` 存在性探测；`providerDeps.codebuddyInfoFile` → `codebuddyAuthDir`。
- **[计划/测试]**: 归档计划新增「第二轮迭代」章节与三条决策记录；credentials 测试重写为目录模型（产品×凭据矩阵、混合地域、多文件去重、坏文件隔离），catalog/gateway/webui 测试跟进新接口。

### 🧠 Design Intent (Why)
- **额度共享让「账号」成为唯一身份维度**：国内两站在 CLI `product.json` 的同一 `internalDomain` 列表内，同账号同额度；凭据选择因此免掉排序偏好——同地域任选，回退时只换接口不换 token。
- **前缀承载产品上游选择**：首期实现里前缀只是名字（凭据 profile 决定端点），`workbuddy/x` 在 cli 凭据下被 serves 校验挡成 404；本轮让前缀真正驱动端点/身份头/目录平台头。
- **多产品登录此前不可见**：不同产品/客户端的登录各有独立 `authentication.id` → 不同 `.info` 文件，旧实现只读固定文件名，WorkBuddy 桌面登录对网关不存在；目录扫描消除该盲区。
- **正确性去 fs.watch 化**：目录 mtime 不随文件原地重写变化、事件到达时机在满负载测试下不稳定（曾致全量套件偶发 18 连挂），改为每次选取前重扫 + applyScan 的 token 级变化检测，测试不再等待真实事件。

### 📊 Change Stats
> 本轮基于未提交的 feature 工作区增量（模块首建见 20260917-2010 历史）；下列为本任务触及文件的当前规模，行级增删以工作区为准。

- **Files changed:** 9（另有执行计划/本历史）

| File | 现规模 | 说明 |
| --- | ---: | --- |
| `src/codebuddy/credentials.ts` | 359 | 缓存层重写为目录扫描+forProduct |
| `src/codebuddy/catalog.ts` | 413 | 多接口存储+缓存命名+显示名 |
| `src/codebuddy/index.ts` | 288 | 前缀→产品路由 |
| `src/webui.ts` | 589 | 目录级探测 |
| `test/codebuddy-credentials.test.ts` | 264 | 重写 |
| `test/codebuddy-catalog.test.ts` | 469 | 更新+双族用例 |
| `test/codebuddy-gateway.test.ts` | 517 | stub 接线+目录头断言 |
| `test/webui.test.ts` | 1197 | 探测用例改目录 |
| `docs/exec-plans/completed/codebuddy-proxy-adapter.md` | 137 | 第二轮迭代章节 |

### 📁 Files Modified
- `src/codebuddy/credentials.ts`、`src/codebuddy/catalog.ts`、`src/codebuddy/index.ts`
- `src/webui.ts`
- `test/codebuddy-credentials.test.ts`、`test/codebuddy-catalog.test.ts`、`test/codebuddy-gateway.test.ts`、`test/webui.test.ts`
- `docs/exec-plans/completed/codebuddy-proxy-adapter.md`

### ✅ Verification
- `bun run typecheck` 通过；`bun test` 417 项 0 失败，连续 6 次全量运行稳定（修复前偶发 155 项/18 挂的 fs.watch 时序连锁）；`bun run check`（类型+测试+构建）通过。
- 新增覆盖：前缀×凭据矩阵（同产品/同地域回退/混合地域取最近刷新）、同 profile 多文件取最新、坏文件隔离带文件名报错、双产品目录各拉各的并合并两前缀族、缓存文件按产品×地域命名、`INTL/`/`CN/` 显示名、目录级存在性探测。
- 未做真实上游验收调用（本轮为路由/凭据层重构，协议链路未动；真实调用验证沿用 20260917-2010 的结果）。
