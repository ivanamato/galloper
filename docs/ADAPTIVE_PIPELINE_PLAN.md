# Adaptive Pipeline — Implementation Plan

## Overview

A new `adaptive` subcommand that runs a plan as an **adaptive loop** instead of a straight-through pipeline. For each task it:

1. **Executes** the task (deconstruct step is inline — the executioner prompt instructs the LLM to think through sub-steps before acting; no separate LLM call, no extra file).
2. **Captures** the implementation artifact — a `git diff` of what actually changed on disk.
3. **Evaluates** whether the remaining plan is still right, given what the diff shows.
4. **Gates** on the evaluation: only re-plans when the evaluator signals the plan needs to change, and only within a budget.
5. **Re-plans** when gated in — can reorder, drop, or insert remediation tasks at the head of remaining. Completed tasks are locked.
6. Proceeds to the next task.

This complements (does not replace) the existing `pipeline` subcommand, which stays as the straight-through path.

---

## Settled design decisions

| Decision | Choice | Rationale |
|---|---|---|
| Deconstruct scope | Inline reasoning in executioner prompt | Cheaper; no extra LLM call or file |
| Re-plan authority | Insert-at-head + reorder/drop remaining; **completed tasks locked** | Prevents full-history rewrite thrash |
| No-op detection | Strict JSON equality on `remainingTasks` | Simpler, safer v1 |
| Evaluator input | `git diff` of implementation, **not** executioner self-report | Ground truth over self-report |
| Diff size policy | Hard truncate to `diffMaxBytes`, but preserve **full file list** | Evaluator sees scope even when patches clipped |
| VCS support | git-only in v1; explicit error on non-git roots | Manifest fallback deferred to v2 |
| Evaluator scope | "Is the remaining plan still right?" (one evaluator, one job) | Task success is read from executioner exit code separately |
| Prompt template location | `src/lib/PromptTemplates.ts` as `export const` | Matches existing pattern for `PLAN_PROMPT` / `IMPLEMENT_PROMPT` |
| Executioner reuse | `AdaptiveRunner` calls `Executioner.implement({ prompt })` per task | Executioner is already task-agnostic; same pattern `TaskRunner` uses |

---

## CLI surface

New subcommand, parallel to `pipeline`:

```bash
galloper adaptive --prompt "..." \
  [--confidence-threshold 0.7] \
  [--max-replans 5] \
  [--diff-max-bytes 32768]
```

All three flags override the corresponding `galloper.json` values for a single run. Flags not passed fall back to config, which falls back to hard-coded defaults.

---

## Data flow per task

```
plan.json (from Planner — same plan format as `pipeline`)
  │
  └─► for each task:
        1. snapshot preSnap = GitDiffCapture.snapshot()
        2. execute  = Executioner.implement({ prompt: task.instructions })
        3. snapshot postSnap = GitDiffCapture.snapshot()
        4. diff     = GitDiffCapture.diff(preSnap, postSnap, diffMaxBytes)
                      → { patch: string (truncated), filesChanged: string[],
                          truncated: bool, fullSizeBytes: number }
        5. evaluate = Evaluator.evaluate({
                        goal, task, implementation: diff,
                        executionExitCode, remainingPlan })
                      → { planStillValid, surprises[], confidence, notes }
        6. gate     = shouldReplan(evalResult, state)
        7. if gate.run:
             newRemaining = Replanner.replan({
                              goal, completedTasks, remainingTasks, surprises })
             if isNoOpDiff(remainingTasks, newRemaining):
               state.lastReplanWasNoOp = true
               emit replan.skipped { reason: "convergence" }
             else:
               remainingTasks = newRemaining
               state.replansUsed += 1
               emit plan.revised { diff: ... }
           else:
             emit replan.skipped { reason: gate.reason }
```

### Gate function (pure, unit-testable)

```ts
function shouldReplan(ev: EvaluationResult, state: AdaptiveState, cfg: AdaptiveConfig)
  : { run: true } | { run: false; reason: "budget-exhausted" | "convergence" | "below-threshold" }
{
  if (state.replansUsed >= cfg.maxReplans)      return { run: false, reason: "budget-exhausted" };
  if (state.lastReplanWasNoOp)                  return { run: false, reason: "convergence" };
  if (ev.planStillValid
      && ev.confidence >= cfg.confidenceThreshold
      && ev.surprises.length === 0)             return { run: false, reason: "below-threshold" };
  return { run: true };
}
```

### No-op diff detection

```ts
function isNoOpDiff(prev: Task[], next: Task[]): boolean {
  return JSON.stringify(prev) === JSON.stringify(next);  // strict equality, v1
}
```

---

## New config section (`galloper.json`)

```json
{
  "adaptive": {
    "confidenceThreshold": 0.7,
    "maxReplans": 5,
    "diffMaxBytes": 32768,
    "defaultEvaluator": "claude-haiku",
    "defaultReplanner": "claude-haiku"
  }
}
```

**All fields optional.** Hard-coded defaults apply when absent:
- `confidenceThreshold`: `0.7`
- `maxReplans`: `5`
- `diffMaxBytes`: `32768`
- `defaultEvaluator`: falls back to `defaultPlanner`, then `default`
- `defaultReplanner`: falls back to `defaultPlanner`, then `default`

---

## New modules

| File | Responsibility |
|---|---|
| `src/lib/Evaluator.ts` | `evaluate(input: EvaluatorInput): Promise<EvaluationResult>` — runs evaluator LLM call, parses structured JSON response |
| `src/lib/Replanner.ts` | `replan(input: ReplannerInput): Promise<Task[]>` — runs replanner LLM call, returns new remaining tasks |
| `src/lib/GitDiffCapture.ts` | `snapshot(cwd): Promise<string>` (returns tree-ish via `git add -A && git stash create`) and `diff(preSnap, postSnap, maxBytes): Promise<ImplementationDiff>` with truncation |
| `src/lib/AdaptiveRunner.ts` | Loop orchestration: per-task snapshot/execute/evaluate/gate/replan cycle. Owns `AdaptiveState` (replansUsed, lastReplanWasNoOp, evaluations[], replans[]) |

### New interfaces

```ts
// Evaluator.ts
interface EvaluatorInput {
  goal: string;
  task: Task;
  implementation: ImplementationDiff;
  executionExitCode: number | null;
  remainingPlan: Task[];
}
interface EvaluationResult {
  planStillValid: boolean;
  surprises: string[];
  confidence: number;   // 0..1
  notes: string;
}

// Replanner.ts
interface ReplannerInput {
  goal: string;
  completedTasks: Task[];
  remainingTasks: Task[];
  surprises: string[];
}

// GitDiffCapture.ts
interface ImplementationDiff {
  patch: string;           // possibly truncated
  filesChanged: string[];  // always full list
  truncated: boolean;
  fullSizeBytes: number;
}

// AdaptiveRunner.ts
interface AdaptiveState {
  replansUsed: number;
  lastReplanWasNoOp: boolean;
  evaluations: EvaluationResult[];
  replans: ReplanRecord[];
}
interface ReplanRecord {
  taskIndex: number;
  ran: boolean;
  skipReason?: "budget-exhausted" | "convergence" | "below-threshold";
  before?: Task[];
  after?: Task[];
}
```

---

## Modified modules

| File | Changes |
|---|---|
| `src/lib/PromptTemplates.ts` | Add `EVALUATE_PROMPT` and `REPLAN_PROMPT` as `export const` strings |
| `src/lib/ConfigManager.ts` | Extend `LlmConfig` with optional `adaptive` section; validate shape at load time |
| `src/lib/CommandResolver.ts` | Add `evaluate` and `replan` roles with fallback `defaultEvaluator → defaultPlanner → default` (same for replanner) |
| `src/lib/Orchestrator.ts` | Route `adaptive` subcommand to `AdaptiveRunner`; build `OrchestratorResult` with adaptive summary |
| `src/run-llm-session.ts` | Parse `adaptive` positional + `--confidence-threshold` / `--max-replans` / `--diff-max-bytes` flags |
| `src/lib/Logger.ts` | Extend `LogEvent` union with new event types (see Events below) |
| `src/lib/SessionManager.ts` | Extend `SessionRecord` with `evaluations[]`, `replans[]`, `finalPlan` |
| `src/lib/Doctor.ts` (or wherever doctor lives) | Validate `adaptive.confidenceThreshold ∈ [0,1]`, `maxReplans ≥ 0`, `diffMaxBytes > 0`, evaluator/replanner refs resolve to existing commands |

---

## Events and hooks

### New lifecycle hook phases

Added to the known-phase enum and fired from `AdaptiveRunner`:
- `pre-evaluate` — before each evaluator LLM call
- `post-evaluate` — after each evaluator LLM call (payload includes `EvaluationResult`)
- `pre-replan` — before each replanner LLM call
- `post-replan` — after each replanner LLM call (payload includes before/after remaining tasks)

### New events (emitted via Logger)

| Event | Payload |
|---|---|
| `task.evaluated` | `{ taskIndex, task, evaluation: EvaluationResult }` |
| `plan.revised` | `{ taskIndex, before: Task[], after: Task[], diff: { added, removed, reordered } }` |
| `replan.skipped` | `{ taskIndex, reason: "budget-exhausted" \| "convergence" \| "below-threshold" }` |
| `adaptive.completed` | `{ tasksRun, replansRun, replansSkipped, finalPlan }` |

---

## Build slices

Each slice is independently commit-able. No slice leaves the build broken.

### Slice 1 — Types + config + doctor (zero behavior change)
- Extend `LlmConfig` in `ConfigManager.ts` with optional `adaptive` section
- Add `evaluate` and `replan` roles to `CommandResolver.ts` with fallback chains
- Add doctor validation rules: `confidenceThreshold ∈ [0,1]`, `maxReplans ≥ 0`, `diffMaxBytes > 0`, evaluator/replanner name resolution
- Unit tests for config shape + doctor rules
- **Done when:** `galloper doctor` accepts a valid adaptive section, rejects invalid one, and nothing else changed

### Slice 2 — Evaluator module (standalone)
- Add `EVALUATE_PROMPT` to `PromptTemplates.ts`
- Implement `src/lib/Evaluator.ts` with typed input/output
- Unit tests with a mocked `CoreRunner` (feed canned JSON responses, assert parsing)
- **Done when:** Evaluator class runs an evaluator LLM call and returns a typed `EvaluationResult`; no wiring yet

### Slice 3 — Replanner module (standalone)
- Add `REPLAN_PROMPT` to `PromptTemplates.ts`
- Implement `src/lib/Replanner.ts` with typed input/output
- Unit tests with mocked `CoreRunner`
- **Done when:** Replanner class returns updated `Task[]` for remaining tasks; no wiring yet

### Slice 4 — GitDiffCapture utility
- Implement `src/lib/GitDiffCapture.ts`:
  - `snapshot(cwd)` via `git add -A && git stash create` (does not modify working tree)
  - `diff(preSnap, postSnap, maxBytes)` returning `ImplementationDiff` with truncation
  - Error with clear message when `cwd` is not a git root
- Unit tests against a temp git repo fixture
- **Done when:** Given a repo and two snapshots, returns a correct, truncation-aware diff

### Slice 5 — AdaptiveRunner (pure loop logic first, then wire-up)
- Implement `shouldReplan()` and `isNoOpDiff()` as pure functions; unit-test exhaustively
- Implement `AdaptiveRunner.run()` wiring Executioner + GitDiffCapture + Evaluator + Replanner
- Unit tests with all four collaborators mocked
- **Done when:** AdaptiveRunner completes a full plan in-process with mocks, producing correct `evaluations[]` / `replans[]` records

### Slice 6 — CLI + Orchestrator wiring
- Parse `adaptive` subcommand + new flags in `src/run-llm-session.ts`
- Route `adaptive` from `Orchestrator.execute()` to `AdaptiveRunner`
- Build `OrchestratorResult` with adaptive fields
- End-to-end smoke test with a trivial plan
- **Done when:** `galloper adaptive --prompt "..."` runs end-to-end on a real plan

### Slice 7 — Hooks + events + SessionRecord
- Add four new lifecycle phases to the known-phase enum
- Fire `pre-evaluate` / `post-evaluate` / `pre-replan` / `post-replan` hooks from `AdaptiveRunner`
- Emit the four new events through `Logger`
- Extend `SessionRecord` with `evaluations[]`, `replans[]`, `finalPlan`; populate from `AdaptiveRunner`
- Tests for event emission and hook firing order
- **Done when:** A full adaptive run produces a complete, inspectable session record and trail

### Slice 8 — Docs
- Update `CLAUDE.md`: new subcommand section, command resolution table (add `evaluate` / `replan` roles), config format section (adaptive block)
- Update `docs/EVENTS_AND_HOOKS.md`: four new lifecycle phases, four new events, payload shapes
- Update `README.md` if it lists subcommands
- **Done when:** Docs describe the feature accurately with example config and CLI invocation

---

## Acceptance criteria (feature-level)

1. `galloper adaptive --prompt "..."` produces the same `OrchestratorResult` envelope as `pipeline`, plus the new adaptive fields in the session record.
2. When the evaluator returns `planStillValid: true, confidence >= threshold, surprises: []`, no re-plan fires; this is observable via a `replan.skipped` event with `reason: "below-threshold"`.
3. When the evaluator signals a surprise or low confidence, a re-plan runs, and its diff is reflected in the `remainingTasks` used for subsequent iterations.
4. A run cannot exceed `maxReplans` re-plans — further attempts emit `replan.skipped` with `reason: "budget-exhausted"`.
5. When a re-plan produces a no-op diff, subsequent re-plans are short-circuited with `reason: "convergence"` until the next surprise.
6. Completed tasks are never rewritten by the replanner; new tasks may only be inserted at the head of remaining.
7. `galloper adaptive` on a non-git workspace root fails fast with a clear error.
8. `galloper doctor` rejects invalid adaptive config with clear error codes.

---

## Out of scope (v1)

- Non-git workspace roots (manifest-based diff fallback) — deferred to v2
- Semantic (non-strict) no-op diff detection — deferred; revisit if strict equality produces thrash in practice
- Per-file diff cap as an alternative truncation policy — only hard-byte-cap in v1
- Parallel task execution — sequential only in v1
- Rewriting completed tasks — explicitly disallowed, not a deferred feature
