# [2026-09-21 14:47] | Task: 实现 ZCode 客户端签名并端到端验证

### 🤖 Execution Context
* **Agent ID**: zcode
* **Base Model**: zai-api/GLM-5.3
* **Runtime**: ZCode CLI
* **Git User**: hubert <hubert@lejian.com>
* **Branch**: fix/config-restart-codex

### 📥 User Query
> 分析 ZCode 源码确认 150% 优惠未生效是缺签名请求头后，按官方协议实现签名并执行验证。

### 🛠 Changes Overview
**Scope:** codex-cliproxy（src/zcode/、test/）

**Key Actions:**
- **[新增 client-signing 模块]**: 逐字节复刻官方 Client Request Signing 协议：`{id}.{secret}` key 解析、HKDF 派生（salt `WD_CLIENT_SIGN_KDF_SALT`，info `getSignKey_hmac`/`ed25519_priv`）、握手（POST `/api/paas/c1f3a7e2/v2/client`，HMAC 签名换取 AES-GCM 加密的 Ed25519 私钥，AAD 为 apiKeyId）、逐请求 Ed25519 签名与 8-bit PoW，补齐 `X-App-Id`/`X-Client-Ts`/`X-Client-Version`/`X-Client-Sig`/`X-Client-Nonce`/`X-Client-Pow`/`X-Session-Id` 头。私钥按 `(apiKey, origin)` 缓存，失败 30s 冷却。
- **[接入转发路径]**: `zcode/index.ts` 主请求、VERIFY 401 失效重试（作废重握手重签一次）、图片识别续跑腿与 vision 执行器每腿独立签名；握手任何失败 fail-open 按未签名继续。本机未装 ZCode（appVersion unknown）或 key 非单点形态（含 JWT）时自动跳过。
- **[测试]**: 新增 `test/zcode-signing.test.ts` 10 项：key 解析边界、握手 HMAC 用 node:crypto 独立复算交叉验证、网关端到端签名头 Ed25519 验签 + PoW 前导零复核、VERIFY 拒绝重握手、fail-open、私钥缓存复用与签名值不复用。

### 🧠 Design Intent (Why)
ZCode 官方客户端对 coding plan 且官方域名的模型请求附加逐请求签名（服务端据此归因官方流量，150% 配额活动即依赖此识别）。网关此前只复刻了来源头（User-Agent/X-ZCode-Agent 等），缺签名层。所有签名输入均可从网关已持有的业务 key 派生，因此按协议自签而非伪造。签名失败 fail-open 与官方客户端 VERIFY 重试耗尽后的 bypass 行为一致，保证不因签名层故障断流。

### 📊 Change Stats
> 数据来自 `git diff --numstat`（工作区未提交改动，仅本次任务相关文件）。

- **Files changed:** 4
- **Insertions:** +661
- **Deletions:** -9

| File | +Added | -Removed |
| --- | ---: | ---: |
| `src/zcode/client-signing.ts` | +258 | -0 |
| `src/zcode/index.ts` | +54 | -7 |
| `src/zcode/vision.ts` | +3 | -2 |
| `test/zcode-signing.test.ts` | +346 | -0 |

### 📁 Files Modified
- `src/zcode/client-signing.ts`（新增）
- `src/zcode/index.ts`
- `src/zcode/vision.ts`
- `test/zcode-signing.test.ts`（新增）

### ✅ Verification
- `bun run check`：482 项测试 0 失败，严格类型检查与构建通过。
- 单次真实请求验证（临时脚本直连适配器，不动运行中的 8320 服务）：
  - 真实握手 `https://api.z.ai/api/paas/c1f3a7e2/v2/client` 成功（HKDF/AES-GCM 参数正确，否则解不出私钥）。
  - `zcode-zai-api/glm-5.3-flash` 路由：模型请求 `signed=true`，HTTP 200 `response.completed`，usage input 16 / output 115，模型按要求回复。无 401 `VERIFY_SIGNATURE_INVALID`、无重签重试——签名被上游接受。
  - `zcode-individual-coding-plan` 路由：同样 `signed=true` 且未被签名拒绝，429 为套餐周配额耗尽（2026-09-28 重置），与签名无关。
- 150% 配额是否实际生效需等配额重置后由服务端用量数据确认，本轮只能证明签名身份被接受。

### ⚠️ Known Limitations / Tech Debt
- 签名协议逆向自官方客户端（已是 V4），服务端可随时调整参数（PoW 难度、握手路径、派生 info）而失效；失效表现为回退未签名流量（优惠丢失但不断流），需跟踪官方客户端更新。
- 未实现官方的远程开关（`codingPlanSignature.enable`，缓存 1 小时）——网关恒签；gate 关闭时服务端不校验签名，恒签属无害冗余。
- Z.ai 订阅条款保留对非支持工具限制权益的权利；本实现以网关自有 key 自签，风险由使用者自担。
