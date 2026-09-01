## [2026-09-01 14:47] | Task: 滚动改 copy-truncate，修复 stderr 活跃文件被 rename 走的问题

### 🤖 Execution Context
* **Agent ID**: `zcode`
* **Base Model**: `GLM-5.3 (builtin:zai-coding-plan)`
* **Runtime**: `ZCode CLI`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `main`

### 📥 User Query
> 继续读一下 claude 会话，还有一个 gateway.error.log 的写入问题。

经 catchup 恢复同一 Claude 会话（3a7a9b1a）条目 45-52 的三审结论：上轮 5 条中 4 条修净，但第 1 条（cap 扩展到 `gateway.error.log`）的 rename 修法引入更严重的问题。

### 🛠 Changes Overview
**Scope:** codex-cliproxy（src/request-log.ts、src/cli.ts、src/types.ts、schemas、test、README）

**Key Actions:**
- **[滚动机制]**: `capGatewayLog` 由 `renameSync` 改为 **copy-truncate**：`copyFileSync` 备份 + `truncateSync(0)` 原地清空。inode 不变，launchd 在 spawn 时打开、之后不重开的 stdout/stderr fd 继续有效，O_APPEND 追加不产生空洞。stdout/stderr 两个文件统一走该路径——stdout 走 rename 的安全性依赖"运行期不写 stdout"这个脆弱前提（将来谁加一行 console.log 即破），copy-truncate 对两者都正确。
- **[注释/文档]**: `capGatewayLog` 注释重写（解释为何不能用 rename：`index.ts` 错误 handler 常驻、运行期持续写 stderr，rename 后活跃文件消失、写入全部落进备份，裁剪甚至可能删掉运行中进程正在写的备份→写已 unlink 的 inode）；`GATEWAY_LOG_BACKUPS` 注释修正磁盘上限为 2 × (N+1) × maxBytes（两文件共用上限，复审指出原 6× 说法不实）；help/schema/types/README 同步 copy-truncate 语义与 per-file 备份保留；README 删去"since runtime errors are appended by launchd"这个不成立的理由，改为说明 inode 稳定才是运行中进程能继续追加的原因。
- **[测试]**: 存量两处"gateway.log 被移走"断言改为"原文件存在且 size=0"；新增 `capGatewayLog truncates in place so open fds keep writing the live log`——测试进程内以 O_APPEND 持有 fd 模拟 launchd，断言滚动后该 fd 的写入落在活跃文件、滚动前内容完整进备份。**双向验证**：临时还原 rename 实现该用例如预期失败（活跃文件消失），恢复 copy-truncate 后通过。

### 🧠 Design Intent (Why)
* rename 与 copy-truncate 的差别只在"另一个持有者持有活跃文件 fd"时显现：stderr 的错误 handler 常驻（进程接管错误后继续服务），Claude 用真实子进程 + O_APPEND 实证滚动后 gateway.error.log 消失、后续错误全进备份、上限彻底失效。copy-truncate 是 logrotate 对无法重开 fd 的写入方的标准解法；复制 O(文件大小) 的代价在"每进程至多一次"的滚动频率下可忽略。
* fd 持有用例最初尝试子进程方案（`Bun.spawn` + `-e` 脚本/fixture 文件），被 Mimosa PreToolUse 钩子以命令注入风险三次拦截；改为进程内 `fs.openSync(path, "a")` 持有 fd——fd 对 rename/truncate 的跟随行为与持有进程无关，锁的是同一属性，且无注入面。
* 复审提到的 14 位旧备份永不裁剪为理论隐患（本机无遗留、特性未发布），未做兼容处理。

### ⚠️ 已知未决问题
- 无新增。models.json `input_modalities` 疑似误删与 `gpt-5.6-sol` 排序无守卫仍待用户决策；`.gitignore` 末尾缺换行。

### 📊 Change Stats
> 数据为工作区相对 HEAD 累计（含前序未提交任务重叠）；本任务净增约 `src/request-log.ts` +14/-8、`test/gateway.test.ts` +38/-6、help/schema/types/README 描述改写。`models.json`、`.gitignore` 为无关改动，未计入。

### 📁 Files Modified
- `src/request-log.ts`
- `src/cli.ts`
- `src/types.ts`
- `schemas/gateway-config.schema.json`
- `test/gateway.test.ts`
- `README.md`

### ✅ Verification
- `bun run check`：类型检查、106 个测试（+1）、单文件构建全部通过；`python3 -m json.tool` 校验 schema 合法。
- 双向验证：rename 实现下 `open fds keep writing` 用例失败（active 文件消失），copy-truncate 下通过。
