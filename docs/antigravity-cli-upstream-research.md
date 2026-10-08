# Antigravity CLI 上游调用方式调研（2026-10-05，纯静态分析）

> **2026-10-06 MITM 实证修正**（实施 `src/agy/` 适配器时通过本地 MITM 代理抓取了
> agy 1.2.17 的一次真实会话，以下实证结论覆盖正文中的静态推断）：
>
> 1. **真实 User-Agent**：`antigravity/cli/1.2.17 (aidev_client; os_type=darwin; arch=arm64; cl=993434119; auth_method=consumer)`
>    ——并非正文猜测的 `antigravity-cli/<version>`；请求仅带 4 个 header（host/UA/authorization/content-type），
>    无 X-Aicode-Trajectory-Id 等额外头。
> 2. **fetchAvailableModels body 只有 `{"project":"aicode-consumers"}`**：真实配额项目是
>    `aicode-consumers`（正文 §3.1 的 `default-cli-project` 只是 CLI 本地缓存文件的哨兵字面量，
>    不出现在线协议中）；该请求不带 metadata（正文 §5.3 猜测错误——metadata 仅 loadCodeAssist 有，
>    且实测只需 `{"metadata":{"ideType":"ANTIGRAVITY"}}`）。
> 3. **streamGenerateContent 外层包装（实证）**：
>    `{"project":"aicode-consumers","requestId":"checkpoint/<uuid>","model":"<id>","userAgent":"antigravity","requestType":"checkpoint","request":{contents,systemInstruction{role:"user",parts},generationConfig{thinkingConfig{includeThoughts:true,thinkingBudget:-1,thinkingLevel?}},sessionId:"-<int64>"}}`
>    ——`model` 在**外层**（内层 request 无 model 字段）、字段全 camelCase、无 user_prompt_id；
>    systemInstruction 携带 `role:"user"`。
> 4. **端点通道**：该账号在 `cloudcode-pa`（stable）上管理面 200 但**推理一律 429**，
>    daily 通道推理正常——网关默认端点取 daily（正文 §4.2 的 stable 建议作废）。
> 5. **响应（实证）**：SSE 帧 = `{"response":{candidates[{content{role:"model",parts:[{text?,thought?,thoughtSignature?,functionCall?}],finishReason?}],usageMetadata{promptTokenCount,candidatesTokenCount,thoughtsTokenCount?,totalTokenCount},modelVersion,responseId},"traceId","metadata"}`，
>    与正文 §5.2 假设一致；`thoughtSignature` 出现在收尾帧。
> 6. **目录结构（实证）**：`agentModelSorts[].groups[].modelIds` 为官方推荐位、
>    `tieredModelIds` 为档位映射（如 `flash → gemini-3.8-flash-tiered`）、
>    `tabModelIds`/`commandModelIds`/`imageGenerationModelIds`/`audioTranscriptionModelIds`
>    为专用模型；`deprecatedModelIds` 提供旧 id 重定向（实证样例
>    `gemini-3.1-pro-high → gemini-pro-agent`）。
> 7. **抓取方法**：自签 CA + 本地 CONNECT 代理（`SSL_CERT_FILE`/`HTTPS_PROXY` 均被 Go 构建遵守，
>    实测确认），仅代理本次验证流量；`AICODE_ENDPOINT_URL` 在该构建上不生效。



调研目标：摸清本机 Antigravity CLI（`agy`）实际如何调用 Google 上游，评估将其作为
codex-cliproxy 网关上游做转发的可行性，重点是调用端点、认证与 HTTP headers。
**全程未执行 agy 二进制、未发起任何对 Google 的真实请求**（避免触发风控/封号），
所有结论来自四类静态证据，下文分别以 [bin]、[log]、[file]、[gemini-cli] 标注：

- [bin]：`strings -a` 提取 `~/.local/bin/agy`（Mach-O arm64 单体 Go 二进制，约 176MB，
  内嵌完整 protobuf descriptor，可直接还原消息定义）；
- [log]：本机已有 CLI 日志 `~/.gemini/antigravity-cli/log/cli-*.log`（历史产物，仅读取）；
- [file]：本机配置/凭据文件的字段结构（只看结构，值一律脱敏，文档不含任何令牌）；
- [gemini-cli]：本机安装的 `@google/gemini-cli@0.43.0` 开源实现。它与 Antigravity 走
  同一套 `v1internal` 协议，可作为线格式的开源交叉参照。

## 1. TL;DR

| 事项 | 结论 |
| --- | --- |
| 上游协议 | Google Cloud Code Assist **内部 REST API（`v1internal`）**：HTTPS + JSON + SSE，不是私有二进制协议，也没有强制 gRPC（gRPC 路径存在但 CLI 实际走 HTTPS JSON，[log] 证实） |
| 本机实际端点 | `https://daily-cloudcode-pa.googleapis.com`（本机为 daily 通道构建；stable 通道为 `https://cloudcode-pa.googleapis.com`）[log][bin] |
| 核心方法 | `loadCodeAssist`、`fetchAvailableModels`、`generateContent`、`streamGenerateContent?alt=sse` [log] |
| 认证 | OAuth2 consumer（Google 账号），Bearer access_token，**有效期整 1 小时**（§3.3）；refresh_token 无固定期限。本机由常驻 `agy remote-control serve` daemon 惰性刷新并回写文件；**网关定案只读消费、不自行刷新** [file][log] |
| 凭据位置 | `~/.gemini/antigravity-cli/antigravity-oauth-token`（JSON 文件；keyring 保存失败时回退文件）[file][bin] |
| 刷新端点 | `POST https://oauth2.googleapis.com/token`，client_id/client_secret 内嵌于二进制 [bin] |
| 必备 headers | `Authorization: Bearer <token>`、`Content-Type: application/json`；SSE 用 query `alt=sse` 而非 header [bin][gemini-cli] |
| 请求体 | 外层 `v1internal.GenerateContentRequest` 包装 + 内层 `aiplatform.master.GenerateContentRequest`（Gemini/Vertex 风格 contents/tools/generationConfig）[bin][gemini-cli] |
| 响应体 | SSE `data:` 帧 = `{"response": {candidates…}, "traceId", …}` [bin][gemini-cli] |
| 网关接入结论 | 完全可行。比 Qoder（私有签名协议）更简单：读 token 文件 → 自刷新 → JSON/SSE 双向转换。参照 `src/qoder/` 模块布局新增 `src/antigravity/` 适配器 |

另有一个意外发现：CLI 自带 **LLM Gateway 客户端模式**（`AGY_LLM_GATEWAY_*` 环境变量组，
官方支持「Enterprise LLM Gateway」），可把 agy 指向 OpenAI/Gemini 兼容网关——这是与
「把 Antigravity 当上游」相反方向的集成入口，见 §9。

## 2. 本机安装布局

| 路径 | 内容 | 备注 |
| --- | --- | --- |
| `~/.local/bin/agy` | CLI 主二进制（176MB Go 单体） | 版本 1.2.16（language server 版本号，[log] `Language server version: 1.2.16`）；更新器自述 "Already on the latest version" |
| `~/.local/bin/agy-od` | 用户自建 wrapper（Open Design 场景 `--sandbox --add-dir --print`） | 证明 CLI 支持 headless `--print` 非交互模式 |
| `/Applications/Antigravity.app` | IDE（VS Code/Windsurf 系 fork） | 内含 `Contents/Resources/bin/language_server`（149MB，同源 Go 二进制），IDE 与 CLI 共用同一上游协议 |
| `~/.gemini/antigravity-cli/` | CLI 数据目录 | 凭据、日志、会话、skills、设置 |
| `~/.gemini/antigravity-cli/antigravity-oauth-token` | OAuth 凭据文件（mode 600） | 结构见 §3 |
| `~/.gemini/antigravity-cli/log/cli-*.log` | 运行日志 | 含每次上游调用的 URL（`http_helpers.go:315` 打点） |
| `~/.gemini/antigravity-cli/settings.json` | 用户设置 | 当前默认模型 `"Gemini 3.8 Flash (High)"` |
| `~/.gemini/antigravity-cli/cache/default_project_id.txt` | 默认配额项目 | 字面量 `default-cli-project`（consumer 档哨兵项目，非数字项目号）[file][bin] |
| `~/.gemini/antigravity-ide/`、`~/.antigravity/` | IDE 侧数据 | 与 CLI 无关，网关不需要 |

## 3. 认证与凭据

### 3.1 凭据文件结构 [file]

`~/.gemini/antigravity-cli/antigravity-oauth-token`：

```json
{
  "token": {
    "access_token": "ya29.…",          // Google OAuth access token，~1 小时有效
    "token_type": "Bearer",
    "refresh_token": "1//0g…",         // 长期刷新令牌
    "expiry": "2026-10-05T23:32:38.74…+08:00"
  },
  "auth_method": "consumer",           // consumer | 企业(BAIC)
  "id_token": "eyJhbGciOiJSUzI1NiIs…"  // Google 账号 OIDC id_token
}
```

要点：

- `auth_method: "consumer"` 表示个人 Google 账号免费档；企业登录走独立的
  Business AI Code（BAIC）通道（`businessaicode.googleapis.com`），本机未使用。
- 日志显示 CLI 自动续期（`browser.go:265] token refreshed, new expiry=+1h`），
  即 **CLI 在运行时会持续把该文件里的 access_token 刷新为最新**。
- [bin] 字符串 `Failed to save token to keyring, falling back to file: %v` /
  `Failed to persist token to keyring: %v`：优先写 macOS Keyring，失败回退该文件；
  本机实际落盘为文件。网关按「文件存在即用文件」处理即可。

### 3.2 OAuth 客户端与刷新 [bin]

- 授权端点：`https://accounts.google.com/o/oauth2/auth`（浏览器流程），
  另支持设备码流程 `https://oauth2.googleapis.com/device/code`。
- 刷新端点：`POST https://oauth2.googleapis.com/token`（标准
  `grant_type=refresh_token&refresh_token=…&client_id=…&client_secret=…` 表单）。
- scopes（[gemini-cli] 同款、[bin] 出现同串）：
  `https://www.googleapis.com/auth/cloud-platform`、`openid`、
  `https://www.googleapis.com/auth/userinfo.email`、
  `https://www.googleapis.com/auth/userinfo.profile`。
- client_id（[bin] 内嵌两个，非机密，id_token 的 `aud` 即为前者）：
  - `1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com`
    —— consumer/个人登录流（本机 `id_token.aud` 与之匹配 [file]，且紧邻
    AuthProvider SetUserTier 代码字符串 [bin]）；
  - `884354919052-36trc1jjb3tguiac32ov6cod268c5blh.apps.googleusercontent.com`
    —— 第二个客户端（疑似 ADC/企业流）。
- 配套的两个 `GOCSPX-…` client_secret 同样内嵌于二进制 rodata（两个 secret 相邻存放于
  同一字符串区，offset ≈ 51.2MB 处；与哪个 client_id 配对无法从布局可靠推断，
  rodata 相邻性在 Go 链接产物里不构成语义证据）。出于仓库「凭据不入库」红线，
  本文不抄录其值；实施时用
  `strings -a ~/.local/bin/agy | grep -oE 'GOCSPX-[A-Za-z0-9-]{20,}'` 现场提取，
  并以「哪个 pairing 能成功刷新」做最终验证（静态无法确认配对关系）。
  另：`id_token.aud`（本机为 `1071006060591-…`）即该账号实际使用的 consumer client，
  刷新应优先用与其同源的 pairing。
- 另有 ADC（服务账号）登录路径 [bin]：`adcAuth: authenticated successfully with
  quota project %s`；本机为 consumer 流，不在首期接入范围。

### 3.3 令牌有效期与保鲜机制（决定网关只读策略）[file][log]

| 令牌 | 有效期 | 证据 |
| --- | --- | --- |
| `access_token` | **3600 秒（1 小时）**，无滑点 | 三重一致：token 文件 mtime `09:33:47.647` vs `expiry` `10:33:46.645`（精确 +3600s）；刷新日志单调钟 `new expiry=… m=+3600.6`；`id_token` 的 `exp-iat=3600s` |
| `id_token` | 3600 秒 | JWT claims `exp-iat=3600`（注意：本账号 iat 为 1970 年异常小值，Google 老账号怪癖，判断新鲜度以文件 `expiry` 字段为准） |
| `refresh_token` | 无固定到期时间 | `1//` 前缀标准 Google refresh token，无 exp 字段。失效只能因：用户吊销、连续 6 个月未使用、超出 client-user 对 token 上限（单一官方 client 正常使用不会触发）、改密码等账号事件 |

**谁在刷新文件**：本机有一个常驻 daemon `agy remote-control serve`（用户此前执行过
`remote-control start`，提示文案 [bin] `Run '%s remote-control start' to re-enable
background remote control using the supported daemon`）。该 daemon 承载 §5.5 的
360 秒轮询，认证层为 golang.org/x/oauth2 的**惰性刷新**——token 过期后的下一次使用
才刷新并回写文件（交互进程的刷新日志：`browser.go:265] token refreshed, new expiry=…`；
daemon 的刷新不写同一行日志，但文件 mtime 证实其刷新行为：2026-10-06 09:33 文件被
刷新时全机没有任何交互 agy 会话，唯一在跑的就是该 daemon）。

由此推出**文件新鲜度的两个边界**：

1. daemon 运行时：文件中的 access_token 在任意时刻「已过期不超过约一个轮询周期
   （≤6 分钟）」——过期后要等下一次带认证的轮询才触发回写；
2. daemon 与一切 agy 进程都没跑时：文件在最后一次刷新的 **+1 小时**后彻底失效，
   网关将持续 401，直到用户再启动任一 agy 会话（或 daemon）。

## 4. 上游端点与调用面

### 4.1 本机实际端点 [log]

对全部历史日志聚合（共约 4800 次调用记录），CLI 只调用过一个 host：

```
https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist          ×2413
https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels    ×2388
https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse ×14
https://daily-cloudcode-pa.googleapis.com/v1internal:generateContent         ×5
```

`loadCodeAssist`/`fetchAvailableModels` 高频出现是因为 CLI 启动与轮询都会打；
推理调用（generateContent 系）只在真实会话时发生，次数少。

### 4.2 host 选择矩阵 [bin]

二进制内出现四个 Google 侧 host 模板，另含 `%s-%s.googleapis.com` 拼接格式串与
`ReleaseChannel{UNKNOWN,STABLE,EXPERIMENTAL}` 枚举，以及环境变量覆盖
`AICODE_ENDPOINT_URL` / `BAICODE_ENDPOINT_URL`：

| host | 用途 |
| --- | --- |
| `https://cloudcode-pa.googleapis.com` | stable 通道（gemini-cli 同款默认值 [gemini-cli]：`CODE_ASSIST_ENDPOINT = "https://cloudcode-pa.googleapis.com"`，亦支持 `CODE_ASSIST_ENDPOINT` 环境变量覆盖） |
| `https://daily-cloudcode-pa.googleapis.com` | daily/preview 通道（**本机在用**） |
| `https://preprod-daily-cloudcode-pa.sandbox.googleapis.com` | 预发沙箱 |
| `https://aicode.googleapis.com` | 「AI Code」新命名域（[bin] `Making AI Code request to: %s`，与 cloudcode-pa 同协议族） |
| `https://businessaicode.googleapis.com` | 企业 BAIC（`/v1/projects/{p}/locations/{l}:selfAssignLicense` 等 REST 路径 + gRPC `google.cloud.businessaicode.v1beta.*`） |

**网关实现建议**：host 做成适配器常量并允许配置覆盖，默认
`https://cloudcode-pa.googleapis.com`（stable）；daily 值保留为注释。两者线协议一致，
通道只影响 host 前缀。

### 4.3 完整 v1internal 方法面 [bin]

二进制 descriptor 中枚举出的全部 `/v1internal:*` 自定义方法（供边界参考，网关只需前四个）：

```
loadCodeAssist            fetchAvailableModels      generateContent      streamGenerateContent
countTokens               completeCode              generateCode         generateChat
streamGenerateChat        transformCode             searchSnippets       tabChat
onboardUser               fetchUserInfo             listCloudAICompanionProjects
listModelConfigs          listExperiments           listAgents           retrieveUserQuota
retrieveUserQuotaSummary  recordClientEvent         recordCodeAssistMetrics
registerInteraction       fetchCodeCustomizationState  getCodeAssistGlobalUserSetting
setCodeAssistGlobalUserSetting  setUserSettings     fetchAdminControls
internalAtomicAgenticChat  battleModeAutoTrigger    battleModeOverrides  …（battle/远控/信令类略）
```

注意模型端口 404 边界（红线）：网关只转发 `antigravity/` 前缀模型，不代理这些
管理类方法；`fetchAvailableModels`/`loadCodeAssist` 仅在网关进程内用于目录与档位探测。

## 5. 请求/响应线格式

以下消息定义均直接还原自二进制内嵌 protobuf descriptor [bin]，字段名以
protojson（camelCase）出现在 HTTP JSON 中；与 gemini-cli 的开源实现交叉一致 [gemini-cli]。

### 5.1 推理请求（`POST /v1internal:streamGenerateContent?alt=sse`）

外层 `google.internal.cloud.code.v1internal.GenerateContentRequest`（字段按 descriptor
出现顺序列出；protojson 编解码只认字段名，编号未逐一核对、实现也不依赖编号）：

```protobuf
message GenerateContentRequest {
  string project;                    // RESOURCE；consumer 档填 "default-cli-project"
  string request_id;                 // 每请求唯一 ID（gemini-cli 开源版未见，Antigravity 新增）
  google.cloud.aiplatform.master.GenerateContentRequest request;  // 内层真实请求
  string user_prompt_id;             // 会话内用户消息 ID（gemini-cli 亦发送）
  string user_agent;                 // 客户端 UA（注意：这是 body 字段，不是 header）
  string request_type;               // 请求类型标记（同上，Antigravity 新增）
  repeated Credits.CreditType enabled_credit_types;  // 付费 G1 credits；免费档不传
}
```

内层 `google.cloud.aiplatform.master.GenerateContentRequest`（Vertex/Gemini 风格，
节选与转换相关的字段）：

```jsonc
{
  "contents": [{ "role": "user", "parts": [{ "text": "…" } / { "inlineData": {…} } / { "functionCall": {…} } / { "functionResponse": {…} }] }],
  "systemInstruction": { "parts": [{ "text": "…" }] },
  "tools": [{ "functionDeclarations": […] / "googleSearch": {…} / … }],
  "toolConfig": { "functionCallingConfig": { "mode": "AUTO" } },
  "safetySettings": […],
  "generationConfig": { "temperature": …, "maxOutputTokens": …, "thinkingConfig": { "thinkingLevel": … }, "responseMimeType": … },
  "labels": { … },
  "session_id": "…"            // gemini-cli 透传会话 ID；master proto 中为 session 相关字段
}
```

master proto 比 public Vertex 多若干 GOOGLE_INTERNAL 字段（`preambleConfig`、
`serviceTier`、`implicitCacheConfig`、`admitTime`、`failFast`、`continuationToken`
长解码续传、`outputConfig` 等）[bin]——对外部调用者不可见也不需要，按 public 形状
构造即可被服务端接受（gemini-cli 即如此 [gemini-cli]）。

gemini-cli 的开源组装逻辑（同协议直接可抄的参照）[gemini-cli]：

```js
{ model, project, user_prompt_id, request: {
    contents, systemInstruction, cachedContent, tools, toolConfig, labels,
    safetySettings, generationConfig, session_id },
  enabled_credit_types }
```

**Antigravity 相对 gemini-cli 的增量**：`request_id`、`user_agent`、`request_type`
三个新字段。稳妥起见网关按 Antigravity 形态补齐（`user_agent` 可填
`antigravity-cli/<version>` 风格值，实施时先以最小集验证再补）。

### 5.2 推理响应（SSE）

`alt=sse` 时返回标准 SSE：`data: {JSON}\n\n`，多个 `data:` 行可拼接（gemini-cli
按空行分帧、join 后 `JSON.parse`）[gemini-cli]。每帧为
`v1internal.GenerateContentResponse`：

```jsonc
{
  "response": {                       // master.GenerateContentResponse
    "candidates": [{ "content": { "role": "model", "parts": [{ "text": "…" } / { "functionCall": … }] }, "finishReason": "…" }],
    "usageMetadata": { "promptTokenCount": …, "candidatesTokenCount": …, "thoughtsTokenCount": … },
    "modelVersion": "…", "promptFeedback": {…}
  },
  "traceId": "…",                     // 服务端 trace，gemini-cli 映射为 responseId
  "consumedCredits": […], "remainingCredits": […]   // 仅启用 credits 时出现
}
```

非流式 `generateContent` 返回同一包装的单 JSON。
错误信封为 `google.rpc.Status` JSON（`code`/`message`/`details`）；配额类错误预期为
`RESOURCE_EXHAUSTED`（429）——**形态未实测**，实现时按 `code` 白名单分类（对照
`src/qoder/index.ts` 的 safeQoderUpstreamError 模式，只输出预定义分类）。

### 5.3 目录与档位（`fetchAvailableModels` / `loadCodeAssist`）

`FetchAvailableModelsRequest { project(RESOURCE), request_id, entitlement(Entitlement), location }` [bin]。

`FetchAvailableModelsResponse` [bin]：

```jsonc
{
  "models": { "<model_id>": ModelDetails },   // map
  "defaultAgentModelId": "…",
  "agentModelSorts": [ ModelSort… ],
  "commandModelIds": […], "tabModelIds": […], "imageGenerationModelIds": […],
  "tieredModelIds": { "<系列>": TieredModelConfig },   // 含 flash_lite 档
  "deprecatedModelIds": { "<旧id>": DeprecatedModelReroutingInfo },
  "audioTranscriptionModelIds": […]
}
```

`ModelDetails` 关键字段 [bin]：`displayName`、`supportsImages`、`supportsThinking`、
`supportsRawThinking`、`supportsVideo`、`supportsPdf`、`thinkingBudget`、
`minThinkingBudget`、`thinkingLevel`、`maxTokens`、`maxOutputTokens`、`tokenizerType`、
`recommended`、`preview`、`supportedMimeTypes`、`quotaInfo{remainingFraction, resetTime}`。

`LoadCodeAssistRequest { cloudaicompanionProject, metadata: ClientMetadata, mode }`；
`LoadCodeAssistResponse { currentTier: UserTier, allowedTiers[], cloudaicompanionProject,
projectValidationError, ineligibleTiers[] }` [bin]——档位/资格判断就绪信号。

> **网关侧档位合并（2026-10-06）**：上游把推理档位发布为独立模型 id（不存在无档位
> 基名模型，`tieredModelIds` 的 key 是系列标签而非可调用 id）。因此本网关目录把同一
> 基名的 `-high/-medium/-low` 变体聚族合并为一个 `agy/<base>` 条目，转发时按请求的
> `reasoning.effort` 解析具体变体（缺省 medium、缺档就近回退），显式档位 id 仍可直连；
> 单档位后缀模型（如 `gpt-oss-120b-medium`）不合并。见 `src/agy/catalog.ts`。

`ClientMetadata` [bin]（loadCodeAssist/onboardUser 携带；**这是 body 内的客户端指纹，
与 header 同样影响风控画像**）：

```jsonc
{ "ideType": "ANTIGRAVITY",        // 枚举含 ANTIGRAVITY/JETSKI/GEMINI_CLI/VSCODE…
  "ideVersion": "1.2.16",
  "pluginType": "CLOUD_CODE",       // 枚举含 CLOUD_CODE/GEMINI/AIPLUGIN_*
  "platform": "DARWIN_ARM64",
  "updateChannel": "…", "duetProject": "…", "ideName": "…" }
```

### 5.4 二进制内嵌的模型 ID 样例 [bin]（仅证明目录内容，实际以 fetchAvailableModels 拉取为准）

```
gemini-3.8-flash / -high / -medium / -low   gemini-3.7-flash(-high/-medium/-low)
gemini-3.6-flash(-high/-medium/-low)        gemini-3.5-flash(-high/-low/-extra-low)
gemini-3.1-pro-preview(-customtools/-high/-low/-low-thinking)   gemini-3-pro-preview
gemini-3-flash-preview  gemini-3-flash-agent  gemini-3.1-flash-lite(-preview)
gemini-3.1-flash-image(-preview)  gemini-3-pro-image  gemini-2.5-pro/-flash(-lite)
claude-sonnet-4(-5/-6)@…  claude-opus-4(-5/-6/-8)@default  claude-haiku-4-5@…
gpt-oss-120b-maas  gpt-oss-20b-maas  gpt-image-1
```

显示名风格（settings.json 默认值）："Gemini 3.8 Flash (High)"。

### 5.5 模型目录的更新机制 [log][bin]

对长驻会话日志 `cli-20260929_192642.log`（2026-09-29 19:26 → 10-06 09:48，跨 6.5 天）
做时间戳统计，`fetchAvailableModels` 共 1121 次调用：

- **固定 360 秒轮询**：相邻调用间隔 median=360s、p10=359s、p90=361s，
  843 个间隔整分钟分桶落 6 分钟——是定时器驱动而非事件驱动；
- `loadCodeAssist` 同周期（1120 次、median 360s），两者计数几乎一致，同一刷新循环；
- 间隔 >66min 的 21 次空档对应机器睡眠，唤醒后恢复，无补发迹象；
- 进程启动即拉取：另一日志显示启动后 ~1s 就调 fetchAvailableModels
  （未登录时跳过：`Auth mode is unspecified, skipping fetchAvailableModels and
  returning empty response`）；认证成功事件触发管理器全量刷新
  （`Auth succeeded, refreshing features and managers`）。

实现侧 [bin]：`go_utils/cache` 泛型 TTL 缓存（entry = value + timestamp），
读走 `Get`，过期由 singleflight 合并并发刷新（日志模板
`Cache(%s): Starting singleflight refresh` / `Singleflight refresh failed: %v`），
另有 `forceRefresh` 强制路径（认证/档位变化用）。**响应只存内存，不落盘**
（`~/.gemini/antigravity-cli/cache/` 无模型文件），进程重启即重拉。

服务端在响应里下发的"更新控制面"，全部由客户端在每次刷新时应用：

| 字段 | 作用 |
| --- | --- |
| `models` + `agentModelSorts`/`ModelSort{displayName, groups[]→ModelGroup{displayName, modelIds[]}}` | 可见模型集合与 UI 分组排序 |
| `defaultAgentModelId` | 默认模型 |
| `tieredModelIds`（值含 `flashLite` 等档位 → 具体 model id） | 按档位解析：用户选的是"系列+档位"标签，客户端查 `TieredModelConfig` 得具体 id（错误路径 [bin]：`no model ID found in TieredModelConfig for tier %q`、`failed to get model info for resolved model %q`） |
| `deprecatedModelIds` → `DeprecatedModelReroutingInfo{newModelId, oldModelEnum}` | 旧 id 服务端重定向到新模型，下线不换协议 |
| `experimentIds` + 每模型 `modelExperiments`（配合 `listExperiments` 轮询，同日志 42 次） | 实验开关灰度控制模型可见性（`AGY_CLI_MODEL_EXPERIMENT_PROFILES` 可本地覆盖） |
| `loadCodeAssist.currentTier/allowedTiers/ineligibleTiers` | 账号档位变化即时改变可用模型集合 |

用户在设置里改模型时只改本地选择，请求时按上表解析出具体 id 发送
（[bin] `Propagating selected model override to backend: label=%q`）。

**网关适配结论**：目录刷新复刻「启动即拉 + 360s 定时 + 认证/401 强刷」即可，
解析时应用 `deprecatedModelIds` 重定向与 `defaultAgentModelId` 标记；
无需本地持久化模型清单，网关自有缓存目录（对齐 `upstream-catalog.ts` 模式）。

## 6. HTTP Headers 清单（重点）

静态可证的全部相关 header 常量 [bin] 及其归属。**网关转发推理请求的最小必备集**
是前三行；其余按场景决定：

| Header | 值 / 来源 | 证据 | 网关是否必须 |
| --- | --- | --- | --- |
| `Authorization` | `Bearer <access_token>`；由 golang.org/x/oauth2 TokenSource 自动注入（[bin] `Bearer %s`；[gemini-cli] 同为 auth 库注入） | [bin][gemini-cli] | **必须**。网关每次请求前检查 `expiry`，临期先刷新 |
| `Content-Type` | `application/json`（POST body 为 JSON） | [bin][gemini-cli] | **必须** |
| `User-Agent` | 运行时拼装（[bin] 存在日志模板 `Request User-Agent to %s:\nUser-Agent: %s\n` 与 `X-Jetski-Remote-Control-User-Agent`），确切字面量未能静态提取；wrapper body 里另有 `user_agent` 字段（§5.1） | [bin] | 低风险，建议复刻 CLI 形态（如 `antigravity-cli/<version>`），实施时抓一次日志确认；服务端鉴权不依赖它（Bearer 为主） |
| `x-goog-user-project` | 配额项目覆盖时携带（[bin] `Overriding quota project for AI Code to: %s`）；consumer 档无需 | [bin] | 否（consumer 档不传） |
| `alt=sse` | **query 参数而非 header**（`…streamGenerateContent?alt=sse`） | [log] | 流式必须（放 URL，不是 header） |
| `X-Vertex-AI-LLM-Shared-Request-Type` / `goog-originating-logical-product-id` | 与 cloudcode-pa 请求构造代码同区的 Vertex 内部 header 字面量（紧邻 `decoding in-band SSE JSON error`、`Could not determine Vertex model ID`）；推断由 AI Code 客户端在推理请求上发送，发送条件未证实 | [bin] | 非必须；首次真实调用如需完全对齐 CLI 画像可补 |
| `X-Aicode-Trajectory-Id` | 轨迹关联 header（[bin] 字面量，aicode 客户端） | [bin] | 可选；不传预期不影响鉴权（未实测） |
| `x-goog-api-key` | API key 流（generativelanguage/其他 Google API 客户端常量） | [bin] | 否——OAuth 流不用，**不要**同时携带两种凭据 |
| `X-Goog-Upload-Command` / `X-Goog-Upload-Protocol` / `X-Goog-Upload-Header-Content-Length` / `X-Goog-Upload-Header-Content-Type` /（响应侧 `X-Goog-Upload-URL`、`x-goog-upload-url`） | Google resumable 媒体上传协议，图片/附件直传时用 | [bin] | 首期只做文本（functionCalling + text parts），不涉及 |
| `X-Goog-Ext-525006001-bin` | Google 内部扩展路由 header（部分 Google API 客户端使用） | [bin] | 否；无需伪造 |
| `x-server-timeout` | GCP frontend 超时 header | [bin] | 否 |
| `x-codeium-csrf-token` | **仅本地** language server HTTP API 的防 CSRF token，与上游无关 | [bin] | 否（勿混用） |
| `Accept` | SSE 场景 gemini-cli 未显式设置（`responseType: "stream"`），默认即可 | [gemini-cli] | 否 |

结论：**容易遗漏但真正要紧的是三件事**——① `Authorization` 必须每次用未过期的
access_token（网关要自己刷新，不能假设文件永远新鲜）；② 流式时 `alt=sse` 在
URL query 上；③ 客户端指纹主要落在 **body**（`ClientMetadata`、`user_agent`、
`request_type`）而不是 header，伪造请求想「像 CLI」要连 body 指纹一起对齐。
未压缩/编码类 header（Accept-Encoding 等）交给运行时默认。

## 7. 网关接入方案（对照现有适配器）

参照 Qoder 接入（`docs/exec-plans/active/qoder-international-flash-proxy-integration.md`）
与 CodeBuddy「只读消费凭据」模式，新增 `src/antigravity/` 适配器：

```
src/antigravity/
  credentials.ts   # 读取 ~/.gemini/antigravity-cli/antigravity-oauth-token（结构校验+脱敏错误）
  transport.ts     # 端点常量、token 刷新（singleflight、内存缓存、不回写文件）、fetch 封装
  catalog.ts       # fetchAvailableModels 拉取/缓存 + loadCodeAssist 档位，重建模型目录
  request.ts       # Responses API → v1internal GenerateContent 双向字段转换
  response.ts      # SSE 帧 {"response":{…}} → Responses 流式事件（含 functionCall/tool 映射）
  index.ts         # createAntigravityAdapter / antigravityEnabled / validateAntigravityConfig
```

关键设计点：

1. **凭据只读、绝不刷新（本项目定案）**：读取 `antigravity-oauth-token` 的
   `access_token`/`expiry`，**发送前校验 `expiry`**（RFC3339 带纳秒，`Date.parse`
   可解析）：
   - 未过期 → 直接使用；**网关不调用 oauth2/token、不触碰 refresh_token**
     （对齐 CodeBuddy「只读消费，绝不外发 refreshToken」红线）；
   - 已过期 → 快速失败，输出分类错误 `antigravity_token_stale`，提示
     「Antigravity 令牌已过期（有效期 1 小时，由 agy 进程负责刷新）；请运行
     agy 或 `agy remote-control start` 后重试」——daemon 在跑时，下一轮轮询
     （≤6 分钟）即会换新文件，用户稍后重试即可；
   - 收到 401 且文件 mtime 比读取时新 → 说明 daemon 刚换过 token，**重读文件重试一次**
     （重读≠刷新，仅限一次）；否则按过期分类处理；
   - 可观测性：把「token 剩余有效期 / 文件 age」写进网关自身日志（不含 token 值），
     便于区分「daemon 没跑」与「上游拒绝」。
   有效性前提（§3.3）：只要 remote-control daemon 常驻，文件近乎永远新鲜
   （最坏过期 ≤6 分钟窗口）；daemon 停跑则 1 小时后断供——这是只读方案的固有边界，
   文档与错误信息都要向用户交代清楚。
2. **目录动态化**：启动时 + 定时（复用 `upstream-catalog.ts` 的缓存/重建模式）
   调 `fetchAvailableModels`，以 `models` map + `tieredModelIds` 生成
   `antigravity/<model-id>` 前缀模型（如 `antigravity/gemini-3.8-flash-high`），
   显示分组 `Antigravity`；`displayName` 直接用 `ModelDetails.displayName`。
   用 `loadCodeAssist.currentTier` 判定档位，未登录/未 onboarding 时不生成目录
   （镜像 CLI 行为 [log]：`Auth mode is unspecified, skipping fetchAvailableModels`）。
3. **请求转换**：Responses → 内层 master 形状（contents/systemInstruction/tools/
   generationConfig.thinkingConfig；模型 id 里的 `-high/-low` 思考档或
   `thinkingLevel` 字段二选一，跟随目录元数据），外层补 `project: "default-cli-project"`、
   `request_id`（生成 UUID）、`user_prompt_id`、`user_agent`、`request_type`。
   `enabled_credit_types` 不传（免费档，不消费 credits）。
4. **Headers 实现**：按 §6 最小集；禁止把客户端任意 header 透传上游（与现有
   适配器一致：白名单式构造，避免凭据/指纹外泄）。
5. **错误分类**：上游 `google.rpc.Status` 映射到预定义分类
   （认证失效 / 配额受限 / 上下文超限），私有错误正文不进客户端与日志
   （复制 `safeQoderUpstreamError` 的白名单正则模式）。
6. **配置与红线**：`config.json` 新增 `antigravity: boolean` 开关；同步更新
   `schemas/gateway-config.schema.json` 与测试（仓库红线）。保留前缀
   `antigravity/`；启用时网关仍只监听环回（对齐 qoder 校验）。凭据与 token
   不进日志/Web UI；对外展示 URL 走 `sanitizeUrlValue`。
7. **风控画像对齐（降低封号风险）**：body 内 `ClientMetadata` 与 `user_agent`
   尽量与真实 CLI 一致（版本号可取本机 `agy` 的 1.2.16 或目录里 IDE 版本）；
   不要并行多账号轮换；目录刷新频率不高于 CLI 自身（其日志里高频但那是官方行为，
   网关取分钟级即可）。
8. **测试策略（不触发真实上游）**：单元测试用 mock transport（同 qoder 测试模式）
   覆盖凭据解析、刷新 singleflight、请求/响应转换、错误分类；真实调用验证放到
   用户明确授权的低频窗口单次执行（本调研未做，也不应在 CI 做）。

### 与其他适配器的难度对比

| | Qoder | CodeBuddy | ZCode | Antigravity |
| --- | --- | --- | --- | --- |
| 凭据 | 本地签名密钥 | OAuth（只读不刷新） | API Key | OAuth（只读不刷新，依赖 agy 进程保鲜文件） |
| 线协议 | 私有信封+SSE | 双向协议转换 | Responses 直通 | 标准 JSON+SSE（Gemini 形状） |
| 目录 | 动态拉取 | 动态拉取 | 静态 | 动态拉取（fetchAvailableModels） |
| 额外机制 | 排队恢复（403/10605） | — | — | 无排队信封（静态未见；credits/配额字段存在） |

## 8. CLI 侧其他发现（备忘）

- 本地语言服务器：CLI 启动后在 localhost 随机端口开 HTTPS gRPC + HTTP 两个 listener
  （[log] `server.go:639/647`），并有 `agy agentapi` 子命令（本地编程接口）、
  `agy remote-control` 守护进程。均与本任务无关，但说明 CLI 自身可被编程驱动。
- `AGY_*` 环境变量族 [bin]：`AGY_ACCOUNT`、`AGY_ADC_AUTH`、
  `AGY_CLI_MODEL_EXPERIMENT_PROFILES`、`AGY_CLI_MODEL_API_MAX_RETRIES` 等，
  以及登录态覆盖 `JETSKI_TEST_GAIA_TOKEN`（测试令牌注入，禁止在网关使用）。
- 媒体上传：图片附件走 Google resumable upload（`x-goog-upload-*` 头族），
  另有 `%s/v1beta/models/%s:generateContent` generativelanguage 风格路径用于图像类模型 [bin]。

## 9. 反向集成入口：CLI 自带 LLM Gateway 模式

agy 内置官方「LLM Gateway」客户端模式（[bin] `google3/third_party/jetski/gateway`
包、`AuthProvider.{SetEndpointURL,SetWireProtocol,SetHTTPHeaders}`、提示文案
`You are connected to an Enterprise LLM Gateway, so there is no session to log out of.
To switch back to signing in, unset %s (or remove gateway configuration from settings)`）。
配置面 [bin]：

| 环境变量 | 作用 |
| --- | --- |
| `AGY_LLM_GATEWAY_URL` | 网关基址（校验：`gateway URL %q is invalid`） |
| `AGY_LLM_GATEWAY_WIRE_PROTOCOL` | 线协议，仅两个取值（错误文案 `wireProtocol %q is unsupported; must be %q or %q`；已确认是纯字符串比较、无枚举常量，两个取值静态不可提取；结合 `/v1/chat/completions` 常量推测为 OpenAI 兼容与 Gemini 兼容两种） |
| `AGY_LLM_GATEWAY_MODELS` | 网关提供的模型清单 |
| `AGY_LLM_GATEWAY_API_KEY` / `AGY_LLM_GATEWAY_HEADERS` | 网关鉴权 |
| `AGY_LLM_GATEWAY_CA_CERT` / `AGY_LLM_GATEWAY_PROXY_URL` | 自签 CA 与出网代理 |

意义：codex-cliproxy 已是 OpenAI Responses 兼容服务，理论上可用这组变量把 agy 的
模型消费切到本网关（让 Antigravity 客户端用网关背后的其他上游）。这是官方扩展点、
不触碰 Google 上游，风险远低于正向转发；具体可用性需一次本地实验验证
（仅连本地网关，不出网，不涉账号）。

## 10. 未验证事项与风险清单

1. **未发起任何真实上游调用**（用户红线）。以下均为静态推断，实施时逐项用最小流量确认：
   - User-Agent header 确切字面量（已确认二进制内无 UA 形态的静态字面量，
     运行时由变量拼装，只有日志模板 `Request User-Agent to %s:\nUser-Agent: %s\n`）；
   - client_id ↔ client_secret 配对（仅自刷新方案需要；本项目已定案不刷新，
     此项仅留作背景知识，见 §3.2）；
   - stable 与 daily host 对同一 token 的可用性（预期一致，未证）；
   - 429/配额错误信封字段（§5.2）；
   - `request_type`/`user_agent` 合法取值集合。
2. daily 通道 host 属预发环境，稳定性与 stable 不同；网关默认应指向 stable。
3. 免费档与账号资格由服务端 `loadCodeAssist.currentTier` 决定，客户端不可缓存成
   永久结论（对齐 Qoder 计划中「免费状态以实际调用为准」的表述纪律）。
4. 封号风险缓解：不轮换账号、UA/指纹与真实 CLI 对齐、目录刷新取分钟级、
   失败不重试风暴（沿用各适配器已有的 idle-timeout 与单次重试边界）。
5. 只读令牌方案的固有边界（§3.3）：网关可用性依赖 agy 侧进程保持文件新鲜
   ——daemon 在跑时最坏存在 ≤6 分钟的「文件 token 刚过期未回写」窗口
   （以发送前 expiry 校验 + 分类错误兜底）；daemon 停跑 1 小时后断供。
   上线前需向用户交代「先 `agy remote-control start` 再用 antigravity/ 前缀模型」。

## 附录：证据复现命令

```bash
# 提取字符串（本文所有 [bin] 结论的来源）
strings -a -n 6 ~/.local/bin/agy > /tmp/agy-strings.txt

# 端点与协议
grep -oE "/v1internal:[a-zA-Z]+" /tmp/agy-strings.txt | sort -u
grep -oE "https://[a-z-]*cloudcode-pa[a-z.-]*|https://aicode.googleapis.com|https://businessaicode.googleapis.com" /tmp/agy-strings.txt | sort -u

# OAuth 客户端与刷新端点
grep -oE "[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com" /tmp/agy-strings.txt | sort -u
strings -a -t d ~/.local/bin/agy | grep "GOCSPX-" | sed -E 's/GOCSPX-[A-Za-z0-9_-]+/GOCSPX-[REDACTED]/g'   # 只看 offset，值不入库
grep -oE "https://oauth2\.googleapis\.com/[a-z/]+|https://accounts\.google\.com/[a-z/]+" /tmp/agy-strings.txt | sort -u

# 消息定义（内嵌 protobuf descriptor 里的 protojson 字段名）
grep -oE ".{60}cloudaicompanionProject.{100}" /tmp/agy-strings.txt
grep -oE "GenerateContentRequest.{0,400}" /tmp/agy-strings.txt | head
grep -oE "ModelDetails.{0,600}" /tmp/agy-strings.txt | head -3

# 本机历史调用面（只读历史日志，不产生新请求）
grep -hoE "URL: https://[^ ]+" ~/.gemini/antigravity-cli/log/*.log | sed 's/ Trace:.*//' | sort | uniq -c

# gemini-cli 开源参照（同协议）
~/.nvm/versions/node/*/lib/node_modules/@google/gemini-cli/bundle/chunk-QH43L44B.js
#   检索: CODE_ASSIST_ENDPOINT / toGenerateContentRequest / requestStreamingPost
```
