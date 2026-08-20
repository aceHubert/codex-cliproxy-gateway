# New Thread Task Packet

Adapted from the `luna-task-lane` contract. It replaces the fixed Luna/max lane with any resolved model and reasoning level.

## Prerequisites

- The current host must expose thread tools: `list_projects`, `list_threads`, `create_thread`, `wait_threads`, `read_thread`, and `send_message_to_thread`.
- Use only the `model.slug` and `reasoning` returned by `resolve-model.py`.
- Stop when the model or reasoning level is unavailable. Do not fall back to another model, reasoning level, agent, or lane.

## Creating a Thread

1. Call `list_projects`, select the target project, and confirm `isGitRepository`.
2. Create the task with `create_thread` using the complete packet, resolved model, and reasoning level.
3. Use an isolated worktree by default for Git projects; use the local environment for non-Git projects.
4. Accept only the returned `threadId` and `hostId` as the task identity. If only `clientThreadId` is returned, discover the real thread with `list_threads`; never pass the pending client ID to `wait_threads`, `read_thread`, or `send_message_to_thread`.

## Full Task Packet

Replace every placeholder. The packet must be executable without access to the primary conversation.

~~~text
ROLE
Act as the implementation worker in the requested model task lane.
Prepare the requested changes and evidence within this packet. Do not redesign
the architecture, broaden ownership, create a PR, or push changes without the
explicit primary authorization stated below. Preserve edits you encounter and
do not revert unrelated work.

OBJECTIVE
<objective>

FILES AND OWNERSHIP
You own only:
- <owned files or directories>
You do not own:
- <excluded files or directories>
Preserve other edits and adapt to concurrent changes.

INTERFACES
- <signatures, schemas, commands, routes, APIs, or behavior that must remain compatible>

CONSTRAINTS
- <constraints>
- This task uses <resolved model slug> at <resolved reasoning> reasoning as
  requested by the primary task.
- Do not use native subagent routing, a companion-agent TOML, or an unapproved
  model or effort as a substitute.

STARTING STATE / BASE
- Project ID: <projectId>
- Project repository: <repository path>
- Target environment: <worktree | local>
- Base branch/ref or working-tree state: <base>
- Existing task identity, if this is a correction: <threadId/hostId>
- Prior accepted stack/commit, if dependent: <commit>

VERIFICATION
- Run: <command>
  Success: <expected output>
- Run: <command>
  Success: <expected output>
- Inspect: <artifact>
  Success: <expected result>

GIT / PR BOUNDARY
- Inspect and report git status, base, changed files, diff, and commit state.
- Commit only when the primary packet explicitly requests a commit; report the
  exact SHA and do not rewrite accepted history.
- Do not push, open, update, or merge a PR until the primary sends explicit
  PR authorization after reviewing the actual diff and checks.
- Do not start or alter another stack, rebase on unaccepted work, or claim that
  an isolated worktree makes concurrent edits merge-safe.

STRUCTURED RETURN
STATUS: complete | partial | blocked
TASK ID: <threadId, hostId, and any clientThreadId history>
OBJECTIVE: <objective>
STARTING STATE: <project, environment, base, and observed branch/worktree>
CHANGES: <changed files and summary>
VERIFIED: <commands run and results>
GIT: <status, changed files, commit SHA, branch, and base>
PR: <PR state if any>
JUDGMENT CALLS: <decisions>
GAPS: <remaining risks>
~~~

## Monitoring and Acceptance

- Monitor with bounded `wait_threads` calls and read the final handoff with `read_thread`.
- Inspect the actual worktree, branch, base, complete diff, commits, and verification output independently.
- Send corrections with `send_message_to_thread` to the same `threadId`, then monitor and read that task again.
- Send explicit PR authorization only after the primary task accepts the actual diff and checks, and record the branch, commit, and PR evidence.
