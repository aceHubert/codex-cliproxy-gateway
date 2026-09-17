## [2026-09-08 15:50] | Task: Keychain 还原单槽位存储（撤销按 URL 分槽）

### 🤖 Execution Context
* **Agent ID**: `zcode`
* **Base Model**: `builtin:zai-coding-plan/GLM-5.3`
* **Runtime**: `ZCode CLI`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `main`

### 📥 User Query
> keychain 恢复成已经的吧，不需要存多份密匙，多次install 来切换即可，这不是一个需要频繁切换的场景

### 🛠 Changes Overview
**Scope:** codex-cliproxy（src/、README.md）

**Key Actions:**
- **[还原]**: `keychain.ts` 恢复单一槽位设计——account 固定为用户名，`saveApiKey(apiKey)` / `readApiKey(optional)` / `deleteApiKey()` 不再接收上游 URL；按 URL 分槽的 `keychainAccount(url)`、legacy 双槽兜底逻辑全部移除（保留通用的 "Upstream API key..." 报错文案）。
- **[调用点还原]**: cli.ts（install 保存/回滚/卸载/models --sync）与 gateway.ts（handler 默认参、startGateway）全部改回无参调用；卸载不再解析 config/state 取 URL。
- **[清理]**: `config.ts` 删除已无调用点的 `upstreamBaseUrlOf`；README 安装步骤第 3 条恢复 "Stores the key in macOS Keychain."。
- 保留：`cliproxyBaseUrl → upstreamBaseUrl` 更名及读取/文件迁移/`deprecated` 标注（本任务未涉及）。

### 🧠 Design Intent (Why)
切换上游并非高频场景，官方路径为 uninstall + install（install 会重写密钥、uninstall 会删除），多槽位存储徒增复杂度与"旧密钥被兜底误用"的歧义；单槽位语义简单直接，切换成本可接受。

### 📊 Change Stats
> 相对上一历史（20260908-1533）的净还原：keychain.ts ~-55 行、cli.ts 卸载段 ~-10 行、config.ts ~-10 行、README ~-2 行；122 用例全过。

### 📁 Files Modified
- `src/keychain.ts`
- `src/cli.ts`
- `src/gateway.ts`
- `src/config.ts`
- `README.md`
