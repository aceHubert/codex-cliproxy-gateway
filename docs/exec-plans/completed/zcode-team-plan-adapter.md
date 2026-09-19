# ZCode 团队套餐请求适配

## 目标

适配 ZCode 3.12.3 的 `team-coding-plan`，确保网关根据当前团队连接和项目读取正确的团队凭据，并在个人套餐、团队项目之间切换时及时刷新凭据。

团队套餐与个人套餐使用相同的 Anthropic Messages API，不新增 Team 专用请求头或请求体字段。团队上下文仅用于本地凭据解析和缓存隔离。

## 源码依据

ZCode 内置 provider 定义将个人和团队声明为不同的 account provider：

```text
account:zai-individual-coding-plan
account:zai-team-coding-plan
```

两者的 API 类型和基础地址相同，但访问模式不同：

```text
api.type    = anthropic-messages
api.baseUrl = https://api.z.ai/api/anthropic
mode        = individual-coding-plan | team-coding-plan
```

ZCode 对个人和团队使用不同的凭据解析路径：

```text
个人：loadIndividualPlanApiKey
团队：resolveTeamPlanApiKey
```

团队解析依赖 `productId`、`organizationId`、`projectId`。因此不能只用归一化后的 `builtin:<family>-coding-plan` 判断凭据身份。

## 当前问题

`src/zcode/config.ts` 当前把两种套餐都归一化为同一个 provider ID：

```text
individual-coding-plan → builtin:<family>-coding-plan
team-coding-plan       → builtin:<family>-coding-plan
```

缓存选择身份只包含 `family` 和 `providerID`。个人切换到团队，或团队项目 A 切换到项目 B 时，缓存可能继续使用旧凭据。最严重的情况是请求成功但消耗个人额度。

现有测试使用相同的虚构 key 覆盖个人和团队，不能发现错误复用。

## 适配范围

### 1. 扩展选择模型

在 `src/zcode/config.ts` 中保留用于 provider 路由的 `providerID`，同时保存套餐和团队上下文：

```ts
interface ZcodeSelection {
  family: ZcodeFamily;
  providerID: string;
  kind: "individual-coding-plan" | "team-coding-plan" | "start-plan" | "api-key";
  team?: {
    productId: string;
    organizationId: string;
    projectId: string;
  };
}
```

`providerFamilyConnectionSelections[family]` 的团队字段必须是非空可打印字符串。缺少任意团队字段时明确报配置错误，不得回退个人凭据。

### 2. 按套餐选择凭据解析器

将凭据读取从 provider 路由读取中拆出：

```text
individual-coding-plan → loadIndividualPlanApiKey
team-coding-plan       → resolveTeamPlanApiKey
start-plan             → 现有 start-plan 逻辑
api-key                → 现有 custom provider 逻辑
```

团队解析需要复刻 ZCode 3.12.3 的运行时流程，而不是直接读取本地团队 Key。源码核对结果为：

1. 读取 `oauth:zai:access_token`（Z.ai）或 `oauth:zhipu:access_token`（BigModel）；
2. `GET {host}/api/biz/customer/getCustomerInfo`，确认所选组织和项目存在；
3. `GET {host}/api/biz/v1/organization/{organizationId}/projects/{projectId}/api_keys`；
4. 查找 `name=zcode-team-api-key`、`keyType=2` 的项目 Key；
5. 缺失时按 ZCode 行为创建，再调用 `/copy/{apiKey}` 获取 secret；
6. 最终业务 Key 为 `{apiKey}.{secretKey}`。

其中凭据读取和解密涉及本机敏感 OAuth，官方接口还可能创建远端项目 Key，必须作为独立的授权步骤实现与验收。未经明确授权，网关不得自动执行该外呼或创建动作。

本地账号凭据布局包括 `account-provider:*:account:<providerId>:account:<uuid>:api-key` 和 `zcodejwttoken`。涉及 `enc:v1` 时按已验证的 AES-256-GCM 方案解密：

```text
key = SHA256(
  ZCODE_CREDENTIAL_SECRET
  ?? zcode-credential-fallback:darwin:<home>:<username>
)
```

凭据内容只在内存中使用，不得写入日志、响应、测试输出或文档。

### 3. 扩展缓存失效身份

缓存 fingerprint 必须包含：

```text
family
kind
providerID
productId
organizationId
projectId
```

以下变化必须重新读取凭据：

- 个人套餐 ↔ 团队套餐；
- 团队项目 A ↔ 团队项目 B；
- 组织或产品变化；
- 团队凭据文件内容变化。

团队凭据读取失败时，旧快照不得继续对外提供，也不得回退到个人 key 或旧项目 key。

### 4. 保持现有 API 请求链

凭据解析成功后继续使用现有请求构造：

```text
POST {baseURL}/v1/messages
Authorization: Bearer <当前凭据>
x-api-key: <当前凭据>
anthropic-version: 2023-06-01
```

不新增或转发以下字段：

```text
organizationId
projectId
productId
X-Organization-Id
X-Project-Id
```

Endpoint mapping `/api/v1/agent/configs` 也继续使用当前凭据，不增加团队分支。

## 测试计划

在 `test/zcode-cache.test.ts` 和 `test/zcode-gateway.test.ts` 增加结果导向测试：

1. 个人套餐解析为 `personal-key`；
2. 切换到团队组织 A 使用 `team-a-key`；
3. 团队项目 A 切换到项目 B 使用 `team-b-key`；
4. 团队切回个人后恢复 `personal-key`；
5. 团队字段缺失、凭据不存在或解密失败时返回配置错误；
6. 团队凭据失败时不发送上游请求；
7. 上游请求只包含当前凭据，不包含个人旧 key；
8. 请求 URL、请求头和请求体与现有 coding-plan 兼容测试一致；
9. `organizationId`、`projectId`、`productId` 不出现在上游请求中。
10. 团队套餐删除 `credentials.json` 后立即失效且不触发外呼，恢复文件后重新构建当前 Key。

测试必须使用相互不同的虚构 key，不能用同一个 key 同时覆盖个人和团队路径。

## 非目标

- 不新增 Team 专用 API endpoint；
- 不新增 Team 专用 HTTP header；
- 不修改 Anthropic Messages 协议转换；
- 不绕过 `enabled` 或 `systemDisabledReason` 门控；
- 不把个人凭据复制到团队 provider；
- 不在日志中输出任何凭据或团队账号敏感字段。

## 验收命令

```text
bun run typecheck
bun test test/zcode-cache.test.ts test/zcode-gateway.test.ts
bun run check
```

验收重点是确认个人、团队项目 A、团队项目 B 三条路径使用不同且正确的凭据，并确认凭据切换后不会继续使用旧快照。

验收结果（2026-09-19）：`bun run typecheck` 通过；`bun test test/zcode-cache.test.ts test/zcode-gateway.test.ts` 58 pass / 0 fail；`bun run check` 356 pass / 0 fail 并完成 UI 与 CLI 构建。

## 进度

- [x] 扩展选择模型并保留团队上下文
- [x] 获得敏感凭据读取和官方团队凭据接口外呼的实现授权；本轮开发验收只使用临时目录、虚构凭据与模拟接口，未读取真实 `~/.zcode` 凭据、未调用生产接口、未创建远端资源
- [x] 接入个人/团队凭据解析器
- [x] 将团队上下文纳入缓存 fingerprint
- [x] 禁止凭据失败时回退旧快照
- [x] 补充不同凭据的切换测试
- [x] 运行完整检查并记录历史

## 决策记录

- 2026-09-19：保留 `providerID` 作为路由身份，另存 `kind` 与团队三元组作为凭据身份；团队凭据解析独立到 `zcode/team-credentials.ts`，模型 API 请求链继续完全复用现有 coding-plan 适配。
- 2026-09-19：团队选择或团队凭据文件变化时先废弃旧快照，再执行防抖刷新与官方项目 Key 流程；解析、解密或远端校验失败均进入配置错误，不回退个人 Key 或旧项目 Key。
- 2026-09-19：真实生产验收未在本轮执行；所有官方接口行为均以 ZCode 3.12.3 本机应用包源码核对结果构造 mock 验证。
- 2026-09-19：为提高可读性，将通用 `enc:v1` 解密抽到 `zcode/credential-cipher.ts`，个人 account-provider Key 读取抽到 `zcode/individual-credentials.ts`；`zcode/team-credentials.ts` 只保留团队 OAuth 与项目 Key 流程。
