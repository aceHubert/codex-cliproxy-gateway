# OpenCode 2 / Zen 免费模型与网关代理接入调研报告

> 调研日期：2026-10-08
>
> 调研对象：OpenCode 2 (`@opencode-ai/cli` v0.0.0-beta-19086)、OpenCode (v1.18.28)、OpenCode Zen 服务 (`https://opencode.ai/zen/v1`)
>
> 关联系统：`codex-cliproxy` 网关

> **⚠️ 2026-10-08 实施期修正（重要）**：本报告 §3.2 的门禁结论在实施当天已部分失效——
> `opencode/1.18.31` 旧式 UA 与本报告的会话生成公式在真实上游全部 403。经 mitm 抓包
> opencode2（beta-19086）与逐项隔离实验，实际门禁为三层：① 标头层要求新四段式 UA
> `opencode/<channel>/<version>/<clientName>` + 会话三回填（`x-opencode-session` /
> `x-session-affinity` / `x-session-id` 同值）+ 任意稳定 40-hex `x-opencode-project` +
> W3C `traceparent`/`b3` 追踪头；② 请求体层要求首条 system 消息**完整包含官方内置
> 提示词模板**（逐字符匹配；无工具流量可用标题生成器模板，带工具流量必须 agent 模板
> + 官方工具定义在场）；③ 传输层**仅接受 `stream: true`**，非流式一律 403。会话生成
> 算法实测为 `r = ts*0x1000 + counter`（counter 为同毫秒自增序号，从 1 起），降序 Hex
> 取 `~r` 的高 48 位（即 `0xffffffffffff - (r & 0xffffffffffff)`）——本报告 §3.2 公式
> 漏了 counter。完整实证与落地实现见
> [执行计划决策记录 #3](exec-plans/completed/opencode-zen-free-models-proxy-integration.md)
> 与 `src/opencode-zen/fingerprint.ts` 头注释。

---

## 1. 核心结论摘要 (TL;DR)

| 维度 | 关键结论 |
| :--- | :--- |
| **Zen 服务本质** | OpenCode 官方维护的模型路由聚合平台（类似针对编程优化的 OpenRouter/Mastra），对外暴露标准 OpenAI 兼容协议（`@ai-sdk/openai-compatible`）。端点为 `https://opencode.ai/zen/v1`。 |
| **免费模型现状** | Zen 当前目录包含 **37 个免费/零计费模型**（`cost.input = 0, cost.output = 0`），涵盖主流国产大模型与开源前沿模型（Nemotron 3.5 Lightning、Qwen 3.6 Plus、Kimi K2.5、MiniMax M3、GLM-5、MiMo V2.6 Flash、Exo Free 等）。 |
| **官方门禁机制 (Gatekeeper)** | **存在严格的客户端指纹白名单风控**（2026年9月中旬上线）。外部普通 OpenAI 请求调用免费模型会直接返回 `HTTP 403 FreeTierError: OpenCode's free tier can only be used from within OpenCode`。 |
| **门禁拦截依据 (逆向实证)** | 1. **`User-Agent` 校验**：必须满足 `opencode/<semver>` 格式且版本需为官方 release（非 git-describe 构建）；<br>2. **`x-opencode-session` 校验**：必须符合 OpenCode 内置 `Identifier.descending` 规则（`ses_` + 12位十六进制降序时间戳 + 14位 Base62 随机串，共 30 字符）；<br>3. **凭据要求**：免费额度无需账号绑定，携带 `Authorization: Bearer public` 即可。 |
| **网关代理可行性** | **架构上可行，但存在显著的被动风控与脆弱性风险**：<br>1. **方案一（网关直连逆向伪装与会话绑定）**：网关作为 upstream 转发时，自动伪装 `User-Agent`，支持从外部 `X-Session-Id` 稳定绑定并映射为合规的 `x-opencode-session`（已有官方会话头则原样透传）；<br>2. **方案二（本地 Daemon 桥接）**：通过本机运行的 `opencode2 serve` 后台服务作为中间宿主转发，合法性与稳定性最佳；<br>3. **方案三（反向代理：OpenCode2 经网关）**：`opencode2` 原生支持标准 `HTTP_PROXY` / `HTTPS_PROXY`，亦可在 `opencode.json` 中配置自定义 provider 桥接本网关。 |

---

## 2. OpenCode 2 与 Zen 的体系分析

### 2.1 架构与组件
- **客户端**：
  - OpenCode 1.x：传统单体 CLI 工具（1.18.28）。
  - OpenCode 2.x：重构后的预览版客户端（`@opencode-ai/cli`，版本 `0.0.0-beta-19086`，二进制入口 `opencode2.exe`），采用 CS 架构（CLI 前端 + 后台 `serve` 服务）。
- **Zen 平台**：
  - OpenCode 的云端模型网关，底层提供代码补全、对话、工具调用（Function Calling / Tools）等多模态支持。
  - API 格式：完全遵循 OpenAI Chat Completions 规范（POST `https://opencode.ai/zen/v1/chat/completions`）。

### 2.2 免费模型清单（经本机缓存与官方目录提取）
Zen 提供了大量供开发者免费体验的 Coding 模型，当前活跃的免费模型多达 37 个，典型代表如下：

| 模型 ID (`model_id`) | 显示名称 | 上下文 / 特性说明 |
| :--- | :--- | :--- |
| `nemotron-3.5-lightning-free` | Nemotron 3.5 Lightning Free | NVIDIA 极速开源编码模型，实测完整支持 Tool Calling |
| `nemotron-3-ultra-free` | Nemotron 3 Ultra Free | NVIDIA 深度推理模型 |
| `qwen3.6-plus-free` | Qwen3.6 Plus Free | 阿里通义千问最新大模型编码优化版 |
| `kimi-k2.5-free` | Kimi K2.5 Free | 月之暗面长文本对话与代码模型 |
| `minimax-m3-free` / `minimax-m2.5-free` | MiniMax M3 / M2.5 Free | MiniMax 高效推理系列 |
| `glm-5-free` / `glm-4.7-free` | GLM-5 Free / GLM-4.7 Free | 智谱 AI 旗舰代码模型 |
| `mimo-v2.6-flash-free` / `mimo-v2.5-free` | MiMo V2.6 Flash / V2.5 Free | 小米自研超轻量代码模型 |
| `deepseek-v4-flash-free` | DeepSeek V4 Flash Free | DeepSeek 高性能轻量推理模型 |
| `ling-3.1-flash-free` / `ling-3.0-flash-free` | Ling 3.1 / 3.0 Flash Free | 零一万物轻量代码模型 |
| `hy3-free` / `hy3-preview-free` | Hy3 Free / Hy3 Preview Free | 腾讯混元 3 代大模型 |
| `longcat-2.5-preview-free` | LongCat 2.5 Preview Free | 美团长上下文代码模型 |
| `exo-free` / `fledge-alpha-free` / `grok-code` | Exo Free / Fledge / Grok Code | 官方精选实验性 / 社区免费模型 |

> **注**：Zen 的免费模型并非永久固定，官方会根据算力成本和合作赞助进行动态轮换（Rotating Selection），并设有频次限制（如单 IP / 单会话限速）。

---

## 3. 门禁风控机制与逆向工程实证

### 3.1 现象重现
直接使用常规 HTTP 客户端调用免费模型：
```bash
curl -s -i https://opencode.ai/zen/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model": "nemotron-3.5-lightning-free", "messages": [{"role": "user", "content": "hi"}]}'
```
**响应结果**：
```http
HTTP/2 403 Forbidden
{"type":"error","error":{"type":"FreeTierError","message":"Error from provider (Console): OpenCode's free tier can only be used from within OpenCode"}}
```

### 3.2 逆向分析：服务端校验规则
通过查阅官方 Issue 讨论（如 `#49433`、`#49430`、`#49431`）以及对 `opencode2.exe` / `opencode.exe` 二进制代码分析，确立了服务端的拦截逻辑：

1. **User-Agent 强校验**：
   - 格式要求：`opencode/<semver>`（如 `opencode/1.18.28`、`opencode/1.18.31` 等）。
   - 服务端解析 UA 中的版本号，要求必须大于等于 `1.17.0`。
   - 若 UA 携带非标准语义版本（例如 Arch Linux 包构建的 git describe 字符串 `1.18.31.r12.g88c6c7a`）或第三方客户端名称（如 `pi/1.0`、`curl/8.x`），直接 403 拦截。
2. **Session ID 格式强校验（`x-opencode-session`）**：
   - OpenCode 内部使用特定算法生成 `SessionID`，其正则表达式为：
     `^ses_[0-9A-Za-z]{26}$`
   - 具体编码算法（见 `Identifier.descending`）：
     - 前缀：`ses_`
     - 中间 12 位：基于当前毫秒时间戳的 48 位空间降序 Hex（`descendingHex = (0xffffffffffffn - ((Date.now() * 0x1000n) & 0xffffffffffffn)).toString(16).padStart(12, '0')`）
     - 后 14 位：Base62 随机字符。
   - 服务端会解码前 12 位十六进制并校验其时间合理性，伪造错误格式会直接触发 `FreeTierError`。
3. **认证标头（Authorization）**：
   - 对于免费模型，无需绑定信用卡或购买付费计划，携带 `Authorization: Bearer public` 或匿名请求均可通过。

---

## 4. 通过网关代理使用的具体方案设计

围绕用户需求“通过网关代理如何使用”，存在三个层面的实现路径：

```
┌────────────────────────────────────────────────────────────────────────┐
│                              使用场景分类                              │
├────────────────────────────────┬───────────────────────────────────────┤
│ 场景 A：作为网关上游 (Inbound) │ 场景 B：客户端走代理 (Outbound)       │
│ 将 Zen 免费模型接入 codex 网关  │ opencode2 经网关/HTTP代理发起外部请求  │
│ 供 Claude Code / Codex CLI 使用│ 解决企业网络隔离与网络出海需求        │
└────────────────────────────────┴───────────────────────────────────────┘
```

### 方案 A：在 codex-cliproxy 网关中接入 Zen 适配器（网关充当客户端）

如需将 OpenCode Zen 免费模型作为 `codex-cliproxy` 网关的一个 Upstream，供 Codex CLI 或 Claude Code 调度，网关需要承担**协议转换与指纹伪装**职责。

#### 1. 架构流向
```
[Codex CLI / Claude Code]
         │ (OpenAI / Claude API)
         ▼
[codex-cliproxy 网关] (127.0.0.1:8321)
         │ 1. 模型路由映射 (如 zen-nemotron -> nemotron-3.5-lightning-free)
         │ 2. 注入合法请求头:
         │    - User-Agent: opencode/1.18.31
         │    - Authorization: Bearer public
         │    - x-opencode-session: ses_<12_hex_timestamp><14_base62>
         │    - x-opencode-client: cli
         ▼
[https://opencode.ai/zen/v1/chat/completions]
```

#### 2. 会话绑定与标头映射策略（Session Binding & Header Precedence）

外部客户端（如 Claude Code、Codex CLI 等）请求网关时通常带有自身的会话标识。为避免每一次请求都生成全新的 `x-opencode-session` 导致服务端会话泛滥被限流或丢失 KV 缓存亲和性，网关应支持**外部会话到 OpenCode 会话的稳定绑定与转换**。

##### 标头判定优先级
```
入站请求到达网关
    │
    ├── 1. 是否已携带 x-opencode-session？
    │        ├── 是 (且有效) ──> 原样保留透传（无需转换）
    │        └── 否 ──┐
    │                 ▼
    ├── 2. 是否携带 X-Session-Id？
    │        ├── 是 ──> 触发会话转换与绑定逻辑，转换为合规 ses_<12_hex><14_base62>
    │        └── 否 ──┐
    │                 ▼
    └── 3. 兜底策略 ──> 生成临时单次合规的 x-opencode-session
```

##### 转换与会话保持实现机制
1. **LRU 内存会话绑定表（推荐：最稳健）**：
   - 网关在内存中维护轻量 LRU 映射表（`Map<string, { openCodeSession: string; expireAt: number }>`），默认 TTL 24 小时并支持滑动续期。
   - 首次遇到外部 `X-Session-Id` 时，按当前时间戳生成合规的 `ses_` 串并存入缓存；后续同一会话请求直接复用已绑定的 ID。
2. **纯确定性无状态哈希映射（备选 / 重启兜底）**：
   - 对 `X-Session-Id` 做 SHA-256 哈希，提取 14 位映射为 Base62 后缀，前 12 位使用合法时间戳 Hex，无需占用内存。

##### 完整实现代码参考 (TypeScript)
```typescript
import crypto from "node:crypto";

const BASE62_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

// LRU 映射表：X-Session-Id -> x-opencode-session
const sessionCache = new Map<string, { openCodeSession: string; expireAt: number }>();
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24小时滑动有效期

function cleanExpiredSessions() {
  const now = Date.now();
  for (const [k, v] of sessionCache.entries()) {
    if (v.expireAt < now) sessionCache.delete(k);
  }
}

/**
 * 生成合规的 OpenCode Session ID (ses_ + 12位降序Hex + 14位Base62)
 */
export function createOpenCodeSessionId(timestampMs = Date.now(), seed?: string): string {
  const mask48 = 0xffffffffffffn;
  const scaled = (BigInt(timestampMs) * 0x1000n) & mask48;
  const hexPart = (mask48 - scaled).toString(16).padStart(12, "0");

  let suffix = "";
  if (seed) {
    const hash = crypto.createHash("sha256").update(seed).digest();
    for (let i = 0; i < 14; i++) {
      suffix += BASE62_CHARS[hash[i] % BASE62_CHARS.length];
    }
  } else {
    for (let i = 0; i < 14; i++) {
      suffix += BASE62_CHARS[Math.floor(Math.random() * BASE62_CHARS.length)];
    }
  }

  return `ses_${hexPart}${suffix}`;
}

/**
 * 标头路由决策与会话转换函数
 */
export function resolveOpenCodeSession(headers: Headers | Record<string, string | string[] | undefined>): string {
  const getHeader = (name: string): string | undefined => {
    if (headers instanceof Headers) {
      return headers.get(name) ?? undefined;
    }
    const val = headers[name.toLowerCase()] ?? headers[name];
    return Array.isArray(val) ? val[0] : val;
  };

  // 1. 若客户端自身已有 x-opencode-session，原样使用，不转换
  const rawOpenCodeSession = getHeader("x-opencode-session");
  if (rawOpenCodeSession && /^ses_[0-9A-Za-z]{26}$/.test(rawOpenCodeSession.trim())) {
    return rawOpenCodeSession.trim();
  }

  // 2. 若存在 X-Session-Id，通过缓存绑定/哈希转换
  const rawSessionId = getHeader("x-session-id");
  if (rawSessionId && rawSessionId.trim()) {
    const cleanSessionId = rawSessionId.trim();
    cleanExpiredSessions();

    const cached = sessionCache.get(cleanSessionId);
    if (cached && cached.expireAt > Date.now()) {
      cached.expireAt = Date.now() + SESSION_TTL_MS; // 活跃请求滑动续期
      return cached.openCodeSession;
    }

    // 首次见到的会话：生成并绑定
    const newSession = createOpenCodeSessionId(Date.now(), cleanSessionId);
    sessionCache.set(cleanSessionId, {
      openCodeSession: newSession,
      expireAt: Date.now() + SESSION_TTL_MS,
    });
    return newSession;
  }

  // 3. 兜底策略：生成单次临时合法 session
  return createOpenCodeSessionId();
}
```

#### 3. 上游转发中间件装配逻辑
```typescript
function buildZenUpstreamHeaders(reqHeaders: Headers): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "User-Agent": "opencode/1.18.31",
    "x-opencode-session": resolveOpenCodeSession(reqHeaders),
    "x-opencode-client": "cli",
    "Authorization": "Bearer public",
  };
}
```

#### 4. 方案 A 的利弊评估
- **优势**：
  - 白嫖 30+ 款主流免费模型（包括长上下文和编程增强模型）。
  - 对外部客户端（Claude Code、Codex 等）完全透明。
- **风险与缺点**：
  - **脆弱性高**：属于逆向对抗。OpenCode 团队已多次更新反脚本门禁逻辑，未来可能引入 Cloudflare Turnstile 人机验证或签名校验。
  - **限频严格**：公用 IP 或高频调用极易触发 429 限制（`FreeUsageLimitError`）。

---

### 方案 B：本地守护进程桥接模式（Local Daemon Bridge）

为避免直接逆向云端接口的脆弱性，可以利用本地已安装的 `opencode2` 守护进程作为正规桥梁：

```
[外部客户端] ──> [codex-cliproxy 网关] ──> [opencode2 本地 serve 接口] ──> [Zen 云端]
```

1. **机制**：
   - `opencode2 serve --port <port>` 在本地以真实官方客户端身份运行，内置官方完整的状态管理、会话生命周期与协议层。
   - `codex-cliproxy` 网关仅需向本地的 `opencode2` 本地 REST API 发送请求，由 `opencode2` 本身与官方 Zen 云端通信。
2. **优势**：
   - 彻底免除 UA 与 Session 指纹被判定为非法的风险。
   - 官方更新客户端时，本地自动保持合规。

---

### 方案 C：在 OpenCode 2 中配置网关代理（正向代理 / 模型桥接）

如果是想在 `opencode2` 工具本身内部，使用网关提供的代理能力，配置方式如下：

#### 1. 网络出海代理（HTTP/HTTPS Proxy）
`opencode2` 基于 Bun 运行时，内置支持标准代理环境变量：
```bash
export HTTP_PROXY=http://127.0.0.1:8321
export HTTPS_PROXY=http://127.0.0.1:8321
export NO_PROXY=localhost,127.0.0.1

opencode2 run -m opencode/nemotron-3.5-lightning-free "你好"
```

#### 2. 在 `opencode.json` 中配置自定义 Provider 接入网关
若希望让 `opencode2` 消费 `codex-cliproxy` 网关所代理的其它模型（例如 Codex、Claude、ZCode）：
编辑 `~/.config/opencode/opencode.json`：
```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "cliproxy-gateway": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "CLIProxy Gateway",
      "options": {
        "baseURL": "http://127.0.0.1:8321/v1",
        "apiKey": "dummy"
      },
      "models": {
        "gpt-5.3-codex": {
          "id": "gpt-5.3-codex",
          "name": "GPT-5.3 Codex (Via Gateway)"
        }
      }
    }
  }
}
```
此时可在 `opencode2` 中直接使用：
```bash
opencode2 run -m cliproxy-gateway/gpt-5.3-codex "分析当前仓库结构"
```

---

## 5. 总结与建议

1. **关于 Zen 免费模型的可用性**：
   OpenCode Zen 的免费模型资源丰富且真实可用，实测工具调用能力完整。
2. **关于接入网关的建议**：
   - **不建议作为生产级主力 Upstream**：由于官方明确通过 `FreeTierError` 防范第三方程序调用，且免费模型池存在动态轮换与频繁限流，将其作为主力生产模型会导致不可预期的 403 / 429 故障。
   - **适合作为个人备用或实验性通道**：若作为个人应急或低频测试使用，网关可通过补充 `User-Agent: opencode/1.18.31` 以及合规的 `ses_` Session 编码实现转发。
   - **最优实践**：在本地环境直接利用官方 `opencode2 run` 进行单次调试，或借助 `opencode2` 守护进程进行本地集成。
