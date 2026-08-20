# codex-cliproxy-gateway

A small Bun-powered local gateway for Codex Desktop and Codex CLI.

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

- macOS
- Bun 1.2+
- Codex Desktop or Codex CLI signed in with ChatGPT
- CLIProxyAPI with a valid client API key

## Install from npm

```bash
npm install -g codex-cliproxy-gateway
codex-cliproxy install
```

`config.json` records the package version in `configVersion` and references the
published JSON Schema through `$schema`. Before every command except `install`
and `uninstall`, a version mismatch triggers one additive configuration sync.
The sync recursively adds only missing fields; existing values, unknown fields,
and fields removed from newer versions remain untouched. Schema problems are
reported as warnings and are never automatically fixed by deleting values.

The default CLIProxyAPI URL is:

```text
http://127.0.0.1:8317/v1
```

For a loopback CLIProxyAPI (`127.0.0.1`, `localhost`, or `::1`), the API key
may be left empty. The gateway then sends no authentication header. Remote
CLIProxyAPI URLs still require a key.

For a remote CLIProxyAPI:

```bash
CLIPROXY_API_KEY='your-key' codex-cliproxy install \
  --cliproxy-url https://cliproxy.example/v1
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
2. Displays the CLIProxy model list and asks which models should appear in Codex.
3. Stores the key in macOS Keychain.
4. Builds a local overlay containing only the selected CLIProxy models. Native rows come from Codex's authenticated `/models` refresh.
5. Prefixes selected model IDs with `cliproxy/` while preserving their original display names; the gateway strips the ID prefix before forwarding.
6. Backs up `~/.codex/config.toml` as `~/.codex/config.toml.bak-cliproxy-gateway-YYYYMMDDHHmmss`.
7. Sets root-level `openai_base_url` and removes `model_catalog_json` so Codex refreshes through the gateway.
8. Installs a `launchd` service bound to `127.0.0.1`.
9. Leaves `~/.codex/auth.json` untouched.

Installed files are split by responsibility:

```text
~/.codex/
  config.toml
  config.toml.bak-cliproxy-gateway-YYYYMMDDHHmmss
  cliproxy-catalog.json              # generated only by models --sync --static
  models_cache.json

~/.codex-cliproxy-gateway/
  config.json
  state.json
  models.json
  models-cache.json                  # last successful official /models response
  cliproxy-catalog.json
  gateway.log
  gateway.error.log
  logs/
    cliproxy-YYYYMMDDhhmmss.log
```

The catalog is generated data, so it is rebuilt rather than backed up. A
downloaded `models.json` cache is preferred over the bundled file; when the
cache is missing, the saved `model_merge_json` URL is downloaded during sync,
or the bundled file is used when no URL is configured. If
`config.toml` was manually edited after installation, uninstall restores only
the two managed root keys and preserves unrelated edits.

Fully quit and reopen Codex Desktop after installation.

## Commands

```bash
codex-cliproxy models
codex-cliproxy models --sync
codex-cliproxy models --sync --static
codex-cliproxy models --sync --restart-codex
codex-cliproxy models --sync --model-merge-json https://github.com/owner/repo/releases/download/v2/models.json
codex-cliproxy models --sync --static --restart-codex
codex-cliproxy status
codex-cliproxy start
codex-cliproxy stop
codex-cliproxy restart
codex-cliproxy log on
codex-cliproxy log off
codex-cliproxy uninstall
```

`start`, `stop`, and `restart` control the installed gateway process. `restart`
also refreshes `openai_base_url`, `experimental_realtime_ws_base_url`, and
`experimental_realtime_webrtc_call_base_url` in Codex configuration from the
current gateway address, so an existing installation does not need to be
reinstalled after that address changes. These commands do not change the model
catalog or the Keychain API key.

`uninstall` removes the managed service and generated runtime data but preserves
`~/.codex-cliproxy-gateway/config.json`, so a later `install` adds missing
defaults and keeps existing configuration.

`models` lists the CLIProxy models currently selected for the Codex picker.

`models --sync` fetches the current CLIProxy model list, rebuilds the local routed-model overlay, removes the managed `model_catalog_json`, and expires only the freshness fields in Codex's `models_cache.json`. Codex then refreshes the official native catalog through the gateway; each successful `/v1/models` response updates the last-good `models-cache.json`. `models --sync --static` requires that cache, merges it with the selected CLIProxy models into `~/.codex/cliproxy-catalog.json`, and configures `model_catalog_json`. Use `--restart-codex` after any sync to refresh the current model picker immediately; it is especially required when entering or leaving static mode. Stopping app-server may interrupt active tasks.

Request logs are disabled after installation. Use `codex-cliproxy log on` to
write them to timestamped files under `logs/`; each request starts with a separator such as
`--2026-08-13T12:34:56.789Z--`. Use `codex-cliproxy log off` to disable them
again. `gateway.log` remains the process log; every gateway start is prefixed
with the same timestamp separator for easier scanning. `gateway.error.log`
uses the same separator and removes blank lines from application errors.

Model metadata overrides are applied to case-insensitive upstream model IDs
before `cliproxy/` is added. The `openai` group leaves names unprefixed; other
groups are joined with `/`. A trailing `*` enables prefix matching:

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

The installed LaunchAgent points to the local `src/index.ts`, so publishing is
not required during development. Restart it after changing source code:

```bash
launchctl kickstart -k "gui/$(id -u)/codex-cliproxy-gateway"
```

## Realtime transport

Installation points both `experimental_realtime_ws_base_url` and `experimental_realtime_webrtc_call_base_url` at the local gateway. The gateway snapshots the Codex provider at startup: the built-in provider supports ChatGPT account authentication and official API keys, while an explicitly configured provider is rejected before its credentials can leave the machine. `/v1/live` and `/v1/realtime` WebSockets are bridged with the authentication from each handshake. CLIProxy routing remains HTTP/SSE-only; unrelated or unsupported WebSocket paths still receive `426`.

## Publishing

TypeScript sources are bundled into the single published executable
`dist/index.js`. The npm package does not include `src` or tests.

Review the package name and repository metadata, then:

```bash
npm run check
npm pack --dry-run
npm publish --access public
```

The package has no runtime dependencies.

## Model catalog refresh

Dynamic mode does not configure `model_catalog_json`. Codex periodically requests `/v1/models`; the gateway forwards the request and OAuth headers to the official backend, atomically records the latest valid native catalog in `~/.codex-cliproxy-gateway/models-cache.json`, and adds the locally selected `cliproxy/` rows. Official failures use the last-good cache without overwriting it. Static mode is opt-in through `models --sync --static` and never uses `codex debug models` as its native source.
