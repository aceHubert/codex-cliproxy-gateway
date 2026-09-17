## [2026-09-12 18:29] | Task: upstream-only 模式下将 ZCode 按禁用处理

### 🤖 Execution Context
* **Agent ID**: `ZCode`
* **Base Model**: `deepseek-v4.1-flash`
* **Runtime**: `ZCode Desktop`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `codex/codex-api`

### 📥 User Query
> 再一个问题就是 cpa-only 时，zcode 当成禁用处理。

（承接前两轮：先核查「重启后 zcode 模型没起来」是否为配置缺失，再验证「zcode 已启用但
ZCode 配置不可用」时目录是否会清空、调用是否报错。确认上游目录被 ZCode 劫持后，用户要求
在 `upstreamOnly`（旧名 cpa-only）下把 ZCode 整体当作禁用。）

### 🛠 Changes Overview
**Scope:** Bun/TypeScript CLI 网关（`src/zcode.ts`、`src/gateway.ts`、`src/cli.ts`）

**Key Actions:**
- **生效判定集中化**：新增导出谓词 `zcodeEnabled(config)`（`config.zcode === true && config.upstreamOnly !== true`），
  取代散落的 `config.zcode === true` 判断。
- **适配器与校验**：`validateZcodeConfig` 在 upstream-only 下提前返回，不再把「必须环回监听」
  与「`z.ai/`、`bigmodel/` 保留前缀」两条约束施加给纯转发配置；`createZcodeAdapter` 不再建
  凭证缓存、不读 identity、不加载/生成 `zcode-catalog.json`。
- **目录与路由**：`/v1/models` 不再注入 ZCode 目录（`owned_by` 随之回到上游归属），
  `/v1/responses` 的 ZCode 拦截与 Responses-over-WebSocket 的 426 降级一并关闭，
  请求回到 upstream-only 直通。
- **CLI 可观测性**：`config` 查询报告生效值，开关与生效值不一致时额外输出 `zcodeConfigured`
  并提示该模式下 ZCode 已按禁用处理。
- **测试**：把 zcode 网关 fixture 的默认模式改回 split（原先默认 upstream-only，掩盖了该缺陷），
  官方 `/models` 刷新改为显式模拟；新增 upstream-only 的目录保留、请求直通、约束失效与
  CLI 状态报告用例。
- **文档**：README 增加 upstream-only 交互说明，JSON Schema 的 `zcode` 描述同步标注。

### 🧠 Design Intent (Why)
`upstreamOnly` 的契约是「目录与请求都只使用第三方上游、模型名不加前缀」，因此 ZCode 入口在该
模式下必须整体失效。改动前三个缺陷叠加：上游目录存的是裸 slug，`mergeZcodeCatalog` 会无条件
剥离裸 `z.ai/*`、`bigmodel/*`；请求拦截块又在 upstream-only 直通之前执行，于是 ZCode 坏配置时
上游的 z.ai 条目会消失，且请求被转发到 `api.z.ai` 而不是配置的第三方上游。选择新增谓词而不是
改写 `config.json` 的值，是因为后者会让持久化配置与运行时行为脱节、破坏「只修改受管字段」的
配置写入约定；把判定收敛到单一函数则保证读写两侧语义一致，且 `zcode` 开关仍然保留可审计。

### 🧪 Validation
- `bun run check` 全通过：类型检查、236 个测试 0 失败、单文件构建成功。
- 新增用例覆盖：upstream-only 下裸 `z.ai/*` 条目按上游原样保留（不被剥离也不被替换）、
  请求命中直通而不是 ZCode fetch、`zcode-catalog.json` 不生成、凭证缓存零读取、
  非环回 host 与保留前缀不再抛错、CLI 状态与启用提示按生效值输出。
- 改动前实测对照（真实上游目录 19 条）：`zcode=false` 19 条；`zcode=true` + 配置坏时仅 17 条
  且 z.ai 条目全无；请求打到 `https://api.z.ai/api/anthropic/v1/messages`。改动后上述三种情形
  的目录与请求归属一致。

### 📊 Change Stats
> 本分支工作区带有大量本任务之外的未提交改动（含未纳入版本控制的 zcode 模块），
> `git diff` 无法隔离本次改动。下表按本次实际编辑范围统计：先对编辑前内容做反向还原生成基线，
> 再执行 `git diff --no-index --no-renames --numstat <baseline> <file>`。

- **Files changed:** 7
- **Insertions:** +132
- **Deletions:** -16

| File | +Added | -Removed |
| --- | ---: | ---: |
| `src/zcode.ts` | +14 | -4 |
| `src/gateway.ts` | +4 | -4 |
| `src/cli.ts` | +9 | -2 |
| `test/zcode-gateway.test.ts` | +61 | -5 |
| `test/zcode-cli.test.ts` | +37 | -0 |
| `README.md` | +6 | -0 |
| `schemas/gateway-config.schema.json` | +1 | -1 |

### 📁 Files Modified
- `src/zcode.ts`
- `src/gateway.ts`
- `src/cli.ts`
- `test/zcode-gateway.test.ts`
- `test/zcode-cli.test.ts`
- `README.md`
- `schemas/gateway-config.schema.json`

### 📌 Notes
- `zcode` 开关在 upstream-only 下仍可写入、仍留审计，只是不生效；切回 split 后立即恢复生效，
  无需重新打开开关。
- 目录缓存失效逻辑位于 `loadZcodeCatalogCache` 内部，upstream-only 下不再调用该函数，
  因此不会因为缺少 `zcode-catalog.json` 而误判为「需要重建」并反复过期 Codex 目录缓存。
