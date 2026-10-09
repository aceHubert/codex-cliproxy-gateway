# 五客户端指纹数据（fingerprint-data）取值依据与更新记录

各适配器模块各自维护自己的指纹数据文件，JSON 只存纯数据（版本、UA 模板、产品身份、内置提示词），
**取值依据（source）、差异与未决项（notes）和更新方法统一记录在本文件**；客户端发版轮换时按本文
「更新方法」重新取值并更新 JSON，同时在下表「更新记录」登记一行。

| 适配器 | 数据文件 | 运行时消费点 |
| --- | --- | --- |
| zcode | `src/zcode/fingerprint-data.json` | `request-context.ts`（来源头）+ `index.ts` 的 `catalog()`（目录条目 `base_instructions`） |
| codebuddy | `src/codebuddy/fingerprint-data.json` | `request-context.ts`（版本常量）+ `index.ts` 的 `catalog()`（仅 `codebuddy/*` 条目） |
| qoder | `src/qoder/fingerprint-data.json` | `transport.ts`（协议版本、client profiles）+ `index.ts` 的 `catalog()`（目录条目） |
| agy | `src/agy/fingerprint-data.json` | `transport.ts`（UA 版本与 changelist）+ `index.ts` 的 `catalog()`（目录条目） |
| opencode-zen | `src/opencode-zen/fingerprint-data.json` | `user-agent.ts`（UA 三段，运行时按 npm dist-tags 刷新）+ `index.ts` 的 `catalog()`（目录条目 `base_instructions`）+ 转发路 `injectZenFingerprintBody`（门禁模板注入） |

与本机安装强相关的值（ZCode.app 版本）仍在运行时动态读取，JSON 中的 `appVersion` 只是分析快照。

## base_instructions 接线（系统提示词下发方式）

Codex 发系统提示词的依据是模型目录条目的 `base_instructions` 字段（真实 Codex catalog 快照
`models/codex_client_models.json` 中每个条目都带 17–21K 字符的官方提示词；网关合成条目原本是
空串，Codex 因此回退客户端内置默认提示词）。五个适配器的 `catalog()` facade 现在把该字段
**直接替换**为各自的 `agentSystemPrompt`：Codex 从 `/v1/models?client_version=…` 或
`config.toml` 的 `model_catalog_json` 缓存文件读到条目后，按官方客户端提示词发送。OpenCode Zen
同时保留转发路的门禁模板注入：客户端送来的首条 system 已完整包含待注入模板时（目录下发即如此），
`injectZenFingerprintBody` 不再重复注入，避免同一段提示词出现两遍。
codebuddy 适配器的 `workbuddy/*` 条目**沿用同一份 CodeBuddy 主提示词**（本机无 WorkBuddy IDE
与其产品配置；未做 `CODEBUDDY_BRAND_NAME` 品牌名替换——真实 WorkBuddy 客户端是把同一模板的
CodeBuddy 字样全局替换成 WorkBuddy，盲目替换会连同文档 URL 一起改错，需拿到 WorkBuddy 产品
配置后再按原样替换，见技术债）。

## 模板变量剥离方法（codebuddy Jinja / agy Go template 通用）

官方提示词常以模板形式内嵌（codebuddy 在 `product.json`、agy 在二进制里），带条件与变量指令，
不能原样下发。剥离规则（下次更新沿用同一方法）：

1. **if/else 条件块**：保留 `else`（默认）分支文本，删除 `if` 分支与指令本身。
2. **无 else 守卫块**：条件默认成立的（如 `not outputStyle`）删指令留内容；默认不成立的
   （如 `cliDescription`/`cliDocsDir`/`isWsl`/`additionalDirs`/`language`/`briefMode`/
   `outputStyle`/`platform == "win32"`/`modelSupportsImages === false`/agy 的 `.IsAutonomous`）整块删除。
3. **for 循环**（列表为空，如 `additionalDirs`）整块删除。
4. **裸变量引用**（`{{workDir}}`/`{{platform}}`/`{{version}}`/`{{modelName}}` 等）删除 token；
   所在行只剩标签（`Working directory:`）或连接性骨架（`You are powered by the model named . The exact model ID is .`）
   的整行删除；由此变空的 XML 式容器（`<codebuddy_background_info>`/`<response_language>`）连标签删除。
5. 连续空行压成一个，去首尾空白；产物中不得残留 `{{`/`{%`（测试断言）。

## zcode

- **source**：ZCode.app 3.14.5（`/Applications/ZCode.app/Contents/Info.plist`）+ 本机会话请求日志
  `~/.zcode/cli/rollout/model-io-*.jsonl`（179 条真实请求：agent 177 / 标题生成 1 / 网页搜索 1）。
- **notes**：
  - 内置提示词取自真实请求的首条 system 文本，agent 身份行 177/179 一致；其余 system 块是工作区
    `AGENTS.md` 等用户内容，不属客户端指纹，不入 JSON。
  - 3.14.5 真实流量 UA 为 `ZCode/3.14.5`，**已无 `ai-sdk/anthropic` 后缀**——此结论了结
    `zcode-3.12.3-compat` 执行计划待办④（原判「待抓真实流量后决定更新或移除」）。
    `x-zcode-agent=glm` 与 `x-zcode-app-version` 经实流确认仍在，保留。
  - 真实 `X-Title` 为 `Z Code@electron`；网关沿用 `Z Code@cli` flavor（headless 代理自报 CLI 形态），
    该组合未经 zcode.z.ai 真实请求回归。
  - `appVersion` 为分析快照，运行时仍动态读本机 Info.plist，未知时 UA 段为 `unknown` 且跳过签名。
- **更新方法**：升级 ZCode.app 后抽查 `~/.zcode/cli/rollout/model-io-*.jsonl` 最新请求的
  `user-agent` / `x-title` / `x-zcode-agent` 与首条 system 文本，同步改 JSON 的
  `userAgentTemplate`（保留 `{version}` 占位符）、`title`、`agent` 与三个提示词字段。

## codebuddy

- **source**：`@tencent-ai/codebuddy-code` 2.157.0（npm 全局安装包 `package.json` 取版本；
  内置提示词取自同包 `product.json` 的 `prompts` 数组——PromptManager 的模板表，共 123 个模板，
  product commit `844f9f7b`）。
- **notes**：
  - CLI 版本已按本机安装包校准（原硬编码 2.151.0）。WorkBuddy IDE 本机未安装，
    `workbuddyVersion`/`workbuddyCliVersion` 沿用历史抓包值，待安装后复核；`workbuddy/*` 目录
    条目的 `base_instructions` 按用户决策直接沿用 CodeBuddy 主提示词（未做品牌名替换）。
  - 品牌名可经 `CODEBUDDY_BRAND_NAME` 环境变量覆盖（默认 `WorkBuddy`），UA 中的产品名随之替换。
  - **主系统提示词是 `product.json` 里的 `cli-agent-prompt` 模板**（原 19,627 字符 Jinja）：
    product.json 的 `agents` 段显示 `cli` 与 `general-purpose` 两个代理的 `instructions` 都指向它，
    经 `promptRenderer.render()` 渲染后作为 system 下发。`agentSystemPromptBase` 是 24 字符身份行
    `base-agent-instructions`；`titleSystemPrompt` 是 `terminal-title-generator-instructions`。
    JS bundle 里只有模式覆盖段（`# Code Mode` / `# Minimal Code Mode` 等 `appendInstructions`）与
    子代理提示词，主模板不在 bundle——这是初版曾误判「无静态字面量」的原因，实际在 product.json。
  - **三个模板均已按上文「模板变量剥离方法」去掉变量指令**：`agentSystemPrompt` 19,627 → 12,223
    字符（保留 else 默认分支、删运行值行与空容器），`titleSystemPrompt` 1,922 → 1,857 字符。
  - 提示词随 product 配置下发（`productManager.configuration.prompts`，可被
    `ACC_PRODUCT_CONFIG_PATH` 等环境变量指向的配置覆盖），客户端升级或服务端调配都可能轮换。
- **更新方法**：`npm ls -g @tencent-ai/codebuddy-code` 取新版本改 `cliVersion`（目录缓存键
  `catalogRevision` 同源，会自动换键）；同步从新包 `product.json` 的 `prompts` 数组重新提取
  `cli-agent-prompt` / `base-agent-instructions` / `terminal-title-generator-instructions`
  三个模板（模板增删改名时按 `agents` 段的 `instructions` 引用核对），并按上文「模板变量剥离方法」
  去掉变量指令后写入；本机安装 WorkBuddy IDE 后复核另两个版本与其产品配置下的提示词。

## qoder

- **source**：`qodercli-1.1.65`（`~/.qoder/bin/qodercli/qodercli-1.1.65`，commit `a0fb135`）
  二进制常量表与内嵌提示词提取。
- **notes**：
  - cli profile 与二进制身份常量一致：`client_type=5`、`business_product=cli`、
    `session_type=qodercli`；`business_type=agent`、`scene=assistant`。
  - CLI 内置提示词以 `# Explanatory Style Active` 段头结尾，段体运行时注入，JSON 保存模板原文。
  - desktop profile 沿用实测 COSY 签名可接受的 `app/10/app`；二进制中 IDE 真实身份为
    `client_type=6`、`business_product=qoder_work`、`session_type=qoder_work`（配套桌面提示词
    `desktopAgentSystemPrompt` 已一并提取），待桌面凭据实流验证后切换。
  - 端点（国际版 `api2.qoder.sh` / 国内版 `gateway.qoder.com.cn`）不在本数据文件内，见
    `src/qoder/transport.ts` 的 `QODER_REGIONS`。
- **更新方法**：`qoder --version` 或 `~/.qoder/bin/qodercli/version.txt` 取新版本改 `version`
  与 `commit`；身份常量变化时按二进制 `Rt()` 函数（`client_type`/`business_product`/
  `business_type`/`scene` 四元组）重新提取并同步 `profiles`。

## agy

- **source**：`~/.local/bin/agy` 1.3.1（`go version -m`：`go1.28-20260921-RC02 cl/985595000`）
  内嵌提示词提取；UA 格式源自 2026-10-06 MITM 抓包。
- **notes**：
  - `agentSystemPrompt` 原为 Go text/template 原文（含 `{{if .IsAutonomous}}` 等指令），已按上文
    「模板变量剥离方法」处理：627 → 454 字符（inline if/else 保留 else 的「pair programming with」、
    autonomous 守卫块整块删除）。`agentSystemPromptVariant` 是另一处短身份行（无变量，原样保留）。
  - 版本与 changelist **必须成对更新**：本次按同一构建取 1.3.1 / cl=985595000，替换 2026-10-06
    抓包的 1.2.17 / cl=993434119；只改其一会出现跨构建的无效组合。
  - UA 格式 `antigravity/cli/<ver> (aidev_client; os_type=…; arch=…; cl=…; auth_method=consumer)`
    经抓包固定，`os_type`/`arch` 按运行平台动态生成。
- **更新方法**：`agy --version` 取新版本号，`go version -m $(which agy)` 取同构建的 `cl/` 段，
  成对写入 `version` 与 `changelist`；提示词变化时按二进制内嵌原文重新提取三个字段，并按上文
  「模板变量剥离方法」去掉变量指令后写入。

## opencode-zen

- **source**：官方 GA 客户端 `@opencode/cli` 2.0.26（`latest` 标签，bin 为 opencode2）。
  UA 三段取自该包 darwin-arm64 平台二进制内嵌字面量 `--user-agent=opencode/latest/2.0.26/cli`；
  agent/标题模板取自 `@opencode/core` 2.0.26 的 `dist/chunks`（`src/session/runner/prompt/system.txt`
  与 `PROMPT_TITLE` 常量）；工具定义沿用 2026-10-08 抓包值。
- **notes**：
  - **GA 换过发布线**：beta 线 `@opencode-ai/cli` 停在 0.0.0-beta-19271，GA 线 `@opencode/cli` 的
    `latest` 是 2.0.26——只按旧包查"新版本"永远查不到。UA 形状未变
    （`opencode/<channel>/<version>/<clientName>`），渠道段由 `beta` 变 `latest`；`user-agent.ts`
    运行时按 dist-tags 刷新版本，渠道段取「预发布段优先，否则取标签名」，跨渠道不采信。
  - agent 模板是**渲染产物**：`system.txt` 含 `${OPENCODE_TOOL_GUIDANCE}` 插槽，按在场工具
    （shell/write/edit）注入指引行后才是客户端实际发送的文本；JSON 存渲染后版本。GA 模板
    1,474 字符，远短于 beta 快照的 17,717 字符（beta 把工具指引写在模板正文里）。
  - `titleSystemPrompt` 与 beta 快照逐字节相同；`tools` 沿用旧值——GA 的 `edit` 描述逐字节相同，
    门禁只看官方工具名在场，实测通过。GA 的工具 schema 是运行时由 Effect schema 转的 JSON
    Schema，未随包发布，要严格对齐需再抓一次真实请求体。
  - GA 标头集新增 `x-opencode-session-id`/`X-Session-Id`/`x-opencode-parent-session-id`，网关未跟随
    （现有标头集实测仍过门禁）；W3C 追踪头实测当前非必需，保留无碍。
- **更新方法（两条路）**：
  1. **包内提取（首选，不必运行客户端）**：`curl https://registry.npmjs.org/-/package/@opencode/cli/dist-tags`
     取 `latest` 版本号 → 从 `@opencode/core@<ver>` 的 `dist/chunks` 找 `src/session/runner/prompt/system.txt`
     与 `PROMPT_TITLE`（`grep -rl 'You are a title generator'`）→ 取
     `@opencode/cli-<platform>-<arch>@<ver>` 平台二进制（本机 darwin-arm64 约 81MB tgz），
     `grep -a 'user-agent=opencode/'` 读 UA 三段的真实字面量。取值后必须用真实上游探针验证：
     无工具走标题模板、带工具走 agent 模板 + 官方工具名，两条都要 200。
  2. **mitm 抓包（回退，需能运行客户端）**：`HTTPS_PROXY` 指向 mitmdump 并让运行时信任自签 CA
     （`NODE_EXTRA_CA_CERTS=~/.mitmproxy/mitmproxy-ca-cert.pem`），跑一次 zen 免费模型请求即可读到
     真实标头与请求体。GA 客户端在隔离 HOME 下内部 server 可能起不来（2026-10-09 未走通），此时用方法 1。

## 更新记录

| 日期 | 客户端 | 变更 |
| --- | --- | --- |
| 2026-10-09 | 全部 | 初版：四客户端指纹数据拆分到各自模块，source/notes 收敛至本文件 |
| 2026-10-09 | zcode | UA 去掉 `ai-sdk/anthropic/3.0.81` 后缀（3.14.5 实流已无）；校准 appVersion 3.14.5；补 agent/标题/网页搜索三个内置提示词 |
| 2026-10-09 | codebuddy | CLI 版本 2.151.0 → 2.157.0（本机安装包）；主提示词从 product.json prompts 表提取（cli-agent-prompt 19,627 字符 + 身份行 + 标题生成器），纠正初版「无静态字面量」误判 |
| 2026-10-09 | qoder | 校准 1.1.65 / a0fb135；补 CLI 与桌面两套内置提示词 |
| 2026-10-09 | agy | 版本与 changelist 成对更新 1.2.17/993434119 → 1.3.1/985595000；补 agent 模板、短身份行、标题提示词 |
| 2026-10-09 | 全部 | codebuddy/agy 提示词按「模板变量剥离方法」去变量（12,223 / 454 字符）；四个适配器 `catalog()` 把目录条目 `base_instructions` 直接替换为各自官方提示词，Codex 据此发送系统提示词；workbuddy/* 按用户决策沿用 CodeBuddy 提示词（未做品牌名替换） |
| 2026-10-09 | opencode-zen | 同步 GA：发布线 `@opencode-ai/cli@beta` → `@opencode/cli@latest`（2.0.26），UA 三段改 `opencode/latest/2.0.26/cli`；agent 模板换 GA 渲染版（17,717 → 1,474 字符），标题模板与工具集不变；本文件补「包内提取」取值方法 |
| 2026-10-09 | opencode-zen | 目录条目 `base_instructions` 直接替换为官方 agent 提示词（与其它适配器一致），转发路对「已含模板」的 system 不再重复注入 |
