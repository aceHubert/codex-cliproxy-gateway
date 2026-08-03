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

The installer:

1. Validates the key against `GET /v1/models`.
2. Displays the CLIProxy model list and asks which models should appear in Codex.
3. Stores the key in macOS Keychain.
4. Builds a combined Codex catalog from `codex debug models --bundled` and only the selected CLIProxy models, preserving their reasoning metadata. An existing `model_catalog_json` is preserved as the base during installation.
5. Prefixes selected model IDs with `cliproxy/` while preserving their original display names; the gateway strips the ID prefix before forwarding.
6. Backs up `~/.codex/config.toml` as `~/.codex/config.toml.bak-cliproxy-gateway-YYYYMMDDHHmmss`.
7. Changes only root-level `openai_base_url` and `model_catalog_json`.
8. Installs a `launchd` service bound to `127.0.0.1`.
9. Leaves `~/.codex/auth.json` untouched.

Installed files are split by responsibility:

```text
~/.codex/
  config.toml
  config.toml.bak-cliproxy-gateway-YYYYMMDDHHmmss
  cliproxy-catalog.json

~/.codex-cliproxy-gateway/
  config.json
  state.json
  gateway.log
  gateway.error.log
```

The catalog is generated data, so it is rebuilt rather than backed up. Model
metadata overrides are read directly from the bundled `models.json` on each
catalog sync and are not copied into the runtime directory. If
`config.toml` was manually edited after installation, uninstall restores only
the two managed root keys and preserves unrelated edits.

Fully quit and reopen Codex Desktop after installation.

## Commands

```bash
codex-cliproxy models
codex-cliproxy models --sync
codex-cliproxy status
codex-cliproxy start
codex-cliproxy stop
codex-cliproxy restart
codex-cliproxy uninstall
```

`start`, `stop`, and `restart` control only the installed gateway process. They
do not reinstall it or change Codex configuration, the model catalog, or the
Keychain API key.

`models` lists the CLIProxy models currently selected for the Codex picker.

`models --sync` fetches the current CLIProxy model list, marks the current selection, asks you to choose again, and rebuilds the picker catalog from the Codex bundled catalog. Press Enter to keep the checked models. Fully quit and reopen Codex Desktop afterward.

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

Run `codex-cliproxy models --sync` after editing `models.json`.

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

## WebSocket note

Version `0.2.x` intentionally supports HTTP/SSE forwarding only. WebSocket upgrade requests receive an immediate `426`, allowing Codex to fall back to HTTPS/SSE. This avoids implementing a second stateful routing protocol before CLIProxy WebSocket behavior is established.

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

The native catalog comes from `codex debug models --bundled`; `models_cache.json` is not required. The generated catalog is written atomically. Fully quit and reopen Codex Desktop after `install` or `models --sync`, because Codex loads `model_catalog_json` when app-server starts.
