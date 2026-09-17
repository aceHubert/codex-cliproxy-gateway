## [2026-09-08 17:30] | Task: install 支持已安装状态原地更新（确认后切换上游）

### 🤖 Execution Context
* **Agent ID**: `zcode`
* **Base Model**: `builtin:zai-coding-plan/GLM-5.3`
* **Runtime**: `ZCode CLI`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `main`

### 📥 User Query
> 是否可以改成已经install 提醒确认后用户选择yes继续，自动执行修改config 并启动服务
> 不需要重建目录吧，为什么要建目录

### 🛠 Changes Overview
**Scope:** codex-cliproxy（src/cli.ts、test/app-server.test.ts、README.md、docs/exec-plans/）

**Key Actions:**
- **[原地更新]**: `install` 的 state 守卫由"直接报错要求 uninstall"改为切换模式——已存在安装时提示确认（TTY 读一行 stdin，`y` 开头即同意；`--yes` 跳过；非 TTY 无 `--yes` 打印指引并中止），确认后原地更新：合并新选项到 config.json、重建/复用目录、重写 config.toml 受管键、重启网关服务。
- **[安全回滚]**: 切换模式失败不拆服务——恢复 config.toml（尝试前原文）、config.json（旧内容）、密钥（try 前留底恢复）、state（旧内容）；服务重启只在全部写盘成功后进行，失败时尽力用恢复后的配置拉回。
- **[备份链]**: 切换模式不覆盖首次安装的纯净备份；installedConfigHash 仅在 config.toml 未被手改过时推进（与 models --sync 语义一致），保证后续 uninstall 整文件还原正确。
- **[目录复用]**: 目录文件已按上游类型分开后，原地更新默认**复用已有目录**（不重拉、不重选模型），密钥仍每次经上游 `/models` 校验；仅当该类型目录文件缺失、或显式 `--select` / `--model-merge-json` 时才重建目录。
- **[测试与文档]**: usage 增补 `--yes` 与原地更新说明；app-server 用例更新为"已存在安装时非 TTY 提示 `--yes` 并中止、state 保持不动"；README 的"切换需 uninstall"改为"重跑 install 确认后原地更新"；执行计划落 completed/。

### 🧠 Design Intent (Why)
切换上游（cliproxy ↔ newapi）不频繁，但每次先 uninstall 再 install 是多余的仪式感：install 完全可以在保留"首次安装"回滚语义的前提下，对已存在安装执行原地更新——所有写盘都带回滚、纯净备份链不破坏，密钥与 state 都能恢复；目录按上游类型分文件后，已有目录直接复用，重建只在文件缺失或显式要求时发生。

### 📊 Change Stats
> 数据来自 `git diff --numstat`（工作区未提交改动，含同日 new-api 系列任务累计；根目录 models.json 为用户既有改动）。

- **Files changed:** 16（累计，本轮净改动 3 文件 + 1 计划/1 历史）
- **Insertions:** 累计约 +1100；**Deletions:** 累计约 -170

### 📁 Files Modified（本轮净改动）
- `src/cli.ts`（install 原地更新、confirmInstallOverwrite、`--yes`、目录复用、回滚、state 分支）
- `test/app-server.test.ts`（abort 断言更新）
- `README.md`（切换说明）
- `docs/exec-plans/completed/install-inplace-update.md`（新增）
