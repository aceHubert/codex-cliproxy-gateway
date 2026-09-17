# install 支持已安装状态原地更新（确认后切换上游）

## 目标

`codex-cliproxy install` 在已存在安装（state.json 存在）时不再直接报错要求先 uninstall：提示用户确认（或 `--yes`）后原地更新——改 config.json、按需重建目录、重写 config.toml 受管键、重启网关服务；失败回滚恢复原安装，不影响其可用性。

## 范围

- 包含：确认交互（TTY 提示 / `--yes` 跳过 / 非 TTY 无 `--yes` 拦截）、切换模式回滚（config/toml/密钥/state）、state 备份链保持（纯净备份不覆盖、hash 条件推进）、usage 与选项白名单、abort 测试。
- 不包含：uninstall 流程改动；非 install 命令的行为改动。

## 背景

- 相关代码路径：`src/cli.ts`（install()/parseArgs/COMMAND_OPTIONS/usage）。
- 已知约束：install 现有语义为"首次安装"，其回滚（删密钥、拆 launchd、清运行时文件）会摧毁已有安装，不能直接放开 state 守卫；uninstall 的整文件还原依赖 state.installedConfigHash 与 configBackup 的"纯净备份"不变式，原地更新必须维持该不变式（只有 config.toml 未被手改过才推进 hash，configBackup 永不覆盖）。

## 风险

- 风险：原地更新中途失败留下半新半旧状态。
  缓解：写入顺序保持"目录→config.json→config.toml→state→launchd 重启"，服务重启只在全部写盘成功后；回滚恢复全部四个文件/密钥到尝试前内容。
- 风险：Keychain 单槽位被覆盖后无法回退。
  缓解：try 之前读取旧密钥（optional），回滚时恢复。
- 风险：非交互环境（CI/管道）静默继续或挂起等待输入。
  缓解：非 TTY 且无 `--yes` 时打印指引并中止；确认读取按行读 stdin，EOF/异常一律视为拒绝。

## 里程碑

1. 确认交互与 `--yes`（parseArgs/白名单/usage/拦截分支）。
2. 切换模式写盘与 state 备份链。
3. 切换模式回滚。
4. abort 测试与全量验证、收尾记录。

## 验证方式

- 命令：`bun run check`（typecheck + 全量测试 + 构建）。
- 手工检查：TTY 下对已安装实例跑 `install --upstream-type newapi` 观察提示与原地更新；`--yes` 跳过；拒绝后安装不被改动。
- 观测检查：切换后 `status` 显示新 upstreamType；uninstall 仍能整文件还原纯净备份。

## 进度记录

- [x] 确认范围和约束。
- [x] 完成确认交互（TTY 提示 / `--yes` / 非 TTY 拦截）与写盘/回滚实现。
- [x] 目录复用：同类型目录已存在且未传 `--select` / `--model-merge-json` 时跳过重建与模型重选，只校验密钥、改配置、重启；目录文件缺失（如首次切到 newapi）或显式要求时才重建。
- [x] 完成验证并记录结果：`bun run check` 通过（122 测试）；app-server 用例更新为"已存在安装时非 TTY 提示 `--yes` 并中止、state 保持不动"。

## 决策记录

- 2026-09-08：不做全自动覆盖——已安装时要求确认（TTY 提示，`y` 开头即同意），`--yes` 供脚本化使用，非 TTY 无 `--yes` 时中止并提示。
- 2026-09-08：原地更新的备份语义与 uninstall 链对齐：configBackup（纯净备份）只由首次安装创建且永不覆盖；installedConfigHash 仅在 config.toml 与上次写入一致时推进，保证后续 uninstall 的整文件还原仍然正确。
- 2026-09-08：目录按上游类型分文件后，原地更新默认复用已有目录（不重拉、不重选模型）；密钥仍每次经上游 `/models` 校验一次。仅当该类型目录文件缺失、或显式 `--select` / `--model-merge-json` 时才重建。
- 2026-09-08：切换上游不重写 config.toml——网关 host/port/mount 与 cpaOnly 未变时，受管键已指向本网关，用 `patchedToml === currentToml`（patchRootToml 同值同串）判断并跳过原子写与 hash 推进；只有实际重写且 toml 未被手改过才推进 installedConfigHash。
