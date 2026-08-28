---
name: run-task-with-model
description: Resolve a requested model from the current Codex host model catalog and run a task in a new user-visible thread. Use when the user asks to dispatch work to a specific model with phrases such as "use xxx model run/execute/implement", or wants model alias/family routing instead of the fixed luna max lane.
---

# Run Task With Model

## Confirm the primary session

The primary session inherits the user's current model and reasoning setting. When
metadata exposes them, report them without treating any particular value as a gate.
Recommend Sol / High for current Codex use, but do not stop or claim a skill can alter
the parent selection.

## Workflow

1. Parse the model identifier, optional reasoning level, and task from the request.
   Example: `use deepseek high run this feature` -> `model=deepseek`, `reasoning=high`, `task=run this feature`.
   Example: `use deepseek run this feature` -> `model=deepseek`, `reasoning=max`, `task=run this feature`.

2. Run the resolver script:

```bash
python3 <directory containing this SKILL.md>/scripts/resolve-model.py \
  --model deepseek \
  --reasoning max
```

Always run the resolver outside the sandbox by setting the tool invocation's
`sandbox_permissions=require_escalated`. This is required because sandboxed
`codex debug models` may silently fall back to the bundled catalog and report
gateway models as unavailable.

3. When a single model is returned, use `model`, `display_name`, and `reasoning` directly; do not re-negotiate the model or reasoning level.

4. Only when `candidates` is returned (multiple matches) must you call `request_user_input` to let the user pick one of the listed options (each with its own `reasoning`), then rerun the resolver with the chosen full slug. When a `message` is returned, no model matched; tell the user and stop.

5. Confirm the current host exposes `list_projects`, `create_thread`, `wait_threads`, `read_thread`, and `send_message_to_thread` (or equivalent thread tools), and that it supports the resolved model and reasoning level. Stop if any capability is unavailable.

6. Read `references/task-packet.md` and build the complete task packet.

7. Create the user-visible task with `create_thread`, passing the project, complete task packet, resolved `model.slug`, and `reasoning`.

8. Monitor with `wait_threads` and read the result with `read_thread`. Accept only after inspecting the actual worktree, branch, complete diff, and verification output.

9. Send explicit PR authorization only after the primary task reviews the actual diff and checks. Send corrections through `send_message_to_thread` on the same thread; do not create a new thread to bypass feedback.

## Model Catalog Sources

The resolver reads from these sources in order:

1. A custom JSON file from `--catalog` or the `USE_MODEL_CATALOG` environment variable.
2. `codex debug models`, which resolves the same catalog the Codex host uses: dynamic mode refreshes through the configured base URL (including gateway-routed models), static mode reads the file referenced by `model_catalog_json`.

Custom catalogs may define `slug`, `display_name`, `aliases`, `family`, `variant`, `rank`, `priority`, and `supported_reasoning_levels`.
