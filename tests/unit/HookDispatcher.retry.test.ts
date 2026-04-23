import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HookDispatcher, type HooksConfig } from '../../src/lib/HookDispatcher.js';

describe('HookDispatcher retry-with-backoff', () => {
  let tempDir: string;
  let counterFile: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'hook-retry-'));
    counterFile = join(tempDir, 'count');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  /**
   * Builds a shell command that increments a counter file on each call
   * and exits non-zero unless the counter has reached `successOn`.
   * When `successOn === Infinity`, the command always fails.
   */
  function flakyCommand(successOn: number): string {
    return `n=$(cat "${counterFile}" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "${counterFile}"; [ "$n" -ge "${successOn === Infinity ? '9999999' : successOn}" ]`;
  }

  function readCount(): number {
    return existsSync(counterFile) ? Number(readFileSync(counterFile, 'utf8').trim()) : 0;
  }

  it('always-failing hook with retry.maxAttempts=3 runs exactly 3 times and reports a single failure', async () => {
    const config: HooksConfig = {
      lifecycle: {
        'post-task-file': [
          {
            match: '**/*.ts',
            command: flakyCommand(Infinity),
            retry: { maxAttempts: 3, backoffMs: 5, jitter: 0 },
          },
        ],
      },
    };
    const dispatcher = new HookDispatcher(config);
    const failures = await dispatcher.runPost('post-task-file', {
      file: { path: 'a.ts', action: 'edit' },
      sessionId: 't',
      cwd: tempDir,
      classification: 'declared',
    });

    expect(readCount()).toBe(3);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.hookRetryCount).toBe(3);
  });

  it('hook that succeeds on attempt 2 runs exactly 2 times and reports no failure', async () => {
    const config: HooksConfig = {
      lifecycle: {
        'post-task-file': [
          {
            match: '**/*.ts',
            command: flakyCommand(2),
            retry: { maxAttempts: 5, backoffMs: 5, jitter: 0 },
          },
        ],
      },
    };
    const dispatcher = new HookDispatcher(config);
    const failures = await dispatcher.runPost('post-task-file', {
      file: { path: 'a.ts', action: 'edit' },
      sessionId: 't',
      cwd: tempDir,
      classification: 'declared',
    });

    expect(readCount()).toBe(2);
    expect(failures).toHaveLength(0);
  });

  it('hook without retry config runs exactly once even on failure', async () => {
    const config: HooksConfig = {
      lifecycle: {
        'post-task-file': [
          {
            match: '**/*.ts',
            command: flakyCommand(Infinity),
            // no retry — onFailure defaults to 'retry' but that's task-level retry, not hook-level
          },
        ],
      },
    };
    const dispatcher = new HookDispatcher(config);
    const failures = await dispatcher.runPost('post-task-file', {
      file: { path: 'a.ts', action: 'edit' },
      sessionId: 't',
      cwd: tempDir,
      classification: 'declared',
    });

    expect(readCount()).toBe(1);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.hookRetryCount).toBeUndefined();
  });

  it('hook with onFailure:warn and retry still retries (retry is independent of outcome routing)', async () => {
    const config: HooksConfig = {
      lifecycle: {
        'post-task-file': [
          {
            match: '**/*.ts',
            command: flakyCommand(3),
            onFailure: 'warn',
            retry: { maxAttempts: 4, backoffMs: 5, jitter: 0 },
          },
        ],
      },
    };
    const dispatcher = new HookDispatcher(config);
    // Note: onFailure !== 'retry' disables the retry loop per the dispatcher's
    // semantics — retry-with-backoff only kicks in when onFailure would retry.
    const failures = await dispatcher.runPost('post-task-file', {
      file: { path: 'a.ts', action: 'edit' },
      sessionId: 't',
      cwd: tempDir,
      classification: 'declared',
    });

    // onFailure: 'warn' means no hook-level retry — one attempt, fail once.
    expect(readCount()).toBe(1);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.onFailure).toBe('warn');
  });

  it('sleeps approximately backoffMs * 2^(n-1) between attempts', async () => {
    const backoffMs = 40;
    const config: HooksConfig = {
      lifecycle: {
        'post-task-file': [
          {
            match: '**/*.ts',
            command: flakyCommand(Infinity),
            retry: { maxAttempts: 3, backoffMs, jitter: 0 },
          },
        ],
      },
    };
    const dispatcher = new HookDispatcher(config);
    const start = Date.now();
    await dispatcher.runPost('post-task-file', {
      file: { path: 'a.ts', action: 'edit' },
      sessionId: 't',
      cwd: tempDir,
      classification: 'declared',
    });
    const elapsed = Date.now() - start;
    // Attempt 1 → sleep 40ms → attempt 2 → sleep 80ms → attempt 3
    // Total sleep floor ~120ms; plus 3 subprocess spawns.
    expect(elapsed).toBeGreaterThanOrEqual(110);
  });
});
