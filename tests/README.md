# Testing Architecture for devflowv3

This directory contains comprehensive unit and integration tests for the devflowv3 TypeScript orchestrator.

## Directory Structure

```
tests/
├── README.md                          # This file
├── helpers/                           # Shared test utilities
│   ├── tempDir.ts                    # Temporary workspace creation
│   └── readJsonl.ts                  # JSONL file parsing
├── fixtures/                          # Test configuration and mock commands
│   ├── llm-config.test.json          # Test LLM configuration
│   └── mock-commands/                # Mock executable commands
│       ├── echo-success.sh           # Success with plaintext output
│       ├── echo-json.sh              # Success with JSON output
│       ├── fail-exit.sh              # Failure with stderr
│       ├── malformed-json.sh         # Mixed valid/invalid JSON
│       ├── impl-fail.sh              # Failure for implement subcommand
│       └── ... (other mock commands)
├── unit/                             # Unit tests for individual modules
│   ├── Logger.test.ts                # Logger JSONL formatting
│   ├── ConfigManager.test.ts         # Config loading and validation
│   ├── CommandResolver.test.ts       # Command resolution logic
│   ├── SessionManager.test.ts        # Session file creation
│   └── CoreRunner.test.ts            # Subprocess execution
└── integration/                      # Integration tests for full flows
    ├── Orchestrator.happy.test.ts    # Happy path with mock commands
    ├── Orchestrator.errors.test.ts   # Error handling and edge cases
    ├── PlannerExecutioner.test.ts    # Planner and Executioner flows
    └── OrchestrationMapping.test.ts  # Command routing and mapping
```

## Test Coverage

### Unit Tests (47 total)
- **Logger** (6 tests): JSONL formatting, event shape validation, directory creation
- **ConfigManager** (14 tests): Config loading, defaults, subcommand restrictions, validation
- **CommandResolver** (9 tests): Command resolution, fallback behavior, error messages
- **SessionManager** (8 tests): Session file creation, record structure, ID generation
- **CoreRunner** (21 tests): Subprocess execution, I/O capture, JSON parsing, event logging

### Integration Tests (63 total)
- **Orchestrator Happy Path** (11 tests): Command execution, session files, logging, output extraction
- **Orchestrator Errors** (14 tests): Non-zero exits, malformed JSON, validation, subcommand enforcement
- **Planner & Executioner** (18 tests): Plan generation, implementation execution, file creation, routing
- **Orchestration Mapping** (20 tests): Command routing, user overrides, fallback, error handling

**Total: 110 tests**

## Running Tests

### All Tests
```bash
npm run test:all          # Build + run full suite
npm run test              # Run vitest in run mode
npm run test:watch       # Run vitest in watch mode
```

### By Category
```bash
npm run test:unit         # Unit tests only
npm run test:integration  # Integration tests only
```

### Coverage Report
```bash
npm run test:coverage     # Generate coverage report (text + LCOV)
```

Coverage includes all source in `src/lib/**` with excludes for CLI entry point.

## Test Fixtures

### Mock Commands
Mock commands simulate LLM output and various failure modes:

| Command | Output | Exit Code | Use Case |
|---------|--------|-----------|----------|
| `echo-success.sh` | Echoes stdin + success message | 0 | Happy path |
| `echo-json.sh` | Valid JSON lines (3 events) | 0 | JSON parsing |
| `fail-exit.sh` | Error to stderr | 2 | Error handling |
| `malformed-json.sh` | Mixed valid/invalid JSON | 0 | Malformed JSON handling |
| `impl-fail.sh` | Error to stderr | 2 | Implement subcommand failure |

### Test Configuration
`llm-config.test.json` defines mock commands with subcommand restrictions:

```json
{
  "default": "mock-success",
  "defaultPlanner": "mock-json",
  "defaultExecutioner": "mock-implement",
  "commands": {
    "mock-success": { "allowedSubcommands": [] },
    "mock-json": { "allowedSubcommands": ["plan"] },
    "mock-fail": { "disallowedSubcommands": ["implement"] },
    "mock-implement": { "allowedSubcommands": ["implement"] },
    ...
  }
}
```

## Adding New Tests

### New Unit Test
1. Create `tests/unit/ModuleName.test.ts`
2. Import module and helpers:
   ```typescript
   import { describe, it, expect, beforeEach, afterEach } from 'vitest';
   import { ModuleName } from '../../src/lib/ModuleName.js';
   import { createTempWorkspace, cleanup } from '../helpers/tempDir.js';
   ```
3. Use `createTempWorkspace()` for file I/O isolation
4. Run: `npm run test:unit`

### New Integration Test
1. Create `tests/integration/Feature.test.ts`
2. Set up complete dependency graph (Orchestrator, all managers, etc.)
3. Use mock commands from fixtures
4. Verify both output AND logs/files
5. Run: `npm run test:integration`

### New Mock Command
1. Create `tests/fixtures/mock-commands/command-name.sh`
2. Make it executable: `chmod +x`
3. Add to `llm-config.test.json` with appropriate subcommand restrictions
4. Test: `bash tests/fixtures/mock-commands/command-name.sh < /dev/null`

## Test Execution Environment

- **Node**: 20+ (ES2020 target)
- **Test Timeout**: 15 seconds (for subprocess-heavy tests)
- **Isolation**: Each test creates isolated temp workspace; auto-cleaned after
- **Logging**: All tests verify central log file (`runs.jsonl`) for event sequences
- **JSON Parsing**: Tests verify both valid event parsing and malformed data handling

## Philosophy

- **Happy path + edge cases**: Every happy path test is paired with error/edge case coverage
- **Output verification**: Sessions, logs, and file structures validated
- **Event sequences**: Log event ordering and field completeness checked
- **Isolation**: No shared state between tests; temp directories used
- **Fail-fast**: Tests stop on first assertion failure; clear error messages

## Troubleshooting

### Flaky Tests
Tests should be deterministic. If you see flakiness:
- Check `tempDir` cleanup in `afterEach`
- Verify mock command scripts don't leave hanging processes
- Check for race conditions in async code

### Port or File Conflicts
Tests use isolated temp directories. If you see "EADDRINUSE" or "EEXIST":
- Run `npm run test:all` (fresh build + full suite)
- Check for orphaned `tmp*` directories

### Build Failures
Run `npm run build` before tests:
- Vitest requires compiled `.js` and `.d.ts` files in `dist/`
- Use `npm run test:all` to auto-build

## CI/CD Integration

For GitHub Actions or similar:
```yaml
- run: npm ci                 # Install dependencies
- run: npm run test:all       # Build + run all tests
- run: npm run test:coverage  # Generate coverage report
```

Expected output:
- Exit code 0 on success
- All 110 tests pass
- Coverage report in `coverage/` directory
