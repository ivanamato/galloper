# Events and Hooks Reference

This document describes all events and lifecycle hooks emitted by galloper. Configure handlers for these in `galloper.json` under `hooks.events` and `hooks.lifecycle`.

## Events

Events are fired at key points during execution. Subscribe to them via `hooks.events` in the config.

| Event | Description | Fired by | Payload |
|-------|-------------|----------|---------|
| `run.started` | Orchestration run begins (single-prompt, plan, implement, pipeline) | Orchestrator | sessionId, timestamp, subcommand, prompt, cwd |
| `run.completed` | Orchestration run completes successfully | Orchestrator | sessionId, timestamp, exitCode, durationMs, sessionFilePath |
| `run.failed` | Orchestration run fails (execution error) | Orchestrator | sessionId, timestamp, error, subcommand |
| `run.crashed` | Application crashes before orchestration starts (bootstrap error) | main() error handler | sessionId, timestamp, error |
| `run.command_resolved` | Command name is resolved for a subcommand | Orchestrator | sessionId, timestamp, resolvedCommand |
| `process.spawn` | Subprocess is spawned | CoreRunner | sessionId, timestamp, command |
| `process.stdout` | Chunk of stdout received from subprocess (may fire multiple times) | CoreRunner | sessionId, timestamp, chunk |
| `process.stderr` | Chunk of stderr received from subprocess | CoreRunner | sessionId, timestamp, chunk |
| `plan.started` | Plan generation begins | Planner | sessionId, timestamp, prompt |
| `plan.completed` | Plan generation completes successfully | Planner | sessionId, timestamp, planId |
| `plan.aborted` | Plan generation fails or is cancelled | Planner | sessionId, timestamp, error |
| `task.started` | Task in a plan begins execution | TaskRunner | sessionId, timestamp, taskId, title |
| `task.completed` | Task completes successfully | TaskRunner | sessionId, timestamp, taskId, status |
| `task.failed` | Task fails (execution error, verification failed, or max attempts exceeded) | TaskRunner | sessionId, timestamp, taskId, error |
| `task.attempt.started` | A task attempt begins (may retry multiple times) | TaskRunner | sessionId, timestamp, taskId, attempt |
| `task.attempt.completed` | A task attempt completes (success or needs retry) | TaskRunner | sessionId, timestamp, taskId, attempt, status |
| `task.attempt.failed` | A task attempt fails and will be retried or abandoned | TaskRunner | sessionId, timestamp, taskId, attempt, error |
| `task.abandoned` | Task is abandoned after max retries exhausted | TaskRunner | sessionId, timestamp, taskId, attempts |
| `task.aborted` | Task is aborted (blocking dependency failed or post-plan hook aborted) | TaskRunner | sessionId, timestamp, taskId, reason |
| `hook.failed` | Lifecycle hook execution fails (pre-plan, post-task, etc) | HookDispatcher | sessionId, timestamp, phase, error |
| `adaptive.plan.completed` | Initial plan parsed in an adaptive run | AdaptiveDriver | runId, taskCount |
| `adaptive.iteration.started` | Adaptive loop iteration begins | AdaptiveDriver | runId, iteration, taskId, completedCount, remainingCount |
| `adaptive.iteration.completed` | Adaptive loop iteration ends | AdaptiveDriver | runId, iteration, taskId, replanContinue, completedCount, remainingCount |
| `adaptive.evaluation.completed` | Evaluator returned a verdict for the just-executed task | AdaptiveDriver | runId, iteration, taskId, planStillValid, confidence, surprises, notes |
| `adaptive.replan.decision` | Gate decided whether to replan; carries the verdict and (when applied) before/after plans | AdaptiveDriver | runId, iteration, taskId, decision: 'applied' \| 'skipped' \| 'noop', reason?, replansUsed, before?, after? |

### Example Event Hook Configuration

```json
{
  "hooks": {
    "events": {
      "run.started": [
        {
          "command": "echo '[run.started]' >> galloper-data/hooks.log",
          "timeoutMs": 3000
        }
      ],
      "task.completed": [
        {
          "command": "echo '[task.completed]' >> galloper-data/hooks.log",
          "timeoutMs": 3000
        }
      ]
    }
  }
}
```

## Lifecycle Hooks

Lifecycle hooks are checkpoints during task execution where you can inject custom logic. Configure them via `hooks.lifecycle` in the config.

### Hook Phases

| Phase | Description | Fires | onFailure options |
|-------|-------------|-------|-------------------|
| `pre-plan` | Before plan generation begins | Once per plan generation | `warn`, `abort` |
| `post-plan` | After a plan is generated | Once per plan generation | `warn`, `abort` |
| `pre-task` | Before a task begins execution | Once per task | `warn`, `retry`, `abort` |
| `post-task` | After a task completes (success or failure) | Once per task | `warn`, `retry` |
| `pre-task-file` | Before a task creates/edits/deletes a file | Once per file operation | `warn`, `retry`, `abort` |
| `post-task-file` | After a task completes a file operation | Once per file operation | `warn`, `retry` |
| `pre-iteration` | Top of an adaptive-loop iteration (after the head task is picked) | Once per iteration (adaptive only) | `warn`, `abort` |
| `post-iteration` | Bottom of an adaptive-loop iteration | Once per iteration (adaptive only) | `warn`, `abort` |
| `pre-evaluate` | Before the adaptive evaluator subprocess is spawned | Once per iteration (adaptive only) | `warn`, `abort` |
| `post-evaluate` | After the evaluation has been parsed and stored | Once per iteration (adaptive only) | `warn`, `abort` |
| `pre-replan` | Before the adaptive replanner is spawned (only when the gate decides to run) | Conditional: skipped/below-threshold/budget-exhausted iterations don't fire it | `warn`, `abort` |
| `post-replan` | After the replanner output is parsed (or detected as no-op) | Same gating as `pre-replan` | `warn`, `abort` |

### Hook Configuration

Each hook in `hooks.lifecycle` can specify:

- **`command`** (string or string[], optional for pre-* phases) - The command to execute. Type depends on `shell`:
  - `shell: true` (default) → `command: string` passed to `/bin/sh -c`.
  - `shell: false` → `command: string[]` spawned directly; `argv[0]` is the executable.
- **`shell`** (boolean, optional, default `true`) - Execution mode. Argv mode (`shell: false`) bypasses the shell and the path-safety check entirely.
- **`instructions`** (string, optional) - For pre-* phases without a command; describes what to do (for LLM consumption)
- **`match`** (string, required for `pre-task-file` / `post-task-file`) - Glob pattern for file matching (e.g., `src/**/*.ts`)
- **`action`** (string, optional) - For `*-task-file` phases: `"create"`, `"edit"`, or `"delete"`
- **`runOnSurprise`** (boolean, optional, `post-task-file` only, default `false`) - When `true`, the hook fires on paths classified as `surprise` (written but not declared). See trust-boundary docs.
- **`timeoutMs`** (number, optional) - Timeout in milliseconds (default: 30000)
- **`onFailure`** (string, optional) - What to do if hook fails: `"warn"`, `"retry"`, or `"abort"` (default: `"warn"`)
- **`retry`** (object, optional, `post-task-file` only) - Per-hook retry with exponential backoff. See "Retry-with-backoff" below.
- **`destructive`** (boolean, optional, default `false`) - Required acknowledgement when the command matches any pattern in `DestructivePatterns`. See "Destructive-hook gating" below.
- **`onAbort`** (`"revert"` | `"keep"`, optional, `post-task-file` only, default `"keep"`) - Controls what happens to the workspace if this hook aborts the task. See "onAbort rollback" below.

### Template Placeholders

`command` strings (shell mode) and every element of `command` arrays (argv mode) are run through placeholder substitution at dispatch time. Unknown tokens are left untouched. Unset fields become the empty string.

| Placeholder | Value |
|---|---|
| `{file}` | Posix-style path of the file being hooked (empty for plan-level / task-level phases) |
| `{path}` | Alias of `{file}` |
| `{action}` | `create` \| `edit` \| `delete` (empty when no file) |
| `{classification}` | `declared` \| `surprise` \| `churn` (empty when not file-scoped) |
| `{sessionId}` | Session id for the run |
| `{taskId}` | Task id (empty for plan-level phases) |
| `{attempt}` | Retry-loop attempt number (empty when not applicable) |
| `{root}` | The hook's `cwd`, posix-normalized |
| `{iteration}` | Adaptive-loop iteration index (0-based); empty for non-adaptive phases |

The legacy `DEVFLOW_*` environment variables (`DEVFLOW_SESSION_ID`, `DEVFLOW_CWD`, `DEVFLOW_FILE_PATH`, `DEVFLOW_FILE_ACTION`) remain set in both modes for back-compat.

### Path-safety (shell mode)

In shell mode, if a command string contains `{file}` or `{path}` and the underlying file path contains shell metacharacters outside the safe charset `[A-Za-z0-9._/\-@+=,~:]`, the hook is **skipped** for that file. A `HookFailure` with `stderr: "skipped: path-injection-risk"` is recorded on the attempt for post-hooks; pre-hooks emit a `console.warn`. Other hooks in the chain continue unaffected.

Argv mode (`shell: false`) is not subject to this check — argv strings are not word-split or shell-expanded, so any bytes are safe to pass.

If you need to operate on arbitrary filenames from a post-task-file hook, use argv mode:

```json
{
  "match": "**/*",
  "shell": false,
  "command": ["./scripts/lint.sh", "{file}"]
}
```

### Destructive-hook gating

At config-load time, every hook's `command` (string or string[]) is scanned against a conservative set of patterns known to be dangerous under automated repetition. If any pattern matches and the hook does not have `"destructive": true` set, **config load fails** with an error naming the matched pattern.

The flag is **acknowledgement, not protection** — it does not change runtime behavior. It exists to force the author of the config to pause and think once at write time, so a dangerous command cannot drift in unnoticed.

**Patterns currently flagged** (see `src/lib/DestructivePatterns.ts` for regexes):

| Pattern | Example matches |
|---|---|
| `rm -rf` | `rm -rf foo`, `rm -fr foo`, `rm -Rf foo`, `rm -r -f foo`, `rm -f -r foo` |
| `git reset --hard` | `git reset --hard HEAD~1`, `git reset --quiet --hard` |
| `git push --force` | `git push --force origin main` (note: `--force-with-lease` is NOT flagged) |
| `git clean -f` | `git clean -fd`, `git clean --force` (note: `--dry-run` is NOT flagged) |
| `dd of=` | `dd if=/dev/zero of=/tmp/file` |
| `mkfs` | `mkfs`, `mkfs.ext4`, `mkfs.xfs` |
| `find -delete` | `find . -name '*.log' -delete` |
| `chmod -R` / `chmod --recursive` | `chmod -R 777 .` |
| `chown -R` / `chown --recursive` | `chown -R user:user .` |

**Known false positives:** a shell-mode command that echoes any of these as literal text (e.g. `echo "rm -rf something"`) also trips the gate. That's intentional — the scan treats any substring match as a hit, because the validator has no general shell parser. Add `"destructive": true` to silence it.

**How to acknowledge:**
```json
{
  "match": "**/*",
  "command": "rm -rf ./build",
  "destructive": true
}
```

**How to avoid it:** rewrite with argv mode and a surgical path, or use a non-destructive alternative (`git restore`, `rimraf`, etc.).

### onAbort rollback

When a `post-task-file` hook is configured with `"onFailure": "abort"` and its command exits non-zero, the hook *aborts the current task* (not the whole run — the task is marked aborted, later tasks continue unless `onTaskAbandoned: "abort"` is set). Whatever the task wrote to disk before the abort fired stays there by default.

`onAbort` controls that behavior:

- `"keep"` (default) — do nothing; partial task writes remain on disk.
- `"revert"` — before propagating the abort, restore the workspace to the state captured at the start of the task via `captureBaseline`.

**How revert is implemented:**
1. `git reset --hard <baseline HEAD>` — restores tracked files to the committed snapshot.
2. `git clean -fd` — removes any untracked files created during the task.
3. If the baseline captured a `stashSha` (tracked dirty state present at baseline), `git stash apply <sha>` replays that dirty state on top.

**Destructive-by-design:** `git reset --hard` + `git clean -fd` run on the task's `cwd`. Any uncommitted untracked files in `cwd` at the moment revert fires are **wiped**, whether they were there before the task or written by the task. That's the point of revert — but it means running `onAbort: revert` with a `cwd` that also contains work you care about will eat that work. Use it only against workspaces you're prepared to reset.

**v1 limitation — untracked files at baseline are not restored.** `captureBaseline` uses `git stash create` (read-only, so baseline capture never mutates the tree). `stash create` only captures tracked-dirty state; it has no equivalent for untracked. If a user has untracked files present when baseline is captured, revert's `git clean -fd` deletes them and the later `git stash apply` won't put them back. This is a conscious trade-off: the only way to capture untracked non-destructively would be a filesystem snapshot outside git, which is deferred to a later pass. Config authors who need to protect untracked workspace files should not use `onAbort: revert`, or should commit-or-stage the files before running galloper.

**Safety checklist before enabling `onAbort: revert`:**
1. The `cwd` galloper runs in is a dedicated workspace (a task sandbox, a checked-out branch, a worktree) — not your daily editor's repo.
2. Tracked files in `cwd` are committed at baseline time OR dirty state is acceptable to snapshot and replay (`stash create` handles this).
3. Untracked files in `cwd` are either absent or disposable — they will be wiped on revert.
4. You understand that `git reset --hard` and `git clean -fd` will run; you would not be surprised to see them in `git reflog`.

**Example — safe use:**
```json
{
  "match": "**/*.ts",
  "shell": false,
  "command": ["./scripts/typecheck.sh", "{file}"],
  "onFailure": "abort",
  "onAbort": "revert"
}
```
`galloper implement --plan-file ...` run inside a per-task git worktree: the task writes `.ts` files, the hook type-checks, and on failure the worktree is reset cleanly. The user's daily editor cwd is untouched.

**Example — dangerous use (don't do this):**
Same hook, but running `galloper implement` in the directory where you're actively editing code with uncommitted changes. The revert would wipe that work.

**Events emitted:** on every abort where `onAbort` is consulted, a `workspace.reverted` event is appended to the central log with `{ taskId, reverted: boolean, reason?: string }`. `reason` carries `"non-git"`, `"unborn-branch"`, or a git stderr snippet when revert was skipped or failed; absent when `reverted: true`.

### Retry-with-backoff

Post-task-file hooks accept a `retry` policy:

```json
{
  "match": "**/*.ts",
  "command": "npx eslint --fix {file} && npx eslint {file}",
  "onFailure": "retry",
  "retry": { "maxAttempts": 3, "backoffMs": 250, "jitter": 0.2 }
}
```

- `maxAttempts` — integer in `[1, 20]`. Hook re-runs up to this many times on non-zero exit.
- `backoffMs` — non-negative integer. Base delay between attempts; exponential: `backoffMs * 2^(n-1)`.
- `jitter` — optional number in `[0, 1]`. Adds `± backoffMs * jitter * rand(-1,1)` to each delay to avoid thundering-herd.

Retry kicks in only when `onFailure` resolves to `"retry"` (the default). A hook with `onFailure: "warn"` or `"abort"` skips the retry loop even if `retry` is set — retry is paired with "this is intended to be retried" semantics. The final `HookFailure` reports `hookRetryCount` = the number of attempts actually made.

### Example Lifecycle Hook Configuration

```json
{
  "hooks": {
    "lifecycle": {
      "pre-plan": [
        {
          "command": "echo '[pre-plan] Checking environment' >> galloper-data/hooks.log",
          "timeoutMs": 5000,
          "onFailure": "warn"
        }
      ],
      "post-task": [
        {
          "command": "echo '[post-task] Cleanup' >> galloper-data/hooks.log",
          "timeoutMs": 5000,
          "onFailure": "warn"
        }
      ],
      "post-task-file": [
        {
          "match": "src/**/*.ts",
          "command": "npx eslint {file}",
          "timeoutMs": 10000,
          "onFailure": "retry"
        },
        {
          "match": "**/*.sh",
          "shell": false,
          "command": ["./scripts/shellcheck.sh", "{file}"],
          "runOnSurprise": true
        }
      ]
    }
  }
}
```

## When Hooks Fire

### Single-Prompt Execution
- `run.started` → `run.command_resolved` → `process.spawn` → `process.stdout/stderr` (multiple) → `run.completed` or `run.failed`

### Plan Execution
- `run.started` → `plan.started` → (plan generation) → `plan.completed` or `plan.aborted` → `run.completed` or `run.failed`

### Implement Execution (with TaskRunner)
- `run.started` → `pre-plan` (hook) → `post-plan` (hook) → `task.started` → `pre-task` (hook) → (task execution) → `post-task` (hook) → `task.completed` or `task.failed` → `run.completed` or `run.failed`

### Pipeline Execution (Plan + Implement)
- `run.started` → `plan.started` → (plan generation) → `plan.completed` → `pre-plan` (hook) → `post-plan` (hook) → `task.started` → `pre-task` (hook) → (task execution) → `post-task` (hook) → `task.completed` → ... (next task) ... → `run.completed`

### Adaptive Execution
The adaptive subcommand spawns inner `plan` / `implement` / `single-prompt` subprocesses (each firing their own hooks as documented above) AND fires its own outer-layer phases and events around the loop:

```
run.started (outer)
   │
   ├── (spawn) galloper plan      → fires inner pre-plan / post-plan / run.* events
   ├── adaptive.plan.completed (event)
   │
   ├── for each iteration:
   │     ├── pre-iteration (hook) + adaptive.iteration.started (event)
   │     ├── (spawn) galloper implement → fires inner task-loop hooks
   │     ├── pre-evaluate (hook)
   │     ├── (spawn) galloper single-prompt → evaluator
   │     ├── adaptive.evaluation.completed (event) + post-evaluate (hook)
   │     ├── if gate decides to replan:
   │     │      pre-replan (hook) → (spawn) replanner → post-replan (hook)
   │     ├── adaptive.replan.decision (event: applied | skipped | noop)
   │     └── post-iteration (hook) + adaptive.iteration.completed (event)
   │
   └── run.completed (outer; now also dispatched to event hooks)
```

See `COMMAND_ADAPTIVE.md` §10 for the per-phase context and event payload reference.

## Error Handling

- **`warn`**: Log the error but continue execution
- **`retry`**: Retry the operation (up to 3 times by default)
- **`abort`**: Stop execution and fail the entire run

Note: `post-plan` hooks cannot use `"retry"` (plan already generated).
