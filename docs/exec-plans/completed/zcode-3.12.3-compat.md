# ZCode 3.12.3 网关读取层最小加固

## 目标

网关在 ZCode 客户端 3.12.3 下保持可用：`readSelection` 能识别新的选择字段 `providerFamilyConnectionSelections` 并**归一化到现有 legacy providerID 空间**（全新安装可以选路、切换套餐不再跟随冻结旧值）。除这一个读取点外，转发、协议转换、请求头、套餐判定、模型目录全部不动——网关只消费 `setting.json` / `config.json` 等配置与凭据调用 API，不适配 ZCode 内部的套餐转换语义。

## 范围

- 包含（单点改动）：
  - `readSelection`（`src/zcode/config.ts:70-79`）优先读 `setting.json` 的 `providerFamilyConnectionSelections[family].kind`，在入口处归一化为与 legacy 解析完全相同的内部表示：
    - `individual-coding-plan` / `team-coding-plan` → providerID `builtin:<family>-coding-plan`
    - `start-plan` → providerID `builtin:<family>-start-plan`
    - 字段缺失 / 形状非法 → 原样走 legacy `modelProviderFamilySelectedKeys` 解析（覆盖 3.12.3 自身磁盘状态的三个窗口：①升级后未启动过 ZCode（迁移惰性持久化，`readSettings` 在内存算 connectionSelections，落盘要等下一次 settings 写入）；②**升级时 family 处于 api-key 模式**（迁移 `if(r[i]==="apiKey")continue` 跳过，该 family 永久无 connectionSelections 条目）；③legacy team 连接未被解析（`e4` 写入逻辑会主动删除未解析的 team 连接）。三者磁盘上只有 legacy，回退成本几乎为零，且 api-key 用户可解析到 `builtin:zai` 镜像走已验证的转发路径——最坏情况是 key 陈旧 401，而非模型列不出来）
    - 未知 kind → 明确报错（消息含 kind 值），**不回退 legacy**：条目存在且 kind 已解析，说明用户做了真实的新选择，回退会静默跟随冻结旧渠道
  - 归一化在 `readSelection` 内完成，产出与 legacy 路径同构的 Selection：下游 `readRoute` 精确镜像查找、`isPlan()` / `zcodePlan()` 的 `builtin:` 套餐判定、credentials watch、头策略、`ZcodePlan` 枚举、协议转换、模型目录**零改动**。
  - 测试补齐与 AGENTS.md / tech-debt-tracker 更新（README.md 不动，见决策记录）。
- 不包含（执行时记入 `docs/exec-plans/tech-debt-tracker.md`）：
  - `account:*` providerID 的显式建模或别名表——归一化直接产出 legacy `builtin:` ID，无需 `account:` 管道。
  - enc:v1 凭据解密链（按账号键 `account-provider:*:account:<providerId>:account:<uuid>:api-key`、`zcodejwttoken`）。全新安装机器在选择归一化后仍会在镜像查找处得到明确报错（而非启动期选路失败）；彻底支持需解密，方案已实证备用：AES-256-GCM，key = SHA256(env `ZCODE_CREDENTIAL_SECRET` ?? `zcode-credential-fallback:darwin:<home>:<username>`)。
  - key 再生后 `config.json` 镜像变旧、start-plan 镜像 JWT 过期（本机 `systemDisabledReason: coding_plan_not_entitled`，已实测 401）。
  - off-peak ticket 认证（`X-Off-Peak-Ticket-ID` + `POST /api/v1/off-peak/ticket`）：`off-peak` 只出现在 account provider mode 枚举里、走独立 ticket 流程，**不在 `providerFamilyConnectionSelections` 入口内**；本入口若意外收到该值会按未知 kind 报错。
  - family api-key 模式（`zai-api` / `bigmodel-api` 等模板仍在，`zhipu-coding-plan-api-key` 类型）在 3.12.3 的 selected key 写法实证；API Key 保持普通 custom provider 路径，不参与 plan 选择与 `account:*` 映射。
  - UA 指纹校准：`ai-sdk/anthropic/3.0.81` 后缀与 `x-zcode-agent` 在 3.12.3 host 代码已搜不到，待抓真实流量后决定更新或移除；`x-zcode-app-version` 已确认仍在，保留。
  - 镜像 `enabled` / `systemDisabledReason` 的维护语义待定（3.12.3 是否仍写 `config.json`）：**保留现有门控不动**，因为它携带权益状态（`coding_plan_not_entitled` / `oauth_provider_inactive`），贸然跳过可能绕过「无权益」的合法拦截。

## 背景

- 相关文档：`docs/exec-plans/completed/zai-config-cache.md`、`zcode-responses.md`、`zcode-endpoint-routing.md`；调查结论来自会话 sess_7047f756（zcode 3.12.3 asar 逆向 + 本机 `~/.zcode/v2` 实测）与 Codex 核对线程 `codex://threads/01a0b313-9233-7870-b7fc-6ab828c636e4`（2026-09-18）。
- 相关代码路径：`src/zcode/config.ts`（本次唯一改动文件 `readSelection`）；测试 `test/zcode-cache.test.ts`。
- 调查与核对实证要点：
  - **转发链路零改动**：`gateway.ts → handleZcode.forward() → cache.get() → translateZcodeRequest() → ${snapshot.baseURL}/v1/messages → endpointRouting.resolve() → buildZcodeModelHeaders() → fetch → createZcodeResponse()` 全链对 3.12.3 无必须变更；`individual-coding-plan` / `team-coding-plan` 是 ZCode 的套餐选择语义，不是新的代理协议，进入代理逻辑前就应归一化为 `coding-plan`。
  - **config.json 未废弃**：本机（upgraded 安装）镜像仍带 `builtin:zai-coding-plan`（enabled: true、49 字符 hex.secret 明文 key）；`builtin:zai-start-plan` enabled: false（`coding_plan_not_entitled`）、bigmodel 两条 `oauth_provider_inactive`。`apiKey` / `baseURL` / `models` 仍从 `config.json` 读取。
  - **选择源冻结**：3.12.3 切换套餐只写 `providerFamilyConnectionSelections = {"zai":{"kind":"individual-coding-plan"|"team-coding-plan"|"start-plan"}}`（renderer schema `ic` 是 3 kind 硬枚举且 `.strict()`，team 项另带 `productId`/`organizationId`/`projectId`；不存在 `none` kind，`off-peak` 只在 account provider mode 枚举里、走独立 ticket 流程）；legacy `modelProviderFamilySelectedKeys` / `modelProviderFamilyModes` 只被一次性迁移读取，之后永不更新，但迁移是惰性持久化，三个窗口（未重启 / api-key 模式被跳过 / team 连接未解析）下磁盘长期只有 legacy。
  - **全新安装硬中断**：无 3.11 历史的机器上 legacy 字段从未写入，现 `readSelection` 报「ZCode 当前渠道缺少有效 provider 选择」→ zcode 模型全量不可用。这是本次要修的唯一硬中断场景。
  - **watch 已覆盖**：缓存已监听 `setting.json` 变化并重跑 `readSelection`（`src/zcode/config.ts:142-155, 248-255`），归一化落在 `readSelection` 内即可自动获得热更新，无需改 watch。
- 已知约束：网关自有 `config.json` 字段与 `schemas/gateway-config.schema.json` 不动；`feature/codebuddy` 分支存在未提交工作，提交只圈定 zcode 相关路径（`fix(zcode): ...`），不动 codebuddy 暂存内容。

## 风险

- 风险：`connectionSelections.kind` 枚举未来再变（新增 kind 或改语义）。
  缓解：仅归一化已知 kind；缺失 / 形状非法回退 legacy；未知 kind 报错并在消息中带出原值，不静默跟随冻结旧值。
- 风险：归一化把 team 折叠到与 individual 相同的 `builtin:<family>-coding-plan` 镜像，镜像 key 未必区分账号形态。
  缓解：接受该近似（两者 baseURL 相同、均为 `zhipu-account` 认证形态；网关本就不消费组织字段）；若上游 401，报错路径与现状一致，记入 tech-debt 观察。
- 风险：3.12.3 的 `systemDisabledReason` 语义若与门控判断冲突（如新增未覆盖的 reason 值）。
  缓解：门控逻辑本次不动，行为与现状完全一致。

## 里程碑

1. `readSelection` 双源归一化（唯一代码改动）。
2. 测试补齐（新字段各 kind、全新安装、缺失/形状非法回退、未知 kind 报错、legacy 回归）并 `bun run check` 全绿。
3. AGENTS.md / tech-debt-tracker 更新、本机冒烟验证、计划移入 `completed/`。

## 验证方式

- 命令：`bun run typecheck && bun test`（合入前 `bun run check`）。
- 手工检查：`bun run dev` 起网关 → `GET /v1/models` 含 `zcode/*` 条目；Codex 对 `zcode/glm-5.3` 发一条请求，预期 200 SSE（coding-plan 主路径回归不受影响）。
- 观测检查：fixture 模拟全新安装 setting.json（仅 connectionSelections、无 legacy 字段）可选通并命中现有镜像；缺失/形状非法时与旧行为逐字段一致；request-log 脱敏行为不变。

## 进度记录

- [x] `readSelection` 双源归一化（`src/zcode/config.ts`，新增 `connectionSelectionKind`）。
- [x] 测试补齐并 `bun run check` 全绿（4 个新用例，全套 349 pass / 0 fail）。
- [x] README / AGENTS.md / tech-debt-tracker 更新。
- [x] 本机冒烟验证：`~/.zcode/v2/setting.json` 实测带 `providerFamilyConnectionSelections: {zai/bigmodel: {kind: "individual-coding-plan"}}`，`createZcodeConfigCache` 归一化后解析到 `builtin:zai-coding-plan`（与 legacy 路径结果一致），快照含 baseURL 与模型字典键；计划移入 `completed/`。
- [x] 评审修正（sess_5d4231a9）：删掉 `none` kind 回退分支与 `off-peak` 并列，实现/测试/AGENTS/tech-debt 同步改完，`bun run check` 复跑全绿。
- [x] 文档边界修正：AGENTS.md 明令禁止把代码解读写进 `README.md`（仅新增命令/参数补简单使用简介）；已写进 README 的归一化说明回退，同样的内容保留在 AGENTS.md 与代码注释中。

## 决策记录

- 2026-09-18：经 asar 逐项核对确认 3.12.3 调用协议层零变化（`/v1/messages`、`x-api-key`+Bearer、anthropic-version、端点重映射）；凭据解密链明确推迟——coding-plan 的 hex.secret key 为用户手动生成、轮换罕见，upgraded 安装的 `config.json` 镜像仍有效。
- 2026-09-18：修复范围三选一（最小加固 / 不改代码 / 完整计划）定为「最小加固」。
- 2026-09-18（修订，依据核对线程 `01a0b313-9233`）：原计划的「`ZcodePlan` 扩枚举、`Selection.plan` 字段、`account:` 别名表、跳过 `enabled` 门控、off-peak forward 拦截」全部取消——这些是在适配 ZCode 的套餐转换语义，代理层并不需要。改为在 `readSelection` 入口把新选择字段归一化为 legacy providerID（individual/team → `builtin:<family>-coding-plan`、start-plan → `builtin:<family>-start-plan`），下游零改动。`enabled` / `systemDisabledReason` 门控保留：镜像携带 `coding_plan_not_entitled` 等权益状态，跳过门控反而可能绕过合法拦截。API Key 保持普通 custom provider 路径，不参与 plan 选择与 `account:*` 映射。
- 2026-09-18（评审修正，依据会话 sess_5d4231a9 的 asar 复核）：两处文档修正。①**`none` kind 不存在**：renderer schema `ic` 是 3 kind 硬枚举且 `.strict()`（`start-plan` / `individual-coding-plan` / `team-coding-plan`，后者带 `productId`/`organizationId`/`projectId`），回退触发条件改为「条目缺失或形状非法」，不再匹配 `kind:"none"`。②**`off-peak` 不走本入口**：只在 account provider mode 枚举（`yp`）里、走 off-peak ticket 流程；计划删掉 off-peak 并列，未知 kind 一律报错并带出原值。同时明确 legacy 回退**不是为了兼容旧版客户端**（用户决定「本项目不做兼容，历史版本可以通过低版本的网关即可」），而是覆盖 3.12.3 自身磁盘状态的三个窗口：迁移惰性持久化、api-key 模式被迁移跳过（否则该 family 永久 503 无法自愈）、legacy team 连接未解析。team-coding-plan 的 `productId`/`organizationId`/`projectId` 参数不消费（网关不处理组织字段），记入 tech-debt。
- 2026-09-18（文档边界）：AGENTS.md 明令禁止把代码解读、内部实现、协议转换或字段处理细节写进 `README.md`——`README.md` 只写面向用户的使用说明，且**只有新增 CLI 命令或参数时才补一段简单使用简介**。此前写进 README 的归一化说明已回退，同样的内容落在 AGENTS.md（规则）与代码注释（约束）中。
