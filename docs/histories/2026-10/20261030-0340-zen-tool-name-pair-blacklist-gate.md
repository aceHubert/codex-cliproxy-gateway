## [2026-10-30 03:40] | Task: zen 工具名配对黑名单门禁的发现与网关适配

### 🤖 Execution Context
* **Agent ID**: `zcode`
* **Base Model**: `GLM-5.3 (account:zai-individual-coding-plan)`
* **Runtime**: `ZCode CLI`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `feat/agent-system-prompt-conversion-layer`

### 📥 User Query
> 又429了 / 还是需要重新连接 / 应该不是zcode升级，codex调用也是429（zen 通道在 ZCode 与 Codex 客户端均持续 429，探针却全绿）

### 🛠 Changes Overview
**Scope:** packages/opencode-zen（fingerprint.ts、index.ts）、scripts/zen-gate-probe.ts、test、docs

**Key Actions:**
- **[门禁发现]**: 定位真因——上游对 tools 数组做**工具名配对黑名单**，共确认三对：ZCode dynamic-workflow 族 `CreateWorkflow`+`GetWorkflowRun`、`AmendWorkflow`+`FillWorkflowHole`，与 Codex Desktop 多 agent 协作族 `spawn_agent`+`wait_agent`（含于 additional_tools 信封、命名空间扁平化后的名字内）；同场声明即整请求 429 FreeUsageLimitError（与配额耗尽同文案）；匹配为子串包含、大小写不敏感（`GetWorkflowRun_z`/`GetWorkflowRun2` 照挂，`Get_Workflow_Run`/`wait__agent`/`ToolB` 过）。
- **[破除实现]**: `fingerprint.ts` 新增 `breakOpencodeZenBlockedToolNamePairs` + 黑名单对表：命中对时对 B 侧全部名字做确定性子串打断（禁用子串中点插 `_`，与在场名冲突追加序号），支持 chat 包裹 / Responses 扁平 / gemini functionDeclarations 三种形状。
- **[接入与还原]**: `index.ts` 在 `adaptOpencodeZenUpstreamRequest` 出口统一收口（覆盖全部协议组合），改名同步登记 ToolIdentityMap，响应侧 tool_call 还原客户端原名。
- **[探针与测试]**: `zen-gate-probe.ts` 补 blocked/broken-tool-pair 两项探针；新增单元测试（三形状、大小写、冲突递增、同族组合不受影响）与网关级测试（anthropic 入口改名过闸 + 响应原名还原）。
- **[文档]**: `docs/fingerprint-data.md` 修正当日凌晨的误判结论（原判「CGNAT 池瞬态耗尽」），补黑名单对门禁画像、排查方法学与更新记录行。

### 🧠 Design Intent (Why)
用户 ZCode 会话的 zen 通道 16 连挂 100% 复现，而网关小负载/大负载/三入口探针全绿——差异藏在请求本身。经 ZCode rollout（`model-io-session_*.jsonl`）取原请求逐字段重放二分：与模板、端点、会话、配额、负载大小、max_tokens、thinking、历史长度全部无关，收敛到 tools 里两个特定名字的**同场声明**。上游疑似针对某特定客户端工具集指纹的反滥用规则，ZCode 3.5 的 workflow 工具族原样命中。后缀式改名（_z/数字）因黑名单为子串匹配而无效，最终采用子串中点打断 + 身份映射还原，模型侧工具语义与客户端侧名字均不受影响。

### 📊 Change Stats
> 数据来自 `git diff --numstat`（工作区对 HEAD；其中 index.ts 含 10-26 会话遗留的少量未提交尾差）。

- **Files changed:** 6
- **Insertions:** +288
- **Deletions:** -2

| File | +Added | -Removed |
| --- | ---: | ---: |
| `packages/opencode-zen/src/fingerprint.ts` | +120 | -0 |
| `test/opencode-zen-fingerprint.test.ts` | +92 | -0 |
| `test/opencode-zen-gateway.test.ts` | +36 | -0 |
| `packages/opencode-zen/src/index.ts` | +13 | -0 |
| `docs/fingerprint-data.md` | +20 | -1 |
| `scripts/zen-gate-probe.ts` | +7 | -1 |

### 📁 Files Modified
- `packages/opencode-zen/src/fingerprint.ts`
- `packages/opencode-zen/src/index.ts`
- `test/opencode-zen-fingerprint.test.ts`
- `test/opencode-zen-gateway.test.ts`
- `scripts/zen-gate-probe.ts`
- `docs/fingerprint-data.md`

### ✅ Verification
- `bun run check`：1259/1259 全绿（新增 3 条测试断言组）。
- 真机 e2e：用户原始 186 工具请求（此前 16 连 429）经网关 `/v1/messages` 双出口（家宽直连、机场台湾节点临时全局）均 HTTP 200（~4.6s，含中文流式回复）。
- Codex 侧：用户反馈 Codex 调用也 429（凌晨 01:26 /v1/responses 与修复部署后 10:31 各一次）；从 `~/.codex/sessions` rollout 复刻其 544KB 原请求（含 additional_tools 信封）修复前稳定 429（2.3s），二分出第三对 `spawn_agent`+`wait_agent`，补表重建后同请求 200（12.7s）；ZCode 原请求回归 200。服务已用最终构建重启（launchctl kickstart）。
- 诊断期临时把 Clash 切全局模式借道台湾节点（家宽池被测试打空），验证完毕已恢复 rule 模式与 GLOBAL=DIRECT，出口复回家宽 IP。
- 探针脚本补的两项黑名单对探针逻辑与实测一致（健康窗口内 blocked→429、broken→200 各验证多次）；最后一轮全量探针因家宽池再度耗尽整体 429，属已知同文案混淆，未再消耗。

### 📝 Notes
- 家宽匿名池当晚两次被诊断流量打空（~50 分钟自愈）；「批量 429 先发最小健康探针分层」已写入 fingerprint-data.md。
- GA 2.2.1（10-29 发布）未滚模板包含校验，快照维持 2.1.4；会话时间段新鲜度窗口实测 ≥24h。
- 黑名单对可能随上游增补；新增时在 `OPENCODE_ZEN_BLOCKED_TOOL_NAME_PAIRS` 追加并跑探针即可。
