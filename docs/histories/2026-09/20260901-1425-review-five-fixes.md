## [2026-09-01 14:25] | Task: 修复复审的 5 点问题

### 🤖 Execution Context
* **Agent ID**: `zcode`
* **Base Model**: `GLM-5.3 (builtin:zai-coding-plan)`
* **Runtime**: `ZCode CLI`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `main`

### 📥 User Query
> （经 catchup 恢复 Claude 会话 3a7a9b1a 的复审结论后）对审核的 5 点做一个结论给出修复步骤 → 修改上面的 5 点。

复审 5 点（均经本人在当前工作区核实成立）：
1. cap 只作用于 `gateway.log`，增长更快的 `gateway.error.log`（stderr）不受约束；
2. 秒级 `fileStamp()` + `renameSync` 静默覆盖，同秒两次滚动丢备份；
3. `pruneGatewayLogBackups` 正则写死 `/^gateway-\d{14}\.log$/`，与按 basename 派生的备份名不符，非默认文件的裁剪静默失效；
4. 设 cap 即约束 gateway.log 中审计的可追溯深度，取舍未在文档点明；
5. `serve()` 用固定 `paths.stdoutLog`，`--config` 临时实例会触碰生产日志。

### 🛠 Changes Overview
**Scope:** codex-cliproxy（src/request-log.ts、src/cli.ts、src/types.ts、schemas、test、README）

**Key Actions:**
- **[#3]**: `pruneGatewayLogBackups(dir, base)` 改为接收目标文件基名，正则由 `base` 转义派生（`^<base>-\d{17}\.log$`），`gateway.error-` 前缀的备份照常裁剪。
- **[#2]**: 备份时间戳改毫秒精度（新增 `gatewayBackupStamp` = `fileStamp` + 3 位毫秒，17 位数字），连续两次滚动不再命中同名备份；定宽 17 位保证字典序仍为时间序。特性未发布、无旧格式备份需要兼容。滚动是每进程至多一次的低频操作，毫秒精度足以消除碰撞（进程启动远慢于 1ms）。
- **[#1+#5]**: `serve()` 的收敛改为 `configPath === paths.gatewayConfig` 时对 `paths.stdoutLog` 与 `paths.stderrLog` 各执行一次 `capGatewayLog`——error.log 在每次网关启动时收敛一次（运行中错误由 launchd 追加，留待下次启动），`--config` 临时实例完全跳过、不再触碰生产文件。
- **[#4]**: help、README、schema、types 四处描述同步：cap 覆盖 `gateway.log` 与 `gateway.error.log`（后者每次启动检查一次），且同时约束 gateway.log 中配置审计的可追溯深度，需要完整追溯保持 `0`。
- **[测试]**: 存量两处 `\d{14}` 断言与 14 位种子更新为 17 位；新增 `capGatewayLog prunes gateway.error.log backups by the derived file name`（7 旧备份 + 1 次滚动 → 裁到 5 个，钉住 #1/#3）与 `consecutive capGatewayLog rotations do not overwrite each other's backups`（连续两次滚动两份备份内容俱在，钉住 #2）。#5 的守卫是单行条件判断且 `serve` 不在单测可达路径（需真实 `Bun.serve`），以代码检视覆盖，未加测试。

### 🧠 Design Intent (Why)
* #3 是 #1 的前置：先让裁剪按文件名派生，再把 error.log 纳入收敛，否则其备份只增不减。#2 与 #3 都属"通用签名与写死实现不符"一类坑，修复均落在实现与签名对齐，而不是收窄签名。
* #4 属设计取舍而非缺陷：审计并入 gateway.log 是用户明确要求的方向，cap 与完整追溯互为代价，用文档把边界说清。
* 毫秒备份名未加 existsSync 递增兜底：调用点（每次 CLI 进程一次、serve 每进程一次）决定了同毫秒碰撞不可达，不为不可达路径增加正则与命名的复杂度。

### ⚠️ 已知未决问题
- 无新增。复审遗留的 models.json 三处 `input_modalities: ["text"]` 疑似误删（上游默认 `['text','image']`，override 是唯一钉住纯文本处，`plugins/vision-reader` 依赖该字段）与 `gpt-5.6-sol` 排序无守卫，仍待用户决策后单独处理。

### 📊 Change Stats
> 数据来自 `git diff --numstat`（工作区相对 HEAD，含前序未提交任务重叠）；本任务净增约 `src/request-log.ts` +18/-8、`src/cli.ts` +12/-6、`test/gateway.test.ts` +60/-8、schema/types/README 描述改写。`models.json` 与 `.gitignore`（新增 `.mimosa/` 忽略项，非本任务所为）为无关改动，未计入。

### 📁 Files Modified
- `src/request-log.ts`
- `src/cli.ts`
- `src/types.ts`
- `schemas/gateway-config.schema.json`
- `test/gateway.test.ts`
- `README.md`

### ✅ Verification
- `bun run check`：类型检查、105 个测试（+2）、单文件构建全部通过；`python3 -m json.tool` 校验 schema 合法。
- `capGatewayLog prunes gateway.error.log...` 用例在旧实现（写死前缀）下必然失败：7 个 `gateway.error-` 备份一个不删、数量断言 5 不成立。
