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

## 2. Automatic Model Scaling

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

## 3. Cross-Tool Context Management

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

## 4. User Interaction During Pipeline Execution

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

## 5. MCP Server Exposure

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
- How does interaction (see §4) translate over MCP — does the caller become the "user" answering checkpoints?

---

## 6. HTTP Dashboard

**Intent.** Runs produce a lot of structured state — session records, central logs, events, plans, task attempts, hook results — that today is only observable by tailing JSONL files or opening session JSONs by hand. A local HTTP dashboard would make that state legible in real time: metrics, run history, live event streams, and — potentially — a lightweight UI where a user can interact with a running pipeline alongside the CLI (approving plans, injecting steering notes, marking tasks).

**Design constraints.**
- Must be **strictly optional and local-first**. galloper's core value is the CLI/library; the dashboard is a viewer, not a requirement.
- Must be **read-mostly by default**. Any write capability (approvals, overrides) should be explicit, authenticated at least to the local user, and configurable off.
- Must source its data from the existing artifacts (session files, central log, event stream) rather than duplicating state. There should be one source of truth.
- Should work offline, against historical runs, not only live ones.

**Open questions.**
- What ships first — a pure observer (metrics + run list + log viewer) or an interactive surface (approve/redirect)? They are very different scopes.
- What metrics are worth surfacing? Runs per day, pass/fail rate, mean duration, per-command cost/latency, retry rate, hook-failure rate, model-tier distribution (once §2 lands)?
- How is the server launched — a `galloper dashboard` subcommand, a separate binary, a flag on normal runs? Always-on or on-demand?
- Does the dashboard tail live runs by polling the log, or does galloper expose an event-stream endpoint (SSE/WebSocket) that handlers subscribe to? If the latter, the event bus becomes a shared dependency of CLI + dashboard.
- How does "work alongside the CLI" reconcile with user interaction (§4) — is the dashboard just another front-end to the same interaction protocol, or does it have its own?
- Authentication: loopback-only, shared-secret token, OS user check? What is the minimum viable bar for a local tool that occasionally exposes approve/abort?
- How much of this belongs in-tree vs. as a separate repo/package consuming galloper's artifacts?

---

## 7. TUI (Terminal UI)

**Intent.** A terminal UI would give users the same observability and interaction benefits as the HTTP dashboard (§6) without leaving the terminal — a live view of the current run, the plan tree, task status, streamed output, and inline approval prompts. It fits the CLI-first ethos and works equally well over SSH or in CI shells.

**Design constraints.**
- Must degrade gracefully. In dumb terminals, non-TTY contexts, or CI, the TUI should either not activate or fall back to plain logging — never corrupt output.
- Must share its data model with the dashboard (§6) and the event stream. Two parallel view implementations is a trap.
- Must not become the default for `just dev` / `npm run run` invocations. Structured JSON output on stdout is contract; the TUI is opt-in (a flag, a separate subcommand, or a separate binary).
- Should stay small. A heavy TUI framework is a disproportionate dependency for a tool whose core is a few hundred lines of orchestration.

**Open questions.**
- **When** should this land? Probably *after* the event bus / shared data model solidifies (tied to §6) — building the TUI first risks hard-coding assumptions that a dashboard later has to relitigate.
- What's the minimum useful surface? A live run view (events + current task + output tail), a run-history picker, or an interactive pipeline controller?
- Invocation model: `galloper watch`, `galloper run --tui`, or a sibling binary (`galloper-tui`)? Each has different tradeoffs for packaging and default behavior.
- Framework choice: a lightweight renderer (raw ANSI + a small helper), [Ink](https://github.com/vadimdemedes/ink), [blessed](https://github.com/chjj/blessed), or [ratatui](https://github.com/ratatui-org/ratatui)-style via a non-Node component? The answer is entangled with the dependency-footprint rule.
- Multi-run view: should the TUI show a single active run, a queue of concurrent runs, or both?
- Input handling: keyboard-only, or mouse-aware? Cross-platform terminal input is historically painful — pick the narrowest surface that's actually useful.
- How does the TUI coordinate with the HTTP dashboard if both are present — same process, separate processes sharing a socket, or mutually exclusive?

---

## 8. Reference Project Examples

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

## Feedback

These are all open design threads. If you have experience with any of them — especially in production orchestration systems, multi-model pipelines, or MCP integrations — please open an issue or discussion. The goal of this document is to make the unknowns explicit, not to pretend they're solved.
