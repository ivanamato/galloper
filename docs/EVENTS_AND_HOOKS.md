# Events and Hooks Reference

This document describes all events and lifecycle hooks emitted by devflowv3. Configure handlers for these in `llm-config.json` under `hooks.events` and `hooks.lifecycle`.

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

### Example Event Hook Configuration

```json
{
  "hooks": {
    "events": {
      "run.started": [
        {
          "command": "echo '[run.started]' >> devflowv3-data/hooks.log",
          "timeoutMs": 3000
        }
      ],
      "task.completed": [
        {
          "command": "echo '[task.completed]' >> devflowv3-data/hooks.log",
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

### Hook Configuration

Each hook in `hooks.lifecycle` can specify:

- **`command`** (string, optional for pre-* phases) - Shell command to execute
- **`instructions`** (string, optional) - For pre-* phases without a command; describes what to do (for LLM consumption)
- **`match`** (string, required for `pre-task-file` / `post-task-file`) - Glob pattern for file matching (e.g., `src/**/*.ts`)
- **`action`** (string, optional) - For `*-task-file` phases: `"create"`, `"edit"`, or `"delete"`
- **`timeoutMs`** (number, optional) - Timeout in milliseconds (default: 30000)
- **`onFailure`** (string, optional) - What to do if hook fails: `"warn"`, `"retry"`, or `"abort"` (default: `"warn"`)

### Example Lifecycle Hook Configuration

```json
{
  "hooks": {
    "lifecycle": {
      "pre-plan": [
        {
          "command": "echo '[pre-plan] Checking environment' >> devflowv3-data/hooks.log",
          "timeoutMs": 5000,
          "onFailure": "warn"
        }
      ],
      "post-task": [
        {
          "command": "echo '[post-task] Cleanup' >> devflowv3-data/hooks.log",
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

## When Hooks Fire

### Single-Prompt Execution
- `run.started` → `run.command_resolved` → `process.spawn` → `process.stdout/stderr` (multiple) → `run.completed` or `run.failed`

### Plan Execution
- `run.started` → `plan.started` → (plan generation) → `plan.completed` or `plan.aborted` → `run.completed` or `run.failed`

### Implement Execution (with TaskRunner)
- `run.started` → `pre-plan` (hook) → `post-plan` (hook) → `task.started` → `pre-task` (hook) → (task execution) → `post-task` (hook) → `task.completed` or `task.failed` → `run.completed` or `run.failed`

### Pipeline Execution (Plan + Implement)
- `run.started` → `plan.started` → (plan generation) → `plan.completed` → `pre-plan` (hook) → `post-plan` (hook) → `task.started` → `pre-task` (hook) → (task execution) → `post-task` (hook) → `task.completed` → ... (next task) ... → `run.completed`

## Error Handling

- **`warn`**: Log the error but continue execution
- **`retry`**: Retry the operation (up to 3 times by default)
- **`abort`**: Stop execution and fail the entire run

Note: `post-plan` hooks cannot use `"retry"` (plan already generated).
