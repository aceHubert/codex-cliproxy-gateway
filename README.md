# codex-cliproxy-gateway

A small cross-platform, Bun-powered local gateway for Codex Desktop and Codex CLI.

It keeps Codex signed in with ChatGPT for native models, while models whose IDs begin with `cliproxy/` are sent to CLIProxyAPI with a separate API key.

```text
Codex app-server
  |
  | openai_base_url = http://127.0.0.1:8320/v1
  v
local Bun gateway
  |-- model starts with cliproxy/ --> CLIProxyAPI, strip prefix, replace auth
  `-- every other model ----------> official Codex backend, preserve OAuth
```

There is deliberately no allowlist for official model names. `gpt-*`, `codex-auto-review`, and future native models all remain on the official route unless their model ID explicitly starts with `cliproxy/`.

## Requirements

- Bun 1.2+
- Codex Desktop or Codex CLI signed in with ChatGPT
- CLIProxyAPI with a valid client API key

The gateway runtime and foreground Web UI work on platforms supported by Bun.
Automated installation, uninstallation, and background service management currently
require macOS because those commands use launchd/LaunchAgent. On other platforms,
run `serve` directly; for the UI, run `web` with `CODEX_CLIPROXY_UI_SERVICE=1`
in the environment, or configure the platform's service manager the same way.
This service mode runs only the UI using the default install config, without
starting the gateway or opening a browser.

## Install from npm

```bash
npm install -g codex-cliproxy-gateway
codex-cliproxy install
```

`config.json` records the package version in `configVersion` and references the
published JSON Schema through `$schema`. Before every command except `install`
and `uninstall`, a version mismatch triggers one additive configuration sync.
The sync recursively adds only missing fields and preserves existing values and
unknown fields. Obsolete fields owned by this gateway may be removed by an
explicit migration; schema problems outside those migrations are reported as
warnings and are never automatically fixed by deleting values.

The default upstream URL (CLIProxyAPI) is:

```text
http://127.0.0.1:8317/v1
```

For a loopback upstream (`127.0.0.1`, `localhost`, or `::1`), the API key
may be left empty. The gateway then sends no authentication header. Remote
upstream URLs still require a key. The installer reads the key from the
`API_KEY` environment variable (or any variable named via `--key-env`) and
falls back to a hidden terminal prompt when it is unset.

When fetching a CLIProxy catalog, the CLI sends a Codex `client_version`. CLIProxy
uses that version to decide what the catalog contains: an outdated value strips
the newer `max`/`ultra` reasoning levels from every model. The value is resolved,
in order, from `CODEX_CLIPROXY_CLIENT_VERSION` (explicit pin), the version the
consuming client reported to the gateway and the gateway stored in
`~/.codex-cliproxy-gateway/models-cache.json`, and a `codex --version` probe on
`PATH`; it falls back to `0.0.0` only when none of those is available.
`codex-cliproxy status` prints the resolved value as `codexClientVersion`.

For a remote upstream:

```bash
API_KEY='your-key' codex-cliproxy install \
  --upstream-url https://cliproxy.example/v1
```

`--cliproxy-url` is a deprecated alias of `--upstream-url`. The same rename
applies to the `config.json` key: `cliproxyBaseUrl` was renamed to
`upstreamBaseUrl`; command preflight migrates old configs automatically, and
the old key is marked `deprecated` in the JSON Schema. `--upstream-only` is the
new name of `--cpa-only` (which stays accepted as a deprecated alias), and the
`config.json` key `cpaOnly` was renamed to `upstreamOnly` with the same
migration. The `config.json` key `upstream_type` was renamed to `upstreamType`
to match the other camelCase fields; old configs migrate automatically the same
way.

To use only CLIProxy models from the first installation:

```bash
codex-cliproxy install --upstream-only --select all
```

To load model metadata overrides from the latest GitHub release:

```bash
codex-cliproxy install --model-merge-json \
  https://github.com/owner/repo
```

Repository URLs resolve to `releases/latest/download/models.json`. Any HTTP(S)
URL whose path includes a file name is downloaded directly.

The installer:

1. Validates the key against `GET /v1/models`.
2. Displays the upstream model list and asks which models should appear in Codex.
3. Stores the key in macOS Keychain (`~/.codex-cliproxy-gateway/credentials.json` on other platforms; see below).
4. Builds a local catalog containing only the selected upstream models.
5. In the default split mode, native rows come from Codex's authenticated `/models` refresh and selected IDs use the `cliproxy/` prefix. With `--upstream-only`, the static catalog keeps original model IDs.
6. Backs up `~/.codex/config.toml` as `~/.codex/config.toml.bak-cliproxy-gateway-YYYYMMDDHHmmss`.
7. Sets root-level `openai_base_url`; split mode removes `model_catalog_json`, while `--upstream-only` points it to the generated static catalog.
8. Installs a `launchd` service bound to `127.0.0.1`.
9. Leaves `~/.codex/auth.json` untouched.

Installed files are split by responsibility:

```text
~/.codex/
  config.toml
  config.toml.bak-cliproxy-gateway-YYYYMMDDHHmmss
  models_cache.json

~/.codex-cliproxy-gateway/
  config.json
  state.json
  models.json
  cliproxy-catalog.json              # selected CPA models with original IDs
  newapi-catalog.json                # per-upstream catalog for --upstream-type newapi
  models-cache.json                  # client_version reported by the consuming client
  credentials.json                   # upstream API key on non-macOS platforms (0600, plain text)
  gateway.log                        # single process log: stdout+stderr, config audit, request summaries
  logs/
    cliproxy-YYYYMMDDhhmmss.log
```

The catalog file is named after the upstream type (`cliproxy-catalog.json` or
`newapi-catalog.json`), so switching upstreams never overwrites the other
type's local catalog.

The catalog is generated data, so it is rebuilt rather than backed up. A
downloaded `models.json` cache is preferred over the bundled file; when the
cache is missing, the saved `model_merge_json` URL is downloaded during sync,
or the bundled file is used when no URL is configured. If
`config.toml` was manually edited after installation, uninstall restores only
the two managed root keys and preserves unrelated edits.

### API key storage

On macOS the upstream API key lives in the login Keychain (service
`codex-cliproxy-gateway`). On other platforms it is stored as plain text in
`~/.codex-cliproxy-gateway/credentials.json` with shape
`{"version":1,"upstream_api_key":"…"}` and permissions `0600`. The automated
installer is macOS-only for now, so on Linux create that file by hand before
running `codex-cliproxy serve` (an empty key is only allowed for loopback
upstreams). Treat the file like a password — the gateway never logs or exposes
its contents, and a corrupted file fails loudly with its path instead of being
treated as a missing key.

Fully quit and reopen Codex Desktop after installation, or install with
`--restart-codex` to stop the current Codex app-server after `config.toml` is updated.

## Commands

### Install and service

| Command | Description |
| --- | --- |
| `codex-cliproxy install` | Install the gateway, patch managed `config.toml` keys, and start the LaunchAgent. Re-running with confirmation updates in place (merge options, rebuild catalog, rewrite managed keys, restart). |
| `codex-cliproxy uninstall` | Remove the managed service and generated runtime data. Keeps `~/.codex-cliproxy-gateway/config.json` so a later install adds only missing defaults. Restores managed `config.toml` keys. |
| `codex-cliproxy status` | Print gateway health, routing mode, and related install state. |
| `codex-cliproxy start` | Start the installed gateway process. |
| `codex-cliproxy stop` | Stop the installed gateway (and the Web UI agent, if running). |
| `codex-cliproxy restart` | Restart the gateway and refresh managed Codex base URLs (`openai_base_url`, Realtime WS/WebRTC URLs) from the current gateway address. Does not change the model catalog or the stored API key. |

### Models

| Command | Description |
| --- | --- |
| `codex-cliproxy models` | List the CLIProxy models currently selected for the Codex picker. |
| `codex-cliproxy models --sync` | Fetch the upstream model list, rebuild the local routed-model overlay in **dynamic split** routing, and expire only the freshness fields in Codex’s `models_cache.json`. |
| `codex-cliproxy models --sync --upstream-only` | Rebuild the **static upstream-only** CPA catalog with original model IDs (no dynamic cache refresh). |
| `codex-cliproxy models --sync --select SELECTOR` | Choose models by number/range, exact ID, `all`, or `none`. |
| `codex-cliproxy models --sync --model-merge-json URL` | Update the cached `models.json` override rules. |
| `codex-cliproxy models --sync --restart-codex` | After sync, stop Codex app-server so the picker reloads immediately (active turns may error). |

Plain `models --sync` switches back from upstream-only to split. Both modes rewrite the managed `model_catalog_json` key in Codex `config.toml`. The gateway restarts automatically only when the routing mode actually changes; re-syncing in the same mode does not restart it.

In split mode, the first explicit `cliproxy/` request pins that `thread-id` to CPA, so later unprefixed HTTP/SSE fallback and WebSocket reconnects for that thread stay on CPA. A subagent uses its own WebSocket and inherits CPA when its `x-codex-parent-thread-id` is already pinned at route-decision time. A guardian prewarm that races ahead of its parent’s first pin can currently attempt the official route; this known race is recorded in `docs/exec-plans/tech-debt-tracker.md`. Current Codex Desktop versions create `thread_title` as an independent, parentless Luna root thread, so title generation remains independently routable to official. Unrelated threads in the same session also remain independently routable to official. If an official prewarm connection receives the first explicit `cliproxy/*` frame, the gateway closes it with `1012` and the pinned reconnect goes to CPA. Realtime `/live` and `/realtime` keep their existing dedicated handling. `/v1/models` adds `cliproxy/` only in its response and merges the CPA rows with the official catalog. If the CPA catalog is missing, invalid, or still contains legacy prefixed IDs, `/v1/models` returns the official catalog alone until the next sync. This fallback changes only the visible directory; upstream-only inference remains routed to CPA.

### Config

| Command | Description |
| --- | --- |
| `codex-cliproxy config` | Print current gateway settings. Does not change routing mode or restart. |
| `codex-cliproxy config --zcode on\|off` | Toggle ZCode Responses-to-Anthropic compatibility. |
| `codex-cliproxy config --log on\|off` | Toggle request logging. |
| `codex-cliproxy config --max-request-logs N` | Max request-log files kept across the directory; `0` (default) means unlimited. |
| `codex-cliproxy config --max-log-size SIZE` | Size cap for `gateway.log` (e.g. `512KB`, `10MB`, `1M`); overflow copies to `gateway-<timestamp>.log` (5 newest backups kept) and truncates in place; `0` means unlimited. |

Options may be combined. Every option write restarts the installed gateway so the process reloads the complete configuration. Real field changes (including `models --sync` mode and selection updates, and the `config.toml` `model_catalog_json` handover) are appended to `gateway.log`, with URL query strings redacted. If a CLI configuration write is saved but its gateway restart fails, run `codex-cliproxy restart` before continuing.

### Web UI

| Command | Description |
| --- | --- |
| `codex-cliproxy web` | Run the Web UI in the foreground (same as `web --start`): check the gateway (start if needed), serve the UI on its own port, open the browser; Ctrl-C stops the UI. |
| `codex-cliproxy web --daemon` | Start the Web UI in the background via LaunchAgent, then open the browser and return to the shell. |
| `codex-cliproxy web --status` | Print whether the UI is running and its URL. |
| `codex-cliproxy web --stop` | Stop only the background UI service; the gateway keeps running. |
| `codex-cliproxy web --restart` | Stop then start the background UI service. |

The UI is off by default — the gateway never starts it. It listens on its own port (gateway port + 1, e.g. `http://127.0.0.1:8321/ui` with the default gateway port 8320) in a separate process structurally isolated from model traffic: its handler has no upstream URL, API key, or forwarding path, so the gateway’s request logs only ever contain model requests. The UI LaunchAgent has `RunAtLoad`/`KeepAlive` off, so the background service stays off across reboots until `web --daemon` starts it again; `stop` and `uninstall` also stop it.

The UI is a single-page form built from the config schema (editable runtime settings — request logging, log retention, gateway log size, ZCode compatibility — plus read-only install-managed fields) with a fullscreen log viewer for `gateway.log` and request logs, and Chinese/English switching. Saving from the UI applies the same config write, `gateway.log` audit, and automatic gateway restart as the `config` command; the UI process re-reads `config.json` per request, so CLI-side config changes show up without restarting it. Access is loopback-only and token-gated: the URL carries a token from `~/.codex-cliproxy-gateway/ui-token`, the page stores it in `sessionStorage`, and the API requires it as a request header; a non-whitelisted `Host` or cross-origin `Origin` gets a 404.

### Shared flags

| Flag | Commands | Description |
| --- | --- | --- |
| `--restart-codex` | `install`, `uninstall`, `restart`, `models --sync` | Stop the current Codex app-server after writing `config.toml` so it reloads managed values. May interrupt active turns; does not start a replacement process. |
| `--upstream-only` | `install`, `models --sync` | Route every model to the upstream with its original ID (static CPA catalog). |
| `--upstream-type newapi` | `install` | Upstream is an OpenAI-compatible new-api gateway; catalog is synthesized locally at `models --sync`. |

### Restart requirements

- **Gateway restarts automatically:** switching between split and upstream-only with `models --sync [--upstream-only]`, and every `config` option write (`--log`, `--max-request-logs`, `--max-log-size`). A same-mode model sync or parameterless `config` query does not restart it.
- **Commands that write `config.toml`:** `install`, `uninstall`, `restart`, and `models --sync` accept `--restart-codex`. The option stops the current Codex app-server after the file update, may interrupt active turns, and does not start a replacement process itself.
- **Codex must reload after a mode switch:** add `--restart-codex` to the sync command for immediate application, or restart Codex before using the new catalog.
- **upstream-only catalog selection changes:** the static catalog is read by Codex app-server at startup, so use `--restart-codex` or restart Codex to make the new selection visible immediately.
- **Split catalog selection changes:** Codex periodically refreshes `/v1/models`; use `--restart-codex` only when the current picker or session keeps a stale snapshot.
- **`codex-cliproxy restart`:** restarts only the gateway by default. Add `--restart-codex` when the running Codex app-server must also reread the managed URLs.
- **Manual file edits:** `config.json` and `config.toml` are not watched. Editing either file does not trigger any automatic restart; use the CLI commands above or restart the affected process explicitly.

Request logs are disabled after installation. Use `codex-cliproxy config --log on` to
write them to timestamped files under `logs/`; each request starts with a separator such as
`--2026-08-13T12:34:56.789Z--`. Use `codex-cliproxy config --log off` to disable them
again. Request-log retention is count-based and separate from any size cap: `codex-cliproxy
config --max-request-logs N` keeps the newest N log files in the whole directory by
modification time (`0`, the default, keeps everything). There is no per-route grouping, so
a busy route can crowd out a quiet one; files still being written are exempt, which is what
keeps an open WebSocket session from losing the file it keeps appending. The cap is applied
when a gateway starts and again as it writes (on every write for caps below 32, every 32
writes above, so the directory can sit up to 31 files over the cap), and it never applies
to `gateway.log`, whose growth is bounded by `--max-log-size`. `gateway.log` is the single
process log: stdout and stderr both point at it (launchd opens each descriptor only once at
spawn, so rotation keeps the inode stable and the running gateway keeps appending), and it
also collects the config audit trail plus a one-line summary for every request — a
successful request logs `-> <status> (Nms)` with its upstream, a failed one logs an error
digest beginning with `!!!` while the full exchange stays in the request log under `logs/`;
protocol negotiation 426 counts as success. Every gateway start is prefixed
with the same timestamp separator for easier scanning. Use `codex-cliproxy config --max-log-size SIZE` (`SIZE` follows the [bytes](https://github.com/visionmedia/bytes.js) format, for example `512KB`, `10MB`, or `1M`; `0`, the default, disables the cap) to bound its growth: when a write would exceed the cap, the current content is copied to `gateway-<timestamp>.log` (the 5 newest backups are kept, oldest first) and the live file is truncated in place. Capping also bounds the config audit trail kept in `gateway.log` (current file plus 5 backups); keep it at `0` if complete audit traceability matters more than disk usage. A legacy
`gateway.error.log` from older installations is no longer written and is cleaned up at uninstall.

Model metadata overrides are applied to case-insensitive upstream model IDs
before `cliproxy/` is added. Rules are applied in order and only the first
match is used. The `openai` group leaves names unprefixed; other groups are
joined with `/`. A trailing `*` enables prefix matching:

```json
{
  "openai": [
    { "name": "gpt-5.6-*", "context_window": 372000 }
  ],
  "z.ai": [
    { "name": "glm-5.2", "context_window": 1000000 }
  ]
}
```

Passing `--model-merge-json` to `models --sync` updates the URL saved in
`config.json` and refreshes the cached `models.json`. GitHub repository URLs
use `models.json` from the latest release; HTTP(S) file URLs are downloaded
directly. Without the option, an existing cache is reused; a missing cache is
downloaded from the saved URL.

In an interactive terminal, use `↑`/`↓` to move, `Space` to toggle a model,
and `Enter` to confirm. `--select` remains available for scripts and CI.

Selection accepts indexes, ranges, exact model IDs, `all`, or `none`:

```bash
codex-cliproxy models --sync --select "1,3,5-8"
codex-cliproxy models --sync --select "claude-opus-4-6,gemini-3.1-pro"
```

For non-interactive installation, pass `--select` explicitly:

```bash
codex-cliproxy install --select "1,3,5-8"
codex-cliproxy install --select all
```

## Routing behavior

For a native model such as `codex-auto-review`:

```text
model: codex-auto-review
Authorization: Bearer <ChatGPT OAuth token>
        -> https://chatgpt.com/backend-api/codex/responses
```

For a CLIProxy model:

```text
model: cliproxy/claude-opus-4-6
Authorization: Bearer <ChatGPT OAuth token>
        -> local gateway
model: claude-opus-4-6
Authorization: Bearer <CLIProxy API key>
        -> CLIProxyAPI /v1/responses
```

The ChatGPT OAuth token is removed before any CLIProxy request.

## Using a new-api upstream

The third-party upstream can be an OpenAI-compatible new-api gateway instead of CLIProxyAPI. Routing is unchanged — prefixed models go to the upstream with the ChatGPT OAuth token replaced by the upstream API key — but new-api does not expose CLIProxy's Codex catalog endpoint (`/v1/models` returns the OpenAI `{"data":[{"id":…}]}` list), so the gateway synthesizes the Codex catalog locally:

```bash
API_KEY='sk-newapi-token' codex-cliproxy install \
  --upstream-type newapi \
  --upstream-url https://newapi.example.com/v1
```

`config.json` records the choice:

```json
{
  "upstreamBaseUrl": "https://newapi.example.com/v1",
  "upstreamType": "newapi"
}
```

Both routing modes work with `newapi`. If Codex is not signed in with ChatGPT (a common new-api setup), use `--upstream-only`: split mode serves the catalog by merging the official `/models` refresh, which requires the official backend. Refreshing the model list later reuses the stored key:

```bash
codex-cliproxy models --sync --select all
```

Notes:

- new-api channels must accept Codex traffic on `/v1/responses` (its Codex adaptor); otherwise requests for these models fail upstream.
- Realtime WebSocket handshakes that new-api cannot serve return `426` and Codex falls back to HTTP/SSE, as with CLIProxy.
- Switching between `cliproxy` and `newapi` does not require `uninstall`: re-running `install` with the new options updates the existing installation in place after a confirmation prompt (or `--yes`). The per-upstream catalog is reused when it already exists, so switching back keeps your previous model selection; the catalog is rebuilt only when the upstream type's catalog file does not exist yet or you pass `--select` / `--model-merge-json`. `uninstall` remains available to tear everything down (it preserves `config.json`).

## ZCode 的 Codex 接入

启用后，Codex 继续使用网关的 `/v1/responses`。网关将 Responses 请求转换为
ZCode 当前 provider 的 Anthropic Messages 请求，并将响应转回 Codex JSON 或 SSE。
普通 function、namespace、freeform `apply_patch`、图片及带工具历史的上下文压缩均受支持。
内置 `web_search` 原生映射为 z.ai 的 `web_search_20250305` 服务端工具，搜索调用与结果
双向转换（声明、历史回放与流式折叠）；`external_web_access: false` 时按剥离处理。
其余内置工具（如 `image_generation`）无法跨格式执行，会被剥离并在 system 中注入降级
说明，请求日志记录被剥离的工具名，不再拒绝整个请求。

请求包含图片时启用图片识别适配：GLM 文本模型无法直接查看图片，z.ai 服务端会把图片
上传 CDN 并改写为 URL。网关在翻译后的请求中声明 `analyze_image` 工具并注入使用说明；
模型调用被网关吸收后代为执行（以 Claude Code 客户端指纹信封侧请求，服务端在同一条
SSE 内完成识别），识别结果作为工具结果续跑上游，对 Codex 呈现为一次连续的响应。
代执行过程以助手消息复刻 z.ai 内置工具的旁白卡片（`**🌐 Z.ai Built-in Tool:
analyze_image**` + Input/Output，与 `web_search_prime` 实测形状逐字一致）：Input 卡片在
执行等待期间先流出，执行结果随后呈现在 Output 卡片里；未续跑的调用补未执行说明，
不会留下悬挂的 "Executing on server..."。执行失败时降级为错误说明文本，不影响主链路；
请求日志记录续跑腿数（`analyze_image continuation legs: N`）。

上游端点跟随 z.ai 服务端下发的动态映射：网关像 ZCode 桌面客户端一样定期拉取
`https://zcode.z.ai/api/v1/agent/configs`，按 `proxyEndpoint.mapping` 把 Anthropic
上游重写到官方 ultra 中转（当前为 `zcode.z.ai/api/v1/ultra[-zai]/...`，国内直连）。
成功缓存 5 分钟、失败冷却 30 秒、请求超时 3 秒，任何失败都回退原 URL（fail-open）；
重定向目标仅接受 `z.ai`/`bigmodel.cn` 官方域名的公网 https 地址。

```bash
codex-cliproxy config --zcode on
codex-cliproxy config --zcode off

# 同时启用请求日志
codex-cliproxy config --zcode on --log on
```

命令写入 `config.json` 的 `zcode` 布尔开关、同步安装状态并记录审计。
已安装 LaunchAgent 时按现有配置命令流程重启网关；未安装时仅保存配置。
默认值为 `false`。旧 `zai.enabled` 自动迁移，新 `zcode` 值优先。
旧 `/zai` 入口及 `CODEX_CLIPROXY_ZAI_TOKEN` 已移除；启用 ZCode 时监听地址必须为环回地址。

### 当前渠道、套餐与模型

三个 ZCode 文件分别读取 `~/.zcode/<文件名>`，仅在文件不存在时回退到
`~/.zcode/v2/<文件名>`；生效文件损坏、权限错误或符号链接不触发旧文件回退。

- `setting.json`：`providerFamilyDomain` 选择 `zai` 或 `bigmodel`；
  `modelProviderFamilySelectedKeys[providerFamilyDomain]` 指定完整 provider。
  只移除选择值中首个冒号之前的模式标签，保留 provider ID 内其余冒号。
- `config.json`：精确读取 `provider[id].options.baseURL`、`apiKey`、可用性与 `models`。
  地址使用当前配置的官方 HTTPS Anthropic 基址，不另外指定网关上游地址。
- `credentials.json`：观察当前计划渠道的登录授权变动。实际模型请求继续使用
  config 中 ZCode 已保存的业务 Key；网关不执行登录、OAuth 刷新或业务 Key 创建。

Coding Plan 与 Start Plan 按实际 provider ID 区分；两者的选择值都可能以
`coding-plan:` 开头。API Key 模式忽略 OAuth 文件变化。

可用模型取当前 `provider.models` **字典键**与 `vendor_models.json` 中 `z.ai`
预设的交集，忽略大小写。显示名或模型属性中的 `name` 不作为模型 ID。
对外 ID 使用厂商规范名称，例如 `z.ai/glm-5.3`、`bigmodel/glm-5.3-flash`；
发送上游时保留 config 字典键中的原始拼写。套餐未支持或厂商目录未收录的型号返回 404。
`cliproxy/z.ai/*` 继续使用原来的 CLIProxy 路由。

`upstream-only` 只使用第三方上游，因此该模式下 ZCode 入口整体按禁用处理：`zcode`
开关仍可写入并保留审计，但不建凭证缓存、不生成 `zcode-catalog.json`、不拦截
`/v1/responses`，也不再把环回监听地址与 `z.ai/`、`bigmodel/` 保留前缀的约束施加给纯转发配置。
第三方上游目录里的裸 `z.ai/*`、`bigmodel/*` 条目按上游原样提供，不再被 ZCode 目录替换或剥离。
`config` 查询报告生效值，开关与生效值不一致时另外给出 `zcodeConfigured`。

### 模型 API 的请求头与正文

按完整 provider ID 区分套餐：Coding Plan 和 API Key 请求发送 `x-api-key` 与
`Authorization: Bearer`；Start Plan 仅用 config 中已保存的计划 JWT 发送 Bearer。
均不把登录 access_token 直接替换成模型请求凭证。

请求来源头由网关构造，包括 `HTTP-Referer`、`User-Agent`、`X-Title: Z Code@cli`、
`X-ZCode-Agent: glm`、应用版本、系统、语言和时区。应用版本首次启用时读取本机公开
Info.plist，失败显示 unknown；SDK 标识沿用本次核查的 `ai-sdk/anthropic/3.0.81`。
不会透传客户端自带的 ZCode 身份、签名或设备字段；只有合法的 `anthropic-beta` 会按白名单保留。

每次模型调用生成 request/trace/query ID；同一 Codex thread（缺失时使用 session）
在相同 provider/Key 作用域关联到内部随机 session ID，闲置15分钟失效、最多保留1024条。
正文的 `metadata.user_id` 与内部 session 一致，省略设备标识和实际账户ID。
非system历史缓存标记会清理，只为最后一个合法非thinking内容块保留临时缓存点。

本轮只调用当前配置地址的模型 API，不新增动态路由配置拉取、签名握手、PoW、
验证码或账号管理请求。Start Plan 若要求额外运行时验证，返回上游错误交由用户处理。
这些协议特征不能证明获得 ZCode 应用内的150%额度或特定扣费倍率。

### 两层缓存

网关启动时在上游目录文件旁创建或复用 `zcode-catalog.json`，默认位于
`~/.codex-cliproxy-gateway/zcode-catalog.json`。该文件保存两渠道共享的厂商裸模型目录，
不包含套餐、provider ID、上游地址或凭证。厂商预设、覆盖规则或缓存内容改变时重新生成；
套餐或渠道切换不重写此文件。重新生成会让 Codex 能看到的目录变化，因此同一次启动会复用
`invalidateModelsCache` 把 Codex 自己的 `~/.codex/models_cache.json` 置为过期：只重置
`fetched_at` 与 `client_version`，保留已缓存目录，让 Codex 下次请求 `/models` 时重新拉取；
复用现有缓存时不改动该文件。`install`、`uninstall` 与 `models --sync` 仍会主动过期它，
在 Codex Desktop 中完全退出并重开即可看到新的模型选择列表。

`/v1/models` 只从内存中的厂商目录按当前套餐筛选、加渠道前缀并合并。
带 `client_version` 返回 Codex catalog，不带时返回 OpenAI 模型列表。
ZCode 条目不进入官方 last-good 缓存或 CLIProxy 目录缓存。
配置不可用时隐藏 ZCode 条目，其模型请求返回 503；其他可用目录保持原有行为。

配置使用目录监听和最小字段差分：100ms 防抖，并在首个事件后最多 500ms 启动检查。
普通窗口、语言、最近项目、其他 provider、同值重写等变化不重建 Key。
仅地址或支持模型改变时更新路由信息，保持 Key 及其绝对有效期。
计划授权变化后会检查当前 config Key，Key 未变时仍复用缓存。

只有实际业务 Key 的 JWT `exp` 被用作到期时间；普通 API Key 或没有 `exp` 的 JWT
不推测 TTL，也不使用登录 `access_token` 的有效期代替。到期后共享一次重读，
若仍是过期 Key 则等待 ZCode 更新配置。正常请求只访问内存快照；在途请求保持原快照。

### 传输与日志

ZCode 模型使用 HTTP JSON/SSE，明确的 ZCode Responses WebSocket 请求返回 426，
由 Codex 降级。官方 Realtime 和其他模型原有的 WebSocket 路由保持可用。
每次请求携带完整历史；非空 `previous_response_id`、服务端会话、结构化输出及未实现的
服务端内置工具返回明确错误。客户端函数工具（包括返回截图的工具）可正常往返。

开启日志后，沿用默认日志目录和每组文件数限制：

```text
zai-v1-responses-http-<时间戳>.log
bigmodel-v1-responses-http-<时间戳>.log
```

两个渠道独立裁剪；错误同时汇总到对应的 `zai-error-*` 或 `bigmodel-error-*`。
日志分别记录入站头、入站正文、实际发送的上游头与转换后发往上游的正文；凭据和账户头脱敏，
上游错误回显的 Key 也会清除。SSE 日志随主流消费记录并包含终态，
不复制第二条上游消费流。客户端取消及网关停止会释放请求、reader、监听和计时器。

## Local development

Run the complete CLI directly from TypeScript. This exercises the same install,
model synchronization, config backup, Keychain, gateway, and launchd paths as
the published package:

```bash
bun run dev install --select all
bun run dev models
bun run dev models --sync
bun run dev status
bun run dev uninstall
```

For Web UI development, one command reuses the regular `web` startup path to
prepare the gateway and UI API service without opening the production page, then
starts Vite HMR and opens `http://127.0.0.1:8322/`. Paste the UI token from
`~/.codex-cliproxy-gateway/ui-token` when prompted if the browser session does not
already have one:

```bash
bun run dev:ui
```

Vite defaults to port `8322` and proxies `/ui/api/*` to the production UI backend
port `8321`. Override them with `CODEX_CLIPROXY_UI_DEV_PORT` and
`CODEX_CLIPROXY_UI_BACKEND_PORT` respectively; the ports must differ. The
`CODEX_CLIPROXY_UI_DEV` variable is internal to the script: it keeps `web` on the
background (LaunchAgent) path so the command returns and Vite can take over the
terminal, and it suppresses the production browser launch. Regular `web` runs the
production UI in the foreground (`web --daemon` for the background form); both
serve the UI built under `dist/ui`.

The installed LaunchAgent points to the local `src/index.ts`, so publishing is
not required during development. Restart it after changing source code:

```bash
launchctl kickstart -k "gui/$(id -u)/codex-cliproxy-gateway"
```

## Realtime transport

Installation points both `experimental_realtime_ws_base_url` and `experimental_realtime_webrtc_call_base_url` at the local gateway. The gateway snapshots the Codex provider at startup: the built-in provider supports ChatGPT account authentication and official API keys, while an explicitly configured provider is rejected before its credentials can leave the machine. `/v1/live` and `/v1/realtime` WebSockets are bridged with the authentication from each handshake. CPA Responses WebSocket is always bridged to CLIProxy in both split and upstream-only mode; the upstream decides per request whether to accept it, and a failed handshake returns `426` so Codex falls back to HTTP/SSE. Unrelated or unsupported WebSocket paths still receive `426`.

## Publishing

TypeScript sources are bundled into the single published executable
`dist/index.js`; the self-contained Web UI is also published as
`dist/ui/index.html`. The npm package does not include `src` or tests. Commits must
follow Conventional Commits; yorkie runs commitlint from the `commit-msg` hook.
Run `bun run commit` to create a commit with the Chinese Commitizen prompts.

`lerna-changelog` builds each release entry from merged GitHub pull requests.
Apply one of its configured labels before merging: `feat`, `bug`, or `breaking`.
The release tools and yorkie hook require Node.js 22.13 or newer. Export a
GitHub token before versioning:

```bash
export GITHUB_AUTH="..."
bun run release:version
bun run release
```

`release:version` runs the checks, selects the next version from Conventional
Commits, prepends the PR-based changelog, creates the release commit and tag,
and pushes them. `release` publishes that tag to npm; rerun it if publishing
fails after the tag was created. The package has no additional runtime
dependencies from the release tooling.

Pushes to `main` run the same version-and-publish flow through GitHub Actions.
Configure npm Trusted Publishing for the GitHub repository, the `deploy.yml`
workflow, and its `production` environment. Separate checks enforce
Conventional Commit PR titles and commit messages before merge.

## Model catalog refresh

Split mode does not configure `model_catalog_json`. Codex periodically requests `/v1/models`; the gateway forwards the request and OAuth headers to the official backend, then adds a `cliproxy/` prefix to the raw CPA rows only in the response. upstream-only points `model_catalog_json` at that same raw CPA catalog and never merges official rows into it.
