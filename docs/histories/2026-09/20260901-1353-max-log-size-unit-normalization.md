## [2026-09-01 13:53] | Task: --max-log-size 支持无 B 后缀写法并堵住 bytes 静默误解析

### 🤖 Execution Context
* **Agent ID**: `zcode`
* **Base Model**: `GLM-5.3 (builtin:zai-coding-plan)`
* **Runtime**: `ZCode CLI`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `main`

### 📥 User Query
> 有实现 1M 的转换吗？（随后提供 bytes.js 仓库链接 https://github.com/visionmedia/bytes.js，并询问"可以直接引用这个包使用吗"）

### 🛠 Changes Overview
**Scope:** codex-cliproxy（src/cli.ts、test/gateway.test.ts）

**Key Actions:**
- **[解析]**: `parseMaxLogSize` 增加输入归一化：去数字与单位间空格、给无 `B` 后缀的 `1M/2k/1G/1T/1P` 补 `b`，再交 `bytes.parse` 换算；归一化结果先过严格语法 `/^[+-]?\d+(?:\.\d+)?(b|kb|mb|gb|tb|pb)?$/i`，语法外输入（如 `1MiB`、`1mbb`）直接报错而非进入解析。
- **[验证]**: 解析测试补 `1M=1048576`、`2k=2048`、`1 MB`、`1 G` 与 `1MiB/1mbb` 拒绝断言；help 文本示例加 `1M`。

### 🧠 Design Intent (Why)
* 实测 `bytes.parse` 对无 `B` 后缀输入不报错而是静默返回数字部分：`"1M"`→`1`、`"1MiB"`→`1`、`"1mbb"`→`1`。若直接裸用，`--max-log-size 1M` 会把上限设成 1 字节，网关日志每次写入都触发滚动。对照 [bytes.js README](https://github.com/visionmedia/bytes.js)：官方语法仅 `b/kb/mb/gb/tb/pb`（1024 进制、大小写不敏感、非法返回 null），无 B 后缀与 IEC 形式均不在文档化语法内。
* 处理策略：`1M` 这类常见写法做归一化兼容（用户意图明确），其余语法外输入显式拒绝并给出正确示例——静默失真比报错危险得多。`bytes` 包本身保持直接引用（换算、格式化仍由它完成），包装层只有六行。
* `pb` 一并纳入语法与归一化，与 README 单位清单对齐。

### ⚠️ 已知未决问题
- 无新增。

### 📊 Change Stats
> 数据为工作区相对 HEAD 的累计（含前序未提交任务重叠），本任务净增约 `src/cli.ts` +12/-4、`test/gateway.test.ts` +6/-0。

### 📁 Files Modified
- `src/cli.ts`
- `test/gateway.test.ts`

### ✅ Verification
- `bun run check`：类型检查、103 个测试、单文件构建全部通过。
- 裸用与包装层对照（bun -e 实测）：`"1M"` raw=1 / wrapped=1048576；`"1MiB"`、`"1mbb"` raw=1 / wrapped 抛错；`"512KB"`、`"1 PB"` 两层一致。
