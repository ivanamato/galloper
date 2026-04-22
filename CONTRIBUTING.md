# Contributing to galloper

Thanks for your interest in contributing. galloper is in early alpha (see the note in [README.md](README.md)) — breaking changes are expected, and the design is still in flux. That makes this an ideal time to contribute: patterns aren't ossified yet, and well-argued proposals carry real weight.

This document covers:

- [Contribution workflow](#contribution-workflow)
- [Development environment](#development-environment)
- [Commands you'll use daily](#commands-youll-use-daily)
- [Codebase tour](#codebase-tour)
- [Coding standards](#coding-standards)
- [Testing](#testing)
- [Pull request checklist](#pull-request-checklist)

---

## Contribution workflow

1. **Open an issue first for non-trivial changes.** Bug reports are always welcome as PRs. Features, refactors, or design-shape changes should be discussed in an issue before code is written — it saves everyone time.
2. **Check [ROADMAP.md](ROADMAP.md)** before starting larger work. Several topics have unresolved design questions; aligning on direction avoids wasted effort.
3. **Fork and branch.** Use a short, descriptive branch name (`fix/config-loader-error-message`, `feat/semantic-search-spike`).
4. **Keep PRs focused.** One concern per PR. Mixing a refactor with a bug fix makes review harder and bisecting worse.
5. **Write tests.** Every behavior change needs a test. See [Testing](#testing).
6. **Run the full suite locally.** `just test` must be green before you push.
7. **Write a clear commit message.** Explain *why*, not *what* — the diff shows the what.
8. **Open the PR against `master`.** Fill in what changed, why, and how you verified it.

---

## Development environment

### Requirements

- **Node.js 20+** (the project targets ES2020 and uses native ESM)
- **npm** (ships with Node)
- **[just](https://github.com/casey/just)** (optional but recommended — all common workflows have a recipe)
- A POSIX shell (galloper spawns subprocesses via `/bin/sh -c`)

### First-time setup

```bash
git clone <your-fork>
cd galloper
just setup        # installs dependencies and builds
```

Without `just`:

```bash
npm install
npm run build
```

### Verify your setup

```bash
just test         # should exit 0 with all tests passing
just status       # version, Node, build state
```

---

## Commands you'll use daily

All of these live in the [`justfile`](justfile). Run `just` (no args) for the full list.

| Command | What it does |
|---------|--------------|
| `just build` | Compile `src/` → `dist/` |
| `just test` | Run the full Vitest suite once |
| `just test-watch` | Watch mode — reruns affected tests on save |
| `just test-coverage` | Generate a coverage report (`coverage/`) |
| `just dev <args>` | Build + run galloper with arguments (e.g. `just dev plan --prompt "x"`) |
| `just clean` | Remove `dist/` and `galloper-data/` |
| `just status` | Version, Node version, build state |

Equivalent npm scripts exist (`npm run build`, `npm test`, `npm run test:watch`, `npm run test:coverage`, `npm run test:unit`, `npm run test:integration`) if you prefer.

### Running galloper against your change

```bash
just dev single-prompt --prompt "hello" -v
just dev plan --prompt-file ./task.txt -vv
```

The `prerun` npm script auto-builds, so you don't need to `just build` between edits when using `just dev`.

---

## Codebase tour

galloper follows a **layered, single-responsibility design**. Each module has a clearly defined role, exported interfaces, and is independently testable.

### Layers

```
CLI Layer (src/run-llm-session.ts)
    ↓ parses args, resolves prompts

Orchestrator Layer (src/lib/Orchestrator.ts)
    ├─ maps orchestration commands → LLM commands (user overrides first)
    ├─ uses CommandResolver for dynamic command resolution with fallback
    ├─ routes 'plan' commands to Planner
    └─ orchestrates execution pipeline

Core Execution Layer
    ├─ CoreRunner (src/lib/CoreRunner.ts) — subprocess spawning
    ├─ ConfigManager (src/lib/ConfigManager.ts) — command resolution + validation
    ├─ CommandResolver (src/lib/CommandResolver.ts) — command selection with fallback
    ├─ Planner (src/lib/Planner.ts) — plan generation via LLM
    ├─ SessionManager (src/lib/SessionManager.ts) — file I/O
    └─ Logger (src/lib/Logger.ts) — centralized event logging
```

### Core flow (per run)

1. **Parse arguments** — positional subcommand + `--prompt` / `--prompt-file`
2. **Load config** — read `galloper.json`, resolve the command for the subcommand
3. **Route** — `single-prompt` executes directly; `plan` and `implement` route to specialized workflows
4. **Spawn subprocess** — resolved command runs, prompt piped on stdin
5. **Capture I/O** — stdout/stderr collected and logged chunk-by-chunk
6. **Parse output** — JSON events and final agent message extracted
7. **Persist** — session file + append to central log
8. **Return** — JSON result with session ID, exit code, final message

### Type system

All modules export interfaces. Build output includes `.d.ts` for external consumers. When adding a module, export its public types from the module file.

| Module | Exports |
|--------|---------|
| **Logger** | `LogEvent` (union of all log event types) |
| **SessionManager** | `SessionRecord` (complete session state) |
| **ConfigManager** | `CommandEntry`, `LlmConfig` (config shape) |
| **CoreRunner** | `RunResult`, `RunOptions` (subprocess contract) |
| **CommandResolver** | `ResolveResult` (resolution outcome with fallback tracking) |
| **Planner** | `PlanInput`, `PlanResult`, `PlanFile` (plan generation contract) |
| **Orchestrator** | `OrchestratorInput`, `OrchestratorResult` (public interface) |

### Hook isolation

The runner sets `CODEX_DISABLE_PROJECT_HOOKS=1` during subprocess execution so parent-workspace hooks don't leak in. galloper is its own Git repo and should not inherit outside configuration. If you add environment plumbing, preserve this guarantee.

---

## Coding standards

The project intentionally keeps a narrow style. Follow it.

### SOLID & clean architecture, enforced in practice

- **Single responsibility.** Each module in `src/lib/` owns one concern (config, command resolution, subprocess I/O, session persistence, logging, planning). If a new class starts doing two of these, split it.
- **Open/closed.** Behavior should be extended via configuration or new strategy-style modules, not by editing existing modules' internals. Lifecycle hooks and event handlers are the primary extension surface.
- **Liskov & interface segregation.** Public interfaces are narrow on purpose — `RunResult`, `OrchestratorResult`, `PlanFile`, etc. expose only what callers need. Don't widen them casually.
- **Dependency inversion.** Modules depend on exported interfaces, not on concrete constructors. Constructor-inject collaborators; don't reach for globals or singletons.
- **Layer discipline.** The CLI layer knows about the Orchestrator; the Orchestrator knows about the Core layer; the Core layer does not know about anything above it. Don't introduce upward imports.

### TypeScript rules

- `strict: true` is non-negotiable. No `any`. If you need an escape hatch, narrow it explicitly (`unknown` + a validator) and document why.
- All public functions have typed parameters and return types. Async work returns `Promise<T>`.
- Runtime-parsed data (JSON config, subprocess output) must be validated before being assigned to a typed variable. Cast only after validation.
- Use `.js` extensions on relative imports — required for native ESM, enforced by the compiler.
- Keep source under `src/`; test code under `tests/`. Do not mix.

### Module conventions

When adding a module to `src/lib/`:

1. Create `src/lib/NewModule.ts` with an exported class or function and its public interfaces.
2. Import it in `Orchestrator.ts` (or wherever it composes in) using dependency injection.
3. Write a unit test in `tests/unit/NewModule.test.ts`.
4. Add integration coverage in `tests/integration/` if the module participates in a full run.
5. Update the type-system table in this document if the module exports public interfaces.
6. Run `just build && just test` before committing.

### Comments & docs

- Default to **no comments**. Good names and small functions carry the meaning.
- Write a comment only when the *why* is non-obvious (hidden invariant, workaround, surprising constraint). Don't comment *what* the code does.
- Public-facing behavior changes go in the relevant top-level doc (`README.md`, `EVENTS.md`, `TROUBLESHOOTING.md`, `ROADMAP.md`), not in source comments.

### Error handling

- Fail early, at the boundary where the invariant is violated. Don't propagate validation errors deep into the pipeline.
- Throw typed errors with clear messages that name the offending input (command name, subcommand, config field).
- Preserve subprocess exit codes in session records and CLI output — they are contract.
- At system boundaries (config load, subprocess I/O, user input) validate explicitly. Internal code trusts its own types.

### What *not* to add

- **No speculative abstractions.** Three similar lines are better than a framework for a hypothetical fourth use.
- **No backwards-compatibility shims** unless there is a concrete user to protect. Alpha is the time to break cleanly.
- **No silent fallbacks** that hide misconfiguration. Loud failures are a feature.
- **No new runtime dependencies** without a discussion in the PR. The current dependency footprint is intentionally tiny.

---

## Testing

Tests are the contract. See [`tests/README.md`](tests/README.md) for the in-depth testing architecture; this section covers what a contributor needs day-to-day.

### Layout

```
tests/
├── unit/          # Per-module tests — narrow, fast
├── integration/   # Full-flow tests — exercise Orchestrator with mock commands
├── fixtures/      # Test configs and mock-command shell scripts
└── helpers/       # Shared utilities (tempDir, JSONL readers)
```

### Running tests

```bash
just test                    # full suite
npm run test:unit            # unit only
npm run test:integration     # integration only
npm run test:watch           # watch mode during development
npm run test:coverage        # coverage report under coverage/
```

Each test runs in an isolated temp workspace created by `helpers/tempDir.ts` and cleaned up after. There is no shared state between tests.

### Writing a unit test

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ModuleName } from '../../src/lib/ModuleName.js';
import { createTempWorkspace, cleanup } from '../helpers/tempDir.js';

describe('ModuleName', () => {
  let tempDir: string;
  beforeEach(async () => { tempDir = await createTempWorkspace(); });
  afterEach(async () => { await cleanup(tempDir); });

  it('does the thing', async () => {
    const mod = new ModuleName({ /* injected deps */ });
    const result = await mod.doThing();
    expect(result).toEqual(/* ... */);
  });
});
```

### Writing an integration test

Integration tests wire up a real `Orchestrator` with its collaborators and run a mock command (see `tests/fixtures/mock-commands/`) so no real LLM is invoked. Verify:

- The returned `OrchestratorResult`
- The session file under the temp `galloper-data/sessions/`
- The central log (`galloper-data/logs/runs.jsonl`) event sequence

### Adding a mock command

1. Create `tests/fixtures/mock-commands/<name>.sh`.
2. `chmod +x` it.
3. Register it in the relevant fixture config (`galloper.test.json` / `galloper.pipeline.test.json` / `galloper.hooks.test.json`) with appropriate `allowedSubcommands` / `disallowedSubcommands`.
4. Smoke-test it: `bash tests/fixtures/mock-commands/<name>.sh < /dev/null`.

### Test expectations

- **Happy path + failure path.** Every new behavior ships with at least one of each.
- **Determinism.** No sleeps, no clock-sensitive assertions, no network. Flaky tests are bugs.
- **Observability.** Assert on session files and log events, not just return values — regressions in what we persist are real regressions.

---

## Pull request checklist

Before opening your PR, confirm:

- [ ] `just build` succeeds with no errors
- [ ] `just test` passes locally (full suite, not just the files you touched)
- [ ] New or changed behavior has tests
- [ ] Public interfaces or event shapes changed? Updated the relevant doc (`README.md`, `EVENTS.md`, `TROUBLESHOOTING.md`, `ROADMAP.md`, this file)
- [ ] No new runtime dependencies, or the PR body explains why the new dep is necessary
- [ ] Commit messages explain *why*, not *what*
- [ ] PR description covers: what changed, why, and how you verified it

If you're unsure about any of the above, open the PR anyway and flag what you're uncertain about — review is a conversation, not a gate.
