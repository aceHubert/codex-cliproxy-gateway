# Vision Subagent Router for Codex and Claude Code

当文本主模型（例如 DeepSeek）遇到图片时，本插件通过 `UserPromptSubmit` Hook 注入一条短指令，让主代理把视觉分析委派给独立的视觉 subagent。

- Codex：根据模型能力配置自动决定是否路由；
- Claude Code：启用插件即表示当前主模型按纯文本模型处理，检测到图片就路由。

它不会为所有模型注册视觉 MCP，因此不会把 MCP tool schema 注入每个模型的上下文。

## Codex 安装

将仓库添加为 Codex marketplace，然后安装插件：

```sh
codex plugin marketplace add aceHubert/codex-cliproxy --ref main
codex plugin add vision-reader@codex-cliproxy
```

插件安装不会自动安装 custom agent 文件。custom agent 是用户拥有的角色配置，安装器不会静默覆盖已存在的不同版本。需要单独安装 agent 模板：

```sh
plugin_dir="$(codex plugin list --json | jq -r '.installed[] | select(.pluginId == "vision-reader@codex-cliproxy") | .source.path')"
test -n "$plugin_dir"
test -d "$plugin_dir"
python3 "$plugin_dir/scripts/install.py" --vision-model gpt-5.6-luna
```

安装器会：

- 更新 `~/.codex/agents/vision-reader.toml`，注入指定的 vision model；
- 运行 `codex debug models` 读取当前有效 model catalog；
- 将默认配置、已有 `~/.codex/vision-router.json` 和 catalog 中的 text-only 模型合并去重后原地写回，不创建备份。

之后重启 Codex，在 `/hooks` 中审核并信任插件 Hook，再新建会话。

> Windows 用户将 `python3` 替换为 `py -3`。

### Codex 配置

安装器生成并合并 `~/.codex/vision-router.json`：

- `text_only_model_patterns`：默认规则、已有规则以及 catalog 中 `input_modalities` 不含 `image` 的模型，合并后去重；
- `vision_agent`：要委派的 custom agent 名称。

只有匹配 `text_only_model_patterns` 的模型才会触发视觉路由，未知模型直接放行。切换到使用不同 catalog 的 Codex profile 后，应通过 `--profile <名称>` 重新运行安装器。

若你的视觉模型 ID 不同，重新运行安装器并传入新模型：

```sh
plugin_dir="$(codex plugin list --json | jq -r '.installed[] | select(.pluginId == "vision-reader@codex-cliproxy") | .source.path')"
python3 "$plugin_dir/scripts/install.py" --vision-model gpt-5.6-luna
```

## Claude Code 安装

将仓库添加为 Claude marketplace，然后安装插件并指定网关中实际可用的视觉模型：

```sh
claude plugin marketplace add aceHubert/codex-cliproxy
claude plugin install vision-reader@codex-cliproxy --config vision_model=sonnet
```

Claude Hook 需要 `python3` 位于 `PATH`；Windows 推荐在 WSL 中运行，或自行提供 `python3` 命令。Claude agent 随插件加载，不需要额外安装器。Claude 端直接使用插件内的 `config/default-config.json`，不查询 Codex model catalog。它只获得 `Read` 工具；读取图片后把结构化结果返回给主模型。

Claude Code 的 `UserPromptSubmit` Hook 不提供可靠的当前模型字段，因此 Claude 端采用显式模式：

- 使用纯文本主模型时启用插件；
- 切换到原生视觉主模型时禁用插件；
- `vision_model` 必须是当前 provider / gateway 可调用且支持图片的模型 ID。

可在 `/plugin` 中启用、禁用或调整插件配置。

## 工作方式与限制

Hook 只能注入上下文，不能直接执行 subagent 调用。实际委派仍由主代理执行：Codex 使用 `vision_reader` + `view_image`，Claude Code 使用 `vision-reader:vision-reader` + `Read`。

图片检测优先检查 prompt，再宽松扫描 transcript 尾部。两端 transcript 都不是稳定接口，因此未来版本可能需要更新检测器。第三方主模型还必须支持工具调用，否则无法启动视觉 subagent。

纯粘贴图片在某些客户端/版本中可能没有暴露稳定的附件字段。最可靠的方式仍是让图片存在为本地文件，并在 prompt 中包含路径。

## Codex 卸载

```sh
# 移除 custom agent；合并后的 config 会保留
plugin_dir="$(codex plugin list --json | jq -r '.installed[] | select(.pluginId == "vision-reader@codex-cliproxy") | .source.path')"
python3 "$plugin_dir/scripts/uninstall.py"

# 移除插件本身
codex plugin remove vision-reader@codex-cliproxy
```

Claude Code 使用原生卸载命令：

```sh
claude plugin uninstall vision-reader@codex-cliproxy
```

## Local development

在本地仓库目录下直接开发调试，无需推送到 GitHub。

### Codex

```sh
cd /absolute/path/to/codex-cliproxy

# 注册本地 marketplace 并安装插件
codex plugin marketplace add /absolute/path/to/codex-cliproxy
codex plugin add vision-reader@codex-cliproxy

# 直接从本地插件目录安装 agent 模板
python3 plugins/vision-reader/scripts/install.py --vision-model gpt-5.6-luna
```

然后开一个新会话让 Codex 加载最新的 skills 和 hooks。

### Claude Code

```sh
claude --plugin-dir ./plugins/vision-reader
```

修改插件组件后运行 `/reload-plugins` 或重启 Claude Code。

### 测试

```sh
python3 plugins/vision-reader/tests/test_router.py
claude plugin validate --strict plugins/vision-reader
claude plugin validate --strict .
```

## License

[MIT](LICENSE)
