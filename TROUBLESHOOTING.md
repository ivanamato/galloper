# Troubleshooting

## Invalid subcommand

```
Usage: npm run run -- <subcommand> --prompt <prompt>
Valid subcommands: single-prompt, plan, implement
```

Use one of the three valid subcommands: `single-prompt`, `plan`, or `implement`.

## Config not found

```
Failed to load galloper.json: ...
```

Ensure `galloper.json` exists in the repo root with valid JSON.

## Subcommand not allowed for command

```
Subcommand 'plan' is not allowed for command 'my-command'
```

Check that the resolved command allows the requested subcommand in `galloper.json` under `allowedSubcommands` and `disallowedSubcommands`.

## Process errors

Check `galloper-data/logs/runs.jsonl` or the session file for detailed error traces.

```bash
jq '.error' galloper-data/logs/runs.jsonl | tail -5
```
