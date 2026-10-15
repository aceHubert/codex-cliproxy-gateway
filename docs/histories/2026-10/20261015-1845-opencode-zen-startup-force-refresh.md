# [2026-10-15 18:45] | Task: opencode-zen 启动刷新强制重拉元数据，重启即手动更新窗口

### 🤖 Execution Context
* **Agent ID**: `zcode`
* **Base Model**: `zai-api/GLM-5.3-FLASHX`
* **Runtime**: `ZCode CLI`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `codex/llm-bridge-conversion`

### 📥 User Query
> 现在所有的 plugin 都是这样吗？安装或重启应该走 refreshOnStartup 的呀，这个需要强制重新获取，相当重启给一个手动更新的窗口。

### 🛠 Changes Overview
**Scope:** packages/opencode-zen（index.ts、catalog.ts）、test/opencode-zen-catalog.test.ts、test/opencode-zen-gateway.test.ts

**Key Actions:**
- **[调查]**: 逐一核对五个插件的启动刷新语义——agy/qoder/codebuddy 的启动 `store.refresh()` 全部直通内部 `refresh(true)`（强制、绕 TTL，agy 注释即「启动/定时刷新入口：绕过 TTL 重新校验」），zcode 的 refresh 直读无 TTL 层。唯一偏离是 zen：启动 `refresh(catalogMode === "manual")` 在动态模式下只强制拉模型列表，元数据仍受 6 小时 TTL 保护——这正是免费池新模型（deepseek-v4.1-flash-free）长期无窗口字段、客户端按自身缺省虚标 1M（950k）的根因。
- **[启动强制]**: index.ts 启动刷新改为无条件 `store.refresh(true)`（强制重拉模型列表 + 元数据 + 无元数据模型重探）：重启/安装即手动更新窗口，对齐其余四个插件的启动强制语义；元数据 6 小时 TTL 只约束后台定时刷新。Web UI 的 refreshCatalog 原本就走 `store.refresh(true)`，行为不变。
- **[失效条件补全]**: catalog.ts 客户端目录缓存失效条件从「可见 id 集合变化」扩展为「可见集合或成品条目内容任一变化」——强制刷新补齐窗口/档位不改变模型集合，但同样改变客户端展示与上下文预算，已缓存客户端必须重新拉取；否则重启修好的数据送不到已缓存的客户端。
- **[测试]**: 新增存储级「强制刷新绕过元数据 TTL，成品内容变化失效客户端缓存」与适配器级「启动刷新强制重拉元数据：预置 TTL 内新鲜但缺新模型条目的磁盘缓存，断言启动仍重拉且窗口就位」。`bun run check` 1136/1136 通过。
- **[真机闭环]**: 网关重启于 18:45:44 强制重拉元数据（上一次拉取 18:25，远在 6 小时 TTL 内），deepseek-v4.1-flash-free 条目保持 `context_window: 200000`。
- **[过程说明]**: 本任务前一版方案（元数据未知 -free 模型的周期性追赶补拉）曾实现后按用户指示撤销；本版按用户设计改为「重启即强制更新」，语义更简单且与其余插件一致。

### 🧠 Design Intent (Why)
zen 的目录分两层：模型列表（分钟级变化）与 models.opencode.ai 元数据（6 小时本地 TTL）。其余插件的目录只有一层，启动强制即全量强制；zen 的启动强制只穿透了列表层，元数据层在 TTL 内拒绝重拉，导致「重启能修」的直觉失效。按「重启 = 手动更新窗口」的统一原则把强制语义穿透到元数据层：用户可预期的修复动作（重启/安装/Web UI 刷新）都拿最新数据，后台定时刷新仍按 TTL 节流。内容变化失效客户端缓存是配套交付机制——没有它，强制刷新只修好网关侧文件，已缓存的客户端继续显示虚标窗口。

### 📊 Change Stats
> 数据来自 `git diff --numstat`（工作区 vs HEAD）。

- **Files changed:** 4
- **Insertions:** +100
- **Deletions:** -2

| File | +Added | -Removed |
| --- | ---: | ---: |
| `packages/opencode-zen/src/index.ts` | +4 | -1 |
| `packages/opencode-zen/src/catalog.ts` | +6 | -1 |
| `test/opencode-zen-catalog.test.ts` | +51 | -0 |
| `test/opencode-zen-gateway.test.ts` | +39 | -0 |

### 📁 Files Modified
- `packages/opencode-zen/src/index.ts`
- `packages/opencode-zen/src/catalog.ts`
- `test/opencode-zen-catalog.test.ts`
- `test/opencode-zen-gateway.test.ts`
