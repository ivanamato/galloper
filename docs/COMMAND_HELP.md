# `galloper help`

Display help information for galloper commands and topics.

## Usage

```bash
galloper help [<topic>]
galloper help <topic>
```

## Arguments

- `<topic>` — Optional. The help topic to display. If omitted, shows general usage information.

## Supported Topics

| Topic | Description | Documentation |
|-------|-------------|---------------|
| `plan` | Generate a plan for a task using the planner LLM | [COMMAND_PLAN.md](COMMAND_PLAN.md) |
| `implement` | Execute a plan using the executor LLM | [COMMAND_IMPLEMENT.md](COMMAND_IMPLEMENT.md) |
| `pipeline` | Generate and execute a plan in one step | [COMMAND_PIPELINE.md](COMMAND_PIPELINE.md) |
| `adaptive` | Run an adaptive planning loop with continuous evaluation | [COMMAND_ADAPTIVE.md](COMMAND_ADAPTIVE.md) |

## Examples

```bash
# Show general help
galloper help

# Show help for the plan command
galloper help plan

# Show help for the adaptive command
galloper help adaptive
```

## See Also

- [galloper.json configuration](../galloper.json) — Configuration file reference
- [Events and Hooks](EVENTS_AND_HOOKS.md) — Complete reference for all 20 event types and 6 lifecycle hooks
