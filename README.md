# codex-cliproxy-gateway

A small cross-platform, Bun-powered local gateway for Codex Desktop and Codex CLI.

It keeps Codex signed in with ChatGPT for native models, while models whose IDs begin with `cliproxy/` are sent to CLIProxyAPI with a separate API key.

## 使用前准备

- 安装 Bun 1.2+ 和 Codex Desktop 或 Codex CLI。
- 准备可访问的 CLIProxyAPI 或 new-api 服务。
- 同时使用官方模型时，先在 Codex 中登录 ChatGPT；只使用第三方上游可选
  `--upstream-only`。
- 自动安装、卸载及后台服务管理目前仅支持 macOS。其他 Bun 支持的平台可手动配置后
  前台运行，见[手动运行](#手动运行)。

## 安装与首次使用

以下自动安装步骤适用于 macOS：

```bash
npm install -g codex-cliproxy-gateway
codex-cliproxy install
```

默认连接本机上游 `http://127.0.0.1:8317/v1`，网关端口为 `8320`。
按提示输入 API Key 并选择要在 Codex 中显示的模型：

- `↑` / `↓` 移动，空格勾选，回车确认。
- 本机上游（`127.0.0.1`、`localhost` 或 `::1`）可以不填 Key；远程上游必须提供。
- 安装会备份并更新 Codex 配置、启动网关，保留原有登录状态。

安装完成后，**完全退出并重新打开 Codex Desktop**；使用 CLI 时重新启动 Codex。
默认模式下，官方模型保持原名，第三方上游模型带 `cliproxy/` 前缀。

### 连接远程上游

```bash
codex-cliproxy install --upstream-url https://cliproxy.example/v1
```

命令会隐藏输入的 Key。也可以通过环境变量传入：

```bash
API_KEY='your-key' codex-cliproxy install \
  --upstream-url https://cliproxy.example/v1
```

使用其他环境变量名时，添加 `--key-env NAME`。

### 使用 new-api

```bash
codex-cliproxy install \
  --upstream-type newapi \
  --upstream-url https://newapi.example.com/v1
```

new-api 渠道需要支持 Codex 使用的 `/v1/responses`。
未登录 ChatGPT、只使用该上游时，添加 `--upstream-only`。

### 只使用第三方上游

```bash
codex-cliproxy install --upstream-only --select all
```

此模式使用上游原始模型名，不添加 `cliproxy/` 前缀，
也不提供官方、ZCode、CodeBuddy/WorkBuddy、Qoder 或 Antigravity 模型。

### 常用安装参数

| 参数 | 用途 |
| --- | --- |
| `--upstream-url URL` | 设置上游地址，通常以 `/v1` 结尾。 |
| `--upstream-type cliproxy\|newapi` | 选择上游类型，默认 `cliproxy`。 |
| `--port PORT` | 设置网关端口，默认 `8320`。 |
| `--prefix PREFIX` | 设置第三方模型前缀，默认 `cliproxy/`。 |
| `--select SELECTOR` | 直接指定模型，支持序号、范围、模型 ID、通配符（如 `gpt-*`）、`all` 或 `none`。 |
| `--upstream-only` | 只使用第三方上游。 |
| `--manual-codex-config` | 不修改 `~/.codex/config.toml`，安装后以 warning 打印需要手动配置的键与值。与 `--upstream-only` 同用时会询问「是否直接修改 codex 配置」：答 `y` 转为托管写入（本参数不生效），默认 `N` 保持手动模式。 |
| `--restart-codex` | 停止当前 Codex app-server，让后续会话重新加载配置。 |
| `--yes` | 再次安装时跳过原地更新确认。 |

重复运行 `install` 可以更新上游地址、类型等设置，无需先卸载。
无人值守安装时显式提供 `--select`；更新已有安装时可同时添加 `--yes`。

## 选择与刷新模型

```bash
# 查看当前选中的第三方上游模型
codex-cliproxy models

# 拉取最新列表并重新选择，使用默认混合模式
codex-cliproxy models --sync

# 选择全部模型，保持或切换到仅上游模式
codex-cliproxy models --sync --upstream-only --select all
```

**不带 `--upstream-only` 的同步命令会切回混合模式。**
刷新时会复用已保存的上游 Key。

手动模式（`install --manual-codex-config`）下 `models --sync --upstream-only` 照常完成 static 切换，
但不会写入 `model_catalog_json`，而是打印需要手动添加的键与目录文件路径；
切回混合模式时同样会提示手动删除该键。`status` 的 `codexConfigManaged` 字段可查看当前模式。

也可以直接指定选择：

```bash
codex-cliproxy models --sync --select "1,3,5-8"
codex-cliproxy models --sync --select "claude-opus-4-6,gemini-3.1-pro"
codex-cliproxy models --sync --select "gpt-*"
```

模型 ID 以当前上游列表为准；`*` 匹配任意字符，`?` 匹配单个字符，
通配符没有命中时按空选择处理。`--select none` 会直接清空第三方上游选择，
并在拉取目录前短路，不访问 CPA 或 new-api 的 `/models`；在仅上游模式下
也不写入空的 `model_catalog_json`，让 Codex 回退官方模型目录。

如需使用维护者提供的模型元数据文件，可在安装或同步时添加：

```bash
codex-cliproxy models --sync --model-merge-json https://github.com/owner/repo
```

也支持直接提供 HTTP(S) 的 `models.json` 文件地址；仓库地址使用最新 Release 的文件。

### 何时需要重启 Codex

- 安装后、切换混合/仅上游模式后：重启 Codex。
- 仅上游模式下修改模型选择：重启 Codex 才能加载新列表。
- 混合模式下修改模型选择：等待自动刷新；列表仍未更新时再重启。
- `codex-cliproxy restart` 默认只重启网关。

`install`、`uninstall`、`restart`、`models --sync` 支持 `--restart-codex`。它会停止
当前 Codex app-server，**可能中断正在执行的任务**，不会主动启动替代进程；必要时
重新打开 Codex。`config` 只写网关侧配置，停止 app-server 无法刷新模型选择器，
因此不提供该参数。

## Web 配置界面

```bash
codex-cliproxy web
```

命令会检查并按需启动网关，然后打开浏览器。默认地址为
`http://127.0.0.1:8321/ui`；自定义网关端口时，界面端口为网关端口加 1。
按 `Ctrl-C` 停止前台界面服务，网关继续运行。

界面支持修改配置、选择上游模型、查看日志及中英文切换。
保存后按页面提示应用设置或重启 Codex。

| 命令 | 用途 |
| --- | --- |
| `codex-cliproxy web --daemon` | 后台运行界面并打开浏览器。 |
| `codex-cliproxy web --status` | 查看界面服务状态和地址。 |
| `codex-cliproxy web --stop` | 停止后台界面服务。 |
| `codex-cliproxy web --restart` | 重启后台界面服务。 |

界面默认关闭，仅允许本机访问。请通过 `web` 打开带访问令牌的链接；
页面要求输入令牌时，可从 `~/.codex-cliproxy-gateway/ui-token` 获取。
后台界面不会在重新登录或重启电脑后自动开启，需再次运行 `web --daemon`。

## 配置与日志

```bash
# 查看当前配置
codex-cliproxy config

# 开启请求日志，并限制保留量
codex-cliproxy config --log on --max-request-logs 100 --max-log-size 10MB

# 关闭请求日志
codex-cliproxy config --log off
```

| 参数 | 用途 |
| --- | --- |
| `--log on\|off` | 开关请求日志，默认关闭。 |
| `--debug on\|off` | 开关调试日志，默认关闭。 |
| `--max-request-logs N` | 请求日志目录最多保留的文件数，`0` 表示不限。 |
| `--max-log-size SIZE` | 主日志大小上限，支持 `512KB`、`10MB`、`1M`；`0` 表示不限。 |
| `--zcode on\|off` | 开关 ZCode 模型，默认关闭。 |
| `--codebuddy on\|off` | 开关 CodeBuddy/WorkBuddy 模型，默认关闭；账号使用 `codebuddy --switch`。 |
| `--qoder on\|off` | 开关本机 Qoder 模型，默认关闭；支持国际版与国内版。 |
| `--agy on\|off` | 开关本机 Antigravity（`agy/`）模型，默认关闭。 |

参数可以组合使用。CLI 配置写入仅支持 macOS：已安装后台服务时自动重启网关，
没有后台服务时仅保存配置，需自行重启前台进程。
如提示配置已保存但重启失败，执行 `codex-cliproxy restart`。
修改 `--zcode`、`--codebuddy`、`--qoder`、`--agy` 或运行 `codebuddy --switch` 时会同时失效 Codex 的
模型目录缓存，Codex 启动或下一次校验时会立即重新拉取列表；纯日志参数不影响目录。

常用文件位置：

- 配置：`~/.codex-cliproxy-gateway/config.json`
- 主日志：`~/.codex-cliproxy-gateway/gateway.log`
- 请求日志：`~/.codex-cliproxy-gateway/logs/`

请求日志数量限制作用于整个目录，正在写入的文件可能使数量暂时超出上限。
主日志达到大小上限后轮换，保留最近 5 份备份。

### 运行主目录与环境变量

网关自管的全部数据（config.json、state、各适配器目录缓存、请求日志、调试转储、
凭据文件后端）默认落在 `~/.codex-cliproxy-gateway`，统一由运行主目录派生，
不从 catalogPath 等文件位置倒推；目录不存在时随首次写入自动创建。

运行主目录的优先级：`serve --config` 的配置所在目录 > `CODEX_CLIPROXY_HOME`
环境变量 > 默认目录。环境变量必须是绝对路径（支持 `~/…` 展开，相对路径直接报错）。
带变量运行的所有命令（`config`、`restart`、`status`、`web` 等）都只操作该变量
指向的实例，不会误碰默认安装。

```bash
# 前台多实例 / 容器与 CI
CODEX_CLIPROXY_HOME=/tmp/ccp-instance codex-cliproxy serve --config /tmp/ccp-instance/config.json
```

多实例的后台服务支持：

- `install` / `web --daemon` 写入 plist 时会嵌入该环境变量，launchd 拉起的网关与
  Web UI 和安装时的 CLI 解析到同一主目录；普通 `config`、`restart` 只重启对应
  实例、不重写 plist。电脑重启后仍按 plist 登记的目录读取已保存的配置。
- 非默认实例的 LaunchAgent 文件名与 label 会加主目录哈希后缀
  （如 `codex-cliproxy-gateway-3f2a9c1d`），plist 仍在 `~/Library/LaunchAgents/`
  （launchd 登录只扫描该目录），与默认服务互不冲突；默认实例完全不变。
- 上游 API key 的 Keychain 槽位使用同一后缀隔离，非默认实例不回退读取默认密钥。
- 非默认实例安装时不托管 `~/.codex/config.toml`（多实例会争用受管键）：
  需要 `--manual-codex-config`，或为该实例设置独立的 `CODEX_HOME`——
  `CODEX_CLIPROXY_HOME` 不隔离 Codex 自身配置。
  托管安装会校验客户端目录归属，并将其记录到安装状态；后续管理命令即使没有
  设置 `CODEX_HOME`，也使用原目录。显式指定不同目录会报错，不能静默切换。

健康检查会校验网关与 Web UI 的实例标记。无标记的旧进程需要更新到新版后重启；
其他实例或占用端口的其他服务不能作为本实例的健康响应。

同一主目录不支持多份不同配置同时运行；前台 `serve` 实例修改配置后需自行重启该进程。

### 使用 ZCode 模型

先在本机 ZCode 中登录并选择可用的渠道与套餐，然后开启：

```bash
codex-cliproxy config --zcode on
```

可用型号取决于当前 ZCode 配置与网关支持范围；登录失效时请回到 ZCode 处理。

关闭：

```bash
codex-cliproxy config --zcode off
```

### 使用 CodeBuddy/WorkBuddy 模型

先在本机 CodeBuddy/WorkBuddy 中登录，然后开启：

```bash
codex-cliproxy config --codebuddy on
```

本机有多份登录（不同账号或产品各落一个 `.info` 文件）时，可用上下箭头选择
网关使用的账号：

```bash
codex-cliproxy codebuddy --switch
```

菜单第一项是 `auto` 此刻命中的登录，标注 `(auto, follows the most recently
refreshed login)`：选它即跟随最近刷新的登录，并随 CodeBuddy 客户端切换账号自动
跟随；该登录不再单独列出，其余登录按 `昵称 <邮箱> / 地域` 显示。↑/↓ 移动、
Enter 确认、Esc 取消。不做选择时即为 `auto`；`config --codebuddy on|off` 只管
开关，不负责账号选择。

配置保存的是 `.info` 文件名（`codebuddyAccount`）。锁定后网关只读该文件；
文件被删除时不改写配置，运行期自动回退 `auto` 并在 `gateway.log` 记一条
warning，Web UI 的「当前账号」标签也会实时显示实际命中的账号。账号选择只在
CLI；Web UI 对该标签只读展示（仅含昵称、邮箱与地域等非敏感账号标识，凭据
token 绝不进入 UI）。历史配置里的 `codebuddyRegion` 已过时，读取时自动按
`auto` 处理并在下次写盘时移除；早期写入的 `codebuddyAccount: "default"` 同样
自动改写为 `auto`。

模型列表的显示名会带 CN/INTL 地域标识和 C/W 产品标识；C 表示 CodeBuddy CLI，
W 表示 WorkBuddy。选择对应条目后，网关会按该条目路由到对应地域登录；
缺少该地域凭据（或锁定账号属于另一地域）时直接报错，不会回退到另一个地域。

切换账号后，Codex 的模型选择器可能短暂保留已下架的旧条目。此时即使请求
落在官方或第三方的 WebSocket 连接上，网关也会在本地断开该连接，让 Codex 重新
协商并降级 HTTPS/SSE，不会把这类已确认不支持的模型帧发给任何上游；ZCode 模型
同样受该逐帧保护。

实际列表取决于当前登录的产品和账号权限。网关不会代为登录或刷新登录凭据；
提示凭据过期或即将过期时，请回到对应客户端重新登录。

关闭：

```bash
codex-cliproxy config --codebuddy off
```

### 使用 Qoder 模型（国际版与国内版）

先在本机登录 Qoder（国际版 `qoder`，国内版 `qodercn`；或直接使用对应版本
的 Qoder 桌面应用登录），再开启统一的 Qoder 开关；CLI 与桌面版、国际版与
国内版互相独立，可同时启用：

```bash
qoder login      # 国际版 CLI，配置目录 ~/.qoder
qodercn login    # 国内版 CLI，配置目录 ~/.qoder-cn
codex-cliproxy config --qoder on
```

请求头的产品标识跟随凭据来源：CLI 令牌发 `product=cli / ClientType=5`，
桌面令牌发 `product=app / ClientType=10`，Qoder 用量页据此区分客户端。
CLI 登录缺失时，网关会自动回退读取 Qoder 桌面版的登录
（macOS：`~/Library/Application Support/com.qoder.app.stable` /
`com.qodercn.app.stable`）。桌面版凭据由 Electron safeStorage 加密，
网关按需从 macOS 钥匙串读取解密密钥（只读、不落盘；若系统弹出授权框，
选择「始终允许」即可）。调试时可用 `QODER_FORCE_DESKTOP=1` 强制只读
桌面版登录（对 launchd 网关：`launchctl setenv QODER_FORCE_DESKTOP 1`
后 `launchctl kickstart -k gui/$(id -u)/codex-cliproxy-gateway`，
恢复用 `launchctl unsetenv` 后再重启）。

模型显示名为 `Qoder-INTL/<名称>` 或 `Qoder-CN/<名称>`，
调用 ID 为 `qoder-intl/<上游模型键>` 或 `qoder-cn/<上游模型键>`。
例如当前国际版 Flash 为 `qoder-intl/qfmodel`、国内版为 `qoder-cn/qfmodel`，
以各账号实时目录为准。
上游并发受限时请求会进入 Qoder 排队，网关按官方 CLI 语义等待并自动恢复重试；
持续繁忙时返回明确的排队失败提示，需稍后重试或关闭其他 Qoder 会话。
推理档位按目录展示；当前 Flash 与 Max 支持低、中、超高，默认分别为中、超高。
名称后显示当前倍率：零倍率为 `(free)`，非零为 `(x倍率)`；
当前 Flash 为 `(free)`、Max 为 `(x0.5)`，以刷新后的目录为准。
上下文从每个模型的 `context_config` 自动取最大可用档位，推理请求同步发送
`context_length`。当前 Max 和 Flash 为 1M，客户端保留 5% 预算后约显示 950k；
没有独立的上下文手动配置。
网关直接调用 Qoder 服务，不依赖 `qodercli2api` 或 CLI 推理子进程。

目录在启动及每两分钟刷新，读取时有 100 秒缓存；只展示当前账号启用的模型。
更新失败保留同账号最近成功的目录，未知模型不会回退到 `auto`。
登录文件只读消费，默认位于 `~/.qoder/.auth`，支持 `QODER_CONFIG_DIR`；
国内版默认位于 `~/.qoder-cn/.auth`，支持 `QODERCN_CONFIG_DIR`；
两版登录互相独立，不会跨地域使用授权。登录失效时请运行对应的
`qoder login` / `qodercn login`，网关不会续期或写回登录文件。

Web UI 的 Qoder 开关后会以只读复选框展示当前实际生效的登录来源，取值可能是
`CLI-INTL`、`CLI-CN`、`DESKTOP-INTL`、`DESKTOP-CN`。每个地域按网关真实加载
顺序显示：CLI 登录存在时只显示 CLI，缺失才回退显示桌面版，因此 CLI 与桌面版
同时登录不会重复出现。探测只判断文件是否存在，不读取或展示凭据内容。

开启请求日志时，Qoder 使用 `qoder-v1-responses-http-<时间戳>.log`，
记录模型、状态、用量和耗时。推理超时按连续 120 秒没有数据判断，
上游输出和心跳会重置计时；流式超时会返回明确的失败事件。

免费资格由 Qoder 当前账号和活动决定；`billable=false` 是当次上游结果，
用量中的 Credits 计算值不等于实际扣费，不能承诺永久免费。

关闭：`codex-cliproxy config --qoder off`。

上述接入均需网关监听本机环回地址，并且在 `--upstream-only` 模式下不生效。
Web 界面检测到本机配置后会显示对应开关；已经开启的开关会保留显示，方便关闭。

### 使用 Antigravity 模型（agy）

先在本机安装并登录 Antigravity CLI（`agy`，数据目录 `~/.gemini/antigravity-cli`），
再开启 Antigravity 开关：

```bash
agy              # 首次交互登录（Google 账号）
codex-cliproxy config --agy on
```

网关只读消费 `~/.gemini/antigravity-cli/antigravity-oauth-token`：
access_token 有效期 1 小时，由 agy 进程负责刷新（常驻可执行
`agy remote-control start`）；网关过期即快速失败并提示刷新，绝不自行刷新或写回凭据。

模型显示名为 `AGY/<名称>`，调用 ID 为 `agy/<上游模型 id>`。同一模型的多档位变体
（high/medium/low）在目录中合并为一个 ID（如 `agy/gemini-3.8-flash`），由请求的
`reasoning.effort` 选择档位（缺省 medium，缺档就近回退）；显式档位 ID
（如 `agy/gemini-3.8-flash-high`）仍可直接调用。目录按官方推荐位与档位动态生成，
以账号实时返回为准。
上游为 Google Cloud Code Assist 内部接口（HTTP/SSE），仅环回监听可用，
与官方、第三方上游互不影响。

## 服务管理与卸载

以下服务管理命令适用于 macOS 自动安装：

| 命令 | 用途 |
| --- | --- |
| `codex-cliproxy status` | 查看网关状态、当前模式及安装信息。 |
| `codex-cliproxy start` | 启动网关。 |
| `codex-cliproxy stop` | 停止网关及后台 Web 界面。 |
| `codex-cliproxy restart` | 重启网关。 |
| `codex-cliproxy uninstall` | 卸载服务并恢复由网关管理的 Codex 设置。 |

卸载会保留网关的 `config.json`，方便再次安装，并保留 Codex 配置中的无关修改。
卸载后重启 Codex；如需移除 npm 包，再执行：

```bash
npm uninstall -g codex-cliproxy-gateway
```

## 手动运行

网关可在 Bun 支持的平台前台运行，需要先准备好配置文件：

```bash
codex-cliproxy serve --config /path/to/config.json
```

不传 `--config` 时使用 `~/.codex-cliproxy-gateway/config.json`。
手动部署还需配置 Codex 的连接地址与模型目录；配置字段见
[配置格式](schemas/gateway-config.schema.json)。`serve` 本身不执行安装或启动 Web 界面。
非 macOS 平台需自行编辑配置文件和管理进程，不能使用上述安装、卸载、
后台服务管理及 `config --...` 写入命令。

macOS 的上游 Key 保存在登录钥匙串中。其他平台需手动准备
`~/.codex-cliproxy-gateway/credentials.json`，内容如下，并将权限设为仅本人可读写
（Linux 为 `0600`）：

```json
{
  "version": 1,
  "upstream_api_key": "your-key"
}
```

该文件包含明文密钥，请妥善保管；仅本机上游允许使用空 Key。

其他平台需要 Web 界面时，使用默认位置的配置文件，在另一个终端执行
（以下为 POSIX shell 写法）：

```bash
CODEX_CLIPROXY_UI_SERVICE=1 codex-cliproxy web
```

此方式只运行界面服务，需自行启动网关并在浏览器打开界面地址。

## 常见问题

- **安装后看不到模型**：先运行 `codex-cliproxy status` 检查网关，
  再运行 `models --sync` 重新选择，最后重启 Codex。
  使用仅上游模式时，同步命令需加 `--upstream-only`。
- **CLIProxy 模型缺少 `max` / `ultra` 思考等级**：
  检查 `status` 的 `codexClientVersion` 是否正确，更新本机 Codex CLI 后重新同步。
  必要时用 `CODEX_CLIPROXY_CLIENT_VERSION` 指定实际使用的客户端版本。
- **ZCode 或 CodeBuddy/WorkBuddy 模型不可用**：
  确认对应客户端已登录、开关已开启，且网关未处于仅上游模式。
  CodeBuddy 提示地域无凭据时，运行 `codex-cliproxy codebuddy --switch`
  确认当前锁定的账号及其地域，或切回 `auto`。
- **无法打开 Web 界面**：重新运行 `codex-cliproxy web`；
  若提示后台界面占用端口，先运行 `web --stop`。
- **手动改了配置但未生效**：修改网关配置后重启网关，
  修改 Codex 配置后重启 Codex。日常调整优先使用命令或 Web 界面。
