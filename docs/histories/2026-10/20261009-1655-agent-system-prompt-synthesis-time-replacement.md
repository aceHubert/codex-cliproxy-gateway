## [2026-10-09 16:55] | Task: 系统提示词改在合成期替换（含 model_messages 模板），zen 目录缓存落成品

### 🤖 Execution Context
* **Agent ID**: `zcode`
* **Base Model**: `GLM-5.3 (account:zai-individual-coding-plan)`
* **Runtime**: `ZCode CLI`
* **Git User**: `hubert`
* **Branch**: `feature/opencode-zen`

### 📥 User Query
> 网关已重启，第一步验收本地的catalog 都更新为各agent最新的系统提示词？
> 然后再通过日志确认我发送了一条qoder qwen-3.8-flash 的请求，看看系统提示词是否正确
> 你查request 啊，有完整的 body内容，系统提示词是在body jsonkh 的啊
> 不在 instructions 中，在 messages system 中，认真检查
> 看了一下这个生成的系统提示词就没有更新，为什么
> You are Codex, xxx这些都需要替换才对
> 代码逻辑不对，在生成 qoder-cn-catalog.json 就应该完成替换，而不是在获取的时候来实时替换
> zen 是不是也应该更新为catalog 作为缓存，/v1/models 只做合并就可以了

### 🛠 Changes Overview
**Scope:** `src/catalog.ts`、五个适配器的 `catalog.ts`/`index.ts`、`test/`、`docs/fingerprint-data.md`

**Key Actions:**
- **[真因定位]**: 只替换 `base_instructions` 对 Codex 客户端无效——客户端按
  `model_messages.instructions_template` 渲染系统提示词。实测：qoder 会话发出 19,754 字符
  官方 Codex 提示词（与快照基底模板长度一致），而目录 `base_instructions` 已正确替换为 484
  字符。Codex 请求 body 无 `instructions` 字段，系统提示词是 `input` 数组首条 developer 消息。
- **[合成期替换]**: 新增共享 helper `withAgentSystemPrompt(entry, prompt)`（`src/catalog.ts`），
  同时替换 `base_instructions` 与 `model_messages.instructions_template`。按用户要求，
  替换点从 serve 期（`catalog()` facade）全部下移到**合成/落盘期**：
  qoder `buildQoderCatalog`、agy `buildAgyCatalog`（缓存修订 5→6）、codebuddy
  `cloneCodexBase`、zen `buildZenCatalog`、zcode `publishServedCatalog`（写 `zcode-catalog.json`
  成品）。serve 路径只读缓存，不再逐条 map。
- **[zen 缓存落成品]**: `opencode-zen-catalog.json` 从「只存 ids/metadata」改为带 `models`
  成品数组；读盘直接读回，旧格式缓存（无 models）原地合成兜底，TTL/单飞/失败回退语义不变。
  `/v1/models` 侧只合并，与 qoder/agy/codebuddy 的 store 语义对齐。
- **[测试]**: 四个 gateway 测试的目录断言从「只断言 base_instructions」升级为同时断言
  `instructions_template`（zcode 合成条目无模板字段，断言「无模板或已替换」）。
- **[文档]**: `docs/fingerprint-data.md` 重写 `base_instructions 接线` 章节（改为模板字段
  说明 + 真因记录），新增「客户端缓存时序」小节（改提示词后必须 `models --sync` 或重启
  Codex 并新开会话，Codex 保存自身缓存时会剥掉 `base_instructions`）；表格更新为真实消费点。

### 🧠 Design Intent (Why)
用户逐层追问把真因逼了出来：先怀疑「没更新」（实际目录侧早已替换），再指出请求 body 的
真实位置（`input` 首条 developer 消息而非 `instructions`），最后定位到 Codex 优先用
`instructions_template`。替换点下移到合成期同样是用户明确要求——目录缓存即成品，
serve 期零加工，也避免了「缓存里是官方提示词、serve 时才覆盖」这种易腐的双轨状态；
zen 的 ids-only 缓存是这个不一致的最后一处，顺势补齐。

### 📊 Change Stats
> 数据来自本次任务工作区改动（`git diff --numstat`，仅统计本次触碰文件）。

- **Files changed:** 15
- **Insertions:** +99
- **Deletions:** -42

| File | +Added | -Removed |
| --- | ---: | ---: |
| `docs/fingerprint-data.md` | +26 | -12 |
| `src/catalog.ts` | +17 | -0 |
| `src/agy/catalog.ts` | +6 | -5 |
| `src/agy/index.ts` | +3 | -3 |
| `src/codebuddy/catalog.ts` | +4 | -3 |
| `src/codebuddy/index.ts` | +2 | -2 |
| `src/qoder/catalog.ts` | +4 | -3 |
| `src/qoder/index.ts` | +3 | -3 |
| `src/zcode/index.ts` | +9 | -6 |
| `src/opencode/{catalog,index}.ts` | +0 | -0（净零，结构改写） |
| `test/{agy,codebuddy,qoder,zcode}-gateway.test.ts` | +14 | -1 |

### ✅ Verification
- `bun run check` 全绿（tsc + 741 测试 + UI/CLI 构建）。
- 网关重启 + `models --sync` 后实测：
  - 线上 `/v1/models` 59 个适配器条目，`base_instructions` 与 `instructions_template`
    全部等于各自 fingerprint 提示词，官方提示词零残留（zcode 4 / codebuddy 16 /
    workbuddy 5 / qoder 15 / agy 8 / opencode-zen 11）。
  - 磁盘缓存同样为成品：qoder-cn 13、qoder-intl 2、agy 8、codebuddy-intl 16、
    zcode 4、opencode-zen 11 条目模板全部正确。
  - Codex 自身 `models_cache.json` 77 条目模板全部为各家提示词（qfmodel = 484）。
- 遗留观察（非本次问题）：`codebuddy-cn`/`workbuddy-cn` 磁盘缓存停在 10-08（当前
  `codebuddyAccount: "auto"` 未解析出 cn 账号，线上也不服务这两个族）；Codex 保存自身
  缓存时剥离 `base_instructions` 仅保留模板，客户端侧核对以模板为准。

### 📌 Notes
- 后续每次更新 `agentSystemPrompt` 都需跑 `models --sync`（或重启 Codex）并新开会话验证，
  已写入 `docs/fingerprint-data.md` 的「客户端缓存时序」。
- opencode-zen 的转发路门禁模板注入保持不变：首条 system 已含模板（目录下发即如此）时
  `injectZenFingerprintBody` 不重复注入，测试已覆盖。
