## [2026-09-11 17:53] | Task: 增加 ZCode Anthropic 直通与配置监听缓存

### 🤖 Execution Context
* **Agent ID**: `codex / 01a08fd3-4c95-74d1-b956-70ea03ac78d8`
* **Base Model**: `cliproxy/gpt-6-astra / xhigh（任务指定；子任务继承当前模型，未切换）`
* **Runtime**: `Codex Desktop / Bun 1.3.5`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `HEAD（detached）`
* **Base**: `deac0cdcb77a67276b0cf82b966678e6749ad086`

### 📥 User Query
> 为 Claude Code 增加默认关闭的 /zai Anthropic 入口，精确读取 ZCode 当前 provider，覆盖 Coding Plan、体验套餐和 API Key，两渠道均纳入；保持模型、正文与流式协议。后续明确修订：取消逐请求读取，改为首次读入内存、目录 fs.watch 事件触发 100ms 防抖刷新。不得真实凭证联调、修改用户运行配置或提交发布，保留隔离工作区继承的全部未提交修改。

### 🛠 Changes Overview
**Scope:** 网关、专用授权缓存、运行配置 Schema、模拟测试及文档。

**Key Actions:**
- **独立路由**：在 Codex HTTP/升级路由之前处理 `/zai`，只支持 messages/count_tokens 的 POST；关闭或未知路径返回 Anthropic 结构错误。
- **精确授权**：主 setting 仅在不存在时回退 v2；按渠道和去首个模式前缀的完整 ID 选 provider，只取 options.apiKey/baseURL，不回退账户或读取 OAuth。
- **事件缓存**：启动时先建立目录及祖先监听，再加载首份快照；请求只访问内存，不逐请求 read/stat，不轮询。相关事件立即失效、末次事件后防抖 100ms，共享串行刷新并用版本号丢弃过时结果。
- **失败与恢复**：损坏、删除或无效授权均清空旧快照，修复后按事件恢复；watch 失败则关闭监听并提示重启。目录替换检测 inode 并重建；处理器关闭、网关停止和启动失败都释放资源。
- **凭据边界**：仅环回监听，独立本地 token；请求头白名单并注入上游双认证；官方 HTTPS Anthropic 基址、无 userinfo、不跟重定向、跳过完整 /zai 交换日志。配置文件通过 O_NOFOLLOW 打开，防止符号链接目标更新导致授权缓存陈旧。
- **原样传输**：保留模型、工具、thinking、压缩请求字节与编码；响应流立即返回、取消传播到上游；上游错误保留状态与正文，本地错误不暴露配置或异常原文。
- **配置与说明**：zai.enabled 可选且默认 false，Schema 与默认值同步；README 提供前台、launchd 和 Claude Code 设置，明确未经生产实测及签名限制。

### 🧠 Design Intent (Why)
将授权读取与事件缓存隔离，保持现有 Codex OAuth、模型目录与 realtime 逻辑。配置更新低频而请求高频，目录事件替代重复文件 IO；失效时先阻断旧授权再共享刷新，兼顾账号切换和授权撤销。原样流转发避免正文转换与日志复制影响协议或取消。

### ✅ Validation
- `timeout 60s bun run check`：退出 0，189 项测试通过、0 失败；测试 21.52 秒，类型检查与构建通过。
- 新增 58 项测试：30 项协议/路由、5 项配置、23 项缓存；包含三模式两渠道、400–599 状态遍历、压缩 HTTP、逐块 SSE、工具/thinking、取消与资源释放、文件/目录原子替换、缺失恢复、突发合并和刷新竞态。
- 最终符号链接专项测试再次通过：主/备用 setting 链接拒绝，config 链接导致缓存失效，替换回真实文件后自动恢复。
- 全量测试使用临时 preload：Keychain 固定虚构值，原生 fetch 只允许环回；没有请求生产模型 API。沙箱内监听/事件限制通过获准的原生本地测试解决；临时 bunfig 已移出交付。
- 依赖安装遇到临时目录限制后，核对 lock 完全相同并复用已有本地依赖，没有变更依赖版本或锁文件。
- 独立审查修复空 Connection 头、显式 null URL 缺省回退、Bun 同路径 watcher 复用旧 inode 和配置文件符号链接授权陈旧问题。
- `git diff --check` 通过；所有任务外继承文件逐字节不变，没有新增范围外文件。

### 📊 Change Stats
> 未创建提交。使用任务前 working-tree 快照与交付快照执行 `git diff --no-index --shortstat` / `--numstat`；包含本 history，并迭代到自身统计稳定。继承 dirty diff 不计入本任务。

- **Files changed:** 14
- **Insertions:** +2533
- **Deletions:** -53
- **Shortstat:** `14 files changed, 2533 insertions(+), 53 deletions(-)`

| File | +Added | -Removed |
| --- | ---: | ---: |
| `README.md` | +122 | -0 |
| `docs/exec-plans/completed/zai-anthropic-passthrough.md` | +55 | -0 |
| `docs/exec-plans/completed/zai-config-cache.md` | +73 | -0 |
| `docs/exec-plans/tech-debt-tracker.md` | +1 | -0 |
| `docs/histories/2026-09/20260911-1753-zai-anthropic-passthrough.md` | +82 | -0 |
| `schemas/gateway-config.schema.json` | +14 | -0 |
| `src/cli.ts` | +1 | -0 |
| `src/gateway.ts` | +75 | -53 |
| `src/types.ts` | +2 | -0 |
| `src/zai-config.ts` | +194 | -0 |
| `src/zai.ts` | +271 | -0 |
| `test/zai-cache.test.ts` | +648 | -0 |
| `test/zai-config.test.ts` | +117 | -0 |
| `test/zai.test.ts` | +878 | -0 |

### 📁 Files Modified
- `README.md`
- `docs/exec-plans/completed/zai-anthropic-passthrough.md`
- `docs/exec-plans/completed/zai-config-cache.md`
- `docs/exec-plans/tech-debt-tracker.md`
- `docs/histories/2026-09/20260911-1753-zai-anthropic-passthrough.md`
- `schemas/gateway-config.schema.json`
- `src/cli.ts`
- `src/gateway.ts`
- `src/types.ts`
- `src/zai-config.ts`
- `src/zai.ts`
- `test/zai-cache.test.ts`
- `test/zai-config.test.ts`
- `test/zai.test.ts`

### ⚠️ Remaining Limits
- 三种模式及两个渠道均未生产实测；未实现 ZCode 条件签名、握手、PoW 或体验 JWT 自动刷新；messages/count_tokens 的权限和兼容性仍由上游决定。
- 401/403 原样返回，不统一归因于签名。三个授权配置文件不支持符号链接；监听基础设施失效需要重启网关。
- 后续验证已进入技术债。全部更改未暂存、未提交、未推送，未创建 PR，也未改用户系统、ZCode 或 Claude Code 运行配置。
