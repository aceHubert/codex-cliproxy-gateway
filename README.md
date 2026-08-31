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
The sync recursively adds only missing fields and preserves existing values and
unknown fields. Obsolete fields owned by this gateway may be removed by an
explicit migration; schema problems outside those migrations are reported as
warnings and are never automatically fixed by deleting values.

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
  models_cache.json

~/.codex-cliproxy-gateway/
  config.json
  state.json
  models.json
  cliproxy-catalog.json              # selected CPA models with original IDs
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

Fully quit and reopen Codex Desktop after installation, or install with
`--restart-codex` to stop the current Codex app-server after `config.toml` is updated.

## Commands

```bash
codex-cliproxy models
codex-cliproxy models --sync
codex-cliproxy models --sync --cpa-only
codex-cliproxy models --sync --restart-codex
codex-cliproxy models --sync --model-merge-json https://github.com/owner/repo/releases/download/v2/models.json
codex-cliproxy config
codex-cliproxy config --log on
codex-cliproxy config --log off
codex-cliproxy status
codex-cliproxy start
codex-cliproxy stop
codex-cliproxy restart
codex-cliproxy restart --restart-codex
codex-cliproxy uninstall --restart-codex
```

`start`, `stop`, and `restart` control the installed gateway process. `restart`
also refreshes `openai_base_url`, `experimental_realtime_ws_base_url`, and
`experimental_realtime_webrtc_call_base_url` in Codex configuration from the
current gateway address, so an existing installation does not need to be
reinstalled after that address changes. These commands do not change the model
catalog or the Keychain API key. Add `--restart-codex` to `restart` when Codex
must immediately reread those managed URLs.

`uninstall` removes the managed service and generated runtime data but preserves
`~/.codex-cliproxy-gateway/config.json`, so a later `install` adds missing
defaults and keeps existing configuration. Because uninstall restores managed
keys in `config.toml`, use `uninstall --restart-codex` when the running Codex
app-server must immediately reload the restored values.

`models` lists the CLIProxy models currently selected for the Codex picker.

`models --sync` fetches the current CLIProxy model list, rebuilds the local routed-model overlay in dynamic split routing, and expires only the freshness fields in Codex's `models_cache.json`. Codex then refreshes the official native catalog through the gateway on each `/v1/models` request. `models --sync --cpa-only` instead rebuilds the static CPA catalog and does not touch the dynamic model cache.

`models --sync --cpa-only` switches routing to a static CPA-only catalog with original model IDs; plain `models --sync` switches back to split. Both rewrite the managed `model_catalog_json` key in Codex `config.toml` accordingly. The gateway restarts automatically only when the routing mode actually changes; synchronizing models again in the same mode does not restart it. In split mode, the first explicit `cliproxy/` request pins that `thread-id` to CPA, so later unprefixed HTTP/SSE fallback and WebSocket reconnects for that thread stay on CPA. A subagent uses its own WebSocket and inherits CPA when its `x-codex-parent-thread-id` is already pinned at route-decision time. A guardian prewarm that races ahead of its parent's first pin can currently attempt the official route; this known race is recorded in `docs/exec-plans/tech-debt-tracker.md`. Current Codex Desktop versions create `thread_title` as an independent, parentless Luna root thread, so title generation remains independently routable to official. Unrelated threads in the same session also remain independently routable to official. If an official prewarm connection receives the first explicit `cliproxy/*` frame, the gateway closes it with `1012` and the pinned reconnect goes to CPA. Realtime `/live` and `/realtime` keep their existing dedicated handling. `/v1/models` adds `cliproxy/` only in its response and merges the CPA rows with the official catalog. If the CPA catalog is missing, invalid, or still contains legacy prefixed IDs, `/v1/models` returns the official catalog alone until the next sync. This fallback changes only the visible directory; CPA-only inference remains routed to CPA.

`config` prints the current gateway settings and does not change the routing mode. Every `config --log on|off` invocation writes the requested setting and restarts the installed gateway so the process reloads the complete configuration; only the parameterless query avoids a restart. Real field changes (including `models --sync` mode and selection updates, and the `config.toml` `model_catalog_json` handover) are appended to `logs/cliproxy-config-*.log` under the gateway log directory, with URL query strings redacted. If a CLI configuration write is saved but its gateway restart fails, run `codex-cliproxy restart` before continuing.

### Restart requirements

- **Gateway restarts automatically:** switching between split and CPA-only with `models --sync [--cpa-only]`, and every `config --log on|off` invocation. A same-mode model sync or parameterless `config` query does not restart it.
- **Commands that write `config.toml`:** `install`, `uninstall`, `restart`, and `models --sync` accept `--restart-codex`. The option stops the current Codex app-server after the file update, may interrupt active turns, and does not start a replacement process itself.
- **Codex must reload after a mode switch:** add `--restart-codex` to the sync command for immediate application, or restart Codex before using the new catalog.
- **CPA-only catalog selection changes:** the static catalog is read by Codex app-server at startup, so use `--restart-codex` or restart Codex to make the new selection visible immediately.
- **Split catalog selection changes:** Codex periodically refreshes `/v1/models`; use `--restart-codex` only when the current picker or session keeps a stale snapshot.
- **`codex-cliproxy restart`:** restarts only the gateway by default. Add `--restart-codex` when the running Codex app-server must also reread the managed URLs.
- **Manual file edits:** `config.json` and `config.toml` are not watched. Editing either file does not trigger any automatic restart; use the CLI commands above or restart the affected process explicitly.

Request logs are disabled after installation. Use `codex-cliproxy config --log on` to
write them to timestamped files under `logs/`; each request starts with a separator such as
`--2026-08-13T12:34:56.789Z--`. Use `codex-cliproxy config --log off` to disable them
again. `gateway.log` remains the process log; every gateway start is prefixed
with the same timestamp separator for easier scanning. `gateway.error.log`
uses the same separator and removes blank lines from application errors.

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

Installation points both `experimental_realtime_ws_base_url` and `experimental_realtime_webrtc_call_base_url` at the local gateway. The gateway snapshots the Codex provider at startup: the built-in provider supports ChatGPT account authentication and official API keys, while an explicitly configured provider is rejected before its credentials can leave the machine. `/v1/live` and `/v1/realtime` WebSockets are bridged with the authentication from each handshake. CPA Responses WebSocket is always bridged to CLIProxy in both split and CPA-only mode; the upstream decides per request whether to accept it, and a failed handshake returns `426` so Codex falls back to HTTP/SSE. Unrelated or unsupported WebSocket paths still receive `426`.

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

Split mode does not configure `model_catalog_json`. Codex periodically requests `/v1/models`; the gateway forwards the request and OAuth headers to the official backend, then adds a `cliproxy/` prefix to the raw CPA rows only in the response. CPA-only points `model_catalog_json` at that same raw CPA catalog and never merges official rows into it.
