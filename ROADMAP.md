# Roadmap & Open Questions

This document tracks areas galloper is actively exploring. Each section lists the intent, the design constraints, and the open questions that still need answers before a concrete implementation lands. Contributions, opinions, and counter-proposals are welcome — nothing here is settled.

---

## 1. Semantic Search as a Pre-Processing Step

**Intent.** Before a prompt reaches the LLM, galloper should be able to pre-select a relevant subset of project files and inject them into the prompt in a structured form — **without calling an LLM to do it**. The goal is to reduce token cost, improve signal-to-noise, and give the model a curated starting point rather than a raw codebase.

**Candidate backends to wrap.** Rather than building retrieval from scratch, galloper should treat existing tools as pluggable providers. Early candidates:

- **[th0th](https://github.com/S1LV4/th0th)** — a semantic-search CLI designed to be invoked from agent pipelines; a natural fit for galloper's "subprocess + structured output" pattern.
- **[mgrep](https://github.com/Mindful-AI-Assistants/mgrep)** — pattern-based / semantic grep useful for fast lexical + approximate-match retrieval when embeddings are overkill.
- Other obvious candidates for later: a local BM25/ripgrep-hybrid, a tree-sitter symbol indexer, or a small local-embedding provider — each slotted behind the same interface.

**Design constraints.**
- Must be pluggable, ideally following the same pattern as CLI commands (named entries in `galloper.json`, swappable backends, per-subcommand selection). Adding a new backend should mean registering a command entry, not patching core.
- Must be deterministic and fast: embeddings, BM25, symbol-graph traversal, or hybrid lexical+vector scoring — not a model call.
- Output shape must be structured (file paths + ranked snippets + metadata) so it can be templated into the prompt predictably, regardless of which backend produced it.

**Open questions.**
- What is the right default backend? Local embeddings (e.g. a small sentence-transformer) vs. a pure lexical index vs. something tree-sitter-aware?
- Where does the index live, and how is it refreshed? On-demand per run, a watcher-driven cache under `galloper-data/`, or both?
- How does the retrieved context get shaped into the prompt — free-form injection, a dedicated template slot, or a tool the LLM can call?
- How much context is "enough"? Fixed top-k, a token budget, or task-adaptive?
- How is this integrated with the existing plan → implement flow? Is retrieval per-task (during implement) or per-plan?

---

## 2. User Onboarding & Configuration Discovery

**Intent.** galloper's surface area — commands, hooks, events, model tiers, retrieval backends — is small today and will keep growing. Writing a correct `galloper.json` by hand is already non-trivial and will get worse. A first-run experience should **make the easy path genuinely easy**: detect what the user has installed, propose a sensible default config, explain the available knobs in context, and let power users drop back to hand-editing at any point. Onboarding is not a nice-to-have; for an alpha tool asking users to trust it with code, it is the difference between being tried and being ignored.

**Status (2026-04-22).** Implementation plan tracked in [`docs/ONBOARDING_PLAN.md`](docs/ONBOARDING_PLAN.md). Shipping order: **B → D → A → C**.

- ✅ **B — `galloper doctor`** shipped. `src/lib/Doctor.ts` validates defaults, PATH lookups for each command's first token, allowed/disallowed subcommand lists, hook event names, and hook glob syntax. CLI branch at `src/run-llm-session.ts`; exit `0` on clean / `1` on any error; structured `{errors, warnings}` JSON on stdout. Unit + integration tests in place; no new runtime deps.
- ✅ **D — In-flow discovery** shipped. `src/lib/Suggest.ts` exposes a zero-dependency `nearest()` (Levenshtein, length-scaled threshold, suppressed on exact match). Wired into the CLI's unknown-subcommand path, `ConfigManager` validation (defaultPlanner, defaultExecutioner, allowed/disallowed subcommands, unknown hook events, unknown command via `getCommand`), and every `Doctor` check. Additive `(did you mean 'x'?)` suffix; silent when no candidate is close enough.
- ✅ **A — `galloper init`** shipped. `src/lib/Init.ts` detects `claude` / `codex` / `gemini` on `$PATH`, prompts interactively (or accepts `--non-interactive`), round-trips through the now-pure `validateLlmConfig` before writing, and uses an atomic tmp+rename with unlink-on-failure. TTY-aware; refuses overwrite without `--force`. Prompt layer is a thin `Prompter` interface over `node:readline` (no framework) — reusable by the future TUI.
- ⏸ **C — Template starters** deferred until §10 (Reference Project Examples) lands at least one real example. Templates without backing reference projects would be decorative; the dependency is explicit in the plan.

**Design constraints.**
- Must never silently write an unusable config. Anything generated must validate against the same loader that runs at execution time.
- Must be **non-destructive**. If a `galloper.json` already exists, onboarding augments or diffs — it does not overwrite without explicit consent.
- Must degrade to plain prompts (or fully scripted/flag-driven invocation) so it works in non-TTY contexts, CI bootstraps, and dotfile-style provisioning.
- Must be the **preferred front-end for the TUI** (see §9). The onboarding flow and the TUI share the same problem — presenting galloper's state and accepting structured input interactively — so they should share the same components and rendering layer rather than growing two parallel implementations. The TUI milestone is a natural home for a richer, ongoing configuration surface; onboarding is its first chapter.

**Scope sketch.**

- **`galloper init`** *(shipped — milestone A)* — scaffolds a `galloper.json` by detecting installed LLM CLIs (`claude`, `codex`, `gemini`), asking which to wire up, and picking a sensible `default`. `defaultPlanner` / `defaultExecutioner` are left unset for now (fall back to `default`).
- **`galloper doctor`** *(shipped — milestone B)* — validates the current config against the binaries, paths, and environment it references; reports missing commands, unresolvable subcommand restrictions, broken hook globs, and invalid event names with a clear fix for each.
- **Template starters** *(deferred pending §10 — milestone C)* — a minimal set of `galloper init --template <name>` presets tied to the reference project examples (see §10), so a React or Go project can start with a hook suite that already makes sense.
- **In-flow discovery** *(shipped — milestone D)* — when a user runs an unknown subcommand, mistypes a command name, or references an undefined hook phase, surfaces the nearest valid option rather than a bare stack trace.

**Open questions.**
- Is `init` a subcommand of `galloper` or a separate companion binary? Bundled is simpler for users; separate keeps the core tight. *(Plan resolves to bundled; revisit if the `init` surface grows.)*
- How aggressive should auto-detection be? Does galloper shell out to each candidate CLI to check versions, or only look for binaries on `$PATH`? Version drift is a real failure mode.
- What's the split between `init` (one-shot) and an ongoing configuration UI in the TUI? The cleanest answer is probably that `init` is a scripted path through the same components the TUI exposes continuously.
- Should onboarding ever write to anything outside the repo (a user-level default, a shell completion file, an editor snippet)? If yes, it must be explicit and reversible.
- How are templates versioned and kept current as the hook/event surface evolves? Same CI pressure as the reference examples (§10).
- ~~For `doctor`, what's the right severity model — errors/warnings/info, or a single pass/fail?~~ *(Resolved: `{errors, warnings}` split, non-zero exit only on errors — matches the project's "loud failures are a feature" stance.)*

---

## 3. Adaptive Plan → Execute → Reevaluate Loop

**Intent.** Today galloper's pipeline is linear: a plan is produced once, then every task in it is executed in order. Real engineering work is not linear. New information surfaces mid-execution — a file turns out to be structured differently than the planner assumed, a dependency is missing, an earlier task reshapes the problem. A correct plan at step 1 can become a *wrong* plan by step 4. galloper should treat the plan as a **living artifact** rather than a write-once manifest, and let execution feed information back into planning in a controlled, bounded loop.

**Target shape.**

```
  ┌──────────────┐
  │  plan (v1)   │◄──────────────────────┐
  └──────┬───────┘                       │
         │                               │ plan revised (vN+1)
         ▼                               │
  ┌──────────────┐   next step           │
  │  execute     │──────────────┐        │
  │  next step   │              │        │
  └──────┬───────┘              │        │
         │                      ▼        │
         │              ┌───────────────┐│
         └─────────────►│ reevaluate?   ├┘
                        │  (yes → replan)
                        │  (no  → continue)
                        └───────┬───────┘
                                │ no
                                ▼
                          ┌──────────┐
                          │  done    │
                          └──────────┘
```

After each task — or at configurable checkpoints — a reevaluation step asks a bounded question: *given what we just learned, does the remaining plan still hold?* If yes, execution proceeds. If not, the plan is revised (partially or wholly) before the next step runs.

**Design constraints.**
- Reevaluation must be **deterministically gated**, not freeform. Rules (task failure, hook veto, file-touch surprise, explicit `post-task` signal) trigger the check; the check itself may call a model, but *whether* to check is not a model decision.
- Replanning must be **scoped and diff-based**, not a restart. A revision should describe which tasks are kept, which are dropped, which are added, and why — so it is inspectable, resumable, and auditable.
- The loop must **terminate**. A per-run cap on revision count (and optionally a budget cap) prevents a plan from oscillating or drifting forever.
- Context accumulated during execution (touched files, decisions, discovered constraints) must flow into reevaluation. This is the same problem as Cross-Tool Context Management (§5) and should share mechanics, not duplicate them.
- The loop must be **interruptible**. Checkpoint-style user interaction (§6) naturally extends to "the plan has been revised — approve, amend, or abort."

**Open questions.**
- What are the reevaluation triggers by default? After every task, after a task failure, after a `post-task-file` surprise, at explicit `post-plan`-style checkpoints? Per-phase configuration, or a single policy setting?
- Who runs the reevaluation — the planner model, the executor model, or a dedicated "critic" role? Does the role change based on severity (minor tweak vs. structural rewrite)?
- How is a plan revision represented on disk? A new plan file per revision (`plan-v2.json`) for full auditability, a single file with an append-only revision log, or both?
- How do in-flight tasks interact with a revision — drained-then-replanned, cancelled, or allowed to complete before the new plan takes effect?
- What stops runaway replanning? Hard revision cap, cost budget, confidence threshold, human-in-the-loop required above N revisions?
- How does this interact with model tiering (§4)? Is reevaluation always done by the planner tier, or can cheap models propose "no change" without escalating?
- What does the event surface look like — `plan.revised`, `plan.revision.proposed`, `plan.revision.rejected`, or a single enriched event with a before/after payload?

---

## 4. Automatic Model Scaling

**Intent.** A run should dynamically escalate or de-escalate the model handling a task based on observed difficulty. Cheap models handle the bulk; frontier models are engaged only when warranted.

**Design constraints.**
- Escalation decisions must themselves be deterministic (rule-based, signal-driven) — not a model picking its own successor.
- The orchestrator must preserve enough context across the switch that the escalated model can continue the task, not restart it.
- Downscaling must be safe: once a frontier model has produced a plan or partial output, handing follow-up work to a cheaper model should not silently lose invariants.

**Open questions.**
- What signals trigger escalation? Retry count, verification failure, hook abort, low-confidence self-report, output schema violations, wall-clock thresholds?
- Is the decision per-task, per-attempt, or per-subtask?
- Should models be configured as an ordered "ladder" in `galloper.json` (e.g. `[haiku, sonnet, opus]`) or as named roles (`executor`, `fallback`, `rescue`)?
- How are escalation events surfaced — a dedicated event (`task.escalated`), a hook phase, or both?
- What prevents runaway cost? A per-run budget, a hard cap on escalations, explicit user confirmation above a threshold?
- De-escalation: who decides the task has become easy again, and on what evidence?

---

## 5. Cross-Tool Context Management

**Intent.** When a pipeline spans multiple LLM CLIs (plan with one, implement with another, validate with a third), the relevant context — decisions made, constraints discovered, files touched, rationale — must flow between them in a structured, lossless way. Today this is handled only crudely at the plan → implement boundary and needs to become a first-class concern.

**Design constraints.**
- Context must be portable across CLIs that have no shared memory or protocol (Claude Code, Codex, Gemini CLI all accept prompts but differ in how they consume supplementary data).
- It must be structured enough to survive translation (JSON or Markdown with predictable sections), but flexible enough to carry free-form reasoning.
- It must be inspectable by humans — the context handed to the next tool should be readable and diffable, not an opaque blob.

**Open questions.**
- What is the canonical shape of a "context packet"? Decisions, open questions, file manifest, prior outputs, constraints — all explicit fields, or a single narrative doc with conventional sections?
- Does the orchestrator own the context, or does each tool append to a shared, versioned artifact (e.g. `galloper-data/context/{run-id}.json`)?
- How is context summarized when it exceeds the next tool's window? Deterministic truncation, LLM-driven compression, or segmented sliding window?
- Should context be scoped (per-task vs. per-run vs. per-pipeline) and inherited explicitly?
- How does this interact with semantic search? Is retrieved context part of the packet, or sourced fresh per step?

---

## 6. User Interaction During Pipeline Execution

**Intent.** Today, `pipeline` generates a plan and immediately executes it end-to-end with no human in the loop. In practice, a plan is often wrong or subtly misaligned, and correcting it after implementation is far more expensive than steering it before. galloper should offer opt-in, lightweight interaction points where the user can confirm, amend, or redirect.

**Design constraints.**
- Interaction must be **optional** — fully autonomous pipelines remain a first-class mode for automation and CI.
- Interruption points must be well-defined (lifecycle phases are the natural fit) rather than ad-hoc.
- The UX must work across terminal, non-interactive CI, and future MCP/API contexts — a blocking TTY prompt is not the right universal answer.

**Open questions.**
- Which phases deserve an interaction checkpoint by default? `post-plan` is the obvious candidate; what about `pre-task` for high-risk tasks, or `post-task-file` for destructive edits?
- What does the interaction payload look like? Approve / amend / abort, or richer (edit plan in-place, inject a steering note, mark tasks to skip)?
- How is interaction configured — a flag (`--interactive`), per-phase hook config, or an interaction mode enum (`auto`, `confirm-plan`, `confirm-each`)?
- How are interactive runs resumed if the user steps away? Session files already exist; is "resume from last checkpoint" a natural extension?
- How is this exposed to non-terminal front-ends (a web UI, an editor integration, an MCP client)? Probably via the same event stream — but the protocol for "orchestrator awaits response" needs to be explicit.

---

## 7. MCP Server Exposure

**Intent.** Once galloper is stable enough to be trusted as an orchestration layer, it should expose itself as an [MCP (Model Context Protocol)](https://modelcontextprotocol.io/) server. Other LLM CLIs could then use galloper directly as an orchestration tool — delegating planning, task decomposition, and deterministic validation to it rather than reimplementing the logic.

**Design constraints.**
- This is explicitly a **"once it works well"** milestone — premature MCP exposure calcifies an immature interface.
- The MCP surface should mirror galloper's existing subcommand semantics (`single-prompt`, `plan`, `implement`, `pipeline`), not a different mental model.
- Events and hooks need an MCP-compatible projection so external orchestrators can subscribe to progress rather than poll.

**Open questions.**
- What is the right MCP tool granularity? One tool per subcommand, one tool with a mode parameter, or a single "run galloper" tool with a rich JSON schema?
- How are long-running runs modeled? Streamed progress via MCP notifications, or session-id + poll?
- How does authentication and sandboxing work when galloper is invoked by another agent? Can certain subcommands or commands be gated at the MCP layer?
- Does galloper-as-MCP-server expose the inner LLM CLIs transparently, or only the orchestration primitives?
- How does interaction (see §6) translate over MCP — does the caller become the "user" answering checkpoints?

---

## 8. HTTP Dashboard

**Intent.** Runs produce a lot of structured state — session records, central logs, events, plans, task attempts, hook results — that today is only observable by tailing JSONL files or opening session JSONs by hand. A local HTTP dashboard would make that state legible in real time: metrics, run history, live event streams, and — potentially — a lightweight UI where a user can interact with a running pipeline alongside the CLI (approving plans, injecting steering notes, marking tasks).

**Design constraints.**
- Must be **strictly optional and local-first**. galloper's core value is the CLI/library; the dashboard is a viewer, not a requirement.
- Must be **read-mostly by default**. Any write capability (approvals, overrides) should be explicit, authenticated at least to the local user, and configurable off.
- Must source its data from the existing artifacts (session files, central log, event stream) rather than duplicating state. There should be one source of truth.
- Should work offline, against historical runs, not only live ones.

**Open questions.**
- What ships first — a pure observer (metrics + run list + log viewer) or an interactive surface (approve/redirect)? They are very different scopes.
- What metrics are worth surfacing? Runs per day, pass/fail rate, mean duration, per-command cost/latency, retry rate, hook-failure rate, model-tier distribution (once §4 lands)?
- How is the server launched — a `galloper dashboard` subcommand, a separate binary, a flag on normal runs? Always-on or on-demand?
- Does the dashboard tail live runs by polling the log, or does galloper expose an event-stream endpoint (SSE/WebSocket) that handlers subscribe to? If the latter, the event bus becomes a shared dependency of CLI + dashboard.
- How does "work alongside the CLI" reconcile with user interaction (§6) — is the dashboard just another front-end to the same interaction protocol, or does it have its own?
- Authentication: loopback-only, shared-secret token, OS user check? What is the minimum viable bar for a local tool that occasionally exposes approve/abort?
- How much of this belongs in-tree vs. as a separate repo/package consuming galloper's artifacts?

---

## 9. TUI (Terminal UI)

**Intent.** A terminal UI would give users the same observability and interaction benefits as the HTTP dashboard (§8) without leaving the terminal — a live view of the current run, the plan tree, task status, streamed output, and inline approval prompts. It fits the CLI-first ethos and works equally well over SSH or in CI shells. It is also the natural home for the ongoing configuration surface introduced by onboarding (§2).

**Design constraints.**
- Must degrade gracefully. In dumb terminals, non-TTY contexts, or CI, the TUI should either not activate or fall back to plain logging — never corrupt output.
- Must share its data model with the dashboard (§8) and the event stream. Two parallel view implementations is a trap.
- Must not become the default for `just dev` / `npm run run` invocations. Structured JSON output on stdout is contract; the TUI is opt-in (a flag, a separate subcommand, or a separate binary).
- Should stay small. A heavy TUI framework is a disproportionate dependency for a tool whose core is a few hundred lines of orchestration.
- Should share components with the onboarding flow (§2). `galloper init` is effectively a scripted walk through a subset of the TUI's configuration views; building them twice would be wasted work.

**Open questions.**
- **When** should this land? Probably *after* the event bus / shared data model solidifies (tied to §8) — building the TUI first risks hard-coding assumptions that a dashboard later has to relitigate.
- What's the minimum useful surface? A live run view (events + current task + output tail), a run-history picker, or an interactive pipeline controller?
- Invocation model: `galloper watch`, `galloper run --tui`, or a sibling binary (`galloper-tui`)? Each has different tradeoffs for packaging and default behavior.
- Framework choice: a lightweight renderer (raw ANSI + a small helper), [Ink](https://github.com/vadimdemedes/ink), [blessed](https://github.com/chjj/blessed), or [ratatui](https://github.com/ratatui-org/ratatui)-style via a non-Node component? The answer is entangled with the dependency-footprint rule.
- Multi-run view: should the TUI show a single active run, a queue of concurrent runs, or both?
- Input handling: keyboard-only, or mouse-aware? Cross-platform terminal input is historically painful — pick the narrowest surface that's actually useful.
- How does the TUI coordinate with the HTTP dashboard if both are present — same process, separate processes sharing a socket, or mutually exclusive?

---

## 10. Reference Project Examples

**Intent.** galloper's power comes from how hooks, events, and subcommand routing are composed for a given project — but without worked examples, new users have to derive the pattern from first principles. A curated set of **reference project templates** would show, end-to-end, how to wire galloper into common real-world stacks. Each example would ship a working `galloper.json` (including a realistic hook suite), a sample prompt, and a short README explaining *why* each hook exists — not just *what* it does.

**Candidate examples.**

- **React + TypeScript frontend (e.g. a todo web app)** — `post-task-file` running `eslint`/`prettier` on `.ts`/`.tsx`, `post-plan` validating the plan mentions a11y checks, `post-task` running `vitest` on touched components, `pre-task-file` with `action: "delete"` gated to prevent accidental component removal.
- **Golang CLI application** — `post-task-file` running `gofmt` / `go vet` / `staticcheck` on `.go`, `post-task` running `go build ./...` and the relevant `go test` package, `pre-plan` instructing the planner to respect the existing `cmd/` / `internal/` layout.
- **Node.js / TypeScript REST API** — `post-task-file` with tiered globs (routes vs. services vs. tests) each running their appropriate linter/formatter, `post-task` running the unit+integration suite, `post-plan` verifying the plan includes an OpenAPI update when a route changes.
- **Python data / ML project** — `post-task-file` running `ruff` + `mypy` on `.py`, `post-task` running `pytest -q` on the affected module, `pre-plan` reminding the planner about the notebook↔module split convention.
- **Rust library crate** — `post-task-file` running `rustfmt`, `post-task` running `cargo check` / `cargo test`, `pre-plan` steering toward feature-flag boundaries.
- **Monorepo (pnpm/turbo)** — package-scoped globs (`packages/ui/**/*.tsx`, `packages/api/**/*.ts`) each with their own tooling, `post-task` invoking `turbo run test --filter=...` based on the task's touched workspace.
- **Infrastructure-as-code (Terraform / Pulumi)** — `post-task-file` running `terraform fmt` / `terraform validate`, `post-plan` enforcing that changes to prod modules are flagged for human review via a blocking hook.
- **Documentation-only project (Markdown/MkDocs)** — `post-task-file` running `markdownlint` and a link checker, `post-task` running the docs build to catch broken cross-refs.

### LLM-assisted hook & QA-gate generation

**Intent.** Static templates only take a user so far — every real project has idiosyncrasies no preset can anticipate. In addition to the curated examples above, galloper should be able to **generate a tailored hook suite for an unknown project** by combining deterministic project discovery with an LLM proposal step. The discovery phase collects objective signals (manifest files, dependency lists, detected test runners, linter configs, CI files, directory conventions); the LLM then proposes a `galloper.json` whose hook suite matches what the project actually uses, with each hook annotated with a short rationale.

**How it composes.** This is the LLM-driven upgrade path for onboarding (§2). `galloper init` can offer a "generate from project" mode alongside the static `--template` presets; `galloper doctor` can suggest *additions* to an existing config when new tooling appears in the repo (e.g. a new `ruff.toml` shows up — propose a `post-task-file` entry for it).

**Discovery signals (deterministic).** No model call needed for these — they are pure file inspection:
- Package manifests: `package.json`, `Cargo.toml`, `go.mod`, `pyproject.toml`, `Gemfile`, `composer.json`
- Tooling configs: `eslint.config.*`, `prettier.config.*`, `tsconfig.json`, `ruff.toml`, `mypy.ini`, `.golangci.yml`, `rustfmt.toml`, `.editorconfig`
- Test frameworks: presence of `vitest.config.*`, `jest.config.*`, `pytest.ini`, `go test` targets, `cargo test` conventions
- Monorepo markers: `pnpm-workspace.yaml`, `turbo.json`, `nx.json`, `lerna.json`
- CI files: `.github/workflows/*.yml`, `.gitlab-ci.yml` — as strong evidence of what the project considers its quality bar
- Directory shape: `src/` vs. `packages/` vs. `cmd/` + `internal/` vs. `apps/` + `libs/`

**LLM proposal step (probabilistic, gated).** With signals in hand, the model is asked to produce a `galloper.json` that:
- Maps each detected tool to the appropriate lifecycle phase (`post-task-file` for formatters/linters, `post-task` for test suites, `pre-plan` for architectural steering)
- Scopes globs correctly (per-workspace in monorepos, per-language in polyglot repos)
- Adds a one-line rationale per hook so the user can audit the proposal
- Leaves a clearly marked "unsure — review" section for anything it couldn't confidently place

**Design constraints.**
- The output must round-trip through galloper's real config loader before being written. A proposal that fails validation is never persisted.
- Proposals are **diffs against the current config**, not replacements. If a `galloper.json` already exists, the user sees an additive or corrective patch, never an overwrite.
- Every generated hook must carry its discovery rationale (as a sibling doc or inline comment equivalent) — a user must be able to tell *why* each hook was proposed.
- The generation step is **opt-in and cached**. Repeated `galloper init` runs should not re-ask the model unless the discovery signals have changed.
- Generated configs are treated as **starting points, not endorsements**. The README produced alongside must reiterate that every hook should be reviewed before it runs destructive commands.

**Open questions.**
- Which model runs the generation — whatever `defaultPlanner` resolves to, a dedicated `configGenerator` role, or a fixed recommendation? This matters because the user may not yet have a planner configured (chicken-and-egg with onboarding).
- Should generation be a single-shot LLM call, or a small agentic loop (propose → validate → refine on validation errors)? The latter is more robust but more expensive.
- How does the generator know what the user *wants* enforced vs. merely what is *present*? A quick questionnaire before the model call ("block merges on test failure? warn or retry on lint?") vs. inferring from CI severity.
- How are proposals versioned — alongside the static templates, or as run artifacts under `galloper-data/`?
- How much of the output belongs in `galloper.json` vs. a companion `galloper.generated.md` with the rationales, keeping the config file itself clean?
- Interaction with reevaluation (§3): if the project acquires new tooling mid-run, should the pipeline itself propose hook additions, or is that strictly a separate `galloper doctor` concern?

---

**Design constraints.**
- Each example must actually run — a contributor should be able to `git clone`, follow the README, and see hooks firing on a real sample prompt.
- Examples should be **minimal but realistic**. Prefer small, representative hook suites over exhaustive ones; quality of explanation beats quantity of hooks.
- Examples must stay in sync with galloper's hook/event surface. A deprecation in the core surface should fail the examples' CI.
- No example should pretend to be a production setup. Each README must reiterate galloper's alpha status.

**Open questions.**
- Where do examples live — in `examples/` inside this repo, or in a separate companion repo? In-tree pressures test the hook surface on every change but bloats the repo; out-of-tree is cleaner but drifts faster.
- What's the minimum set to ship first? A single end-to-end example probably teaches more than a broad but shallow matrix.
- How is each example verified in CI — full hook runs against a local mock LLM, or structure-only smoke tests (config valid, hook commands invokable)?
- Should examples include golden outputs (session JSONs, log excerpts) so users know what "healthy" looks like?
- How are they discovered — a top-level `examples/README.md` index, a link table in the main README, or a `galloper init <template>` scaffolding command down the line?
- What's the contribution model for new examples? Free-form, or required to follow a template (same README sections, same `galloper.json` skeleton)?

---

## 11. Hook Coverage for Undeclared File Changes

**Intent.** galloper's `pre-task-file` / `post-task-file` hooks match against declared globs, which implicitly assumes the set of files a task touches is either listed ahead of time or matches a pattern the user knew to configure. In practice, even with a carefully structured prompt enumerating expected files, LLMs routinely write outside that list — a dependency gets bumped in `package.json`, a sibling config gets tweaked, a helper two directories over gets refactored as a side effect. Those out-of-manifest changes **escape the hook system entirely**. galloper needs a way to detect and gate file changes the model made but did not declare, or the whole premise of "deterministic edges around a probabilistic step" has a hole in it.

**Why this matters.** It's the central trust boundary. A QA gate that lints `src/**/*.ts` is meaningless if the model can silently edit `scripts/release.sh` and slip past the linter. "Only what was declared is checked" is an invariant by accident, not by design.

**Primary approach: post-hoc diff against the workspace.**

```
  pre-task   ──►  capture baseline (git rev / snapshot)
                  │
                  ▼
  task runs  ──►  LLM writes — declared and undeclared
                  │
                  ▼
  post-task  ──►  diff workspace vs. baseline
                  │
        ┌─────────┴──────────┐
        ▼                    ▼
   declared paths         surprise paths
   → normal hooks         → `task.file.undeclared`
                          → policy: warn / retry / abort
                          → optionally run matching hooks anyway
```

The default implementation is `git diff` against a baseline captured at `pre-task`. It's cheap, deterministic, well understood, and the common case (project is a git repo) makes it free. For non-git workspaces (docs projects, iac without VCS, scratch dirs), fall back to a pre/post filesystem snapshot with content hashing.

**Multi-repo implication (acknowledged).** A single `git diff` only covers the repo galloper is running in. Real workspaces are often multi-root: a monorepo where the touched file lives in a sibling package with its own `.git` boundary, a setup where galloper runs from one repo but the LLM also modifies a linked repo checked out nearby, a dev environment with generated artifacts in an ignored submodule. Solving undeclared-change detection properly **requires first-class multi-repo / multi-worktree support** in galloper — which is a real scope increase and should be called out up front, not smuggled in. Without it, a "safe" single-repo check creates false confidence the moment the workspace gets more complex.

**Alternative / complementary approaches.**

- **Filesystem watcher.** Install an inotify/fsevents watcher for the duration of the task and collect the union of written paths. No git dependency, but platform-dependent and noisy (editors, build caches, language servers).
- **Pre/post filesystem snapshot with hashing.** Simpler than a live watcher, slower than a git diff; useful as the non-git fallback.
- **LLM-side enforcement via tool protocol.** Where the underlying CLI exposes structured tool calls, intercept file-write calls and validate against the declared manifest *before* the write. Strongest guarantee, but couples galloper to each CLI's tool schema — heavy and fragile.

**Design constraints.**
- Default to the git-diff path when a repo is present — cheapest, most common, zero new dependencies. Fall back to snapshot only when git is unavailable.
- Must classify every post-task change as **expected** (matches declared manifest / glob) or **surprise** (doesn't). Expected changes run through the normal `post-task-file` hooks. Surprise changes flow through a separate, louder path — a dedicated event, a configurable policy (`warn` / `retry` / `abort`), and optional opt-in to run matching hooks against them anyway.
- Detection must be **unavoidable from the model's perspective**. The orchestrator, not the model, owns the manifest of what was actually touched. A model that hides writes by omitting them from its output still can't hide them from the diff.
- Multi-repo support, when it lands, must be an explicit, declared set of tracked roots — not auto-detected magic. Surprise writes to an undeclared root are themselves a surprise.

**Open questions.**
- Single-repo diff is straightforward; what is the right **data model for multi-repo**? A `workspace.roots` list in `galloper.json`, an auto-discovered set via `git worktree list` / submodule parsing, or a first-class `workspace` concept independent of git?
- What is the right **default policy** on a surprise change — `warn`, `retry`, or `abort`? Likely `warn` for README/config tweaks, `abort` for source under strict gate patterns — but the defaults need concrete guidelines, not vibes.
- Where does the baseline live? A captured ref at `pre-task` (git stash or revision hash), a full filesystem snapshot under `galloper-data/baselines/{session-id}/`, or both for cross-checking?
- How does this interact with a **pre-existing dirty working tree**? Refuse to start? Treat the task-start state as baseline regardless of cleanliness? Require `--allow-dirty`?
- How does undeclared-change detection feed the adaptive loop (§3)? A surprise write is a prime reevaluation trigger — *"the model touched something it didn't plan to; is the plan still correct?"*
- What is the cost of `git status` + targeted `git diff` per task on large repos / long pipelines? Measurable but probably acceptable; pathological monorepos may need scoping.
- What gets reported to the user — a flat list of surprise paths, a classified list (source / config / generated / tooling), or a structured `task.file.undeclared` event per path the dashboard (§8) and TUI (§9) can render?

---

## 12. User-Editable Plan / Implement Prompt Templates

**Intent.** The prompts that drive `plan` and `implement` are currently hard-coded in `src/lib/PromptTemplates.ts` and loaded as constants by `Planner` and `Executioner` (e.g. `Executioner.loadPromptTemplate` returns `IMPLEMENT_PROMPT` verbatim). That makes the most consequential strings in galloper — the ones that actually shape what the LLM does in each phase — unreachable from a project's config. A user who wants to enforce a house style, add a project-specific preamble, or swap in a different planning rubric has to fork the codebase. The implementation/execution loop should be **editable per project**, just like `commands` and `hooks` already are.

**Why this matters.** Hooks and command entries already let users shape the *deterministic edges* around each phase. The prompt template is the *probabilistic core* of that same phase. Leaving it un-overridable means the most important behavioral surface is the least configurable one — and the only escape valve today is "wrap your whole prompt in your own preamble before calling galloper," which defeats the point of having a planner/executor abstraction.

**Design constraints.**
- Templates must be **resolved with a clear precedence**, mirroring how command resolution already works: explicit per-command override → project-level override in `galloper.json` → built-in default. The built-in must remain a working fallback so a fresh `galloper init` still does something useful.
- Overrides must be **inspectable and versionable**. Inline strings in `galloper.json` work for short cases; a `templates/` directory referenced by path is the right answer for non-trivial prompts so they live in their own files and diff cleanly.
- The template variable surface (`{{CWD}}` today, more later) must be **explicit and documented** — not "whatever happens to be in scope at render time." Adding a new variable should be a deliberate change to a documented contract.
- Validation must catch broken overrides at config load (`galloper doctor`), not at run time. Missing template files, unknown variables, empty overrides — all should fail loudly before a subprocess spawns.
- Per-command overrides (a specific `claude-haiku` entry shipping its own `implement` prompt) must compose with the existing `allowedSubcommands` / `disallowedSubcommands` machinery without surprises.

**Open questions.**
- What is the right shape in `galloper.json` — a top-level `prompts: { plan, implement }` block, a per-command `prompts` field, or both with a documented precedence?
- Inline strings vs. file paths vs. both? Files are better for anything non-trivial but introduce a new "where do template files live" decision (project-relative? `galloper-data/templates/`? a configurable dir?).
- What template variables are part of the **stable contract**? `{{CWD}}` is in today; obvious candidates are `{{PROMPT}}`, `{{PLAN_FILE}}`, `{{TASK_INDEX}}`, plus discovered context once §5 lands. Locking the surface early prevents users' templates from breaking on upgrade.
- Should overrides be **additive** (preamble / postamble slots that wrap the built-in) or **replacing** (full template takeover)? Additive is safer for users who only want to nudge behavior; replacing is necessary for users who want full control. Probably both, with the additive form as the recommended default.
- How does this interact with adaptive replanning (§3)? The reevaluation step is its own prompt — does it inherit the same override mechanism, or does it get its own slot?
- How does this interact with the LLM-assisted hook generation (§10)? A generated config could ship project-tailored prompt overrides alongside the hook suite — but only if the override surface exists first.
- What does `galloper doctor` need to check on a custom template — presence, non-emptiness, mention of required variables, or actually round-tripping a render with sample inputs?

---

## Feedback

These are all open design threads. If you have experience with any of them — especially in production orchestration systems, multi-model pipelines, or MCP integrations — please open an issue or discussion. The goal of this document is to make the unknowns explicit, not to pretend they're solved.
