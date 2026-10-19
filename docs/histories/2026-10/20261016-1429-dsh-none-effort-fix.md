## [2026-10-16 14:29] | Task: 修复 models --push 写入 dsh 的 none 档位导致自定义模型消失

### 🤖 Execution Context
* **Agent ID**: `zcode`
* **Base Model**: `GLM-5.3 (account:zai-individual-coding-plan)`
* **Runtime**: `ZCode CLI`
* **Git User**: `hubert`
* **Branch**: `feat/model-catalog-push`

### 📥 User Query
> sess_528204a2… 模型同步把 dsh 搞坏了，不支持 none …… none 换成 off 就可以了 …… zcode 先不修改，
> 验收后再修改

### 🛠 Changes Overview
**Scope:** apps/gateway/src/dsh-client-sync.ts、test、docs；本机 dsh 配置急救

**Key Actions:**
- **[根因]**: zen 目录的 `none`（无推理）档位被 `synthesizeDshModel` 原样写入
  `reasoningEfforts` 的键；dsh schema 只认 `off/minimal/low/medium/high/xhigh/max`，
  未知键使整个 `llm-pi-ai` 插件校验失败 → dsh 全部自定义模型消失
  （startup 日志 ValidationError：`opencode-zen/nemotron-3.5-super-vl-free`）。
- **[修复]**: 新增 `dshReasoningEfforts` 归一——`none` → `off` 键（值保留 `none` 发给上游，
  zen 上游本就接受该 effort 值）；白名单外键丢弃，全滤空则省略 `reasoningEfforts`。
- **[zcode 侧]**: 用户裁决先不修改、验收后再评估（variants 暂不做 `none` 过滤）。
- **[本机急救]**: desktop `cordis.patch.yml:677` 的 `none: none` → `off: none`
  （备份 `bak-reasonoff-*`）；web 侧由并行会话先修（同形态）。

### 🧠 Design Intent (Why)

推送合成的档位键必须落在目标工具的 schema 白名单内——dsh 对整个 provider 聚合插件做
整体校验，一个非法键就会让全部自定义 provider 失效。`none` 与 dsh 的 `off` 语义等价
（不发送/关闭推理参数），映射而非丢弃可保留 zen 模型的「无推理」可选项。

### 📊 Change Stats
> 工作区未提交改动（含前序推送任务线；本任务净增约 +45/-3）。

- **Files changed:** 3（源码 1 + 测试 1 + 文档 1，另本机 dsh 配置急救）

| File | 变更 |
| --- | --- |
| `apps/gateway/src/dsh-client-sync.ts` | +`dshReasoningEfforts` 白名单归一（none→off） |
| `test/models-push-dsh.test.ts` | +档位归一回归断言 3 组 |
| `docs/exec-plans/completed/models-push-clients.md` | +事故修复小节（含 zcode 待验收决策） |

### 📁 Files Modified
- `apps/gateway/src/dsh-client-sync.ts`、`test/models-push-dsh.test.ts`、
  `docs/exec-plans/completed/models-push-clients.md`
- 本机：`~/.dsh/profiles/{desktop,web}/cordis.patch.yml`（`none: none` → `off: none`）

### ✅ Verification
- `bun run check` 1180 例全绿（含新增档位归一断言：none→off、白名单外丢弃、全滤空省略）。
- 本机两份 patch `grep -c "none: none"` 均为 0；修复后 dsh 桌面版已由用户重启，
  最新 startup 日志零 ValidationError，自定义模型恢复。
- 3080 端口确认为 dsh 自身 web 服务（非残留进程），未做清理。

### 🔁 同日追加：dsh credential 机制定案（14:43）
- 用户实测反馈 `apiKeyEnv` 指向无值 ref 时 dsh 以 `MISSING_CREDENTIAL` 拒绝调用；
  经 dsh 源码核实其取值分层（进程 env > `~/.dsh/.credentials.yaml` refs > .env 回退），
  且省略该字段的 keyless 路由在 OpenAI 兼容协议层同样被拒。
- 定案：受管 provider 恢复 `apiKeyEnv: AGENT_PROXY_API_KEY`（用户已经 dsh Models
  页面把值存入 credentials service）；源码、本机两份 patch、测试断言同步恢复；
  「EMPTY 字面值」「省略字段」两条路均证伪回退。zcode 侧保持字面 `apiKey: "EMPTY"`。
- `bun run check` 1180 例全绿。

### 🔁 同日追加二：credential ref 幂等补充（14:5x）
- 用户裁决最终形态：`.credentials.yaml` 有 `AGENT_PROXY_API_KEY` 就不动（无论值），
  缺失则补 `EMPTY`；`ensureDshApiKeyRef` 落实（文档级往返、新文件 atomicWrite 无备份、
  已有 ref 不触碰），补 3 场景测试（已有不动 / 缺失补写 / 新建最小文件）。
- 释疑：`AGENT_PROXY_API_KEY` 名字来自工具写入的 `apiKeyEnv` 声明，dsh Models 页按
  声明名写值，非 dsh 自动生成。
- `bun run check` 1181 例全绿；本机 ref 已存在，按规则未修改。
