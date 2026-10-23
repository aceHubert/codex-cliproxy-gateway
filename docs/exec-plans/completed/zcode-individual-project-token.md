# ZCode 3.16 个人套餐项目令牌适配

## 目标

ZCode 3.16 起个人 Coding Plan 的业务 Key 不再持久化到 `credentials.json`，网关读不到落盘 Key 导致个人套餐模型整体消失。目标是让网关在落盘 Key 缺失时，复刻 ZCode 3.16 客户端的「项目令牌在线签发」机制，用已有的 OAuth 登录态签出短时业务 Key，使个人套餐模型恢复可用；旧版 ZCode（仍有落盘 Key）行为保持不变。

## 范围

- 包含：
  - 新增 `packages/zcode/src/individual-project-token.ts`：解析 `project-key-location:v1:*` 指针、调用 `POST .../api_keys/{apiKeyId}/access_tokens` 签发、指针 404 时经 `getCustomerInfo` → 列 `api_keys` 的发现兜底。
  - `packages/zcode/src/config.ts`：个人套餐在「身份存在但落盘 Key 缺失」且 OAuth token 可用时，从直接报错改为在线签发；签发结果进内存缓存并按到期时间提前重签（复用团队套餐的 resolving/generation 机制与 armExpiry）。
  - `packages/zcode/src/index.ts`：向配置缓存传入 `clientVersion`（来自 readZcodeIdentity）。
  - 测试：签发成功、到期重签、指针 404 发现兜底、旧版落盘 Key 优先、换账号隔离、无 OAuth 仍报「凭据不可用」。
- 不包含：
  - Start Plan 暴露（仍受阿里云 captcha 阻塞，见 tech-debt-tracker）。
  - 团队套餐键格式迁移（3.16 团队走 `account-provider:team:*` 新格式由 OAuth 在线解析，现有团队流程已覆盖）。
  - 向 `credentials.json` 回写指针（发现结果仅存内存，避免写坏 ZCode 自管文件）。

## 背景

- 相关代码路径：`packages/zcode/src/config.ts`（个人套餐凭据分支）、`individual-credentials.ts`、`team-credentials.ts`（同款在线换 Key 参照）、`credential-cipher.ts`。
- 3.16.2 逆向结论（app.asar + 实测，2026-10-23）：
  - 持久化仅剩 OAuth 登录态与指针 `project-key-location:v1:<enc([origin, family, accountId, null, 1, "non-team"])>` → `{organizationId, projectId, apiKeyId}`。
  - 签发：`POST {origin}/api/biz/v1/organization/{org}/projects/{proj}/api_keys/{keyId}/access_tokens`，`Authorization: Bearer <oauth>`，body `{clientType:"zcode", clientVersion}`；响应 `{code, data:{enable, accessToken, tokenType, expiresIn, expiresAt}}`（秒）。实测无阿里云 captcha。
  - 客户端在过期前约 2 分钟（加抖动）主动刷新；指针 404 时删除指针并经 `getCustomerInfo` 重建。
  - 指针按账号隔离：误用他账号指针返回 `code:404 "project API key is not available"`。
- 已知约束：网关不得写 `~/.zcode`；凭据与令牌不得出现在日志/错误正文；模型端口仅环回监听。

## 风险

- 风险：签发接口未来接入风控（captcha）或协议变更。
- 缓解：签发失败给出「请在 ZCode 中重新登录」类可执行报错并撤下槽位快照；签发逻辑集中在独立模块便于跟进。
- 风险：OAuth token 过期导致签发 401，与「未登录」混淆。
- 缓解：401/业务错误统一映射为带重登指引的 ZcodeConfigError；不回退 config.json 旧镜像 Key（沿用既有防串号设计）。
- 风险：现有「换账号不沿用旧 Key」回归被弱化。
- 缓解：保留镜像回退禁令与身份匹配；新增测试覆盖「切账号后按新账号 OAuth 签发、绝不暴露旧账号 Key/镜像 Key」。

## 里程碑

1. 执行计划与方案收敛（已完成逆向与实测验证）。
2. 实现 individual-project-token 模块与 config.ts 接线。
3. 测试、`bun run check`、本机真实凭据端到端验证。
4. 历史记录、changeset、归档计划。

## 验证方式

- 命令：`bun run test`（含新增用例）、`bun run typecheck`。
- 手工检查：`~/.agent-proxy-gateway/zcode-catalog.json` 重新出现 `zcode-individual-coding-plan/*` 条目；`agent-proxy status` 正常。
- 观测检查：签发/重签不打印任何令牌；错误正文不含凭据。

## 进度记录

- [x] 逆向 3.16.2 签发链路并实测无 captcha（2026-10-23）。
- [x] individual-project-token 模块与 config.ts 接线（2026-10-23）。
- [x] 新增/调整测试并全量通过（`bun run check` 1244 用例全绿）。
- [x] 本机端到端验证目录恢复（个人套餐签发成功，模型 GLM-5.3/GLM-5.3-Flash 恢复）。
- [x] 归档计划并写历史记录。

## 决策记录

- 2026-10-23：不回写发现得到的指针到 credentials.json（只缓存在内存）。理由：该文件由 ZCode 自管、加密写回风险高，指针缺失属罕见路径且发现流程可随时重建。
- 2026-10-23：发现兜底不创建新 API Key（仅复用列表中 `keyType=2` 的既有 Key）。理由：避免网关在用户账号里产生资源副作用；无可用 Key 时提示打开一次 ZCode 重建。
- 2026-10-23：到期重签沿用 `expiresAt` + `armExpiry`/`expire()` 既有机制，令牌有效期取 `min(expiresAt, now+expiresIn)`（与客户端一致），不引入独立的刷新定时器。
- 2026-10-23：签发响应的 `data.enable` 缺省按已启用处理，仅显式 `false` 视为停用。理由：实测官方接口成功响应不带 `enable` 字段，3.16.2 客户端在 zod preprocess 里对缺省注入 `true`。
