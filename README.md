# devflowv3

A minimal Node.js runner for executing Claude Code (Codex) commands programmatically. Use it to orchestrate multiple Claude Code runs, batch process prompts, integrate with external systems, or test Claude Code automation.

## Features

- **Config-based LLM commands** — Define available commands in `llm-config.json` with a configurable default
- **Flexible input** — Accept prompts via CLI (`--prompt`) or file (`--prompt-file`)
- **Session tracking** — Each run creates a JSON session file with complete execution details
- **Centralized logging** — Append-only audit trail at `devflowv3-data/logs/runs.jsonl` for monitoring and debugging
- **Event parsing** — Extracts JSON-formatted events from Claude Code output
- **Consolidated data directory** — All runtime data (sessions, logs, plans, executions) live under `devflowv3-data/`

## Installation

Requires Node.js 20+.

```bash
npm install
```

## Configuration

Create `llm-config.json` at the repo root:

```json
{
  "default": "claude-haiku",
  "defaultPlanner": "claude-haiku",
  "defaultExecutioner": "claude-haiku",
  "commands": {
    "claude-haiku": {
      "command": "claude --model claude-haiku-4-5-20251001 --allowedTools * --dangerously-skip-permissions",
      "allowedSubcommands": [],
      "disallowedSubcommands": []
    }
  }
}
```

- **`default`** — The command name to use for `single-prompt` subcommand
- **`defaultPlanner`** — The command name to use for `plan` subcommand (falls back to `default` if not set)
- **`defaultExecutioner`** — The command name to use for `implement` subcommand (falls back to `default` if not set)
- **`commands`** — Object mapping command names to their configuration (command string + subcommand restrictions)
- **`allowedSubcommands`** — If non-empty, only these subcommands can use this command
- **`disallowedSubcommands`** — These subcommands cannot use this command

The config is required and will be loaded on every run.

## Usage

The CLI accepts three positional subcommands: `single-prompt`, `plan`, and `implement`.

### single-prompt — Execute a single prompt

```bash
npm run run -- single-prompt --prompt "Your prompt here"
```

Uses the `default` command from `llm-config.json`. For basic execution where you send a prompt and get a response.

### plan — Generate a plan

```bash
npm run run -- plan --prompt "Describe the task to plan"
```

Uses the `defaultPlanner` command from `llm-config.json` (falls back to `default` if not set). For structured plan generation.

### implement — Execute implementation

```bash
npm run run -- implement --prompt "Implementation details"
```

Uses the `defaultExecutioner` command from `llm-config.json` (falls back to `default` if not set). For code generation and implementation tasks.

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
  "sessionFilePath": "/path/to/devflowv3-data/sessions/2026-04-17T12-48-19-722Z-d3b46482-ea5d-4e4d-82c4-0a0a0d0a928a.json",
  "exitCode": 0,
  "finalOutput": "The last message from Claude Code"
}
```

### Session Files

Each run creates a detailed session file at `devflowv3-data/sessions/{session-id}.json`:

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

Append-only log at `devflowv3-data/logs/runs.jsonl` (one JSON object per line):

- Tracks all run lifecycle events: `run.started`, `process.spawn`, `process.stdout`, `process.stderr`, `run.completed`, `run.crashed`
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

## Architecture

### Core Flow

1. **Parse arguments** — Extract positional subcommand (`single-prompt`, `plan`, or `implement`) and `--prompt` / `--prompt-file`
2. **Load config** — Read `llm-config.json` and resolve appropriate command based on subcommand type
3. **Route by subcommand** — For `single-prompt`, execute directly; for `plan` and `implement`, route to specialized workflows
4. **Spawn subprocess** — Run the resolved command with prompt on stdin
5. **Capture I/O** — Collect stdout/stderr, immediately log each chunk
6. **Parse output** — Extract JSON events and final agent message
7. **Persist results** — Write session file and append to central log
8. **Return output** — Output JSON with session ID, path, exit code, and final message

### Hook Isolation

The runner sets `CODEX_DISABLE_PROJECT_HOOKS=1` during execution. This prevents parent workspace hooks from running during Codex subprocess execution — devflowv3 is its own Git repository and should not inherit parent configurations.

## Troubleshooting

### Invalid subcommand

```
Usage: npm run run -- <subcommand> --prompt <prompt>
Valid subcommands: single-prompt, plan, implement
```

Use one of the three valid subcommands: `single-prompt`, `plan`, or `implement`.

### Config not found

```
Failed to load llm-config.json: ...
```

Ensure `llm-config.json` exists in the repo root with valid JSON.

### Subcommand not allowed for command

```
Subcommand 'plan' is not allowed for command 'my-command'
```

Check that the resolved command allows the requested subcommand in `llm-config.json` under `allowedSubcommands` and `disallowedSubcommands`.

### Process errors

Check `devflowv3-data/logs/runs.jsonl` or the session file for detailed error traces.

```bash
jq '.error' devflowv3-data/logs/runs.jsonl | tail -5
```

## Development

Session files and logs are created on every run. Clean up old data:

```bash
rm -rf devflowv3-data/
```

The `.gitignore` excludes `devflowv3-data/` from version control.
