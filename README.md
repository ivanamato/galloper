# galloper

galloper is a **deterministic orchestration shell for LLM coding agents**. It wraps any capable LLM CLI — Claude Code, Codex, Gemini CLI, others — in a typed, observable harness of hooks, events, and validation gates, so the probabilistic work of the model runs inside deterministic edges you control. It also tiers models across a single pipeline: frontier models plan, cheaper models execute and verify, with rule-driven escalation when a task outgrows its tier.

> ## Status: Alpha — Research & Study Use Only
>
> galloper is in **early alpha** and under active development. Expect breaking changes, rough edges, and unresolved bugs between releases; behavior may differ across environments, and your mileage will vary.
>
> It is intended **for experimentation, learning, and research purposes only**. **Do not deploy it to production** or rely on it for business-critical workflows. No stability, compatibility, or support guarantees are offered at this stage.

## Motivation

Most LLM-driven automation breaks down because it treats two different kinds of work the same way.

| | **Probabilistic** (use an LLM) | **Deterministic** (use code) |
|---|---|---|
| Nature | Same input → possibly different output | Same input → same output, always |
| Good at | Judgment, drafting, exploration, ambiguity | Invariants, gates, verification |
| Examples | Plans, refactors, summaries, classifications | Lint, tests, schema checks, release gates |
| Variability is… | A feature — surfaces options rules can't | A bug — breaks the guarantee |

**The guiding rule:** *let the model reason, let the harness verify.*

```
           ┌────────────────────────────────────────────┐
 prompt ──►│  probabilistic step  (LLM CLI — any)       │
           │  reason, draft, decompose                  │
           └──────────────────┬─────────────────────────┘
                              │  structured output
                              ▼
           ┌────────────────────────────────────────────┐
 galloper  │  deterministic shell                       │
 is this ──►│  hooks · events · validation · routing    │
           │  lint, test, schema, gate, persist, log    │
           └──────────────────┬─────────────────────────┘
                              ▼
                       typed result · session file · audit log
```

galloper is the deterministic shell: a thin, opinionated layer that wraps any capable LLM CLI (Claude Code, Codex, Gemini CLI, …) with edges, hooks, events, and typed outputs.

> **Today:** plan → execute (linear, write-once).
> **Aspiration:** plan → execute one step → reevaluate → continue or revise → … — a plan that stays alive throughout the run. See [ROADMAP §3](ROADMAP.md#3-adaptive-plan--execute--reevaluate-loop).

### Tiered model orchestration

A second goal: not every step needs a frontier model.

```
  hard problem ──►  [ Opus 4.7 / GPT-5.4 ]  plan
                              │
                              ▼  one task each
                    [ Haiku / mini / Flash ]  execute · verify
                              │
                  too hard?   │   ──►  escalate up one tier
                  too easy?   │   ──►  stay cheap
                              ▼
                           done
```

Frontier models plan; cheap models execute and validate; deterministic rules — not model whim — decide when to escalate.

## Documentation

- [Events & Hooks](EVENTS.md) — 20 event types, 6 lifecycle phases, example configuration, firing order
- [Contributing](CONTRIBUTING.md) — development environment, codebase tour, coding standards, SOLID/clean-architecture enforcement, testing, PR checklist
- [Troubleshooting](TROUBLESHOOTING.md) — common errors and how to resolve them
- [Roadmap & Open Questions](ROADMAP.md) — planned directions (semantic search, automatic scaling, context management, user interaction, MCP) with the open design questions still to resolve

## Features

- **Config-based LLM commands** — Define available commands in `galloper.json` with a configurable default
- **Flexible input** — Accept prompts via CLI (`--prompt`) or file (`--prompt-file`)
- **Session tracking** — Each run creates a JSON session file with complete execution details
- **Centralized logging** — Append-only audit trail at `galloper-data/logs/runs.jsonl` for monitoring and debugging
- **Event parsing** — Extracts JSON-formatted events from Claude Code output
- **Consolidated data directory** — All runtime data (sessions, logs, plans, executions) live under `galloper-data/`
- **Hooks & events** — 20 event types and 6 lifecycle phases with configurable handlers for custom automation (see [EVENTS.md](EVENTS.md))

## Installation

Requires Node.js 20+.

```bash
npm install
```

## Configuration

Create `galloper.json` at the repo root. See [EVENTS.md](EVENTS.md#example-configuration) for a full sample including hooks.

Top-level fields:

- **`default`** — The command name to use for `single-prompt` subcommand
- **`defaultPlanner`** — The command name to use for `plan` subcommand (falls back to `default` if not set)
- **`defaultExecutioner`** — The command name to use for `implement` subcommand (falls back to `default` if not set)
- **`commands`** — Object mapping command names to their configuration (command string + subcommand restrictions)
- **`allowedSubcommands`** — If non-empty, only these subcommands can use this command
- **`disallowedSubcommands`** — These subcommands cannot use this command
- **`env`** — Optional map of env vars merged into the subprocess environment (overrides inherited process env on key collision)
- **`hooks`** — Optional map defining custom handlers for events and lifecycle phases (see [EVENTS.md](EVENTS.md))

The config is required and will be loaded on every run.

## Usage

The CLI accepts three positional subcommands: `single-prompt`, `plan`, and `implement`.

### single-prompt — Execute a single prompt

```bash
npm run run -- single-prompt --prompt "Your prompt here"
```

Uses the `default` command from `galloper.json`. For basic execution where you send a prompt and get a response.

### plan — Generate a plan

```bash
npm run run -- plan --prompt "Describe the task to plan"
```

Uses the `defaultPlanner` command from `galloper.json` (falls back to `default` if not set). For structured plan generation.

### implement — Execute implementation

```bash
npm run run -- implement --prompt "Implementation details"
```

Uses the `defaultExecutioner` command from `galloper.json` (falls back to `default` if not set). For code generation and implementation tasks.

### Prompt from file

All subcommands support reading prompts from a file:

```bash
npm run run -- single-prompt --prompt-file ./prompt.txt
npm run run -- plan --prompt-file ./task.txt
npm run run -- implement --prompt-file ./impl.txt
```

## Output

Each run outputs a JSON object to stdout:

```json
{
  "sessionId": "2026-04-17T12-48-19-722Z-d3b46482-ea5d-4e4d-82c4-0a0a0d0a928a",
  "sessionFilePath": "/path/to/galloper-data/sessions/2026-04-17T12-48-19-722Z-d3b46482-ea5d-4e4d-82c4-0a0a0d0a928a.json",
  "exitCode": 0,
  "finalOutput": "The last message from Claude Code"
}
```

### Session Files

Each run creates a detailed session file at `galloper-data/sessions/{session-id}.json`:

| Field | Description |
|-------|-------------|
| `id` | Unique session identifier |
| `prompt` | The input prompt |
| `command` | The executed shell command |
| `cwd` | Working directory |
| `startedAt`, `endedAt`, `durationMs` | Execution timing |
| `exitCode` | Process exit code (0 = success) |
| `stdout`, `stderr` | Raw output text |
| `parsedStdoutEvents` | JSON events extracted from stdout |
| `parsedStderrEvents` | JSON events extracted from stderr |
| `finalOutput` | Extracted final agent message (or raw stdout fallback) |

### Central Log

Append-only log at `galloper-data/logs/runs.jsonl` (one JSON object per line):

- Tracks all run lifecycle events — see [EVENTS.md](EVENTS.md) for the full list
- Use for audit trails, monitoring, failure analysis, or forwarding to external logging systems

## Examples

### Single-prompt execution

```bash
npm run run -- single-prompt --prompt "List the top 3 TypeScript best practices"
```

### Generate a plan

```bash
npm run run -- plan --prompt "How should I refactor this authentication system?"
```

### Batch processing

```bash
for file in prompts/*.txt; do
  npm run run -- single-prompt --prompt-file "$file"
done
```

### Integration with external systems

```javascript
const { execSync } = require('child_process');
const result = JSON.parse(
  execSync('npm run run -- single-prompt --prompt "analyze this code"').toString()
);
console.log(result.finalOutput);
```

### Orchestrate a planning + implementation workflow

```bash
# First, generate a plan
npm run run -- plan --prompt "Create a user authentication system"

# Then, implement based on the plan
npm run run -- implement --prompt "Build the authentication system as planned"
```

## Development

Session files and logs are created on every run. Clean up old data:

```bash
rm -rf galloper-data/
```

The `.gitignore` excludes `galloper-data/` from version control.

## License

Released under the [MIT License](LICENSE). © 2026 Ivan Amato.
