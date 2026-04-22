# Events & Hooks

galloper emits events at key points during execution and supports lifecycle hooks that let you inject custom logic into task execution. Both are configured under the top-level `hooks` key in `galloper.json`.

For a more detailed internal reference (payload fields per event, dispatcher internals), see [`docs/EVENTS_AND_HOOKS.md`](docs/EVENTS_AND_HOOKS.md).

## Events

Events are fired at key points during execution. Subscribe to them via `hooks.events` in the config. Each handler receives a JSON payload on stdin.

| Event | Fired by | Description |
|-------|----------|-------------|
| `run.started` | Orchestrator | Orchestration run begins |
| `run.completed` | Orchestrator | Orchestration run completes successfully |
| `run.failed` | Orchestrator | Orchestration run fails (execution error) |
| `run.crashed` | main() | Bootstrap error before orchestration starts |
| `run.command_resolved` | Orchestrator | Command name is resolved for a subcommand |
| `process.spawn` | CoreRunner | Subprocess is spawned |
| `process.stdout` | CoreRunner | Chunk of stdout from subprocess (fires multiple times) |
| `process.stderr` | CoreRunner | Chunk of stderr from subprocess |
| `plan.started` | Planner | Plan generation begins |
| `plan.completed` | Planner | Plan generation completes successfully |
| `plan.aborted` | Planner | Plan generation fails or is cancelled |
| `task.started` | TaskRunner | Task in a plan begins execution |
| `task.completed` | TaskRunner | Task completes successfully |
| `task.failed` | TaskRunner | Task fails (execution error or max attempts exceeded) |
| `task.attempt.started` | TaskRunner | A task attempt begins (may retry multiple times) |
| `task.attempt.completed` | TaskRunner | A task attempt completes (success or needs retry) |
| `task.attempt.failed` | TaskRunner | A task attempt fails and will be retried or abandoned |
| `task.abandoned` | TaskRunner | Task is abandoned after max retries exhausted |
| `task.aborted` | TaskRunner | Task aborted (blocking dependency failed or hook aborted) |
| `hook.failed` | HookDispatcher | Lifecycle hook execution fails |

## Lifecycle Hooks

Lifecycle hooks are checkpoints during task execution where you can inject custom logic.

| Phase | Fires | onFailure options |
|-------|-------|-------------------|
| `pre-plan` | Before plan generation begins | `warn`, `abort` |
| `post-plan` | After a plan is generated | `warn`, `abort` |
| `pre-task` | Before a task begins execution | `warn`, `retry`, `abort` |
| `post-task` | After a task completes (success or failure) | `warn`, `retry` |
| `pre-task-file` | Before a task creates/edits/deletes a file | `warn`, `retry`, `abort` |
| `post-task-file` | After a task completes a file operation | `warn`, `retry` |

Each lifecycle hook entry accepts:

- `command` (string, optional for `pre-*` phases) — Shell command to execute
- `instructions` (string, optional) — For `pre-*` phases without a command; describes what to do (for LLM consumption)
- `match` (string, required for `*-task-file` phases) — Glob pattern for file matching (e.g., `src/**/*.ts`)
- `action` (string, optional) — For `*-task-file` phases: `"create"`, `"edit"`, or `"delete"`
- `timeoutMs` (number, optional) — Timeout in milliseconds (default: 30000)
- `onFailure` (string, optional) — `"warn"`, `"retry"`, or `"abort"` (default: `"warn"`)

`onFailure` semantics:

- **`warn`** — Log the error but continue execution
- **`retry`** — Retry the operation (up to 3 times by default)
- **`abort`** — Stop execution and fail the entire run

Note: `post-plan` hooks cannot use `"retry"` (plan already generated).

## Example Configuration

```json
{
  "default": "claude-haiku",
  "commands": {
    "claude-haiku": {
      "command": "claude --model claude-haiku-4-5-20251001 --dangerously-skip-permissions",
      "allowedSubcommands": [],
      "disallowedSubcommands": []
    }
  },
  "hooks": {
    "events": {
      "run.started":            [{ "command": "echo '[run.started]' >> galloper-data/hooks.log",            "timeoutMs": 3000 }],
      "run.completed":          [{ "command": "echo '[run.completed]' >> galloper-data/hooks.log",          "timeoutMs": 3000 }],
      "run.failed":             [{ "command": "echo '[run.failed]' >> galloper-data/hooks.log",             "timeoutMs": 3000 }],
      "run.crashed":            [{ "command": "echo '[run.crashed]' >> galloper-data/hooks.log",            "timeoutMs": 3000 }],
      "run.command_resolved":   [{ "command": "echo '[run.command_resolved]' >> galloper-data/hooks.log",   "timeoutMs": 3000 }],
      "process.spawn":          [{ "command": "echo '[process.spawn]' >> galloper-data/hooks.log",          "timeoutMs": 3000 }],
      "process.stdout":         [{ "command": "echo '[process.stdout]' >> galloper-data/hooks.log",         "timeoutMs": 3000 }],
      "process.stderr":         [{ "command": "echo '[process.stderr]' >> galloper-data/hooks.log",         "timeoutMs": 3000 }],
      "plan.started":           [{ "command": "echo '[plan.started]' >> galloper-data/hooks.log",           "timeoutMs": 3000 }],
      "plan.completed":         [{ "command": "echo '[plan.completed]' >> galloper-data/hooks.log",         "timeoutMs": 3000 }],
      "plan.aborted":           [{ "command": "echo '[plan.aborted]' >> galloper-data/hooks.log",           "timeoutMs": 3000 }],
      "task.started":           [{ "command": "echo '[task.started]' >> galloper-data/hooks.log",           "timeoutMs": 3000 }],
      "task.completed":         [{ "command": "echo '[task.completed]' >> galloper-data/hooks.log",         "timeoutMs": 3000 }],
      "task.failed":            [{ "command": "echo '[task.failed]' >> galloper-data/hooks.log",            "timeoutMs": 3000 }],
      "task.attempt.started":   [{ "command": "echo '[task.attempt.started]' >> galloper-data/hooks.log",   "timeoutMs": 3000 }],
      "task.attempt.completed": [{ "command": "echo '[task.attempt.completed]' >> galloper-data/hooks.log", "timeoutMs": 3000 }],
      "task.attempt.failed":    [{ "command": "echo '[task.attempt.failed]' >> galloper-data/hooks.log",    "timeoutMs": 3000 }],
      "task.abandoned":         [{ "command": "echo '[task.abandoned]' >> galloper-data/hooks.log",         "timeoutMs": 3000 }],
      "task.aborted":           [{ "command": "echo '[task.aborted]' >> galloper-data/hooks.log",           "timeoutMs": 3000 }],
      "hook.failed":            [{ "command": "echo '[hook.failed]' >> galloper-data/hooks.log",            "timeoutMs": 3000 }]
    },
    "lifecycle": {
      "pre-plan": [
        {
          "command": "echo '[pre-plan]' >> galloper-data/hooks.log",
          "timeoutMs": 5000,
          "onFailure": "warn"
        }
      ],
      "post-plan": [
        {
          "command": "echo '[post-plan]' >> galloper-data/hooks.log",
          "timeoutMs": 5000,
          "onFailure": "warn"
        }
      ],
      "pre-task": [
        {
          "command": "echo '[pre-task]' >> galloper-data/hooks.log",
          "timeoutMs": 5000,
          "onFailure": "warn"
        }
      ],
      "post-task": [
        {
          "command": "echo '[post-task]' >> galloper-data/hooks.log",
          "timeoutMs": 5000,
          "onFailure": "warn"
        }
      ],
      "pre-task-file": [
        {
          "match": "src/**/*.ts",
          "command": "echo '[pre-task-file] {{file}}' >> galloper-data/hooks.log",
          "timeoutMs": 5000,
          "onFailure": "warn"
        }
      ],
      "post-task-file": [
        {
          "match": "src/**/*.ts",
          "command": "npx eslint {{file}}",
          "timeoutMs": 10000,
          "onFailure": "retry"
        }
      ]
    }
  }
}
```

## Firing Order

**Single-prompt:** `run.started` → `run.command_resolved` → `process.spawn` → `process.stdout/stderr` → `run.completed` / `run.failed`

**Plan:** `run.started` → `plan.started` → `plan.completed` / `plan.aborted` → `run.completed` / `run.failed`

**Implement:** `run.started` → `pre-plan` → `post-plan` → `task.started` → `pre-task` → `post-task` → `task.completed` / `task.failed` → `run.completed` / `run.failed`

**Pipeline (plan + implement):** `run.started` → `plan.started` → `plan.completed` → `pre-plan` → `post-plan` → (per task: `task.started` → `pre-task` → `post-task` → `task.completed`) → `run.completed`
