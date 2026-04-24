# `galloper plan`

> **Purpose** — Turn a natural-language task into a **structured, validated JSON plan** of small, verifiable tasks. **Does not write code or execute anything** beyond the LLM call. The output plan file is the artifact you feed to `implement`, `pipeline`, or `adaptive`.

---

## 1. Mental model

```
        ┌─────────────────────┐
        │   Your prompt       │   "Add JWT auth to the API"
        └──────────┬──────────┘
                   │
                   ▼
   ┌───────────────────────────────┐
   │   PLAN_PROMPT template        │   src/lib/PromptTemplates.ts
   │   (fixed instructions +       │
   │    {{CWD}} + your prompt)     │
   └──────────┬────────────────────┘
              │  stdin
              ▼
   ┌───────────────────────────────┐
   │   LLM subprocess              │   resolved from
   │   (claude / codex / gemini)   │   defaultPlanner → default
   └──────────┬────────────────────┘
              │  stdout (JSON)
              ▼
   ┌───────────────────────────────┐
   │   parsePlan() validates       │   src/lib/PlanSchema.ts
   │   • topo-sortable DAG         │
   │   • file actions inferred     │
   │   • required fields present   │
   └──────────┬────────────────────┘
              │
              ▼
   ┌───────────────────────────────────────────────────┐
   │   galloper-data/plans/<ISO-timestamp>.json        │
   └───────────────────────────────────────────────────┘
```

`plan` is **read-only on your codebase**. The only artifacts it creates live under `galloper-data/`.

---

## 2. Usage

```bash
# Inline prompt
galloper plan --prompt "Add JWT auth middleware to the Express app"

# From file
galloper plan --prompt-file ./tasks/jwt-auth.txt

# With verbose progress
galloper plan --prompt "..." -vv --human-friendly

# Custom config
galloper plan --config ./alt-galloper.json --prompt "..."
```

### Flags

| Flag | Type | Required | Default | Notes |
|------|------|----------|---------|-------|
| `--prompt <text>` | string | one of these two | — | Inline task description |
| `--prompt-file <path>` | string | one of these two | — | Read prompt from file |
| `--config <path>` | string | no | `./galloper.json` | Config file location |
| `-v` / `-vv` / `-vvv` | flag | no | 0 | Stack for higher verbosity (stderr only) |
| `--human-friendly` / `-H` | flag | no | off | Human progress to stderr; independent of `-v` |

### Disallowed
- `--plan-file` is rejected (that's an `implement`-only flag).
- Any positional args after `plan` other than the supported flags fail arg parsing (exit 2).

---

## 3. End-to-end flow

```
 STEP 1   CLI parsing                src/run-llm-session.ts
          │
          ▼
 STEP 2   Resolve command            ConfigManager.resolveForSubcommand('plan')
          │   defaultPlanner ──fallback──► default
          ▼
 STEP 3   Validate restrictions      command.allowedSubcommands / disallowedSubcommands
          │
          ▼
 STEP 4   Build prompt               PLAN_PROMPT + {{CWD}} + user prompt
          │
          ▼
 STEP 5   Spawn LLM                  /bin/sh -c "<command>"  ◄── stdin = prompt
          │   • Capture stdout/stderr in chunks
          │   • Emits process.spawn / process.stdout / process.stderr log events
          ▼
 STEP 6   Extract final message      CoreRunner.extractFinalOutput()
          │   • strip ```json fences
          │   • stripThinkingBlocks() removes Claude <thinking>…</thinking>
          ▼
 STEP 7   Parse + validate plan      PlanSchema.parsePlan()
          │   • required fields
          │   • dependsOn refs known IDs
          │   • no duplicate file paths per task
          │   • auto-infer  edit → create  if file missing on disk
          ▼
 STEP 8   Write PlanFile envelope    galloper-data/plans/<id>.json
          │
          ▼
 STEP 9   Emit run.completed         galloper-data/logs/runs.jsonl
          │
          ▼
 STEP 10  Print OrchestratorResult on stdout (single JSON line)
```

---

## 4. The Plan JSON shape

The file at `galloper-data/plans/<id>.json` is an **envelope** with metadata plus a `content` field that holds the plan as a JSON string.

### Envelope (`PlanFile`)

```jsonc
{
  "id": "2026-04-23T14-12-08-441Z",
  "createdAt": "2026-04-23T14:12:08.441Z",
  "prompt": "Add JWT auth middleware to the Express app",
  "command": "claude-haiku",
  "sessionId": "2026-04-23T14-12-08-441Z",
  "content": "{\"planId\":\"...\",\"tasks\":[ ... ]}"   // ← stringified Plan
}
```

### Inner plan (`Plan` — what's inside `content`)

```jsonc
{
  "planId": "2026-04-23T14-12-08-441Z",
  "prompt": "Add JWT auth middleware to the Express app",
  "createdAt": "2026-04-23T14:12:08.441Z",
  "maxAttempts": 3,                    // optional, per-task default
  "concurrency": 1,                    // optional
  "onTaskAbandoned": "abort",          // optional: continue | abort | abort-branch
  "retryPolicy": {                     // optional, per-failure-category
    "verify":          "retry",
    "hook":            "retry",
    "executor-crash":  "abort"
  },
  "tasks": [
    {
      "id": "t1",
      "title": "Install jsonwebtoken and add types",
      "files": [
        { "path": "/abs/path/package.json", "action": "edit"   }
      ],
      "instructions": "Add `jsonwebtoken` as a dependency and `@types/jsonwebtoken` as a devDependency. Run `npm install`.",
      "verify": "npm ls jsonwebtoken >/dev/null",
      "dependsOn": []
    },
    {
      "id": "t2",
      "title": "Create JWT verify middleware",
      "files": [
        { "path": "/abs/path/src/middleware/auth.ts", "action": "create" }
      ],
      "instructions": "Export `verifyJwt(req,res,next)` that reads the Bearer token from Authorization, verifies with JWT_SECRET, and attaches `req.user`.",
      "verify": "npx tsc --noEmit",
      "dependsOn": ["t1"]
    }
  ]
}
```

### Field reference

#### `Plan`

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `planId` | string | yes | Unique ID, usually an ISO timestamp |
| `tasks` | `PlanTask[]` | yes | Must form a DAG (no cycles) |
| `prompt` | string | no | Echo of the user's prompt |
| `createdAt` | string | no | ISO timestamp |
| `maxAttempts` | number | no | Default retries per task (overridden per task) |
| `concurrency` | number | no | Reserved for parallel executors |
| `onTaskAbandoned` | `'continue' \| 'abort' \| 'abort-branch'` | no | What to do when a task exhausts retries |
| `retryPolicy` | object | no | Per-failure-category retry/abort rules (see Implement docs) |

#### `PlanTask`

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `id` | string | yes | Unique inside the plan (`t1`, `t2`, …) |
| `title` | string | yes | One imperative sentence |
| `files` | `FileSpec[]` | yes | Files this task will touch (declared up front) |
| `instructions` | string | yes | Concrete steps for the executioner |
| `verify` | string | yes | Shell command — must exit 0 to count as success |
| `dependsOn` | `string[]` | yes | IDs of tasks that must complete first; empty = independent |
| `maxAttempts` | number | no | Overrides `plan.maxAttempts` |

#### `FileSpec`

| Field | Type | Notes |
|-------|------|-------|
| `path` | string | Absolute path |
| `action` | `'create' \| 'edit' \| 'delete'` | `edit` is auto-corrected to `create` if file doesn't exist on disk |

---

## 5. Stdout: the `OrchestratorResult`

Stdout always emits a single JSON object:

```json
{
  "sessionId":       "2026-04-23T14-12-08-441Z",
  "sessionFilePath": "/.../galloper-data/sessions/2026-04-23T14-12-08-441Z.json",
  "exitCode":        0,
  "finalOutput":     "{ ...the Plan JSON... }",
  "planFilePath":    "/.../galloper-data/plans/2026-04-23T14-12-08-441Z.json"
}
```

Verbose progress and human-friendly messages go to **stderr** so stdout stays parseable.

---

## 6. Files written

```
galloper-data/
├── plans/<planId>.json                  ← the PlanFile envelope (primary artifact)
├── sessions/<sessionId>.json            ← raw stdin/stdout/stderr + parsed events
└── logs/runs.jsonl                      ← append-only event log
```

---

## 7. Hooks fired

Lifecycle phases (run only if you've configured them in `galloper.json` → `hooks.lifecycle`):

| Phase | When | Typical use |
|-------|------|-------------|
| `pre-plan` | Before LLM is spawned | Snapshot env, refresh tokens |
| `post-plan` | After plan is parsed and written | Lint the plan, notify Slack |

Event hooks (anything from `hooks.events` matching these names runs as side-effects on the central log):

- `run.started`
- `run.command_resolved`
- `process.spawn` / `process.stdout` / `process.stderr`
- `run.completed`
- `run.failed` (on any thrown error)

See `docs/EVENTS_AND_HOOKS.md` for the full reference.

---

## 8. Command resolution

```
                ┌─ user override via flag? ──► (none for plan today)
                │
plan  ────────► │
                │
                └─► config.defaultPlanner   ─┐
                       │ not set?            │
                       ▼                     ▼
                    config.default ──── must allow 'plan'
                                         in allowedSubcommands /
                                         disallowedSubcommands
```

If neither is set, or the resolved command's `allowedSubcommands` excludes `plan`, the run fails fast (exit 1) **before** any subprocess is spawned.

---

## 9. Error and edge cases

| Scenario | Exit | Where it surfaces |
|----------|------|-------------------|
| Missing `--prompt` and `--prompt-file` | 1 | CLI parse |
| Unknown subcommand / bad flag | 2 | CLI parse |
| Resolved command not in `commands{}` | 1 | ConfigManager |
| `plan` not allowed for resolved command | 1 | ConfigManager |
| LLM subprocess non-zero exit | passthrough | `OrchestratorResult.exitCode` |
| Stdout missing/invalid JSON | 1 | `parsePlan` throws "Failed to parse plan JSON" |
| Task missing required field | 1 | `parsePlan` throws "Task[i] missing or invalid 'X'" |
| Cycle in `dependsOn` graph | 1 | `topoSort` throws "Cycle detected in task dependency graph" |
| Duplicate file path inside one task | 1 | `parsePlan` throws |

---

## 10. Quick reference card

```
INPUTS                              OUTPUTS
──────                              ───────
--prompt | --prompt-file            galloper-data/plans/<id>.json
config.defaultPlanner               OrchestratorResult on stdout
   ↓ (fallback)                     events on galloper-data/logs/runs.jsonl
config.default

DOES NOT                            DOES
────────                            ────
• touch your codebase               • call the planner LLM
• execute tasks                     • validate JSON shape + DAG
• run verify commands               • persist a typed PlanFile envelope
• fire pre-/post-task hooks         • fire pre-plan / post-plan hooks
```
