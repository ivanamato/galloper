# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Purpose

**galloper** is a production-grade TypeScript orchestrator for executing Claude Code commands programmatically. It:
- Provides a layered architecture: CLI → Orchestrator → Core execution engine
- Supports high-level orchestration commands (e.g., `--orchestration-command plan`) that map to LLM commands
- Spawns subprocess runners with that command and streams stdin prompts
- Captures all stdout/stderr and parses JSON-formatted events
- Persists typed session data and centralized logs with full traceability
- Returns structured, typed output with final message extraction

This is used for **automation workflows** — orchestrating multiple Claude Code runs, batch processing, integration with external systems, or testing Claude Code programmatically.

## Architecture

### Layered Design (SOLID Principles)

The codebase is organized into focused, single-responsibility modules:

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
    ├─ CommandResolver (src/lib/CommandResolver.ts) — smart command selection with fallback
    ├─ Planner (src/lib/Planner.ts) — plan generation via LLM
    ├─ SessionManager (src/lib/SessionManager.ts) — file I/O
    └─ Logger (src/lib/Logger.ts) — centralized event logging
```

### Type System

All modules export TypeScript interfaces for compile-time safety:

| Module | Exports |
|--------|---------|
| **Logger** | `LogEvent` (union type for all log event types) |
| **SessionManager** | `SessionRecord` (complete session state) |
| **ConfigManager** | `CommandEntry`, `LlmConfig` (config shape) |
| **CoreRunner** | `RunResult`, `RunOptions` (subprocess contract) |
| **CommandResolver** | `ResolveResult` (resolution outcome with fallback tracking) |
| **Planner** | `PlanInput`, `PlanResult`, `PlanFile` (plan generation contract) |
| **Orchestrator** | `OrchestratorInput`, `OrchestratorResult` (public interface) |

Build output includes `.d.ts` type definitions for external consumers.

### Request Flow

1. CLI parses positional subcommand argument (`single-prompt`, `plan`, or `implement`) → `CliArgs`
2. CLI calls `Orchestrator.execute(OrchestratorInput)` with subcommand
3. Orchestrator routes based on subcommand type
4. CommandResolver maps subcommand to config default (defaultPlanner for `plan`, defaultExecutioner for `implement`, default for `single-prompt`)
5. ConfigManager validates subcommand restrictions on resolved command
6. For `plan`/`implement`, Orchestrator spawns Planner/Executioner which handle specialized workflows
7. Orchestrator builds `SessionRecord`, writes to session file
8. Orchestrator emits `run.completed` log, returns `OrchestratorResult`
9. CLI outputs JSON to stdout, exits with subprocess exit code

## Build & Development

### Setup

```bash
npm install                # Install TypeScript + @types/node
npm run build              # Compile src/ → dist/
npm run run -- [args]      # Auto-builds + runs compiled CLI
```

### TypeScript Configuration

- **Target**: ES2020 (Node.js 20+)
- **Module**: ESNext (native ES modules)
- **Strict Mode**: Enabled (`strict: true`, `esModuleInterop`, `skipLibCheck`)
- **Output**: `dist/` with `.js`, `.d.ts`, and `.map` files
- **Source Maps**: Enabled for debugging

### Adding New Modules

1. Create `src/lib/NewModule.ts` with exported interfaces
2. Use `.js` extensions in relative imports (required for ESM)
3. Run `npm run build` to compile
4. Export from Orchestrator if part of core pipeline

### Type Safety

- All public functions have typed parameters and returns
- All async operations return `Promise<T>`
- No `any` types used — data flows through defined interfaces
- JSON parsing includes type assertions validated at runtime (e.g., `config as LlmConfig`)

## Commands

### CLI Usage

The CLI accepts several positional subcommands:

```bash
# single-prompt: send a prompt and get a response (uses default command)
npm run run -- single-prompt --prompt "Your prompt"

# plan: generate a plan for a task (uses defaultPlanner)
npm run run -- plan --prompt "Task to plan"

# implement: execute implementation based on a plan file (uses defaultExecutioner)
npm run run -- implement --plan-file ./galloper-data/plans/plan.json

# pipeline: generate and execute a plan in one step (uses defaultPlanner and defaultExecutioner)
npm run run -- pipeline --prompt "Build and execute a complete plan"

# doctor: validate the galloper.json configuration
npm run run -- doctor --config ./galloper.json

# init: scaffold a new galloper.json by detecting installed LLM CLIs
npm run run -- init --non-interactive

# Prompt from file
npm run run -- plan --prompt-file ./task.txt
```

### Doctor Subcommand

The `doctor` subcommand validates the `galloper.json` configuration and reports issues.

**Checks (v1):**
- Config file exists and is valid JSON
- `default`, `defaultPlanner`, and `defaultExecutioner` (if set) reference existing command entries
- Each command entry's first shell token exists on `$PATH`
- `allowedSubcommands` and `disallowedSubcommands` only reference known subcommands (`single-prompt`, `plan`, `implement`, `pipeline`)
- Hook event names match the known set (20 total events)
- Hook glob patterns are syntactically valid
- `workspace.roots[*].path` exists on disk
- `workspace.roots[*].vcs` claim matches reality (`.git` presence/absence)

**Exit codes:**
- `0` if no errors found
- `1` if any errors are found

**Example output:**
```bash
npm run run -- doctor --config ./galloper.json
# {
#   "errors": [
#     {
#       "code": "BINARY_NOT_FOUND",
#       "message": "command 'claude' not found on $PATH",
#       "path": "commands.claude-haiku.command"
#     },
#     {
#       "code": "WORKSPACE_ROOT_MISSING",
#       "message": "workspace root path does not exist on disk",
#       "path": "workspace.roots[0].path"
#     },
#     {
#       "code": "WORKSPACE_ROOT_VCS_MISMATCH",
#       "message": "workspace vcs type mismatch: claimed vcs 'git' but .git directory not found",
#       "path": "workspace.roots[1].vcs"
#     }
#   ],
#   "warnings": []
# }
```

### Init Subcommand

The `init` subcommand scaffolds a new `galloper.json` by detecting installed LLM CLIs on `$PATH` and writing a minimal, validated config.

**Detection set:** `claude`, `codex`, `gemini` (hardcoded; conservative default command strings per CLI).

**Flags:**
- `--force` — overwrite an existing `galloper.json`
- `--non-interactive` — skip prompts; select all detected CLIs with the first detected as `default`
- `--default <name>` — use the named CLI as the default command (must be one of the selected)

**Behavior:**
- Refuses to overwrite an existing `galloper.json` unless `--force` is given
- TTY detection: if either stdin or stderr is not a TTY, behaves as if `--non-interactive` were passed
- In TTY mode, prompts for which detected CLIs to include (comma-separated; blank or `all` picks all) and which to use as the default
- Round-trips the in-memory config through the same validator `ConfigManager` uses at load time before writing. Invalid configs are never written.
- Atomic write: contents go to `galloper.json.tmp-<random>` then `rename` to the final path. On any write failure the tmp file is unlinked and no partial file is left on disk.

**Exit codes:**
- `0` on success (config written)
- `1` on any failure (file exists without `--force`, no CLI detected, unknown `--default`, validation failure, write failure)
- `2` on argument parse errors (unknown subcommand, etc.)

**Example:**
```bash
npm run run -- init --non-interactive --default codex
# {
#   "ok": true,
#   "writtenPath": "/path/to/galloper.json",
#   "selected": ["claude", "codex", "gemini"],
#   "defaultName": "codex"
# }
```

### Command Resolution

Each subcommand resolves to an LLM command from `galloper.json`:

1. **`single-prompt`** → uses `config.default`
2. **`plan`** → uses `config.defaultPlanner` (falls back to `config.default`)
3. **`implement`** → uses `config.defaultExecutioner` (falls back to `config.default`)

The resolved command must allow the requested subcommand via `allowedSubcommands` and `disallowedSubcommands`.

### Verbosity

Control logging output with `-v` flags (stacked for higher levels). All verbose output goes to **stderr**; stdout is always reserved for the JSON result.

| Flag | Level | Output |
|------|-------|--------|
| (none) | 0 | Silent — only JSON result on stdout |
| `-v` | 1 | **Basic** — orchestration start/completion events (recommended for quick checks) |
| `-vv` | 2 | **Detail** — command resolution + intermediate steps like template loading, file writes |
| `-vvv` | 3 | **Debug** — all subprocess I/O (stdout/stderr chunks from child process) |

Examples:
```bash
npm run run -- single-prompt --prompt "Hello" -v                      # Basic verbosity
npm run run -- plan --prompt-file task.txt -vv                        # Detail level
npm run run -- implement --plan-file ./galloper-data/plans/plan.json # Full debug output
```

### Human-friendly Progress

For human-readable progress output independent of debug logging, use the `--human-friendly` / `-H` flag:

```bash
npm run run -- plan --human-friendly --prompt "Task to plan"
npm run run -- pipeline --human-friendly -v --prompt "Complex task"
```

This flag streams human-friendly messages to **stderr**, showing:
- Task/subcommand start messages
- Command resolution steps
- Plan summary (task count + titles)
- Task completion status
- Hook firings: phase/event type, command, exit code, duration, and truncated stdout/stderr — including skipped hooks and instructions-only pre-hooks
- Final completion summary

The `--human-friendly` flag is **independent** from `-v/-vv/-vvv` debug flags and can be combined with them. Both output to stderr while stdout remains reserved for the JSON result.

### Justfile Commands

**Recommended**: Use `just` commands for development automation. Run `just` or `just help` to see available recipes.

| Command | Purpose |
|---------|---------|
| `just help` | Show all available commands (default) |
| `just install` | Install npm dependencies |
| `just setup` | Install dependencies and build |
| `just build` | Compile TypeScript sources |
| `just test` | Run full test suite |
| `just test-watch` | Run tests in watch mode |
| `just test-coverage` | Run tests with coverage report |
| `just dev <args>` | Run galloper with arguments (e.g., `just dev plan --prompt "x"`) |
| `just clean` | Remove `dist/` and `galloper-data/` directories |
| `just version` | Show current version |
| `just bump-patch` | Bump patch version (e.g., 0.2.0 → 0.2.1) |
| `just bump-minor` | Bump minor version (e.g., 0.2.0 → 0.3.0) |
| `just update` | Pull latest, install, and rebuild |
| `just status` | Show version, Node version, and build status |

**Version management**: `bump-patch` and `bump-minor` update `package.json` and create a `VERSION` file. Remember to commit both after bumping.

**Version checking**: Each recipe that needs the version reads it dynamically from `package.json`, so the `VERSION` file is optional but recommended for clarity.

## Configuration

### galloper.json Format

```json
{
  "default": "claude-haiku",
  "defaultPlanner": "claude-haiku",
  "defaultExecutioner": "claude-haiku",
  "commands": {
    "codex": {
      "command": "codex exec --json --skip-git-repo-check -",
      "allowedSubcommands": [],
      "disallowedSubcommands": []
    },
    "claude-haiku": {
      "command": "claude --model claude-haiku-4-5-20251001 --allowedTools * --dangerously-skip-permissions",
      "allowedSubcommands": ["plan"],
      "disallowedSubcommands": [],
      "env": {"ANTHROPIC_API_KEY": "...", "FOO": "bar"}
    }
  }
}
```

**Top-level fields:**
- `default` (string, required) — Fallback command name for `single-prompt` subcommand
- `defaultPlanner` (string, optional) — Command name for `plan` subcommand; falls back to `default` if not set
- `defaultExecutioner` (string, optional) — Command name for `implement` subcommand; falls back to `default` if not set

**Command entry** (`CommandEntry`):
- `command` (string, required) — Shell command executed by `/bin/sh -c`
- `allowedSubcommands` (string[], optional) — If non-empty, only these subcommands can use this command (e.g., `["plan", "implement"]`)
- `disallowedSubcommands` (string[], optional) — These subcommands cannot use this command (e.g., `["implement"]`)
- env (object, optional) — Map of string env vars merged into the subprocess environment. Overrides inherited process env on key collision.

**Subcommand restriction rules:**
- Empty `allowedSubcommands` + empty `disallowedSubcommands` = command is allowed for all subcommands
- Non-empty `allowedSubcommands` = command is ONLY allowed for those subcommands
- `disallowedSubcommands` = command is NOT allowed for those specific subcommands (unless empty `allowedSubcommands` overrides)

Validation happens at config load time. If `defaultPlanner`/`defaultExecutioner` reference non-existent commands, load fails with a clear error.

### Hooks and Events

The application emits 20 different event types and supports 6 lifecycle hook phases. These can be configured in the `hooks` section of `galloper.json` to run custom commands at key points during execution.

**See `docs/EVENTS_AND_HOOKS.md` for a complete reference** of all events and lifecycle phases, their payloads, firing order, and example configurations.

Quick summary:
- **Lifecycle hooks** (`hooks.lifecycle`): `pre-plan`, `post-plan`, `pre-task`, `post-task`, `pre-task-file`, `post-task-file`
- **Events** (`hooks.events`): `run.started`, `run.completed`, `run.failed`, `task.completed`, `plan.started`, etc. (20 total)

Each hook/event can have one or more handlers (command to run, with optional timeout and failure mode).

## Session Files

Each run creates a typed `SessionRecord` at `galloper-data/sessions/{session-id}.json`:

```typescript
interface SessionRecord {
  id: string;
  prompt: string;
  command: string;
  cwd: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  parsedStdoutEvents: unknown[];
  parsedStderrEvents: unknown[];
  finalOutput: string | null;
}
```

### CLI Output

All commands return:

```json
{
  "sessionId": "2026-04-17T13-29-38-981Z",
  "sessionFilePath": "/path/to/galloper-data/sessions/2026-04-17T13-29-38-981Z.json",
  "exitCode": 0,
  "finalOutput": "The extracted final message from stdout"
}
```

Type: `OrchestratorResult`

## Central Log

Append-only JSONL file at `galloper-data/logs/runs.jsonl` with all events typed as `LogEvent`:

**Event Types:**
- `run.started` — Orchestration beginning (includes prompt, command, cwd)
- `run.command_resolved` — Resolved command string
- `process.spawn` — Subprocess spawned (includes command)
- `process.stdout` — Chunk received from stdout
- `process.stderr` — Chunk received from stderr
- `run.completed` — Execution finished (includes exitCode, durationMs, sessionFilePath, finalOutput)
- `run.failed` — Error during orchestration (includes error message)
- `run.crashed` — Bootstrap failure before any orchestration (includes error message)

Use for:
- **Audit trail** — Complete execution history with timestamps
- **Debugging** — Trace I/O, timing, error paths
- **Monitoring** — Parse for patterns, failures, SLAs
- **Integration** — Forward to external observability systems

## Important Notes

- **Error handling**: Validation errors (unknown command, subcommand restrictions) fail before subprocess spawn with clear error messages. Subprocess exit codes are preserved in session records.
- **Stdin handling**: Entire prompt is written to subprocess stdin and stream closed immediately. Subprocess is spawned via `/bin/sh -c` (non-login shell) for consistency across platforms.
- **Command execution**: Command strings are passed verbatim to shell. Environment variables can be included: `VAR=value command --flags`.
- **Output preservation**: Complete stdout/stderr captured in session files. For large outputs, use `parsedStdoutEvents` to reduce memory.
- **Type safety**: All modules export `.d.ts` files. External code can import types for tight integration.
- **Git isolation**: This is its own repository. Commands run from repo root; parent workspace hooks are disabled via `CODEX_DISABLE_PROJECT_HOOKS=1`.
- **Node version**: Requires Node.js 20+ (ES2020 target).
