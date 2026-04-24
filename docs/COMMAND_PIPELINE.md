# `galloper pipeline`

> **Purpose** — Run `plan` **and** `implement` **back-to-back in a single process**, from a single prompt. The plan is generated, written to disk, then immediately executed. You get both artifacts: the plan file and the run manifest.

> Use `pipeline` when you trust the planner enough to not need human review between decomposition and execution. If you want to inspect or edit the plan first, use `plan` → `implement` separately.

---

## 1. Mental model

```
   "Your prompt"
        │
        ▼
   ┌────────────┐   plan.json
   │  PLAN      │ ─────────────┐
   │  (LLM)     │              │
   └────────────┘              │
        │                      │
        │  pre-plan / post-plan│  (lifecycle hooks, in-process)
        ▼                      ▼
   ┌────────────────────────────────────────────────┐
   │          IMPLEMENT  (TaskRunner)               │
   │  task loop, retries, verify, reconcile, hooks  │
   └────────────────────────────────────────────────┘
        │
        ▼
   manifest.json
```

Both stages share the **same process** and the **same session ID family**, so events from plan + execute land in one linear trace on `galloper-data/logs/runs.jsonl`. The two sub-stages still write their own separate artifacts.

---

## 2. Usage

```bash
# Plan-then-execute from a prompt
galloper pipeline --prompt "Add JWT auth middleware to the Express app"

# From a prompt file with human-friendly progress
galloper pipeline --prompt-file ./tasks/jwt-auth.txt --human-friendly

# Full debug output, higher hook parallelism
galloper pipeline --prompt "..." -vvv --concurrency 8
```

### Flags

| Flag | Type | Required | Default | Notes |
|------|------|----------|---------|-------|
| `--prompt <text>` | string | one of these two | — | Inline task description |
| `--prompt-file <path>` | string | one of these two | — | Read prompt from file |
| `--config <path>` | string | no | `./galloper.json` | Config file |
| `--concurrency <n>` | int | no | 4 | Parallel `post-task-file` hooks (forwarded to implement) |
| `-v` / `-vv` / `-vvv` | flag | no | 0 | Verbosity |
| `--human-friendly` / `-H` | flag | no | off | Human progress to stderr |

### Disallowed
- `--plan-file` — the plan is generated, not provided.

---

## 3. Flow

```
 STEP 1   CLI parsing + config load
          │
          ▼
 STEP 2   Resolve planner command
          │   defaultPlanner → default
          ▼
 STEP 3   Lifecycle hook: pre-plan
          │
          ▼
 STEP 4   Planner.plan(prompt)
          │   • PLAN_PROMPT template + prompt → LLM
          │   • parse + validate
          │   • write galloper-data/plans/<planId>.json
          ▼
 STEP 5   Lifecycle hook: post-plan
          │   • if it aborts → entire pipeline aborts BEFORE execution
          ▼
 STEP 6   Resolve executioner command
          │   defaultExecutioner → default
          ▼
 STEP 7   TaskRunner.run(planFilePath)
          │   • same per-task loop as `implement`
          │   • writes manifest incrementally
          ▼
 STEP 8   Final RunManifest + OrchestratorResult on stdout
```

Key property: **step 5 (`post-plan`) is the abort gate**. If you need a policy like "don't execute plans that touch security code without a review", wire it here as a `post-plan` hook with `onFailure: abort`.

---

## 4. Outputs

Both artifacts are produced:

```
galloper-data/
├── plans/<planId>.json                ← PlanFile envelope (same shape as `plan`)
├── runs/<runId>-manifest.json         ← RunManifest (same shape as `implement`)
├── sessions/<sessionId>.json          ← one per LLM subprocess (planner + per-task)
├── executions/<executionId>.json      ← per-task execution detail
└── logs/runs.jsonl                    ← single linear event log
```

### Stdout (`OrchestratorResult`)

```json
{
  "sessionId":       "2026-04-23T14-22-09-002Z",
  "sessionFilePath": "/.../galloper-data/runs/2026-04-23T14-22-09-002Z-manifest.json",
  "exitCode":        0,
  "finalOutput":     "{ ...stringified RunManifest... }",
  "planFilePath":    "/.../galloper-data/plans/2026-04-23T14-12-08-441Z.json",
  "runManifestPath": "/.../galloper-data/runs/2026-04-23T14-22-09-002Z-manifest.json"
}
```

> Note: `pipeline` is the one subcommand whose result carries **both** `planFilePath` and `runManifestPath`.

---

## 5. Hooks fired

```
run.started
   │
   ├── pre-plan          (before planner LLM)
   ├── (planner runs, plan written)
   ├── post-plan         (after plan written — abort gate)
   │
   ├── (per-task loop — same as `implement`)
   │    ├── pre-task, pre-task-file
   │    ├── executioner, verify, reconcile
   │    ├── post-task-file, post-task
   │    └── task.* events
   │
   └── run.completed | run.failed
```

All events from **both** sub-stages land in the same `runs.jsonl` in order.

---

## 6. Command resolution

`pipeline` consults **two** config fields:

| Stage | Resolves from | Fallback |
|-------|---------------|----------|
| Plan | `config.defaultPlanner` | `config.default` |
| Implement | `config.defaultExecutioner` | `config.default` |

Each resolved command must allow its respective subcommand (`plan` / `implement`) in `allowedSubcommands` / `disallowedSubcommands`. Nothing else is special about pipeline at the config level — it is just the union of the two.

---

## 7. When to use `pipeline` vs the alternatives

```
┌────────────────────────┬──────────────────────────────────────────────┐
│ Situation              │ Command                                       │
├────────────────────────┼──────────────────────────────────────────────┤
│ Want to see the plan   │ `plan` now, `implement` later                 │
│ before executing       │                                              │
│                        │                                              │
│ Trust the planner,     │ `pipeline`                                    │
│ one-shot task          │                                              │
│                        │                                              │
│ Plan is already        │ `implement --plan-file ...`                   │
│ written                │                                              │
│                        │                                              │
│ Task is exploratory    │ `adaptive` (plan + execute + evaluate +       │
│ and may need replans   │   replan loop)                                │
└────────────────────────┴──────────────────────────────────────────────┘
```

---

## 8. Error and edge cases

| Scenario | Outcome |
|----------|---------|
| Neither `--prompt` nor `--prompt-file` | exit 1 at CLI parse |
| Plan LLM exits non-zero | pipeline fails before implement stage |
| Plan JSON invalid / DAG cycle | pipeline fails before implement stage |
| `post-plan` hook returns non-zero with `onFailure: abort` | pipeline aborts; no tasks executed |
| Task fails → `retryPolicy` + `onTaskAbandoned` decide | same as `implement` |
| Workspace drift / out-of-workspace write | task aborted; run status may be `aborted` or `partial` |

---

## 9. Quick reference card

```
INPUTS                              OUTPUTS
──────                              ───────
--prompt | --prompt-file            galloper-data/plans/<id>.json
--concurrency (post-task-file)      galloper-data/runs/<runId>-manifest.json
config.defaultPlanner               OrchestratorResult on stdout (BOTH paths)
config.defaultExecutioner           one linear event log
   ↓ both fall back to
config.default

DOES                                DOES NOT
────                                ────────
• plan and execute in one process   • accept an existing plan file
• share a central log               • evaluate or replan (use `adaptive`)
• honor post-plan as an abort gate  • pause for human review between stages
```
