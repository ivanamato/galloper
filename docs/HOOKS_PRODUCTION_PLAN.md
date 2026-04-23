# Hooks — Production Hardening Plan

**Status.** Steps 1, 2, 5, 6, 9 landed — the MVP path from §5 is complete. Steps 3, 4, 7, 8, 10 are still design. This expands ROADMAP §11 (Hook Coverage for Undeclared File Changes) into a concrete, sequenced plan grounded in the current code in `src/lib/HookDispatcher.ts`, `src/lib/TaskRunner.ts`, `src/lib/ConfigManager.ts`, `src/lib/WorkspaceReconciler.ts`, `src/lib/HookTemplate.ts`, `src/lib/PathLock.ts`, `src/lib/DestructivePatterns.ts`, and `src/lib/Doctor.ts`.

**Implemented.**
- **Step 1 — workspace-aware detection (git-only, single-root).** Baseline capture + porcelain-v2 reconciliation + declared/surprise/churn classification; `post-task-file` hooks fire on the reconciled set with `runOnSurprise` gating; per-task classified manifests persist on `RunManifest.taskManifests`. Events: `task.file.declared`, `task.file.surprise`, `task.file.churn`, `workspace.baseline.captured`, `workspace.reconciled`. See `src/lib/WorkspaceReconciler.ts` and `tests/integration/trust-boundary.test.ts`.
- **Step 5 — command ergonomics + safety.** Template substitution (`{file}`, `{path}`, `{action}`, `{classification}`, `{sessionId}`, `{taskId}`, `{attempt}`, `{root}`), `shell: false` argv mode, shell-mode path-injection gating. See `src/lib/HookTemplate.ts`.
- **Step 6 — scale.** Per-path `PathLock` (same-file hooks serialize, different files run concurrently), `WorkerPool`-backed fan-out in `TaskRunner` (default concurrency 4, `concurrency: 1` preserves the pre-pool ordering invariant), `retry: { maxAttempts, backoffMs, jitter }` on hook entries. See `src/lib/PathLock.ts` and `tests/integration/hook-*.test.ts`.
- **Step 9 — safety net.** `DestructivePatterns` validator scan with `destructive: true` acknowledgement, `AbortHookError` carrying the aborting hook's index, `onAbort: 'revert' | 'keep'` on post-task-file hooks, `revertToBaseline` (destructive-by-design), `workspace.reverted` event. Baseline capture is now **read-only** via `git stash create` — consult §5 "Step 9 caveats" for the incident that forced this design and the accepted v1 limitations (notably: untracked files at baseline are not restored on revert). Full safety guidance lives in `docs/EVENTS_AND_HOOKS.md`.

**Scope.** Everything required to move the hook system from "works on the happy path" to "I would run this against a real codebase unsupervised." The plan has two halves:

1. **Correctness** — close the trust boundary so hooks fire on *every* file the model actually wrote, not just the files it declared.
2. **Operational readiness** — execution semantics, config expressiveness, observability, safety, and testing that production use requires on top of correctness.

**Out of scope.** Preventing writes *during* task execution (FUSE/LSM/sandbox-exec style interposition), full LLM-tool-protocol interception, and MCP surface exposure. All are reachable later; none are on this plan's critical path.

---

## 1. Problem Statement — the Trust Boundary

Today, `pre-task-file` and `post-task-file` hooks fire by iterating `task.files` (TaskRunner.ts:250, 346) — the *declared* manifest the LLM produced during planning. Any file the model writes that isn't on that list is invisible to the hook system.

This breaks the central premise of galloper's hook design: *deterministic edges around a probabilistic step*. A QA gate that lints `src/**/*.ts` is meaningless if the model can silently edit `scripts/release.sh` and slip past the linter. "Only what was declared is checked" is an invariant by accident, not by design.

**Examples of real writes that escape today:**
- Dependency bumps in `package.json` that the model touched as a side effect.
- A sibling config tweaked to make a test pass.
- A helper two directories away refactored to fit the new code.
- Files in a sibling repo the workspace spans (monorepo link, submodule, adjacent checkout).

Fixing this is the single highest-leverage production-readiness improvement. Nothing else in this plan matters if the detection layer has a hole.

### 1.1 Acceptance Criteria

The trust boundary is closed when, for every completed task, all of the following hold:

1. **No silent writes.** Every path the subprocess wrote inside a declared workspace root appears in the task's classified manifest as exactly one of `declared`, `surprise`, or `churn`. A write that lands on disk but not in the manifest is a correctness bug.
2. **No escapes.** Every path the subprocess wrote outside all declared roots surfaces as `out-of-workspace` and aborts the task before any `post-task-file` hook runs.
3. **Reconciliation is authoritative.** When the watcher and reconciliation disagree, reconciliation wins. A watcher miss (fsevents coalesce, inotify overflow) does not cause a file to go unclassified — it produces a `workspace.watcher.dropped` event and the file still lands in the manifest.
4. **Declared-manifest independence.** Classification does not depend on the plan's `task.files` list being accurate. Feeding a deliberately wrong `task.files` (empty, overstated, or mis-pathed) must produce identical reconciled sets; only the `declared` vs `surprise` partition shifts.
5. **Routing honors `runOnSurprise`.** A `post-task-file` hook with `runOnSurprise: true` fires on undeclared writes that match its glob. A hook without the flag (default `false`) never fires on `surprise` or `out-of-workspace` paths.
6. **Session record honesty.** `SessionRecord` contains the full classified manifest per task (`declared`, `surprise`, `out-of-workspace`, `churn`) plus the post-hook snapshot (§3.4). Auditing a completed session can answer "what did the model touch that the plan didn't declare?" without replaying the run.
7. **Loud failure over silent skip.** Pre-task quiesce failure, baseline-capture failure, or reconciliation failure abort the task with a typed event (`workspace.noisy`, `run.failed`) — they never degrade to "best-effort detection."

Explicit non-criterion: preventing writes during task execution is out of scope (§8). Detection is observational; acceptance is about what is observed, not what is blocked.

### 1.2 Testing

The guarantee is end-to-end behavior across the lifecycle, so verification is fixture-driven integration tests, not unit tests on individual modules. Unit tests still cover reconciliation, classification, and policy logic in isolation, but they are not sufficient to close the trust boundary.

**Current harness (Step 1).** The fixture directory convention below is the longer-term plan. Step 1 shipped as inline-scenario tests in `tests/integration/trust-boundary.test.ts` using `tests/helpers/fakeExecutioner.ts` (a deterministic `FakeWrite[]` replay) and a real temp git repo per test. Migrating to the per-scenario-directory layout is cheap and tracked against the Step 4 fixture expansion — at that point the watcher adds enough fixture-input surface (recording timelines, chokidar event logs) to justify the extra structure.

**Fixture layout (target).** `tests/fixtures/trust-boundary/<scenario>/` containing:
- `plan.json` — the declared task manifest.
- `subprocess.recording.json` — a deterministic replay of the subprocess's stdout/stderr and the files it wrote (the harness replays recordings rather than invoking a real LLM).
- `workspace/` — the initial filesystem state.
- `expected.manifest.json` — the classified manifest the run must produce.
- `expected.events.jsonl` — the event timeline (ordered), including `task.file.*` and `workspace.*` events.
- `galloper.json` — the hook config under test.

**Required scenarios.** Each is a standalone fixture; all must pass for the full §2 design to be considered done.

1. **Escape — undeclared write.** Subprocess writes `scripts/release.sh`; plan declares only `src/**/*.ts`. Asserts `task.file.surprise` fires for the script and the `**/*.sh` hook with `runOnSurprise: true` runs; the `**/*.ts` hook does not. **Landed in Step 1** (`trust-boundary.test.ts` > *scenario 01*).
2. **Gitignored write.** Subprocess writes `.env.local` (matched by `.gitignore`). Asserts the watcher caught it, reconciliation merged it in, and classification landed as `surprise` despite `git status` being silent. *Deferred to Step 4 (watcher required).*
3. **Watcher drop.** Subprocess writes ~5k files in a burst to provoke fsevents coalescing. Asserts at least one `workspace.watcher.dropped` fires and every written path still appears in the reconciled manifest. *Deferred to Step 4.*
4. **Multi-root.** Task writes to main git root and to a sibling `vcs: "none"` root. Asserts both paths are classified under the correct `root.label` and per-root policies apply independently. *Deferred to Step 3.*
5. **Churn.** Subprocess writes `foo.ts` then reverts it to the baseline content. Asserts `task.file.churn` fires, no `post-task-file` hook runs for `foo.ts`, and reconciliation reports it as unchanged. **Partially landed in Step 1** — the byproduct half (reconcile returns empty, no hooks fire) is asserted in *scenario 05*; authoritative `task.file.churn` emission requires the watcher (Step 4).
6. **Out-of-workspace abort.** Subprocess writes `/tmp/stolen.txt`. Asserts `task.file.out-of-workspace` fires, the task aborts, `post-task-file` is skipped, and `post-task` still fires with a failure payload (so cleanup/reporting hooks run). *Deferred to Step 3 (requires workspace-root config).*
7. **Wrong declared manifest.** Same subprocess recording as scenario 1, but `plan.json` overstates `task.files` (lists files never written) and understates (omits files written). Asserts the reconciled set is identical to scenario 1; only `declared` vs `surprise` partitioning differs. **Landed in Step 1** (*scenario 07*).
8. **Hook recursion termination.** A hook (`eslint --fix`) mutates a declared file. Asserts the mutation does not re-trigger classification or fire additional `post-task-file` invocations, and the post-hook snapshot records the rewritten content. *Deferred — requires post-hook snapshot (§3.4).*
9. **Quiesce-gate failure.** A background process writes to the workspace during baseline capture. Asserts `workspace.noisy` fires and the task aborts before `pre-task-file` hooks run. *Deferred to Step 4.*

**Regression gate.** Scenarios 1, 5 (byproduct), and 7 are the operational definition of "Step 1 trust boundary closed" — any change that turns one of them back to red blocks merge. Scenarios 2, 3, 4, 6, 8, 9 are regression gates for their respective later steps.

**Coverage for Doctor.** `galloper doctor --plan plan.json` gains a test suite that asserts orphaned-glob warnings, missing-`runOnSurprise` warnings (§4.4), and workspace-root validation against each fixture's config. Doctor is part of the acceptance surface — a user who runs `doctor` before a real run must be warned about classification gaps their config will produce. *Deferred to Step 3 (doctor additions).*

---

## 2. Design — Workspace-Aware Detection

The guiding principle: **watcher as signal, reconciliation as truth.** Neither filesystem events nor git diffs alone are sufficient; each solves problems the other can't.

| Approach | Strength | Weakness |
|---|---|---|
| Git diff only | Exhaustive; `.gitignore` filters noise; net-change semantics | Misses non-git workspaces, gitignored writes; post-hoc only |
| FS events only | Works everywhere; real-time; catches gitignored writes | Noisy (editors, LSPs, caches); lossy under load; no net-change semantics; no attribution |
| **Hybrid** | Watcher for real-time + non-git coverage; reconciliation for authoritative net change | More moving parts; requires explicit workspace roots |

The hybrid is what durable tools (watchman, nodemon, vite) converged on. Pure-watcher solutions have been tried and retreated.

### 2.1 Workspace Roots (Config)

First-class workspace concept in `galloper.json`. Explicit, never auto-detected from `git worktree list` or submodule traversal.

```jsonc
"workspace": {
  "roots": [
    { "path": ".",              "vcs": "git",  "label": "main" },
    { "path": "../sibling-api", "vcs": "git",  "label": "api" },
    { "path": "./scratch",      "vcs": "none", "label": "scratch" }
  ],
  "ignore": ["**/*.generated.ts", "**/*.tsbuildinfo"]
}
```

**Invariants.**
- Anything written outside all declared roots → `task.file.out-of-workspace` → default policy `abort`.
- Auto-detection (`git worktree list`, submodule parsing) is used to **validate** the declared set, never to infer it. A root auto-detection would discover but the user didn't declare is its own kind of surprise.
- Each root has a `label` for event payloads so downstream consumers can route.
- `vcs: "git" | "none"` picks the reconciliation strategy per root.

### 2.2 Revised Task Lifecycle

No new lifecycle phases. Existing six (`pre-plan`, `post-plan`, `pre-task`, `post-task`, `pre-task-file`, `post-task-file`) remain. Detection slots in *between* them as internal machinery.

```
pre-task hooks fire            ──►  user setup (seeds, fixtures — before baseline)
  │
  ▼
[baseline capture, per root]        ◄── internal
  │
  ▼
[quiesce gate]                      ◄── emits workspace.noisy on failure
  │                                     → abort before task starts
  ▼
[watchers start, per root]
  │
  ▼
pre-task-file hooks fire       ──►  for each DECLARED path (unchanged)
  │                                  (speculative gate on plan manifest)
  ▼
── task runs (LLM subprocess) ──
  │
  ▼
[watchers stop, drain events]
  │
  ▼
[reconciliation vs baseline, per root]
  │
  ▼
[classification]                    ◄── each path → declared | surprise |
  │                                     out-of-workspace | churn
  ▼
[detection events emitted]          ◄── task.file.surprise,
  │                                     task.file.out-of-workspace,
  │                                     task.file.churn,
  │                                     workspace.watcher.dropped
  ▼
[policy gate]                       ◄── abort? retry? warn? allow?
  │
  ▼
post-task-file hooks fire      ──►  per classified path, per policy +
  │                                  per-hook runOnSurprise flag
  ▼
[post-hook snapshot]                ◄── records final disk state for session
  │
  ▼
post-task hooks fire           ──►  aggregate, with full classified manifest
```

### 2.3 Baseline Capture (Pre-Task, per root)

- **Git root:** `git rev-parse HEAD` plus a hash of staged+unstaged diff. Works on dirty trees without stashing (no mutation of working state).
- **Non-git root:** full `mtime + sha256` manifest of all non-ignored files.
- Stored under `galloper-data/baselines/{session-id}/{root-label}/`.
- Retained for the life of the session; cleaned up on successful `run.completed` (configurable — keep-on-failure for debugging).

### 2.4 Quiesce Gate (Pre-Task)

After baseline, wait until every root's watcher has been idle for ~250ms. Purpose: catch background-process contamination (dev server, language server, file indexer) *before* it corrupts attribution.

- If quiet within N seconds → proceed.
- If never quiet → emit `workspace.noisy` and fail loudly. Tells the user something is writing in the background; they need to stop it or extend `workspace.ignore`.
- Tunable window (`workspace.quiesceMs`, `workspace.quiesceTimeoutMs`) but defaults biased toward loud failure.

### 2.5 Live Watcher (During Task)

One `chokidar` instance per root. Purpose: real-time signal, **not** source of truth.

**What the watcher is for:**
- Non-git roots (primary detection source).
- Real-time UX (dashboard §8, TUI §9, interactive abort §6).
- Catching gitignored-but-interesting writes (e.g., `.env`).
- Detecting churn (files written then reverted).

**Event filter pipeline (per raw event):**
1. `.gitignore` of the containing root (via `ignore` npm package).
2. Built-in noise list: `.DS_Store`, `node_modules/**`, `**/.cache/**`, `**/.next/**`, `**/dist/**`, `**/*.tsbuildinfo`, editor swap files (`*~`, `.#*`, `*.swp`, `.idea/**`, `.vscode/**`).
3. User-configured `workspace.ignore` globs.
4. Coalesce per path to final state (`created` | `modified` | `deleted`).

### 2.6 Reconciliation (Post-Task, Authoritative)

**Per root:**
- Git root: `git status --porcelain=v2 -z` plus diff against baseline.
- Non-git root: re-scan, compare hashes to baseline manifest.

**Merge with watcher set:**
| In watcher | In reconciliation | Interpretation | Action |
|---|---|---|---|
| yes | yes | normal change | classify, fire hooks |
| no | yes | watcher dropped (fsevents coalesce, inotify overflow) | classify, fire hooks, emit `workspace.watcher.dropped` |
| yes | no | churn — written then reverted | emit `task.file.churn`, **do not** fire hooks |

Reconciliation wins on disagreement. The watcher is real-time sugar; the diff is the source of truth.

### 2.7 Classification

Every reconciled path lands in exactly one bucket:

| Classification | Definition |
|---|---|
| `declared` | path ∈ task's declared `files` manifest (explicit path or glob match) |
| `surprise` | in-workspace, not declared |
| `out-of-workspace` | outside all roots |
| `churn` | written and reverted (informational only) |

Each is addressable in config by a policy and by per-hook routing.

### 2.8 Policy

Policy resolves **before** `post-task-file` hooks fire. This matters — you don't want linters running on files a policy has already decided to reject.

| Classification | Default policy | Effect |
|---|---|---|
| `declared` | `allow` | normal hook flow |
| `surprise` | `warn` | emit event, continue; `post-task-file` fires only for hooks opting in via `runOnSurprise: true` |
| `out-of-workspace` | `abort` | task fails; `post-task-file` skipped; `post-task` still fires with failure payload so reporting/cleanup runs |
| `churn` | `allow` (informational) | no hooks fire |

All configurable per root and per path-glob. `retry` on surprise re-queues the task with a reevaluation signal (ties into ROADMAP §3 adaptive loop).

---

## 3. Hook Integration

### 3.1 What Changes per Lifecycle Phase

| Phase | Today | After this plan |
|---|---|---|
| `pre-plan` | — | unchanged |
| `post-plan` | — | unchanged |
| `pre-task` | — | **unchanged**; runs *before* baseline so user setup lands in the baseline |
| `pre-task-file` | fires on declared globs | **unchanged** — gate on *intent*, keys off declared manifest. Can't gate on what hasn't been written yet. |
| `post-task-file` | fires on `task.files` matching globs | **source of truth changes**: fires on the *reconciled* set, classified, per policy + `runOnSurprise` |
| `post-task` | aggregate | **unchanged API, richer payload** — full classified manifest (`declared`, `surprise`, `out-of-workspace`, `churn`) available to aggregate hooks |

### 3.2 Hook Routing per Classification

A `post-task-file` hook entry gains a `runOnSurprise` flag. Default `false`:

```jsonc
"hooks": {
  "lifecycle": {
    "post-task-file": [
      {
        "match": "**/*.ts",
        "command": "eslint --fix {file}",
        "runOnSurprise": true     // fires on declared + surprise
      },
      {
        "match": "**/*.sh",
        "command": "shellcheck {file}",
        "runOnSurprise": false    // declared only (default)
      }
    ]
  }
}
```

The flag lets a user say "run this linter on *any* `.ts` the model touched, even ones it didn't declare" without forcing every hook in the config to opt into surprise handling.

### 3.3 Hook Recursion / Idempotence Contract

When `post-task-file` fires `eslint --fix foo.ts`, eslint mutates the file. **It does not fire again.** Why:

- Watchers are stopped before reconciliation. Classification is a one-shot pass.
- Hook chains replace loops: three hooks matching the same file run *in declaration order*, each seeing the previous's output. That's what users actually want — ordered, deterministic, terminating.
- Re-triggering has no safe termination story. Formatter wars (eslint vs prettier disagreeing on quotes) would oscillate.
- Idempotence is the **hook author's contract**. Hooks must be one of: (a) read-only (linters that report), (b) idempotent under repetition (formatters), (c) internally paired (`eslint --fix && eslint`).

The escape hatch for "fix then verify" lives inside the command string, not in the runner:

```jsonc
{ "match": "**/*.ts", "command": "eslint --fix {file} && eslint {file}" }
```

### 3.4 Post-Hook Snapshot (Session Record Honesty)

After all `post-task-file` hooks complete, take a **lightweight final snapshot** (mtime+hash for changed paths only) and attach it to `SessionRecord` as `postHookManifest`. This is a recording step — no hooks fire from it, no events emitted. Lets auditing show "LLM wrote X with content A; eslint rewrote it to A'."

### 3.5 What If a Hook Writes to a Different File?

A hook writing `schema.generated.ts`, `tsbuildinfo`, snapshot files, etc. is **not** re-classified and **not** re-hooked. Reasons:

- Hook-generated writes are the hook's contract, not the LLM's manifest.
- Routing them through surprise-detection would swamp signal with noise (every formatter would look like it caused a surprise).
- If the output matters for auditing, it appears in the post-hook snapshot.

---

## 4. Gap Analysis (Grounded in Current Code)

### 4.1 Trust Boundary — the §11 Hole (~~Blocker~~ *closed for single-root git*)

**Previous state.** `TaskRunner.ts` iterated `task.files` directly for both pre- and post-task-file hook dispatch. `HookDispatcher.ts` matched those declared paths against hook globs. No baseline, no watcher, no reconciliation, no classification, no multi-root concept.

**Now (Step 1).** Pre-task, `TaskRunner` calls `WorkspaceReconciler.captureBaseline(cwd)` and records the git HEAD + porcelain-v2 snapshot. After the verify block, it calls `reconcile` (net-changed paths relative to baseline) and `classify` (declared ∪ surprise ∪ churn). `post-task-file` hooks now iterate `declared ∪ surprise`, with `runOnSurprise` gating inside `HookDispatcher.runPost`. Declared manifest is no longer the source of truth — an LLM writing `scripts/release.sh` without declaring it now surfaces as `task.file.surprise` and is routed to any hook with `runOnSurprise: true`.

**Still missing (later steps).**
- Watcher layer for gitignored writes and non-git roots (§2.5, Step 4).
- Multi-root / workspace config (§2.1, Step 3).
- `out-of-workspace` classification + abort (§2.8, Step 3).
- Quiesce gate + `workspace.noisy` (§2.4, Step 4).
- Authoritative churn detection (requires the watcher; Step 4). Write-then-revert currently falls out of reconciliation as an empty set — correct by byproduct, not by design.

**Non-git cwd.** `captureBaseline` throws; `TaskRunner` logs a warning and falls back to the pre-Step-1 behavior (iterate `task.files`). Acceptable for Step 1 because the production use case is a git workspace; a proper `workspace.roots` + non-git reconciliation story arrives with Steps 3–4.

### 4.2 Execution Model

**Sequential-only** (HookDispatcher.ts:76-115 pre-hooks, :117-174 post-hooks). Fine today because the declared-manifest case is bounded; breaks the moment surprise-routing multiplies the number of candidates.

| Gap | File:line | Fix |
|---|---|---|
| `WorkerPool` declared but never instantiated | WorkerPool.ts:1-49 | Instantiate per task; parallel *across files*, sequential *within* a file (eslint → prettier → tsc order) |
| Only run-manifest write lock | WriteLock.ts:4-18 | Add per-path write lock keyed by canonical path so two hooks touching the same file don't clobber |
| No lock ordering → deadlock risk once parallel | n/a | Lock paths in sorted order per task, or single global per-task mutex |
| Retry is immediate, no backoff | TaskRunner.ts:156 | Add `retry.maxAttempts`, `retry.backoffMs`, `retry.jitter` on hook entries |
| Timeout output may be lost | HookDispatcher.ts:100, 141 | Verify partial stdout/stderr is preserved in session record on timeout; fix if not |
| No dry-run mode for hooks | n/a | `galloper plan --dry-run-hooks` resolves matching hooks against declared manifest, prints firing order — zero-cost debugging aid |

### 4.3 Config Schema — Missing Expressiveness

Current schema allows `command | instructions | match | action | timeoutMs | onFailure` (ConfigManager.ts:105-171, docs/EVENTS_AND_HOOKS.md:72-79). Production needs:

| Field | Purpose |
|---|---|
| `runOnSurprise: boolean` | Required for §2 surprise routing. **Live (Step 1)** — validator rejects non-boolean and rejects the flag on non-`post-task-file` phases. |
| `parallel: boolean` / `serializeBy: "file" \| "task"` | Explicit concurrency intent rather than inferred |
| `retry: { maxAttempts, backoffMs, jitter }` | Flaky-hook survival |
| `env: Record<string, string>` | Per-hook env (today only run-level via `CommandEntry.env`) |
| `shell: boolean` | Opt-in/out of `/bin/sh -c`; argv form for path-safety |
| `workingDir: string` | Per-root hooks need to run from the root, not the orchestrator cwd |
| `condition: string` | Declarative "only run if ..." (e.g., a shell probe) |
| `continueOnFailure: boolean` | "Log failure, don't abort task" — distinct from the current `warn\|retry\|abort` trichotomy |
| `destructive: boolean` | Required-confirmation flag for `rm`, `git reset --hard`, etc. |

**Template substitution missing** (HookDispatcher.ts:222-225). Hooks can only access file info via env vars (`$DEVFLOW_FILE_PATH`). Production needs `{file}`, `{relpath}`, `{root}`, `{classification}`, `{sessionId}` templating. Env-only works for shell-wrapped hooks but breaks `shell: false` argv-style invocations.

**Path-injection surface.** `$DEVFLOW_FILE_PATH` interpolates via shell. A filename containing `;` or `$( )` — legal filenames — becomes arbitrary shell execution. Production fix: either mandate argv form when `shell: false`, or validate paths at dispatch against a strict charset and document the hazard.

### 4.4 Doctor — Validates Syntax, Not Semantics

Doctor.ts today: glob syntax (:35-55), event name membership (:8-29), binary-on-PATH (:105-107). Missing:

| Gap | Fix |
|---|---|
| No plan-aware hook dry-run | `galloper doctor --plan plan.json` resolves which hooks match which declared files; flags orphaned globs ("no file matches `**/*.tsx` in this plan") |
| No conflict detection | Two hooks with `onFailure: retry` that always fail will loop; two mutating hooks on the same file may fight — today invisible |
| No policy coverage report | Once classification exists: "your config won't catch surprise `**/*.sh` writes because no hook has `runOnSurprise: true` for that glob" |
| No workspace-root validation | Once §2.1 lands: each declared root must exist, be readable, and the `vcs` claim must match reality |
| No `destructive` audit | Scan command strings for destructive-pattern list; warn unless explicitly flagged |

### 4.5 Observability — Hooks are Opaque When They Misbehave

| Gap | Fix |
|---|---|
| No correlation ID across hook env, stdout, session record, central log | Thread `hookInvocationId` through env (`DEVFLOW_HOOK_INVOCATION_ID`), `hook.*` events, session record |
| Event payloads are unvalidated `Record<string, unknown>` | JSON schema per event type; validated at emission |
| No per-hook timing in session record | Per-invocation `durationMs`, keyed by `hookInvocationId` |
| No "hook decision" log | Per-hook, per-candidate-file trace (`matched` \| `skipped-glob` \| `skipped-action` \| `skipped-surprise`) for Doctor and the eventual TUI |

### 4.6 Safety / Reversibility

| Gap | Fix |
|---|---|
| No destructive-hook gating | Warning at config-load for `rm`, `git reset --hard`, `rm -rf`, etc. in command strings; `destructive: true` flag required to silence |
| No rollback on `abort` | When a `post-task-file` hook aborts mid-task, earlier hook edits stick. Once §2.3 baseline exists, add `onAbort: "revert" \| "keep"` policy |
| Write-serialization gap | (same as §4.2) must land before parallelism — correctness, not perf |

### 4.7 Testing Surface

| Gap | Fix |
|---|---|
| No hook test harness | `galloper hook run --name X --file foo.ts --fixture ./fixtures/` — dev loop for hook authors |
| No end-to-end golden fixtures | A fixture-driven test covering multi-task plan × mixed classifications × hook chains; catches silent regressions in firing order |

---

## 5. Implementation Sequencing

Minimum viable production-ready = steps 1, 2, 5, 6, 9. Everything else separates "works" from "debuggable and trusted."

| # | Step | Size | Unlocks | Status |
|---|---|---|---|---|
| 1 | Baseline capture + git-diff reconciliation, single-root | M | Trust boundary closed for 80% case | **done** — `WorkspaceReconciler.ts`, 17 unit + 6 integration tests |
| 2 | Classification + `runOnSurprise` + new events (`task.file.declared`, `.surprise`, `.churn`, `workspace.baseline.captured`, `.reconciled`) | S | Hooks can actually defend | **done** as part of Step 1; `out-of-workspace` deferred to Step 3 |
| 3 | Workspace roots config + Doctor validation for roots + `out-of-workspace` classification | M | Multi-repo story | **partial** — slice A (commit `9abcee1`): `WorkspaceRoot` / `WorkspaceConfig` types + `validateLlmConfig` shape checks + 17 validator tests. Slice B (commit `039b583`): Doctor `WORKSPACE_ROOT_MISSING` / `WORKSPACE_ROOT_VCS_MISMATCH` checks + 6 Doctor tests + CLAUDE.md error-code docs. Still pending: slice C (wire roots into `captureBaseline` / `reconcile` for multi-root), slice D (`task.file.out-of-workspace` classification + abort semantics + events). |
| 4 | Watcher layer + quiesce gate + `workspace.noisy` event + authoritative churn | M | Non-git coverage, real-time UX hooks, gitignored-write detection | pending |
| 5 | Template substitution + argv mode + path validation | S | Security + ergonomics | **done** — `HookTemplate.ts`, `{file}`/`{path}`/`{action}`/`{classification}`/`{sessionId}`/`{taskId}`/`{attempt}`/`{root}` placeholders, `shell:false` argv mode, path-injection gating |
| 6 | Parallel execution with per-path write lock + retry-with-backoff | M | Scale | **done** — `PathLock.ts` (per-file serialization), `WorkerPool` fan-out in TaskRunner (default concurrency=4), `retry: { maxAttempts, backoffMs, jitter }` on hook entries |
| 7 | Per-hook `hookInvocationId` + timing + decision trace | S | Debuggability | pending |
| 8 | Hook test harness + `--dry-run-hooks` | S | Dev loop for hook authors | pending |
| 9 | Destructive-hook gating + `onAbort` rollback | S | Safety net | **done** — `DestructivePatterns.ts` + validator, `AbortHookError` with `hookIndex`, `captureBaseline` via `git stash create` (read-only), `revertToBaseline`, `workspace.reverted` event. See "Step 9 caveats" below. |
| 10 | Event payload schemas + MCP projection | M | Production-grade observability | pending |

**Dependency notes.**
- Steps 1 → 2 → 4: each consumes the previous. Watcher is the last layer, not the first.
- Step 6 depends on the per-path write lock from §4.6; must land together.
- Step 9's `onAbort: revert` depends on the baseline from step 1.
- Step 10 (event schemas) can begin early; retrofitting schemas after MCP exposure calcifies a bad shape.

### Step 9 caveats

`captureBaseline` was initially implemented with `git stash push --include-untracked` + immediate `stash pop` so the baseline could carry both dirty-tracked AND untracked state. That sequence **mutates the working tree** — push clears it, pop restores it. When run against the galloper repo itself (any test path that sets `cwd: process.cwd()`), the push raced against uncommitted Step 9 work and wiped it. Stash reflog from the incident: `stash@{0}: On master: galloper-baseline`.

**Fix:** `captureBaseline` now uses `git stash create`, which builds a commit object representing the current tree state but **does not touch the working tree or the stash stack**. Baseline capture is fully read-only. Verified by a unit test that asserts file contents before/after `captureBaseline` are identical on a dirty tree.

**Consequences accepted:**
1. **Untracked files at baseline are not captured.** `git stash create` covers tracked dirty state only. Revert's `git clean -fd` removes any untracked files (whether present at baseline or written by the task), and the subsequent `stash apply` doesn't restore untracked. Config authors who need their untracked workspace files protected should either commit/stage them before running galloper, or not use `onAbort: revert`.
2. **Revert is destructive by design.** `git reset --hard` + `git clean -fd` run on the task's `cwd`. This is the feature; it is gated behind an explicit `onAbort: 'revert'` opt-in and should only be used against a workspace the user is prepared to reset (per-task worktrees, sandboxed checkouts, dedicated dev containers). `docs/EVENTS_AND_HOOKS.md` carries the safety checklist for config authors.
3. **Destructive-hook gating is acknowledgement, not enforcement.** The validator rejects `rm -rf`, `git reset --hard`, etc. in hook command strings unless `destructive: true` is set. It cannot prevent the command from running once acknowledged, and it cannot catch destructive calls made by galloper's own internal code paths (e.g. `revertToBaseline`). Those remain the responsibility of the implementation to keep narrowly-scoped.

**Future work on Step 9:**
- Non-destructive untracked-file snapshot (copy to a temp dir at baseline time, restore on revert). Not done for v1 because the cost-vs-benefit wasn't clear and the simpler fix unblocked the acceptance tests.
- Runtime guard that refuses `onAbort: revert` when `cwd` is detected to match the running galloper repo's own root (heuristic: compare `cwd` to `require.main`'s package root or similar). Would turn the current "don't point revert at your dev repo" doc warning into a refuse-and-warn runtime check.

---

## 6. New Events (Additions, Not Replacements)

All land on the existing event bus (`hooks.events`), no new lifecycle phases.

| Event | When | Payload | Status |
|---|---|---|---|
| `task.file.declared` | classified as declared | `{ root, path, action, via }` | **live** (Step 1) |
| `task.file.surprise` | in-workspace, not declared | `{ root, path, action, via }` | **live** (Step 1) |
| `task.file.out-of-workspace` | outside all roots | `{ path, via }` | pending (Step 3) |
| `task.file.churn` | written and reverted | `{ root, path, events }` | type registered; only fires on caller-supplied churn list today — authoritative firing needs the watcher (Step 4) |
| `workspace.noisy` | pre-task quiesce failed | `{ roots, sampleEvents }` | pending (Step 4) |
| `workspace.watcher.dropped` | reconciliation caught what watcher missed | `{ root, path, count }` | pending (Step 4) |
| `workspace.baseline.captured` | after baseline | `{ root, vcs, ref?, hashCount? }` | **live** (Step 1) — payload is `{ taskId, root, vcs: "git", ref }` |
| `workspace.reconciled` | after reconciliation | `{ root, declared, surprise, outOfWorkspace, churn }` | **live** (Step 1) — `outOfWorkspace` count absent until Step 3 |

Every event payload includes `{ sessionId, taskId, root?, via?: "watcher" \| "reconcile" \| "both" }` for downstream routing. Step 1 always emits `via: "reconcile"`; the `watcher` and `both` variants arrive with Step 4.

---

## 7. Schema Additions (Sketch)

For later deconstruction. Not final types — these will be refined against `ConfigManager.ts` during step 3.

```typescript
interface WorkspaceConfig {
  roots: WorkspaceRoot[];
  ignore?: string[];            // applied across all roots
  quiesceMs?: number;           // default 250
  quiesceTimeoutMs?: number;    // default 5000
  defaultPolicy?: ClassificationPolicy;
}

interface WorkspaceRoot {
  path: string;                 // absolute or relative to repo root
  vcs: "git" | "none";
  label: string;
  ignore?: string[];            // per-root, layered on top of workspace.ignore
}

interface ClassificationPolicy {
  declared?: Policy;            // default "allow"
  surprise?: Policy;            // default "warn"
  outOfWorkspace?: Policy;      // default "abort"
  churn?: Policy;               // default "allow"
}

type Policy = "allow" | "warn" | "retry" | "abort";

interface PostTaskFileHook {
  match: string;                // glob — existing
  command: string;              // existing (+ template substitution)
  action?: FileAction;          // existing
  timeoutMs?: number;           // existing
  onFailure?: "warn" | "retry" | "abort";  // existing
  runOnSurprise?: boolean;      // NEW — default false
  parallel?: boolean;           // NEW — default true
  retry?: RetryPolicy;          // NEW
  env?: Record<string, string>; // NEW
  shell?: boolean;              // NEW — default true (backward compat)
  workingDir?: string;          // NEW
  condition?: string;           // NEW
  continueOnFailure?: boolean;  // NEW — distinct from onFailure
  destructive?: boolean;        // NEW — required for flagged commands
  onAbort?: "revert" | "keep";  // NEW — once baseline exists
}

interface RetryPolicy {
  maxAttempts: number;
  backoffMs: number;
  jitter?: number;              // 0..1 proportion
}
```

---

## 8. Intentional Non-Goals

Things called out explicitly so they don't creep in:

- **No FUSE/LSM/sandbox-exec interception.** Detection is observational. Preventing writes mid-task belongs in a later, separate workstream with its own acceptance criteria.
- **No auto-discovered workspace roots.** Silent gaps are the #1 risk; explicit declaration is non-negotiable.
- **No cross-root atomic reconciliation.** Each root reconciles independently. A write-then-revert across roots (impossible in practice) would show as churn-on-one-root, declared-on-another — acceptable.
- **No hook-level LLM awareness.** Hooks stay deterministic subprocesses. Any LLM-driven hook lives above galloper's hook runner, invoked via the hook like any other command.
- **No retroactive classification of the current dirty tree.** A pre-existing dirty working tree is either the baseline (`--allow-dirty`) or a startup failure. Not the orchestrator's job to untangle the user's uncommitted state.

---

## 9. Open Questions

Recorded here for resolution before implementation, not in this document:

- **Default for pre-existing dirty tree at `pre-task`.** Treat the dirty state as baseline (simple, permissive) or refuse to start without `--allow-dirty` (strict, potentially annoying)? Probably strict by default with clear flag.
- **Baseline retention policy.** Keep all baselines under `galloper-data/baselines/` indefinitely (disk growth), keep last N runs (cleanup logic), or keep-on-failure-only (balance)? Probably the last.
- **Watcher shutdown race.** Between task-subprocess exit and watcher drain, some OS-level events may still be in-flight. Acceptable drain window is an empirical number; start at 500ms, measure.
- **Windows support.** chokidar works but has caveats (ReadDirectoryChangesW semantics differ from inotify). Tier Windows as "best-effort for v1"; primary correctness target is macOS + Linux.
- **Quiesce-gate false positives in CI.** CI runners may have background noise (container init, network mounts settling) that fails the gate on startup. Provide a `--skip-quiesce` flag but log loudly when used.
- **`post-plan` destructive check.** Should the plan itself be scanned for obviously-destructive declared actions (e.g., `action: "delete"` on entire directory globs)? Probably yes, in Doctor's plan-aware mode.

---

## 10. References

- **ROADMAP.md §11** — originating intent (Hook Coverage for Undeclared File Changes).
- **ROADMAP.md §3** — Adaptive Plan → Execute → Reevaluate Loop (surprise writes are a prime reevaluation trigger).
- **ROADMAP.md §6** — User Interaction During Pipeline Execution (abort/approve surface on surprise).
- **docs/EVENTS_AND_HOOKS.md** — current events and hooks reference.
- **src/lib/HookDispatcher.ts** — current hook execution.
- **src/lib/TaskRunner.ts** — current lifecycle-phase firing points.
- **src/lib/ConfigManager.ts** — current config schema and validation.
- **src/lib/Doctor.ts** — current validation surface.
