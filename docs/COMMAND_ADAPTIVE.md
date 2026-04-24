# `galloper adaptive`

> **Purpose** — Run a plan as a closed-loop **adaptive** workflow. After every task, an **evaluator** LLM judges the resulting git diff against the remaining plan. If the plan is still valid, keep going. If reality drifted (surprises, low confidence, or the plan no longer applies), call a **replanner** LLM to rewrite the *remaining* tasks. Completed tasks are locked.

> Think of it as `pipeline` with an inner **execute → evaluate → maybe replan** loop, gated by a confidence threshold and a hard replan budget.

> **Requires a git working tree.** Diffs are how the evaluator sees what happened.

> **Where it sits in the family.** `adaptive` is a **sibling of `pipeline`**, not of `implement`. Its input is a **prompt** — it generates its own initial plan by spawning `galloper plan` internally. You never hand it a `--plan-file`.
>
> ```
>            takes a prompt          takes a plan file
>            ───────────────         ─────────────────
>   plan      ✓                       —
>   implement —                       ✓
>   pipeline  ✓   (plan + execute)    —
>   adaptive  ✓   (plan + execute +   —
>                   evaluate + replan)
> ```

---

## 1. Mental model

```
                  ┌─────────────────────────────────────────────────────┐
                  │                                                     │
   "Your goal" ──►│  Initial plan  (defaultPlanner)                     │
                  │                                                     │
                  └─────────────────────┬───────────────────────────────┘
                                        │
                                        ▼
                ┌─────────────────────────────────────────────────────────┐
                │   ADAPTIVE LOOP   (while remainingTasks not empty)      │
                │                                                         │
                │   ┌───────────────┐    pre-snap = git stash create     │
                │   │ EXECUTE head  │    spawn `galloper implement` with  │
                │   │ of remaining  │    a single-task plan synthesized   │
                │   └──────┬────────┘    from remainingTasks[0]           │
                │          │             post-snap = git stash create     │
                │          │             diff = git diff pre post         │
                │          │             (truncated to diffMaxBytes)      │
                │          ▼                                              │
                │   ┌───────────────┐                                     │
                │   │ EVALUATE      │ ── EVALUATE_PROMPT + diff →         │
                │   │ (single-prompt│    `single-prompt` (defaultEvaluator)│
                │   │  defaultEval) │ ── parse:                           │
                │   └──────┬────────┘    { planStillValid, surprises[],   │
                │          │              confidence, notes }             │
                │          ▼                                              │
                │   ┌───────────────┐    shouldReplan(eval, state, cfg)?  │
                │   │ GATE          │                                     │
                │   │ (no LLM call) │  if SKIP → record reason, advance   │
                │   └──────┬────────┘                                     │
                │          │ proceed                                      │
                │          ▼                                              │
                │   ┌───────────────┐ ── REPLAN_PROMPT (locked completed +│
                │   │ REPLAN        │     current remaining + surprises)→ │
                │   │ (single-prompt│    `single-prompt` (defaultReplanner)│
                │   │  defaultRep.) │ ── parse:                           │
                │   └──────┬────────┘    { remainingTasks: Task[] }       │
                │          │             isNoOpDiff(old, new)?            │
                │          │             • yes → lastReplanWasNoOp=true   │
                │          │             • no  → swap remainingTasks      │
                │          ▼                                              │
                │   ┌───────────────┐                                     │
                │   │ ADVANCE       │  pop head into completedTasks       │
                │   │ persist state │  write galloper-data/adaptive/<id>  │
                │   └───────────────┘                                     │
                │                                                         │
                └─────────────────────────────────────────────────────────┘
```

The loop terminates when `remainingTasks` is empty. The replan budget (`maxReplans`) caps how often the **replanner** can rewrite the tail.

---

## 2. Usage

```bash
# Defaults (threshold 0.7, max 5 replans, 32 KiB diff cap)
galloper adaptive --prompt "Migrate the auth module from sessions to JWT"

# Tune sensitivity
galloper adaptive --prompt "..." --confidence-threshold 0.85 --max-replans 3

# Allow larger diffs to reach the evaluator
galloper adaptive --prompt-file ./goal.txt --diff-max-bytes 65536 --human-friendly
```

### Flags

| Flag | Type | Required | Default | Notes |
|------|------|----------|---------|-------|
| `--prompt <text>` | string | one of these two | — | Inline goal |
| `--prompt-file <path>` | string | one of these two | — | Read goal from file |
| `--config <path>` | string | no | `./galloper.json` | Config file |
| `--confidence-threshold <n>` | float ∈ [0,1] | no | `adaptive.confidenceThreshold` or `0.7` | Below this triggers a replan |
| `--max-replans <n>` | int ≥ 0 | no | `adaptive.maxReplans` or `5` | Hard budget |
| `--diff-max-bytes <n>` | int > 0 | no | `adaptive.diffMaxBytes` or `32768` | Patch truncation cap (file list always preserved) |
| `-v` / `-vv` / `-vvv` | flag | no | 0 | Verbosity |
| `--human-friendly` / `-H` | flag | no | off | Human progress to stderr |

**Resolution order** for the three numerics: CLI flag → `galloper.json` → built-in default.

---

## 3. The four roles

`adaptive` orchestrates four distinct LLM calls — each can be a different command in `galloper.json`:

```
┌────────────┬─────────────────────────┬───────────────────────────────────────────────┐
│ Role       │ Subcommand spawned      │ Resolves from                                  │
├────────────┼─────────────────────────┼───────────────────────────────────────────────┤
│ Planner    │ `galloper plan`         │ defaultPlanner → default                       │
│ Executor   │ `galloper implement`    │ defaultExecutioner → default                   │
│ Evaluator  │ `galloper single-prompt`│ adaptive.defaultEvaluator → defaultPlanner →   │
│            │                         │   default                                      │
│ Replanner  │ `galloper single-prompt`│ adaptive.defaultReplanner → defaultPlanner →   │
│            │                         │   default                                      │
└────────────┴─────────────────────────┴───────────────────────────────────────────────┘
```

You can use a small/fast model for evaluation and a larger one for planning, for example.

---

## 4. The gate (`shouldReplan`)

After every evaluation, the gate decides whether to spend a replan **without** calling the LLM again. A replan is **skipped** when any of:

```
┌──────────────────────────────────────┬──────────────────────┐
│ Condition                            │ Recorded skip reason │
├──────────────────────────────────────┼──────────────────────┤
│ replansUsed >= maxReplans            │ budget-exhausted     │
│ lastReplanWasNoOp === true           │ convergence          │
│ planStillValid                       │ below-threshold      │
│   && confidence >= threshold         │                      │
│   && surprises.length === 0          │                      │
└──────────────────────────────────────┴──────────────────────┘
```

If none of those hold, the replanner LLM is called.

### Convergence detection (`isNoOpDiff`)

If the replanner produces a `remainingTasks` array equivalent to the current one, `lastReplanWasNoOp` flips to `true`, and the **next** evaluation will skip with reason `convergence`. This prevents the loop from burning budget on a "no, really, the plan is fine" stutter.

---

## 5. Replan authority and constraints

The replanner is given the **full** locked completed list and the **full** current remaining list, plus the surprise summary. The contract enforced by the prompt + the driver:

```
                       ┌─ LOCKED ──────────────┐
   completedTasks  ──► │ may NOT be modified   │
                       │ may NOT be referenced │
                       │ as new dependencies   │
                       └───────────────────────┘

                       ┌─ MUTABLE ─────────────────────────────┐
   remainingTasks  ──► │ • insert new tasks AT THE HEAD        │
                       │ • reorder existing remaining tasks    │
                       │ • drop tasks that are no longer needed│
                       │ • to "edit" a task: drop + re-add it  │
                       └───────────────────────────────────────┘
```

---

## 6. State file (the primary artifact)

Path: `galloper-data/adaptive/<runId>.json` — written **after every task** and **after every replan**, so a kill -9 leaves a usable trace.

```jsonc
{
  "runId":              "2026-04-23T15-02-44-918Z",
  "goal":               "Migrate the auth module from sessions to JWT",
  "completedTasks":     [ /* PlanTask[]; locked once added */ ],
  "remainingTasks":     [ /* PlanTask[]; mutated by replanner */ ],
  "evaluations": [
    {
      "planStillValid": true,
      "surprises":      [],
      "confidence":     0.82,
      "notes":          "All declared files modified; tests pass."
    }
    // one entry per task
  ],
  "replans": [
    {
      "taskId":    "t2",
      "ran":       false,
      "skipReason":"below-threshold"
    },
    {
      "taskId":    "t3",
      "ran":       true,
      "before":    [ /* old remainingTasks */ ],
      "after":     [ /* new remainingTasks */ ]
    }
  ],
  "replansUsed":         1,
  "lastReplanWasNoOp":   false
}
```

### Field semantics

| Field | Meaning |
|-------|---------|
| `runId` | Run identifier (ISO timestamp) |
| `goal` | Original user prompt |
| `completedTasks[]` | Tasks that have been executed and evaluated (in order) |
| `remainingTasks[]` | Tasks still to execute; head is "next" |
| `evaluations[]` | One `EvaluationResult` per executed task |
| `replans[]` | One entry per evaluation cycle — whether a replan ran or was skipped, and why |
| `replansUsed` | Count of replans where `ran === true` (compared to `maxReplans`) |
| `lastReplanWasNoOp` | Drives the `convergence` gate on the next iteration |

### `EvaluationResult` (from the evaluator LLM)

| Field | Type | Meaning |
|-------|------|---------|
| `planStillValid` | boolean | Does the remaining plan still make sense? |
| `surprises[]` | string[] | Anything the evaluator didn't expect (gitignored writes, side effects, missing changes) |
| `confidence` | number | Self-rated 0.0–1.0 |
| `notes` | string | Free-form rationale |

### `ReplanRecord`

| Field | Type | Meaning |
|-------|------|---------|
| `taskId` | string | The task whose evaluation produced this decision |
| `ran` | boolean | Did the replanner LLM actually run? |
| `skipReason` | `'budget-exhausted' \| 'convergence' \| 'below-threshold'` | Present iff `ran === false` |
| `before` | task[] | `remainingTasks` immediately before replan (only when `ran === true`) |
| `after` | task[] | `remainingTasks` immediately after replan (only when `ran === true`) |

---

## 7. Diff capture

Per task, the driver captures a git diff between two `git stash create` snapshots so it sees both committed and uncommitted state without disturbing the working tree:

```
   pre   = git stash create     ◄── before executor runs
   exec  = galloper implement <one-task-plan>
   post  = git stash create     ◄── after executor + verify
   diff  = git diff <pre> <post>      ┐
          │                            ├── handed to evaluator
          └─ truncate to diffMaxBytes  │
             (file list ALWAYS kept)   ┘
```

The evaluator receives:
- `goal` (original prompt)
- the just-executed task
- `implementation` = `{ filesChanged: [...], patch: "..." }`
- the `executionExitCode`
- the **remaining** plan

---

## 8. Stdout (`AdaptiveResult`)

```json
{
  "runId":          "2026-04-23T15-02-44-918Z",
  "stateFilePath":  "/.../galloper-data/adaptive/2026-04-23T15-02-44-918Z.json",
  "tasksRun":       7,
  "replansRun":     2,
  "replansSkipped": 5,
  "finalPlan":      [ /* the completedTasks list */ ]
}
```

Verbose progress and human-friendly messages go to **stderr**.

---

## 9. Files written

```
galloper-data/
├── adaptive/
│   ├── <runId>.json                ← AdaptiveState (primary artifact)
│   └── tmp/<runId>-task-*.json     ← per-iteration single-task plans
├── plans/<planId>.json             ← initial plan (PlanFile envelope)
├── runs/<runId>-manifest.json      ← per-task RunManifest (one per implement spawn)
├── sessions/<sessionId>.json       ← every plan / implement / single-prompt subprocess
└── logs/runs.jsonl                 ← every event from every spawn (linear)
```

---

## 10. Hooks

`adaptive` fires hooks at **two layers**:

1. **Inner layer** — every spawned subcommand (`plan`, `implement`, `single-prompt`) fires its own hooks as if you'd called it directly. So all your `pre-task`, `post-task-file`, etc. hooks still run, once per iteration, inside the spawned `implement` process.
2. **Outer layer** — the adaptive loop itself fires **6 lifecycle phases** and **5 events** unique to adaptive runs.

```
adaptive
   │
   ├── (spawn) galloper plan       ──► inner pre-plan / post-plan / run.* events
   │
   ├── event: adaptive.plan.completed
   │
   ├── for each iteration:
   │     ├── pre-iteration                                          (lifecycle)
   │     ├── event: adaptive.iteration.started
   │     ├── (spawn) galloper implement  ──► inner task-loop hooks
   │     ├── pre-evaluate                                           (lifecycle)
   │     ├── (spawn) galloper single-prompt  (evaluator)
   │     ├── event: adaptive.evaluation.completed
   │     ├── post-evaluate                                          (lifecycle)
   │     ├── if gate decides to replan:
   │     │     ├── pre-replan                                       (lifecycle)
   │     │     ├── (spawn) galloper single-prompt  (replanner)
   │     │     └── post-replan                                      (lifecycle)
   │     ├── event: adaptive.replan.decision  (applied | skipped | noop)
   │     ├── post-iteration                                         (lifecycle)
   │     └── event: adaptive.iteration.completed
   │
   └── outer run.completed event (now also dispatched to event hooks)
```

The central `runs.jsonl` log is the unified observability surface for everything that happened.

### 10.1 Adaptive lifecycle phases

| Phase | When | Notes |
|-------|------|-------|
| `pre-iteration` | Top of every loop iteration, after the head task is picked | Ctx: `task`, `iteration` |
| `post-iteration` | Bottom of every loop iteration (after replan decision applied) | Always fires once per trip through the loop |
| `pre-evaluate` | Right before the evaluator subprocess is spawned | |
| `post-evaluate` | After the evaluation has been parsed and stored | |
| `pre-replan` | Right before the replanner subprocess is spawned | **Only fires when the gate decides to run** — skipped/below-threshold/budget-exhausted iterations never see it |
| `post-replan` | After the replanner output has been parsed and applied (or detected as no-op) | Same gating as `pre-replan` |

Phase context is intentionally minimal: `task`, `iteration`, plus the standard `sessionId` / `cwd`. **Rich diagnostic data flows through the events**, not the lifecycle ctx — keep the ctx small so hook commands stay fast and predictable.

A new template token `{iteration}` is available for hook command interpolation.

### 10.2 Adaptive events (rich JSON payload on stdin)

| Event | Payload (selected) |
|-------|--------------------|
| `adaptive.plan.completed` | `{ runId, taskCount }` |
| `adaptive.iteration.started` | `{ runId, iteration, taskId, completedCount, remainingCount }` |
| `adaptive.iteration.completed` | `{ runId, iteration, taskId, replanContinue, completedCount, remainingCount }` |
| `adaptive.evaluation.completed` | `{ runId, iteration, taskId, planStillValid, confidence, surprises, notes }` |
| `adaptive.replan.decision` | `{ runId, iteration, taskId, decision: 'applied' \| 'skipped' \| 'noop', reason?, replansUsed, before?, after? }` |

The outer `run.started` and `run.completed` events also dispatch to event hooks now (previously they were only logged).

### 10.3 Hook abort semantics

Post-phase hooks support `onFailure: 'abort'` exactly like other subcommands. If a `post-evaluate` hook decides "confidence too low, kill the run", configure it as `onFailure: 'abort'` — the dispatcher will throw `AbortHookError`, which propagates out of the adaptive loop and ends the run with `run.failed`.

---

## 11. End-to-end worked example

```
Goal: "Migrate auth from sessions to JWT"

Initial plan (defaultPlanner):
  t1. Add jsonwebtoken dep
  t2. Implement verifyJwt middleware
  t3. Replace session middleware in app.ts
  t4. Update auth tests

Iteration 1: execute t1
  diff: +deps in package.json, +package-lock.json
  evaluator: { planStillValid: true, confidence: 0.91, surprises: [] }
  GATE → below-threshold → SKIP replan
  state: completed=[t1] remaining=[t2,t3,t4] replansUsed=0

Iteration 2: execute t2
  diff: +src/middleware/auth.ts
  evaluator: { planStillValid: true, confidence: 0.78, surprises: [] }
  GATE → below-threshold → SKIP replan
  state: completed=[t1,t2] remaining=[t3,t4] replansUsed=0

Iteration 3: execute t3
  diff: edits app.ts BUT also creates src/middleware/jwtErrorBoundary.ts
  evaluator: { planStillValid: false, confidence: 0.55,
               surprises: ["new error-boundary file not in plan;
                            need test coverage for it"] }
  GATE → not skipped → REPLAN
  replanner inserts at head:
    t3.5  Add tests for jwtErrorBoundary middleware
  state: completed=[t1,t2,t3]
         remaining=[t3.5,t4]
         replansUsed=1
         replans=[{ ran:true, before:[t4], after:[t3.5,t4] }]

Iteration 4: execute t3.5  ... and so on.
```

---

## 12. Why not `pipeline` per task?

A natural-looking alternative would be: instead of spawning `galloper implement` for each task in the loop, spawn `galloper pipeline` — so each task gets re-planned into sub-tasks and then executed. **Don't do this.** It breaks the design in three ways:

### 12.1 The plan IS the decomposition

The `plan` contract requires each task to be **small and verifiable**: declared `files`, concrete `instructions`, a single `verify` shell command that exits 0 on success. A task is sized to fit in **one executioner call** (with retries). If your tasks feel too coarse for that, the right fix is to make the planner prompt decompose harder — not to staple a second planning pass on top.

### 12.2 You'd lose the per-task evaluation signal

The evaluator's job is to look at the **diff produced by exactly one task** and decide whether the remaining plan still makes sense. If a single iteration of the loop runs a `pipeline` (N sub-tasks, N diffs lumped into one), the evaluator sees an aggregated blob and can't tell which sub-step drifted. Surprises become attributable to "the task" rather than "step 3 of the task" — exactly the granularity adaptive exists to give you.

```
                     diff fed to evaluator
                     ────────────────────
   implement per task   one task's changes        clear signal
   pipeline  per task   N sub-tasks' changes      muddied signal
                        mashed together
```

### 12.3 Double planning cost, double drift surface

Every iteration would spend two planner LLM calls (the outer initial plan + an inner per-task plan), and each inner plan would itself be subject to the same kinds of surprises adaptive is built to handle — but **without** an inner evaluator loop to catch them. You'd have hidden drift inside each iteration that the outer evaluator only sees as smoke.

### 12.4 What to do instead

| If you want… | Do this |
|--------------|---------|
| Smaller, more atomic tasks | Tighten the planner prompt; consider a smaller-grain planner command for `defaultPlanner` |
| Per-task replanning before exec | That's already what `adaptive`'s **replanner** does, but at the *plan* level, with locked completed tasks and a budget |
| True hierarchical "epic → tasks → sub-tasks" | Build a separate command (e.g. `adaptive-epic`) that nests `adaptive` calls — keep `adaptive`'s per-task evaluation contract intact |

---

## 13. Error and edge cases

| Scenario | Outcome |
|----------|---------|
| Not in a git working tree | exit 1 — "adaptive requires a git working tree" |
| Initial plan fails | exit 1 with planner stderr tail |
| Per-task `implement` exits non-zero | continue — let the evaluator see it (`executionExitCode` is part of the prompt) |
| Evaluator output unparseable | exit 1 — "adaptive: parsed eval missing planStillValid" |
| Replanner output unparseable | exit 1 — "adaptive: replan output missing remainingTasks" |
| Replanner returns empty `remainingTasks` while goal incomplete | treated as a valid drop; loop ends |
| Replanner returns identical `remainingTasks` | `lastReplanWasNoOp = true`; next eval will skip with `convergence` |
| `maxReplans` reached | future replans skipped with `budget-exhausted`; loop continues to drain `remainingTasks` without rewriting them |

---

## 14. Quick reference card

```
INPUTS                                  OUTPUTS
──────                                  ───────
--prompt | --prompt-file                galloper-data/adaptive/<runId>.json
--confidence-threshold (default 0.7)    AdaptiveResult on stdout
--max-replans          (default 5)      one PlanFile + N RunManifests + many sessions
--diff-max-bytes       (default 32768)  unified events on logs/runs.jsonl
config.adaptive.{eval,replan,...}

GATE SKIP REASONS                       REPLAN AUTHORITY
─────────────────                       ────────────────
budget-exhausted   replansUsed >= max   • insert new tasks AT THE HEAD
convergence        last replan = no-op  • reorder remaining
below-threshold    valid && conf>=th    • drop remaining
                   && no surprises      • completedTasks are LOCKED

DOES                                    DOES NOT
────                                    ────────
• plan, then loop: exec → eval → maybe  • support non-git workspaces (today)
  replan                                • mutate completedTasks
• track surprises and convergence       • commit, push, or otherwise modify history
• use 4 distinct LLM roles
• fire 6 adaptive lifecycle phases +
  5 adaptive.* events (see §10)
• persist state after every iteration
```
