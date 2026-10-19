## [2026-10-16 11:20] | Task: 实现 models --push 推送模型清单到 ZCode 与 DSH

### 🤖 Execution Context
* **Agent ID**: `zcode`
* **Base Model**: `GLM-5.3 (account:zai-individual-coding-plan)`
* **Runtime**: `ZCode CLI`
* **Git User**: `hubert`
* **Branch**: `feat/release-action`

### 🛠 Changes Overview
**Scope:** apps/gateway（CLI 命令、推送管道与两个客户端目标）、test、docs

**Key Actions:**
- **[CLI flag]**: `models --push [TARGETS]`（值可选解析仿 `--exclude`；`COMMAND_OPTIONS`/usage 更新；可与 `--sync`/`--exclude`/`--select` 组合，一律在其他操作成功落盘后最后执行；不加入 `writesClient`）。
- **[推送管道]**: 新模块 `models-push.ts`——`ModelPushTarget` 契约（安装预检 + push）、excludedModels 过滤（作用域限本地插件模型）、来源失败/空清单中止、单目标失败隔离与整体非零退出；共享元数据提取与 `writeIfChanged`（值未变不写盘也不备份，变更前备份 `<file>.bak-agent-proxy-<ts>` 后 `atomicWrite`）。
- **[ZCode 目标]**: `zcode-client-sync.ts`——定位 `~/.zcode/v2`（`ZCODE_HOME` 可覆盖）中 `providerName === "cliproxy"` 的 provider，按 ID 全量替换 `modelOrder`/`personalModelIds`/`providerModelRules` 与 `config.json` 的 `models` 映射；保留模型原定义不动、新定义按网关元数据合成（缺啥省啥）；剔除 zcode 插件模型防回环；尊重 `zcode.deletedModels`；不触碰 `options`/`access` 等非受管字段。
- **[DSH 目标]**: `dsh-client-sync.ts`（`DSH_HOME` 复用 dsh 原生 env）——在各 profile `cordis.patch.yml` 的 `llm-pi-ai` 条目管理专属 provider `agent-proxy`（`AgentProxy`/`anthropic-messages`/网关本地根地址/apiKey 占位 `AGENT_PROXY_API_KEY`），缺失自动创建、此后只同步 `models[]`；用户自建 provider 与 `settings.yaml`/`.credentials.yaml` 完全不动。
- **[依赖]**: `yaml@^2.9.0` 加入 gateway dependencies 与根 devDependencies（测试直接 import）。
- **[测试/文档]**: 3 个测试文件 17 例；README 补 `--push` 手册；执行计划归档至 `docs/exec-plans/completed/models-push-clients.md`。

### 🧠 Design Intent (Why)

用户需要把网关当前可用的模型清单一键写入本机客户端工具（ZCode 与 DeepSeek Harness），
替代长期手工维护（此前 `~/.zcode` 与 `~/.dsh` 的模型列表均手工编辑并已出现漂移）。
关键裁决（均留痕于执行计划决策记录）：按 ID 全量替换、忽略目标侧手动添加；修改前自动备份；
推送前安装预检；DSH 侧自建 `agent-proxy` 受管 provider（与用户 `cliproxy*` 各归各，apiKey 为占位——
网关忽略客户端 key、各插件自处理上游授权）。

实施中的关键教训：dsh 真机首推暴露 `YAML.parse→stringify` 纯值往返会把 patch 层的
`!!js` 表达式降级为普通字符串（`trustedHosts: !!js "…"` 求值语义丢失）。已当场从备份恢复，
改为 `YAML.parseDocument` 文档级往返：未触及内容（含 `!!js` 标签、注释、格式）原样保留，
真机重推实测 desktop/web 均 0 删除行、纯新增 `agent-proxy` 块，并补了 `!!js` 保留回归测试。

### 📊 Change Stats
> 工作区未提交改动（与本任务无关的 agy/codebuddy 改动未计入）。

- **Files changed:** 16（9 修改 + 7 新增，其中 `packages/agy/src/credentials.ts` 为钥匙串回退适配）
- **Insertions:** +1525（新文件）+251（修改）
- **Deletions:** -29

| File | +Added | -Removed |
| --- | ---: | ---: |
| `apps/gateway/src/models-push.ts` | +130 | 新增 |
| `apps/gateway/src/zcode-client-sync.ts` | +259 | 新增 |
| `apps/gateway/src/dsh-client-sync.ts` | +205 | 新增 |
| `test/models-push.test.ts` | +296 | 新增 |
| `test/models-push-zcode.test.ts` | +212 | 新增 |
| `test/models-push-dsh.test.ts` | +208 | 新增 |
| `docs/exec-plans/completed/models-push-clients.md` | +149 | 新增 |
| `packages/agy/src/credentials.ts` | +85 | -15 |
| `apps/gateway/src/cli.ts` | +53 | -6 |
| `test/agy-credentials.test.ts` | +62 | -5 |
| `apps/gateway/README.md` | +39 | 0 |
| `apps/gateway/src/webui.ts` / `test/webui.test.ts` / `bun.lock` / `package.json` / `apps/gateway/package.json` | +12 | -3 |

### 📁 Files Modified
- `apps/gateway/src/cli.ts`、`apps/gateway/src/models-push.ts`（新）、`apps/gateway/src/zcode-client-sync.ts`（新）、`apps/gateway/src/dsh-client-sync.ts`（新）、`apps/gateway/src/webui.ts`
- `packages/agy/src/credentials.ts`（钥匙串回退）
- `apps/gateway/package.json`、`package.json`、`bun.lock`
- `test/models-push{,-zcode,-dsh}.test.ts`（新）、`test/agy-credentials.test.ts`、`test/webui.test.ts`
- `apps/gateway/README.md`、`docs/exec-plans/completed/models-push-clients.md`（新，自 active/ 归档）

### 🔄 设计迭代（同日，用户裁决）
- 数据源收敛为**只推本地 agent 插件模型**（上游/官方模型不推，授权问题）；push 与 upstreamOnly 无关、恒走 `reloadCatalog`（纯本地缓存、零网络）；zcode 插件模型由 zcode 目标自行剔除。
- ZCode 目标从「管理用户 cliproxy provider」改为**受管 `agent-proxy` provider**（与 dsh 同构：自动创建、anthropic-messages、apiKey 占位、连接字段永不回写）。
- 目录来源失败从「中止」降级为「警告后继续」（与 models 无参视图口径一致；清单为空仍中止）。
- **agy 凭据钥匙串回退**：新版 agy CLI 把凭据存 macOS 钥匙串 `gemini/antigravity`（`go-keyring-base64:` + base64 JSON），`loadAgyCredentials`/`agyCredentialsPresent` 在文件缺失时（darwin）回退钥匙串。
- **（同日修订）agy 凭据读取优先级对齐终端 CLI**：钥匙串合法（未过期）令牌优先并完全屏蔽文件；无合法令牌（缺失/损坏/过期）才回落文件（daemon 只刷新文件）；仅有过期钥匙串凭据时原样返回由请求层给过期指引。

### ✅ Verification
- `bun run check` 全绿（boundaries + build + 严格 typecheck + 1172 例测试，含新增 push 17 例与 agy 钥匙串用例）。
- dsh 真机验证：40 个插件模型推送至 desktop/web 的 `agent-proxy` provider（从含上游的 47 收敛），
  备份 `.bak-agent-proxy-*` 生成；`/usr/bin/diff` 确认 0 删除行、纯新增受管块；web 的
  `!!js` 表达式原样保留；幂等重推 "already up to date"；其余 profile patch、
  `.credentials.yaml`、`settings.yaml` 未动。
- zcode 真机验证：受管 `agent-proxy` provider 自动创建，35 个插件模型（含钥匙串恢复后的
  agy 3 个），无上游/zcode 插件模型混入；用户既有 cliproxy provider（rule 26 / models 23）
  字节不动；provider 总数 16→17；幂等重推 +0/-0。
