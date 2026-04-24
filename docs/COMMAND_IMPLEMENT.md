# `galloper implement`

> **Purpose** — Take a previously generated plan file and **execute its tasks**: spawn an LLM executioner per task, run the task's `verify` command, classify what changed on disk, and produce a typed **run manifest** describing every attempt and outcome. Includes retry, hook orchestration, and workspace-boundary enforcement.

---

## 1. Mental model

```
   plan.json ──┐
               │
               ▼
   ┌──────────────────────────────────────────────────────────────────┐
   │   TaskRunner                                                     │
   │                                                                  │
   │   ┌──────────────┐  ┌────────────────┐  ┌─────────────────────┐ │
   │   │ topoSort     │─►│ for each task  │─►│ write manifest      │ │
   │   │ (DAG order)  │  │  (see §3)      │  │ after every task    │ │
   │   └──────────────┘  └────────────────┘  └─────────────────────┘ │
   └──────────────────────────────────────────────────────────────────┘
                          │
                          ▼
              <plan-file>.manifest.json    ← primary artifact
```

Per task, the loop is **execute → verify → reconcile → hook → decide**. Failure modes are categorized (`verify`, `hook`, `executor-crash`) and routed through `plan.retryPolicy` to either retry the task or abort it.

---

## 2. Usage

```bash
# Execute the plan you generated earlier
galloper implement --plan-file ./galloper-data/plans/2026-04-23T14-12-08-441Z.json

# More aggressive parallel post-task-file hooks
galloper implement --plan-file ./plan.json --concurrency 8

# Verbose with progress
galloper implement --plan-file ./plan.json -vv --human-friendly
```

### Flags

| Flag | Type | Required | Default | Notes |
|------|------|----------|---------|-------|
| `--plan-file <path>` | string | **yes** | — | Path to `PlanFile` envelope JSON |
| `--config <path>` | string | no | `./galloper.json` | Config file |
| `--concurrency <n>` | int | no | 4 | Parallel `post-task-file` hook dispatches per task |
| `-v` / `-vv` / `-vvv` | flag | no | 0 | Verbosity (stderr) |
| `--human-friendly` / `-H` | flag | no | off | Human progress to stderr |

### Disallowed
- `--prompt` and `--prompt-file` are rejected. The plan is the source of truth.

---

## 3. The per-task loop (the heart of `implement`)

```
   ┌──────────────────────────  ONE TASK  ──────────────────────────┐
   │                                                                │
   │  A.  Capture workspace baseline (per workspace root)           │
   │      • git rev-parse HEAD, status, etc.                        │
   │      • emit workspace.baseline.captured                        │
   │                                                                │
   │  B.  Start FileWatcher (chokidar)                              │
   │                                                                │
   │  C.  Quiesce gate (wait until tree is idle)                    │
   │      • quiesceMs=250ms, timeout=5000ms                         │
   │      • if timeout: workspace.noisy ─► abort task               │
   │                                                                │
   │  D.  RETRY LOOP   for attempt = 1 .. maxAttempts               │
   │  ┌──────────────────────────────────────────────────────────┐  │
   │  │                                                          │  │
   │  │  D1. Run pre-task-file hooks (per declared file)         │  │
   │  │      tokens: {file} {path} {action} {attempt}            │  │
   │  │                                                          │  │
   │  │  D2. Build task prompt (plan, this task, retry context,  │  │
   │  │      previous failure summary, status markers)           │  │
   │  │                                                          │  │
   │  │  D3. Spawn Executioner (LLM)                             │  │
   │  │      • catches crash → executor-crash failure            │  │
   │  │                                                          │  │
   │  │  D4. Run task.verify (shell command)                     │  │
   │  │      • exit 0  → pass                                    │  │
   │  │      • else    → verify failure                          │  │
   │  │                                                          │  │
   │  │  D5. Stop FileWatcher; reconcile changes per root        │  │
   │  │      classify each path:                                 │  │
   │  │          declared    (in task.files, on disk)            │  │
   │  │          surprise    (on disk, not declared)             │  │
   │  │          churn       (touched then reverted)             │  │
   │  │                                                          │  │
   │  │  D6. Out-of-workspace boundary check                     │  │
   │  │      any change outside workspaceRoots → abort           │  │
   │  │      (optional revert-on-abort restores baseline)        │  │
   │  │                                                          │  │
   │  │  D7. post-task-file hooks (parallel, PathLock'd per file)│  │
   │  │      • run on declared ∪ surprise (filter via            │  │
   │  │        runOnSurprise)                                    │  │
   │  │                                                          │  │
   │  │  D8. Decide outcome                                      │  │
   │  │      • no failures        → 'done', exit retry loop      │  │
   │  │      • failures + retry   → next attempt                 │  │
   │  │      • failures + abort   → 'aborted'                    │  │
   │  │      • out of attempts    → 'abandoned'                  │  │
   │  └──────────────────────────────────────────────────────────┘  │
   │                                                                │
   │  E. post-task hook (always runs, success or failure)           │
   │  F. Persist manifest to disk                                   │
   │                                                                │
   └────────────────────────────────────────────────────────────────┘
```

### File-classification semantics

```
                   ┌── on disk now? ──┐
                   │                  │
        declared?  │  YES             │  NO
        ─────────  │ ─────            │ ────
        YES        │ declared         │ churn (touched then reverted)
        NO         │ surprise         │ ── (nothing happened)
```

- **declared** — in `task.files` AND visible in the post-task git diff. Expected.
- **surprise** — a path was changed/created that wasn't in `task.files`. Often gitignored artifacts; routed through `runOnSurprise` filtering.
- **churn** — the watcher saw activity, but the net diff is empty. Useful for catching "wrote then reverted" patterns.
- **out-of-workspace** — any change outside the configured `workspaceRoots`. Always an abort.

---

## 4. Failure categories and `retryPolicy`

The runner classifies every failure into exactly one of three buckets:

| Category | Source | Example |
|----------|--------|---------|
| `verify` | `task.verify` exit ≠ 0 | `npx tsc --noEmit` failed |
| `hook` | a pre/post hook exited non-zero or timed out | linter rejected the file |
| `executor-crash` | the LLM subprocess itself crashed | network drop, OOM kill |

These categories are routed through the plan's `retryPolicy`:

```jsonc
{
  "retryPolicy": {
    "verify":          "retry",   // re-run the task with failure context injected
    "hook":            "retry",   // same
    "executor-crash":  "abort"    // give up immediately
  }
}
```

If all attempts are exhausted, the **task-level disposition** kicks in:

| `onTaskAbandoned` | Effect on the run |
|-------------------|-------------------|
| `continue` (default-ish) | Mark task `'abandoned'`, keep going |
| `abort` | Mark task `'abandoned'`, set run status to `aborted`, stop scheduling new tasks |
| `abort-branch` | Mark dependent subtree as skipped; siblings continue |

---

## 5. Output: the `RunManifest`

Written to `<plan-file>.manifest.json` (or `runManifestPath` if overridden upstream).

```jsonc
{
  "runId":     "2026-04-23T14-22-09-002Z",
  "planId":    "2026-04-23T14-12-08-441Z",
  "createdAt": "2026-04-23T14:22:09.002Z",
  "endedAt":   "2026-04-23T14:24:51.187Z",
  "status":    "completed",            // running | completed | aborted | partial

  "tasks": [
    {
      "id": "t1",
      "title": "Install jsonwebtoken and add types",
      "status": "done",                 // pending | running | done | abandoned | aborted
      "startedAt": "2026-04-23T14:22:09.220Z",
      "endedAt":   "2026-04-23T14:22:43.711Z",
      "attempts": [
        {
          "attemptNumber":      1,
          "startedAt":          "...",
          "endedAt":            "...",
          "executionSessionId": "2026-04-23T14-22-09-220Z",
          "command":            "claude-haiku",
          "verifyExitCode":     0,
          "hookFailures":       [],
          "status":             "completed"
        }
      ]
    }
    // ... one entry per task
  ],

  "taskManifests": {
    "t1": {
      "declared":  [{ "path": "/abs/path/package.json", "action": "edit" }],
      "surprise":  [{ "path": "/abs/path/package-lock.json", "action": "edit" }],
      "churn":     [],
      "perRoot":   { "/abs/path": { "declared": [...], "surprise": [...], "churn": [] } }
    }
  }
}
```

### Run-level `status`

| Status | Meaning |
|--------|---------|
| `running` | In-flight; you're seeing a live snapshot |
| `completed` | All tasks `done` |
| `aborted` | At least one task triggered an `abort` policy |
| `partial` | Some tasks `abandoned` but no full abort |

### `HookFailure`

```jsonc
{
  "hookId":              "post-task-file",
  "phase":               "post-task-file",
  "file":                { "path": "...", "action": "edit" },
  "command":             "eslint --fix {file}",
  "exitCode":            1,
  "stdout":              "...",
  "stderr":              "...",
  "timedOut":            false,
  "durationMs":          812,
  "onFailure":           "retry",
  "category":            "hook",
  "hookRetryCount":      2,
  "hookInvocationId":    "h_…",
  "invocationDurationMs": 1410
}
```

---

## 6. Stdout: the `OrchestratorResult`

```json
{
  "sessionId":       "2026-04-23T14-22-09-002Z",
  "sessionFilePath": "/.../plan.json.manifest.json",
  "exitCode":        0,
  "finalOutput":     "{ ...stringified RunManifest... }"
}
```

Exit code `0` for `completed`, `1` for `aborted`/`partial`.

---

## 7. Files written

```
galloper-data/
├── plans/<planId>.json                        ← (input, not modified)
├── runs/<runId>-manifest.json   OR
└── <plan-file>.manifest.json                  ← primary artifact
├── sessions/<sessionId>.json                  ← one per executioner spawn + verify
├── executions/<executionId>.json              ← per-task execution detail
└── logs/runs.jsonl                            ← every event from every sub-call
```

---

## 8. Hooks fired

```
run.started
   │
   ├── pre-plan   (lifecycle, once)
   │
   ├── for each task:
   │     ├── pre-task                         (per attempt)
   │     ├── for each declared file:
   │     │      └── pre-task-file             (per attempt × per file)
   │     ├── (executioner LLM runs)
   │     ├── (verify command runs)
   │     ├── workspace.baseline.captured / .reconciled / .noisy / .reverted
   │     ├── task.file.declared / .surprise / .churn / .out-of-workspace
   │     ├── for each declared ∪ surprise file:
   │     │      └── post-task-file            (parallel, per file)
   │     ├── task.attempted.failed   OR   task.completed
   │     └── post-task                        (after final attempt)
   │
   ├── post-plan (lifecycle, once)
   │
   └── run.completed | run.failed
```

Hook tokens available in command strings: `{file}`, `{path}`, `{action}`, `{attempt}`, plus the standard set documented in `docs/EVENTS_AND_HOOKS.md`.

Per-hook controls:
- `timeout` (ms) — kill long-running hooks
- `onFailure: retry | warn | abort` — drives the failure category for that invocation
- `onAbort: revert` — restore the workspace to the captured baseline if this hook aborts
- `runOnSurprise: true|false` — whether `post-task-file` fires for surprise paths

---

## 9. Command resolution

```
implement ──► config.defaultExecutioner ──fallback──► config.default
                                              │
                                              └── must allow 'implement'
                                                  in allowedSubcommands /
                                                  disallowedSubcommands
```

Verify commands run via `/bin/sh -c` in the workspace cwd; they don't go through `commands{}`.

---

## 10. Error and edge cases

| Scenario | Outcome |
|----------|---------|
| `--plan-file` missing or unreadable | exit 1, throw at startup |
| Plan JSON invalid / unparsable `content` | exit 1 |
| Cycle in `dependsOn` | exit 1 in `topoSort` |
| Workspace too noisy (quiesce timeout) | task aborted, `workspace.noisy` event |
| Change outside `workspaceRoots` | task aborted, `task.file.out-of-workspace` event |
| Hook timed out | counted as failure with `timedOut: true` |
| Executioner crash | `executor-crash` failure → consult `retryPolicy['executor-crash']` |
| `verify` exits non-zero | `verify` failure → consult `retryPolicy['verify']` |
| All attempts exhausted | task `'abandoned'` → consult `onTaskAbandoned` |

---

## 11. Quick reference card

```
INPUTS                              OUTPUTS
──────                              ───────
--plan-file (REQUIRED)              <plan-file>.manifest.json   (RunManifest)
--concurrency (post-task-file)      OrchestratorResult on stdout
config.defaultExecutioner           sessions/, executions/, logs/runs.jsonl
   ↓ (fallback)                     incremental writes after every task
config.default

DOES NOT                            DOES
────────                            ────
• generate the plan                 • topo-sort tasks
• re-plan on failure                • spawn executioner per task per attempt
• touch outside workspaceRoots      • run task.verify, classify diff
• read --prompt                     • drive retryPolicy + onTaskAbandoned
                                    • fire pre-/post-task[-file] hooks
                                    • persist a typed manifest incrementally
```
