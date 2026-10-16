## [2026-10-16 12:06] | Task: 展示并同步 CodeBuddy 双地域目录

### 🤖 Execution Context
* **Agent ID**: `codex`
* **Base Model**: `GPT-6`
* **Runtime**: `Codex Desktop`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `feat/model-catalog-push`

### 📥 User Query
> auto 模式应按 .info 登录支持情况同时展示 codebuddy-cn/intl，模型同步也覆盖两地；
> Web 与 codebuddy --switch 仅将显示格式改为 Auto(account / intl|cn)。
> 继续完成实施，并验收两个地域是否同时出现在 /v1/models。

### 🛠 Changes Overview
**Scope:** `@agent-proxy/codebuddy`、网关账号显示、目录与模型同步测试。

**Key Actions:**
- **地域枚举**：目录入口复用 `forProduct(product, region)`，依据 `.info` 内存快照分别选取两地凭据；正常缺失地域不触发重复重扫，锁定账号保持原地域限制。
- **独立缓存**：产品缓存文件名保持不变，文件内以 `profiles` 分别保存地域目录；继续校验账号身份及内容指纹，保留各侧 last-good，并支持旧单目录缓存迁移。
- **同步链路**：模型刷新与离线推送共用适配器目录入口，新增真实临时 ZCode 配置测试，证明两地完整模型 ID 均被保留。
- **显示格式**：Web 与 CLI 自动项统一显示 `Auto(account / region)`，无有效登录时显示 `Auto`；选项过滤、选择值与账号选择行为保持原样。

### 🧠 Design Intent (Why)
凭据层已经能按模型前缀选择两地登录，但目录入口此前只按最新登录选择一个地域。
显式枚举现有可用地域，使目录与实际请求路由一致；文件内部按 profile 隔离，避免两地缓存互相覆盖。
各地域独立拉取实际模型清单，不通过复制另一地域目录推断可服务模型。

### ✅ Validation
- `bun run check` 再次通过：1172 项测试，0 失败，包含边界检查、构建、UI 构建与严格类型检查。
- 独立只读审查通过，覆盖双地域展示、账号锁定、缓存迁移及 Auto 显示范围。
- 使用本机已有登录及隔离运行目录启动当前工作区网关，通过真实 HTTP `/v1/models` 验收：CN 19 个、INTL 7 个，四个产品地域目录接口均返回 HTTP 200。
- 现有开发网关源码进程早于本次改动启动；经既有 launchd 重启入口加载当前代码后，直接请求本机 `8320` 的 `/v1/models`，返回总计 68 个模型，其中 `codebuddy-cn/*` 19 个、`codebuddy-intl/*` 7 个，断言两侧均非空。
- 真实缓存的离线同步收集通过：CN 19 个、INTL 14 个，来源失败列表为空且禁止联网；这是应用排除规则前的完整目录，当前规则过滤后的 HTTP 展示为上述 CN 19 个、INTL 7 个。
- 验收复用当前 `auto` 配置和已有排除规则，未修改实际登录、账号选择或客户端配置；仅重启现有开发服务，未发布或全局安装。

### 📊 Change Stats
> 未提交任务：通过 `git diff --shortstat` 与 `git diff --numstat` 统计本任务独占的八个已跟踪文件；
> `cli.ts` 仅计 Auto 标签一行修改，其余模型推送改动属于已有任务；新测试用
> `git diff --no-index --numstat /dev/null test/codebuddy-model-sync.test.ts` 统计。
> 以下不含执行计划与本历史记录。

- **Files changed:** 10
- **Insertions:** +472
- **Deletions:** -54

| File | +Added | -Removed |
| --- | ---: | ---: |
| `apps/gateway/src/cli.ts`（仅 Auto 标签） | +1 | -1 |
| `apps/gateway/src/ui/ConfigPage.tsx` | +2 | -3 |
| `apps/gateway/src/ui/i18n/locales/zh/config.ts` | +1 | -1 |
| `packages/codebuddy/README.md` | +5 | -0 |
| `packages/codebuddy/src/catalog.ts` | +35 | -15 |
| `packages/codebuddy/src/credentials.ts` | +3 | -2 |
| `packages/codebuddy/src/index.ts` | +20 | -13 |
| `test/codebuddy-catalog.test.ts` | +123 | -7 |
| `test/codebuddy-gateway.test.ts` | +119 | -12 |
| `test/codebuddy-model-sync.test.ts` | +163 | -0 |

### 📁 Files Modified
- 上述十个实现、文档与测试文件。
- `docs/exec-plans/completed/codebuddy-multi-region-catalog.md`。
