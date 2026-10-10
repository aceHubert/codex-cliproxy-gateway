# Magpie 对 ZCode Start Plan 支持的调研（2026-10-07，纯静态分析）

调研目标：核实 magpie-community/plugins 的 ZCode 插件对 Start Plan（Weekend Build /
Trust Build 等免费 gift bucket）的支持程度，评估「用 Magpie 稳定消耗 gift 额度」是否
成立，并回答两个与本项目相关的问题：① 官方 ZCode 的动态风控/CAPTCHA 层到底在什么
条件下拦截；② 本项目被注释掉的 Start Plan 支持，`-Trial` 后缀是不是缺失的那一环。
**全程未发起任何对 z.ai / bigmodel 的真实请求**，结论来自三类静态证据：

- [magpie]：magpie-community/plugins `main` 分支（tree sha `ac3b697`，
  `packages/zcode` v0.1.12）源码与测试；
- [zcode]：本机官方 ZCode Desktop 3.14.4 的 CLI bundle
  （`/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs`，14.8MB minified）；
- [repo]：本仓库已有实现与记录（`src/zcode/`、
  `docs/exec-plans/tech-debt-tracker.md` 2026-09-29 Start Plan 复验条目）。

## 结论（TL;DR）

1. **Magpie 的能力边界与社区贴文描述一致**：能发现 gift 余额、以 `-Trial` 后缀暴露
   gift 模型、把请求路由到 `zcode-plan/anthropic` 并完整伪装官方请求形态；`-Trial`
   请求 gift 拒绝时**不会**回落到付费 Coding Plan。这些全部在源码与测试中核实。
2. **但「缺 CAPTCHA 恢复（3007）」不是决定性问题——决定性的墙是 3012 边缘风控**。
   官方 3.14.4 已把模型请求的 captcha 预检改为服务端开关
   （`configs.captcha.skip_model_request`，实测为 true），3007 只在事后重试一次的
   traceless 场景出现；真正拦截 headless 流量的是阿里云 ESA 边缘风控的
   `405 {"code":3012,"msg":"request has been blocked due to unusual activity"}`，
   这一层没有「解一道题」式的协议可复刻，绑定会话/设备画像。本仓库 2026-09-29 的
   headless 直发实测（全套官方头 + `zcodejwttoken`）即被 3012 拦截，与 Magpie 注释
   中独立记录的同一堵墙相互印证。
3. **因此 Magpie「能用」与否不取决于它自己的实现质量**，而取决于阿里云边缘风控当
   时如何给「伪装成 ZCode/3.14.3 的 Node/Bun TLS 流量」打分。短期能跑 ≠ 长期稳定，
   官方客户端自身都会账号级 3012（社区 2026-09 报告：同账号当天成功 232 次后全被拦）。
4. **`-Trial` 后缀不是本项目缺失的那一环**。它是 Magpie 在单一 provider 内区分
   gift/付费模型的命名约定；本项目的等价物是套餐槽位前缀（`zcode-start-plan/<model>`，
   目录与凭据按路由隔离），模型 ID 保持规范名，结构上同样保证「gift 失败不烧付费
   计划」。本项目 start-plan 未暴露的唯一原因是 3012 风控（见 `src/zcode/index.ts`
   planRoutes 注释与 tech-debt-tracker），与命名方式无关。

## 1. Magpie zcode 插件实际做了什么 [magpie]

`packages/zcode/index.mjs`（1599 行，v0.1.12）的关键事实：

- **gift 发现**：`startPlan()` 读 `GET /api/v1/zcode-plan/billing/balance`，遍历
  `plans[]`×`balances[]`，跳过非 active / 已过期 / `remaining_units<=0` 的 bucket，
  汇总「现在还能花」的模型列表；`claimHint()` 另读 `billing/preview` 发现
  **已发放但未领取**的 gift。注释明确：领取（claim）需要的阿里云 captcha
  attestation 只有官方 App 的 renderer 能做，插件只在用量卡片上提示用户去官方
  App 领取——**插件不代领**。
- **`-Trial` 命名约定**：`giftID(m) = m + "-Trial"`（如 `GLM-5.3-Flash-Trial`）。
  双套餐账号（Coding Plan key + gift JWT 同时存在）时，目录里同名模型两份：裸名走
  付费 Coding Plan（`api.z.ai/api/anthropic`，x-api-key 鉴权），`-Trial` 走 gift
  （`zcode.z.ai/api/v1/zcode-plan/anthropic`，Bearer zcode JWT）。
- **无回落（no fallback）**：`-Trial` 请求若 gift 余额不可用，本地直接回
  `429/400`（`rate_limit_error`），**绝不**改走 Coding Plan；识别到配额错误
  （HTTP 429，或 200/错误体里 `code` 为 `1113`/`1005`）还会把该模型记入 60 秒
  blocked 名单，避免同一轮反复撞。这保证了测试 gift 消耗时不会误烧付费额度。
- **请求伪装**（`startHeaders()` + `dress()`）：删 `x-api-key`/`authorization`/
  `X-Device-Mid`，设 `Authorization: Bearer <jwt>`、`User-Agent: ZCode/3.14.3
  ai-sdk/anthropic/3.0.81`、`X-ZCode-App-Version/X-ZCode-Agent/X-Platform/
  X-Os-Category/X-Os-Version/X-Client-Language/X-Client-Timezone/x-request-id/
  x-zcode-session-type/x-zcode-trace-id` 等；body 重写为 ZCode 形态——三个带
  `cache_control` 的官方 system 块（`prompt.mjs` 内嵌 ZCode system prompt）、首个
  user turn 是 `<system-reminder>` 包裹的日期上下文、末块打 cache 标记、tools 不打、
  `metadata.user_id` 填 `{device_id, account_uuid:"", session_id:""}`。
- **错误透传**：gift 端点返回非配额类错误（含 405/3012）时**原样透传**给上层
  agent，不重试、不换路由、不做 captcha。

### 测试的效力边界 [magpie]

- `start.test.mjs` 开头自述：「The requests go to a local Bun.serve that records
  them; **nothing reaches z.ai or bigmodel**」——全部断言针对本地 fake server，
  证明的是「构造出的请求长得对」，不是「真实网关长期接受」。
- `dual.test.mjs` 有专门的 3012 用例：fake 返回
  `405 {"code":"3012","msg":"unusual activity"}`，断言：响应原样透传（status 405）、
  没有任何请求改走 `api.z.ai`、且该模型**不**进 blocked 名单（下一请求仍会再试
  gift）。即：Magpie 明确知道 3012 的存在，行为设计是「透传 + 下次再试」，没有
  恢复链路。
- 版本细节：`APP_VERSION = "3.14.3"` 硬编码，而当前官方客户端为 3.14.4——UA 与
  `X-ZCode-App-Version` 的版本偏差本身可能就是边缘风控的打分项之一。

## 2. 官方 ZCode 3.14.4 的风控链 [zcode] [repo]

对 3.14.4 CLI bundle 的静态分析（函数名为 bundle 内原名）：

- **start-plan/off-peak 不能走静态鉴权**：`cRs({access, baseURL})` 对
  `type:"zhipu-account" && (mode:"start-plan" | mode:"off-peak")` 直接返回 false
  （个人/团队 coding-plan 与 API key 返回 true）。返回 false 的流量必须经
  `interaction/requestProviderRuntimeHeaders` 这个 **CLI→桌面端 IPC** 获取本次请求
  的运行时头——即动态头由桌面 App 下发，不在 CLI 内静态拼装。
- **3007 的处理范围极窄**：`CaptchaRequestRetry.claim()` 仅当
  `accountAccess.mode === "start-plan"`、请求带 `refreshRuntimeHeadersBeforeAttempt`、
  且响应 `providerErrorCode === "3007"` 时生效，**只重试一次**（`used` 单次标志），
  重试以 `reason:"captcha-retry"` 重新走上述 IPC。合并新头前会先剥掉旧的
  `x-aliyun-captcha-verify-param` / `x-aliyun-captcha-verify-region`。
- **captcha 是服务端开关控制的**：[repo] 2026-09-29 拆包实证，
  `/api/v1/client/configs` 下发 `configs.captcha={enabled:true,
  skip_model_request:true,...}`——`skip_model_request:true` 使模型请求**不再预检/
  携带** captcha 头，只有 `billing/claim`（领取 gift）仍强制该头；3007 只在模型
  请求被拒后的那次 traceless（无感、无弹框）重试中出现。Magpie 侧证据一致：
  领取需官方 renderer，模型请求则未见 captcha 参与。
- **签名层已移除**：`x-client-sig` / `x-client-pow` / `Nonce` 等签名头在 3.14.4
  的 host/renderer/agent 中已彻底删除，bundle 里只剩日志脱敏名单中的头名残留
  （`RFs = new Set([...,"x-client-sig","x-client-pow",...])`）。复刻签名层不再是
  问题——它不存在了。
- **3012 是真正的墙**：[repo] 2026-09-29 headless 直发实测——Bearer
  `zcodejwttoken`（OAuth 经 `/api/auth/z/login` 换出的 biz JWT）+ 全套官方头
  （含取自 `telemetry-state.json` 的 `X-Device-Mid`、trace/session 头、UA
  `ZCode/3.14.4`）仍被 `405 {"code":3012,"msg":"request has been blocked due to
  unusual activity"}` 拦截；Cookie 重放（`acw_tc`/`cdn_sec_tc`/`visitor_id`）无效、
  换 TLS 栈（curl）同样被拦。agent 内无任何 3012 处理路径（bundle 中亦无业务级
  3012 分支）。结论：拦截发生在阿里云 ESA 边缘 + 应用层风控，依据是复刻不出的
  会话/设备画像，而非某个可解的 challenge。

## 3. 对「Magpie 支持 Start Plan」评估的修正

社区贴文的能力表基本准确，但归因需要修正：

| 能力 | Magpie | 佐证 |
| --- | --- | --- |
| 发现 gift 余额 / 显示 `-Trial` 模型 | ✅ | [magpie] `startPlan()`/`giftID()` |
| `-Trial` 路由到 gift、不回落付费计划 | ✅ 设计如此 | [magpie] dual.test.mjs、blocked 名单 |
| 伪装官方请求形态（头/system prompt/cache-control/metadata） | ✅ | [magpie] `startHeaders()`/`dress()` |
| 领取（claim）新 gift | ❌ 交给官方 App | [magpie] `claimHint()` 注释 |
| 3007 captcha 恢复 | ❌（透传） | [magpie] dual.test.mjs 3012/405 用例 |
| 3012 unusual-activity 恢复 | ❌（透传） | 同上；官方 agent 同样无路径 [zcode] |
| 长期稳定消耗 Weekend Build | ❌ 不能保证 | 3012 边缘风控 [repo] 实测 |

关键修正：**「没有 CAPTCHA 恢复链路」为真，但不是失败的原因**。在 3.14.4 形态下，
模型请求根本不做 captcha 预检（`skip_model_request:true`），3007 只覆盖一次性事后
重试；把 Magpie 挡在门外的是 3012 边缘风控——即使给 Magpie 补上完整的 3007 traceless
重试实现，也过不了 3012，因为后者评估的是会话/设备/TLS 画像而非某个可解 token。
反过来说，Magpie 对 405/3012 选择透传而非「恢复」，是对这堵墙的正确认知，不是偷懒。
因此「Magpie 值得试、但不能当稳定方案」的判断成立，且理由应从「缺 captcha 恢复」
改写为「能否通过取决于阿里云边缘风控的动态打分，任何 headless 实现都无法承诺」。
验证方法（官方 App 确认余额 → 选 `-Trial` → 连续跑工具轮 → 观察 bucket 扣减，
出现 405/3012 即撞墙）仍然有效，且观察到的直接会是 3012 而非 3007。

## 4. 与本仓库的关系：`-Trial` 后缀不是缺失的那一环 [repo]

本仓库的 Start Plan 支持是「机制就绪、路由有意关闭」：

- 就绪部分：`src/zcode/plans.ts` 解析 billing/balance 的 active Start Plan 实例与
  模型能力；`src/zcode/config.ts` 解析 `builtin:<family>-start-plan` 槽位、
  `startPlanApiKey()` 走 zcodejwttoken 鉴权；`src/zcode/catalog.ts` 已定义
  `zcode-start-plan/` 前缀与「免费」标签；`src/zcode/request-context.ts` 对
  start-plan 请求不发 `x-api-key`。
- 关闭点：`src/zcode/index.ts` 的 `planRoutes` 只注册个人/团队 Coding Plan，
  注释写明原因——「zcode-plan 中继在鉴权之外还要求阿里云 captcha（code 3007），
  网关无法 headless 通过」（2026-09-29 复验后堵点实为 3012，见
  `docs/exec-plans/tech-debt-tracker.md`）。

`-Trial` 后缀回答的问题——「双套餐账号如何让用户显式选择 gift 而非付费计划，并
保证选了 gift 就绝不烧付费额度」——本仓库已用**套餐槽位前缀**（模型 slug 的
`zcode-start-plan/` 段 → 独立路由/快照/凭据缓存）结构性解决：模型 ID 保持规范名
（对 Codex 侧目录更友好），凭据按路由隔离天然不存在回落路径。若未来风控放开需要
暴露 start-plan，直接把 `"start-plan"` 加回 `planRoutes` 即可，不需要引入 `-Trial`
命名。**真正的缺口自始至终只有一个：3012。**

## 5. 何时重估

沿用 tech-debt-tracker 的观察性重估条件，并补充 Magpie 侧信号：

- 官方客户端日志出现 3012/`unusual activity` 策略变化，或
  `configs.captcha.skip_model_request` 变为 false（模型请求恢复预检），或
- magpie-community 出现 `-Trial` 大面积可用/大面积 3012 的用户报告（分别提示
  风控放宽/收紧），或阿里云风控对非官方流量放开。

在上述信号出现前，维持本项目 start-plan 路由不暴露的决策不变；本次调研作为独立
第三方佐证（Magpie 注释与测试独立记录了同一 3012 墙与「claim 需官方 renderer
captcha」事实）并入该条目的证据链。
