# Run Task With Model

按请求从当前 Codex 模型目录中解析目标模型，并在新的用户可见线程中执行任务。用于替代固定的 Luna/max 通道：用户说 "用 xxx 模型跑这个功能" 时，本插件解析出具体的模型和推理级别，而不是固定在某个模型上。

## 工作方式

插件提供一个 `run-task-with-model` skill，流程为：

1. 从请求中解析模型标识、可选推理级别和任务描述；
2. 运行 `resolve-model.py` 解析出模型 slug 和推理级别；
3. 确认当前 host 具备线程工具（`list_projects`、`create_thread`、`wait_threads`、`read_thread`、`send_message_to_thread`）且支持解析出的模型与推理级别；
4. 读取 `references/task-packet.md`，组装完整任务包，用 `create_thread` 创建用户可见线程；
5. 用 `wait_threads` 监控、`read_thread` 读取结果，独立检查实际 worktree、分支、完整 diff 和验证输出后接受；
6. 仅在主任务审核实际 diff 和检查结果后，发送显式 PR 授权；修正通过 `send_message_to_thread` 发往同一线程。

解析失败、模型或推理级别不可用时立即停止，不回退到其他模型、推理级别或通道。

## Codex 安装

将仓库添加为 Codex marketplace，然后安装插件：

```sh
codex plugin marketplace add aceHubert/codex-cliproxy --ref main
codex plugin add run-task-with-model@codex-cliproxy
```

之后重启 Codex，新建会话让 skill 生效。插件支持隐式调用：无需显式触发，用户请求中带有 "用 xxx 模型运行/实现" 之类的表述时即会使用。

## 模型解析

解析器 `scripts/resolve-model.py` 按以下顺序读取模型目录：

1. `--catalog` 指定的自定义 JSON 文件，或 `USE_MODEL_CATALOG` 环境变量指向的文件；
2. `codex debug models` 返回的目录：动态模式下经当前配置的 base URL 刷新（包含 gateway 合并的 cliproxy 模型），静态模式下读取 `model_catalog_json` 指向的文件。

```sh
# 解析模型和推理级别
python3 plugins/run-task-with-model/skills/run-task-with-model/scripts/resolve-model.py \
  --model deepseek --reasoning high

# 列出当前目录中的全部模型
python3 plugins/run-task-with-model/skills/run-task-with-model/scripts/resolve-model.py --list
```

未指定推理级别时默认使用 `max`；若模型不支持 `max`，则取其 `supported_reasoning_levels` 的最后一项。显式请求的级别若不在支持列表内，同样回退到最后一项；模型未声明支持列表时按输入的级别处理。

自定义目录支持以下字段：

```json
{
  "models": [
    {
      "slug": "cliproxy/opencode-go-chat/deepseek-v4-pro",
      "display_name": "DeepSeek V4 Pro",
      "aliases": ["deepseek", "v4-pro"],
      "family": "deepseek",
      "variant": "pro",
      "rank": 2,
      "supported_reasoning_levels": ["low", "high"]
    }
  ]
}
```

匹配按 slug、display name、family、variant 和 aliases 进行；名字带 `free` 的模型会被排除；命中 flash 变体时优先从 flash 中选取。候选唯一时直接返回 `model`（slug）、`display_name`、`reasoning` 供直接使用；候选多个时返回 `candidates` 列表（每项含各自的 `reasoning`，不支持 `max` 时会回退到支持列表最后一项），由 AI 展示给用户确认；无匹配时返回 `message` 提醒用户。

## Local development

在本地仓库目录下直接开发调试，无需推送到 GitHub：

```sh
cd /absolute/path/to/codex-cliproxy

# 注册本地 marketplace 并安装插件
codex plugin marketplace add /absolute/path/to/codex-cliproxy
codex plugin add run-task-with-model@codex-cliproxy
```

然后开一个新会话让 Codex 加载最新的 skill。

## License

[MIT](../../LICENSE)
