# Onboarding Implementation Plan (ROADMAP §2)

Superficial implementation plan for ROADMAP §2 — *User Onboarding & Configuration Discovery*. Four milestones, shipped in order: **B → D → A → C**. Each milestone is independently shippable and leaves reusable pieces behind for the next.

Test framework: **vitest** (already in use). Test layout: `tests/unit/`, `tests/integration/`, `tests/fixtures/`, `tests/helpers/`.

---

## B — `galloper doctor`

A new subcommand that loads the existing `galloper.json`, reports everything broken about it, and exits non-zero if anything is.

### Implementation shape

- New module `src/lib/Doctor.ts` exporting `runDoctor(config: LlmConfig, deps): DoctorReport`.
- New types: `DoctorReport = { errors: DoctorIssue[]; warnings: DoctorIssue[] }`, `DoctorIssue = { code: string; message: string; path: string }`.
- New CLI branch in `src/run-llm-session.ts`: `galloper doctor [--config <path>]`.
- Dependencies injected (for testability): PATH-lookup helper, filesystem reader.

### Checks (v1)

1. Config loads and parses (reuse `ConfigManager`).
2. `default` / `defaultPlanner` / `defaultExecutioner` resolve to existing command entries.
3. Each command entry's first shell token exists on `$PATH`.
4. `allowedSubcommands` / `disallowedSubcommands` reference known subcommands.
5. Hook event names match the known event set.
6. Hook globs are syntactically valid.

### Out of scope

`--fix`, version probing, network checks, hook command dry-runs.

### Testing

**Unit** — `tests/unit/Doctor.test.ts`. Pass a loaded `LlmConfig` and stub the PATH-lookup.

| Case | Expected |
|---|---|
| Valid config, all binaries present | `errors: [], warnings: []` |
| `default` references non-existent command entry | 1 error, code `UNKNOWN_DEFAULT` |
| `defaultPlanner` references non-existent command | 1 error, code `UNKNOWN_PLANNER` |
| `defaultExecutioner` references non-existent command | 1 error, code `UNKNOWN_EXECUTIONER` |
| Command entry's first token not on `$PATH` | 1 error, code `BINARY_NOT_FOUND` |
| `allowedSubcommands` contains unknown subcommand | 1 error, code `UNKNOWN_SUBCOMMAND` |
| Hook event name unknown (e.g. `post-taks`) | 1 error, code `UNKNOWN_EVENT` |
| Hook glob syntactically invalid | 1 error, code `INVALID_GLOB` |
| Multiple issues at once | All surfaced, none hide each other |

**Integration** — `tests/integration/doctor.test.ts`. Run the CLI against fixtures in `tests/fixtures/doctor/`.

- `valid-config/galloper.json` → exit 0, empty report on stdout.
- `broken-defaults/galloper.json` → exit 1, stderr names the offending key.
- `missing-binary/galloper.json` → exit 1 (use a deliberately bogus command).
- `--config <path>` resolves relative paths correctly.
- Config file missing → exit 1 with a clear "not found" error (not a stack trace).

**Helpers** — `tests/helpers/fakePathLookup.ts` returning a configurable set of "present" binaries.

### Acceptance criteria

- [x] `galloper doctor` exits `0` on a valid config, `1` on any error.
- [x] Every error includes a `code`, a human-readable `message`, and the offending config `path` (e.g. `commands.claude-haiku.command`).
- [x] A missing `galloper.json` produces a clear error, not a stack trace.
- [x] All checks above are covered by unit tests; all CLI flags are covered by integration tests.
- [x] No new runtime dependencies added.
- [x] `just test` passes.

---

## D — In-flow discovery (nearest-match suggestions)

Better error messages. When the user mistypes a subcommand, command name, or hook event, point at the nearest valid option instead of dumping a stack.

### Implementation shape

- New module `src/lib/Suggest.ts` exporting `nearest(input: string, candidates: string[], max?: number): string[]`. Levenshtein distance, no dependency.
- Wire into existing error sites:
  - CLI arg parsing (unknown subcommand) in `src/run-llm-session.ts`.
  - `CommandResolver` (unknown command name referenced by `default*`).
  - `ConfigManager` validation (unknown subcommand in allow/disallow lists, unknown hook event name).
  - `Doctor` enriches its messages via the same helper.

### Out of scope

Fuzzy flag matching, auto-correct prompts, colored output.

### Testing

**Unit** — `tests/unit/Suggest.test.ts`.

| Case | Expected |
|---|---|
| Exact match present in candidates | Returns `[exact]` or empty (define behavior; probably empty — no suggestion needed) |
| One-character typo (`plna` vs `plan`) | `plan` is first suggestion |
| Transposition (`paln` vs `plan`) | `plan` is first suggestion |
| Completely unrelated input | Returns `[]` (distance above threshold) |
| Multiple near matches | Ordered by distance, capped at `max` |
| Empty candidates list | Returns `[]` |
| Empty input | Returns `[]` |
| Unicode input | Does not crash |

**Integration** — exercised through existing error paths; add focused cases:

- `tests/integration/cli-errors.test.ts` — `galloper plna` produces stderr containing `did you mean 'plan'`.
- `tests/integration/config-errors.test.ts` — config with `"allowedSubcommands": ["paln"]` produces an error mentioning `plan`.
- Regression check: error messages that *don't* have a near match remain clean (no empty "did you mean" line).

### Acceptance criteria

- [ ] `nearest()` returns a sensible suggestion for any single-character typo of a valid option.
- [ ] Unknown subcommand at the CLI suggests the nearest of `single-prompt`, `plan`, `implement`.
- [ ] Unknown command name in `default` / `defaultPlanner` / `defaultExecutioner` suggests the nearest configured command.
- [ ] Unknown hook event name suggests the nearest event from the known set.
- [ ] Suggestions never fire for inputs too distant from any candidate (no noise).
- [ ] Existing error message format is preserved; the suggestion is an additive line.
- [ ] No new runtime dependencies added.

---

## A — `galloper init` (scaffolding subcommand)

Detect installed LLM CLIs, prompt for choices, write a valid minimal `galloper.json`.

### Implementation shape

- New module `src/lib/Init.ts` exporting `runInit(opts): InitResult`.
- New CLI branch: `galloper init [--force] [--non-interactive] [--default <name>]`.
- Flow:
  1. Refuse if `galloper.json` exists unless `--force`.
  2. Detect candidates from a hardcoded list (`claude`, `codex`, `gemini`) via B's PATH helper.
  3. TTY: prompt user to pick which to wire up and which is the `default`.
  4. Non-TTY / `--non-interactive`: pick all detected; use first as `default`.
  5. Build `LlmConfig` in-memory with one command entry per selection and a conservative hardcoded command string per CLI.
  6. **Round-trip through `ConfigManager`'s loader** to validate before writing.
  7. Atomic write (tmp + rename).

### Prompt layer

Plain Node `readline` — no Ink/blessed. Constraint from §2: shared components with future TUI. Way to honor that now: don't pick a framework yet.

### Out of scope

Version probing, editing existing configs, writing outside the repo, shell-completion, template selection (that's C).

### Testing

**Unit** — `tests/unit/Init.test.ts`. Inject PATH-lookup, prompt, and filesystem writer.

| Case | Expected |
|---|---|
| No CLIs detected | Returns error result, writes nothing |
| One CLI detected, non-interactive | Config has that command, `default` = it |
| Multiple CLIs detected, non-interactive | All added, first detected is `default` |
| `--default <name>` overrides auto-pick | `default` = specified name |
| `--default <name>` names a CLI not detected | Errors before writing |
| Interactive: user picks subset | Only selected CLIs in output |
| Interactive: user picks `default` | Honored in output |
| Generated config fails loader validation | Throws; nothing written (should be unreachable, but the check is required by constraint 1) |
| `galloper.json` exists, no `--force` | Refuses, exits non-zero, nothing written |
| `galloper.json` exists, `--force` | Overwrites |
| Write fails mid-flight | No partial file left at destination (atomic write works) |

**Integration** — `tests/integration/init.test.ts`. Real filesystem in a temp dir.

- Non-interactive run in empty dir produces a `galloper.json` that `galloper doctor` then accepts.
- Non-interactive run with no LLM CLI on `$PATH` (stubbed) exits non-zero with a useful message.
- `--force` flag behavior on pre-existing config.
- Round-trip: `init` → `doctor` → `single-prompt --prompt "hi"` (with a mocked CLI on `$PATH`) succeeds end-to-end.

**Helpers** — `tests/helpers/tempRepo.ts` for temp-dir setup/teardown; `tests/helpers/fakePrompt.ts` returning scripted answers.

### Acceptance criteria

- [x] `galloper init` in an empty repo with at least one supported CLI on `$PATH` produces a `galloper.json` that `galloper doctor` accepts.
- [x] Generated configs always pass the same loader that runs at execution time (constraint 1).
- [x] Refuses to overwrite an existing `galloper.json` without `--force` (constraint 2).
- [x] Works without a TTY via `--non-interactive` (constraint 3).
- [x] No new runtime dependencies added beyond Node's `readline`.
- [x] Prompt layer is a thin wrapper reusable by future TUI work — no framework lock-in.
- [x] Failure modes (no CLI detected, write error, validation failure) leave the filesystem untouched.

---

## C — Template starters (`init --template <name>`)

`galloper init --template react-ts` drops a known-good config wired for that stack.

### Blocking dependency

**Blocked on ROADMAP §10.** Templates are only meaningful if reference examples exist to back them. Ship B/D/A first; revisit when §10 has at least one real example in `examples/`.

### Implementation shape (when unblocked)

- New directory `templates/` in repo, one subdir per template containing a `galloper.json`.
- `Init.ts` gains a `--template <name>` path that:
  1. Loads the template file.
  2. Applies the CLI-detection overlay (fills in `command` strings based on what's on `$PATH`).
  3. Round-trips through the loader.
  4. Writes.
- `galloper init --list-templates` enumerates available templates.

### Out of scope

Remote templates, template versioning beyond "what's in the repo now," user-contributed templates, template variables beyond CLI-name substitution.

### Testing

**Unit** — `tests/unit/InitTemplate.test.ts`.

| Case | Expected |
|---|---|
| Unknown template name | Errors with suggestions from D |
| Known template, CLI present | Config written, command strings filled |
| Known template, required CLI missing | Errors clearly naming the missing CLI |
| `--list-templates` | Prints discovered templates, exits 0 |
| Template file itself is invalid | Loud failure; the CI check below should have caught it earlier |

**Integration** — `tests/integration/init-templates.test.ts`.

- For each shipped template: `init --template <name>` in a temp repo → `doctor` accepts the result.
- Template + existing `galloper.json` respects the same `--force` rules as bare `init`.

**CI gate** — every file in `templates/` must pass `ConfigManager` load at test time. This prevents template rot as the config surface evolves (same pressure §10 examples will face).

### Acceptance criteria

- [ ] At least one template shipped and passing full integration test.
- [ ] Every template in `templates/` is validated in CI by the same loader that runs at execution time.
- [ ] `init --template <name>` produces a config that `doctor` accepts.
- [ ] Missing required CLI for a template produces a clear, actionable error.
- [ ] `--list-templates` works and is documented.
- [ ] Templates kept in-tree (per §10 open question — revisit if pattern grows).

---

## What this plan deliberately doesn't do

- No new runtime dependencies (no prompt libraries, no fuzzy-match packages, no TUI frameworks).
- No changes to the orchestrator pipeline — these are new subcommands sitting alongside the existing three.
- No shared "onboarding engine" abstraction. Four small modules, a few shared helpers (`Suggest`, PATH lookup, prompt wrapper). If a pattern emerges later, extract then — not now.

## Cross-milestone reuse

| Helper | Introduced by | Reused by |
|---|---|---|
| PATH-lookup helper | B | A, C |
| `DoctorIssue` shape | B | A (validation feedback) |
| `nearest()` / Suggest | D | B, A, C, existing CLI |
| Prompt wrapper (readline) | A | C, future §9 TUI |
| Atomic file write | A | C |
