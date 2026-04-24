# Adaptive Pipeline — Implementation Plan

## Overview

A new `adaptive` subcommand that runs a plan as an **adaptive loop** instead of a straight-through pipeline. The subcommand is a thin **driver** on top of galloper's existing CLI: for each task it self-spawns `galloper plan` / `galloper implement` / `galloper single-prompt` subprocesses. There is no Evaluator, Replanner, AdaptiveRunner, or GitDiffCapture *module* — those collapse into the driver itself plus two prompt templates.

Per task the driver:

1. **Executes** the current task — spawns `galloper implement` on a synthesized one-task plan. The task's `instructions` already tell the executioner to think through sub-steps before acting (inline deconstruct).
2. **Captures** the implementation as a `git diff` between pre-task and post-task `git stash create` tree-ishes. Truncated to `diffMaxBytes`, but the full changed-files list is preserved.
3. **Evaluates** whether the remaining plan is still right — spawns `galloper single-prompt` with the `EVALUATE_PROMPT` template, the captured diff, and the remaining tasks. Parses structured JSON back.
4. **Gates** on the evaluation: re-plans only when the evaluator signals the plan needs to change, within a budget, and not after a recent no-op.
5. **Re-plans** when gated in — spawns `galloper single-prompt` with the `REPLAN_PROMPT` template. Can insert remediation tasks at the head of remaining, or reorder/drop remaining. Completed tasks are locked.
6. Proceeds to the next task.

This complements (does not replace) the existing `pipeline` subcommand.

---

## Why this shape

The earlier design proposed Evaluator, Replanner, GitDiffCapture, AdaptiveRunner modules and extensions to `LogEvent`, `LifecyclePhase`, and `SessionRecord`. A driver subcommand eliminates all of that:

- The "LLM calls" for evaluate and replan become `galloper single-prompt` invocations — no new modules, same infrastructure.
- Per-task execution becomes `galloper implement` on a one-task plan — same reconciliation, same hooks, same verify loop.
- Git diff becomes a ~20-line helper inside the driver file, not a shared module.
- The driver writes its own state file under `galloper-data/adaptive/<runId>.json` — no `SessionRecord` changes.
- No new lifecycle hook phases, no new `LogEvent` types. Observability comes from the state file plus galloper-core's existing logs for each sub-invocation.

**Net: ~8-9 small tasks instead of ~15.**

---

## Settled design decisions

| Decision | Choice | Rationale |
|---|---|---|
| Architecture | Subcommand acting as a driver over `galloper plan` / `galloper implement` / `galloper single-prompt` | Reuses existing CLI contracts verbatim, no new in-tree modules |
| Subprocess mechanism | Self-spawn via `process.execPath` + `process.argv[1]` | Stable self-location, no PATH assumption |
| Deconstruct scope | Inline reasoning in the executioner prompt | Cheaper; no extra LLM call |
| Re-plan authority | Insert-at-head + reorder/drop remaining; **completed tasks locked** | Prevents full-history rewrite thrash |
| No-op detection | Strict JSON equality on `remainingTasks` | Simpler, safer v1 |
| Evaluator input | `git diff` of implementation, **not** executioner self-report | Ground truth |
| Diff size policy | Hard truncate to `diffMaxBytes`, preserve **full file list** | Evaluator sees scope even when patches clipped |
| VCS support | git-only in v1; explicit error on non-git cwd | Manifest fallback deferred to v2 |
| Evaluator scope | "Is the remaining plan still right?" (one evaluator, one job) | Task success read from subprocess exit code |
| Prompt template location | `src/lib/PromptTemplates.ts` as `export const` | Matches existing `PLAN_PROMPT` / `IMPLEMENT_PROMPT` |
| State persistence | Per-run file at `galloper-data/adaptive/<runId>.json` | Avoids touching `SessionRecord` |

---

## CLI surface

```bash
galloper adaptive --prompt "..." \
  [--confidence-threshold 0.7] \
  [--max-replans 5] \
  [--diff-max-bytes 32768]
```

Flags override the corresponding `galloper.json` `adaptive` values for a single run. Flags not passed fall back to config, which falls back to hard-coded defaults.

---

## Driver algorithm (per run)

```
1. Resolve config: planner/executioner/evaluator/replanner command names
   and adaptive numeric config (with CLI flag overrides).
2. Spawn: galloper plan --prompt "<user goal>"   → outer plan (list of tasks)
3. state = { replansUsed: 0, lastReplanWasNoOp: false,
              completedTasks: [], remainingTasks: plan.tasks, evaluations: [],
              replans: [] }
4. Write initial state to galloper-data/adaptive/<runId>.json
5. While state.remainingTasks is not empty:
     task = state.remainingTasks[0]
     preSnap = gitStashCreate(cwd)
     Spawn: galloper implement --plan-file <one-task-plan>
       (synthesize a one-task plan JSON in a temp file from `task`)
     exitCode = child.exitCode
     postSnap = gitStashCreate(cwd)
     diff = gitDiff(preSnap, postSnap, diffMaxBytes)
            → { patch, filesChanged, truncated, fullSizeBytes }
     evalPrompt = renderEvaluatePrompt({
                    goal, task, implementation: diff,
                    executionExitCode: exitCode,
                    remainingPlan: state.remainingTasks })
     Spawn: galloper single-prompt --prompt "<evalPrompt>"
            → parse JSON: { planStillValid, surprises, confidence, notes }
     state.evaluations.push(evaluation)
     decision = shouldReplan(evaluation, state, cfg)
     if decision.run:
       replanPrompt = renderReplanPrompt({
                        goal,
                        completedTasks: state.completedTasks,
                        remainingTasks: state.remainingTasks,
                        surprises: evaluation.surprises })
       Spawn: galloper single-prompt --prompt "<replanPrompt>"
              → parse JSON: { remainingTasks: Task[] }
       if isNoOpDiff(state.remainingTasks, newRemaining):
         state.lastReplanWasNoOp = true
         state.replans.push({ taskId: task.id, ran: false,
                              skipReason: "convergence" })
       else:
         state.remainingTasks = newRemaining
         state.replansUsed += 1
         state.lastReplanWasNoOp = false
         state.replans.push({ taskId: task.id, ran: true,
                              before, after })
     else:
       state.replans.push({ taskId: task.id, ran: false,
                            skipReason: decision.reason })
     state.completedTasks.push(task)
     state.remainingTasks = state.remainingTasks.slice(1)  // or [0] was replaced by replan; re-read
     write state file
6. Write final state. Emit stdout JSON summary.
```

### Gate function (pure, unit-testable)

```ts
function shouldReplan(
  ev: EvaluationResult,
  state: AdaptiveState,
  cfg: AdaptiveResolvedConfig
): { run: true } | { run: false; reason: "budget-exhausted" | "convergence" | "below-threshold" } {
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

### Diff truncation

```ts
function truncateDiff(fullPatch: string, filesChanged: string[], maxBytes: number):
  { patch: string; filesChanged: string[]; truncated: boolean; fullSizeBytes: number }
{
  const fullSizeBytes = Buffer.byteLength(fullPatch, "utf8");
  if (fullSizeBytes <= maxBytes) {
    return { patch: fullPatch, filesChanged, truncated: false, fullSizeBytes };
  }
  const clipped = fullPatch.slice(0, maxBytes);
  return { patch: clipped, filesChanged, truncated: true, fullSizeBytes };
}
```

---

## Config (extends the shape already added in slice 1)

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

All fields optional. Defaults if absent: `0.7`, `5`, `32768`; evaluator/replanner fall back to `defaultPlanner` → `default` via existing `ConfigManager` accessors.

---

## New modules

| File | Responsibility |
|---|---|
| `src/lib/AdaptiveDriver.ts` | The loop. Pure helper functions (`shouldReplan`, `isNoOpDiff`, `truncateDiff`) plus the `AdaptiveDriver` class. Spawns galloper subprocesses via an injectable `spawner` dep (enabling unit tests with mocks). Writes `galloper-data/adaptive/<runId>.json`. |

That's it. No Evaluator, Replanner, GitDiffCapture, or AdaptiveRunner as separate modules.

### New interfaces (all in `AdaptiveDriver.ts`)

```ts
export interface AdaptiveInput {
  prompt: string;
  confidenceThreshold?: number;
  maxReplans?: number;
  diffMaxBytes?: number;
  cwd?: string;
}

export interface EvaluationResult {
  planStillValid: boolean;
  surprises: string[];
  confidence: number;
  notes: string;
}

export interface ImplementationDiff {
  patch: string;
  filesChanged: string[];
  truncated: boolean;
  fullSizeBytes: number;
}

export interface ReplanRecord {
  taskId: string;
  ran: boolean;
  skipReason?: "budget-exhausted" | "convergence" | "below-threshold";
  before?: unknown[];   // remaining tasks snapshot
  after?: unknown[];
}

export interface AdaptiveState {
  runId: string;
  goal: string;
  completedTasks: unknown[];
  remainingTasks: unknown[];
  evaluations: EvaluationResult[];
  replans: ReplanRecord[];
  replansUsed: number;
  lastReplanWasNoOp: boolean;
}

export interface AdaptiveResolvedConfig {
  confidenceThreshold: number;
  maxReplans: number;
  diffMaxBytes: number;
}

export interface AdaptiveResult {
  runId: string;
  stateFilePath: string;
  tasksRun: number;
  replansRun: number;
  replansSkipped: number;
  finalPlan: unknown[];
}

export type Spawner = (args: {
  subcommand: "plan" | "implement" | "single-prompt";
  argv: string[];
  stdinPrompt?: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
}) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
```

---

## Modified modules

| File | Changes |
|---|---|
| `src/lib/PromptTemplates.ts` | Add `EVALUATE_PROMPT` and `REPLAN_PROMPT` as `export const` strings with their input/output contracts |
| `src/lib/Orchestrator.ts` | Extend `SubcommandName` with `'adaptive'`; add `OrchestratorInput` fields (`confidenceThreshold`, `maxReplans`, `diffMaxBytes`); route `adaptive` to `AdaptiveDriver` |
| `src/lib/Doctor.ts` | Add `'adaptive'` to `KNOWN_SUBCOMMANDS` so it's valid in `allowedSubcommands` / `disallowedSubcommands` |
| `src/run-llm-session.ts` | Parse `adaptive` positional + `--confidence-threshold` / `--max-replans` / `--diff-max-bytes` flags |

No `Logger.LogEvent` changes, no `HookDispatcher.LifecyclePhase` changes, no `SessionManager.SessionRecord` changes in v1.

---

## Build slices (remaining)

### Slice 1 ✅ SHIPPED
Types + config + doctor reference checks (commit `72dfd77`).

### Slice 2 — Prompt templates
Add `EVALUATE_PROMPT` and `REPLAN_PROMPT` to `PromptTemplates.ts`. Each template clearly states its JSON output contract so downstream parsing is predictable.
- **Done when:** templates compile; `npm run build` passes; their contract shapes match the interfaces in `AdaptiveDriver` (slice 3).

### Slice 3 — AdaptiveDriver
**3a — Pure helpers + types.** `shouldReplan`, `isNoOpDiff`, `truncateDiff` as exported pure functions; all interfaces from the list above. No class yet. Unit tests exhaustively cover the gate (all reason paths), no-op equality, and truncation boundary/over-limit/exact-limit cases.
- **Done when:** `npx vitest run tests/unit/AdaptiveDriver.helpers.test.ts` passes.

**3b — Driver class + mock-spawner tests.** `AdaptiveDriver` class wiring the loop. Accepts a `Spawner` dependency (default impl shells out via `child_process.spawn` using `process.execPath` + `process.argv[1]`). Writes the state file. Returns `AdaptiveResult`.
- **Done when:** `npx vitest run tests/unit/AdaptiveDriver.test.ts` passes with mocked spawner covering: happy path, forced replan, budget exhaustion, convergence short-circuit.

### Slice 4 — CLI + Orchestrator wiring
**4a — CLI parsing.** Add `'adaptive'` to `SubcommandName`, `SUBCOMMANDS`, `KNOWN_SUBCOMMANDS`. Parse the three new flags in `run-llm-session.ts`. Route the subcommand through `OrchestratorInput`.
- **Done when:** `npm run build` passes + CLI arg parsing unit test.

**4b — Orchestrator routing.** `Orchestrator.execute()` routes `adaptive` to an `AdaptiveDriver` instance. Builds `OrchestratorResult` with `runId`, `stateFilePath`, and the summary fields.
- **Done when:** `npx vitest run tests/unit/Orchestrator.test.ts` passes (existing tests + one new routing test).

### Slice 5 — Docs
Update `CLAUDE.md`: new subcommand section, config format (link to slice 1 adaptive block), command resolution addendum for evaluator/replanner roles, state-file location. No `EVENTS_AND_HOOKS.md` changes (no new events/phases).
- **Done when:** doc describes the feature with example invocation and sample state JSON.

---

## Acceptance criteria (feature-level)

1. `galloper adaptive --prompt "..."` end-to-end: plans, executes each task, evaluates, re-plans when signaled, writes a state file, exits 0.
2. When the evaluator returns `planStillValid: true`, `confidence >= threshold`, `surprises: []`, no replan fires; state file records `replan.skipped` entry with `reason: "below-threshold"`.
3. Low confidence or surprises trigger a replan; the modified `remainingTasks` are used for the next iteration.
4. After `maxReplans`, further gate hits record `reason: "budget-exhausted"` and no replan fires.
5. A no-op replan diff short-circuits subsequent replans with `reason: "convergence"` until a fresh surprise.
6. Completed tasks are never rewritten by the replanner; added tasks appear at the head of `remainingTasks`.
7. `galloper adaptive` in a non-git directory fails fast with a clear error.

---

## Out of scope (v1)

- Non-git workspaces (manifest-based diff fallback) — v2
- Semantic no-op diff (vs strict JSON equality) — v2 if thrash observed
- Per-file diff cap as alternative truncation — v1 is bytes-only
- First-class integration into `SessionRecord` / `LogEvent` / lifecycle phases — driver state file suffices for v1
- Parallel task execution — sequential only
- Rewriting completed tasks — explicitly disallowed
