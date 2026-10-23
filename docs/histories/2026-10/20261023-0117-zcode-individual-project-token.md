# [2026-10-23 01:17] | Task: 适配 ZCode 3.16 个人套餐项目令牌签发

### 🤖 Execution Context
* **Agent ID**: `zcode`
* **Base Model**: `GLM-5.3 (zai-individual-coding-plan)`
* **Runtime**: `ZCode Desktop`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `feat/zcode-individual-project-token`

### 📥 User Query
> 怎么获取不到 zcode 登录账号的模型了，只有知道 zai-api 了？→ 排查确认是 ZCode 更新到 3.16 后个人套餐业务 Key 不再落盘导致；先验证签发接口没有阿里云检测，然后实现适配。

### 🛠 Changes Overview
**Scope:** `packages/zcode`、`test/`

**Key Actions:**
- **[新增项目令牌模块]**: `individual-project-token.ts` 复刻 ZCode 3.16 客户端机制——解析 `project-key-location:v1:*` 指针（按账号/渠道/场景隔离）、`POST .../api_keys/{apiKeyId}/access_tokens` 在线签发短时令牌、指针 404 时经 `getCustomerInfo` → 项目 API Key 列表发现兜底。
- **[config.ts 接线]**: 个人套餐在「账号身份存在但落盘 Key 缺失」且 OAuth 可解析时，从直接报错改为在线签发；沿用团队套餐的 resolving 代际隔离与 `armExpiry` 到期重签机制；镜像回退禁令保持不变（防跨账号串号）。
- **[index.ts]**: 向配置缓存传入 `clientVersion`（来自 readZcodeIdentity），签发请求按官方客户端上报版本。
- **[测试]**: 新增签发成功/到期自动重签/指针 404 发现兜底/指针匹配单元/无 OAuth 仍报凭据不可用共 5 个用例；既有「换账号不沿用旧 Key」用例改为断言按新账号 OAuth 签发，「落盘 Key 优先」用例补断言不发起网络。

### 🧠 Design Intent (Why)
ZCode 3.16.2（10-19 更新）把个人 Coding Plan 的业务 Key 改为运行时用 OAuth 现签的项目令牌、仅内存缓存，`credentials.json` 里的持久化路径（`saveApiKey`）已成死代码；10-22 凭据文件重写清掉残留旧 Key 后网关永久读不到，个人/团队套餐模型整体消失，只剩 `zai-api` API Key 渠道。适配让网关走与客户端一致的签发链路，实测签发接口无阿里云 captcha（与 Start Plan 的 zcode-plan 中继不同）。旧版 ZCode（仍有落盘 Key）行为不变。

关键实测语义：签发响应的 `data.enable` 缺省即启用（客户端 preprocess 注入 true），仅显式 false 为停用；令牌 TTL 短（实测约 2–23 分钟）且不带绝对 expiresAt，按 `now+expiresIn` 计算到期。

### 📊 Change Stats
> 数据来自 `git diff --stat HEAD~1..HEAD`

- **Files changed:** 5
- **Insertions:** +628
- **Deletions:** -25

| File | +Added | -Removed |
| --- | ---: | ---: |
| `packages/zcode/src/individual-project-token.ts` | +229 | -0 |
| `packages/zcode/src/config.ts` | +139 | -18 |
| `test/zcode-cache.test.ts` | +193 | -6 |
| `docs/exec-plans/completed/zcode-individual-project-token.md` | +64 | -0 |
| `packages/zcode/src/index.ts` | +3 | -1 |

### 📁 Files Modified
- `packages/zcode/src/individual-project-token.ts`
- `packages/zcode/src/config.ts`
- `packages/zcode/src/index.ts`
- `test/zcode-cache.test.ts`
- `docs/exec-plans/completed/zcode-individual-project-token.md`

### ✅ Verification
- `bun run check` 全绿（boundaries + build + typecheck + 1244 用例）。
- 本机真实凭据端到端：个人套餐槽位签发成功（令牌约 160s 有效期、二次读取不重复签发），模型恢复 `GLM-5.3`/`GLM-5.3-Flash`。
- 注意：运行中的安装版网关（v0.16.1）需随下个版本发布后才恢复个人套餐模型。
