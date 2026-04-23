import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HookDispatcher, type LifecycleHookConfig, type HooksConfig } from '../../src/lib/HookDispatcher.js';
import { Logger } from '../../src/lib/Logger.js';

describe('HookDispatcher', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'hook-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('runPre', () => {
    it('should match files with glob pattern', async () => {
      const hookConfig: HooksConfig = {
        lifecycle: {
          'pre-task-file': [
            {
              match: 'src/**/*.ts',
              command: `echo "matched"`,
            },
          ],
        },
      };

      const dispatcher = new HookDispatcher(hookConfig);
      const output = await dispatcher.runPre('pre-task-file', {
        file: { path: 'src/main.ts', action: 'edit' },
        sessionId: 'test',
        cwd: tempDir,
      });

      expect(output).toContain('matched');
    });

    it('should skip files when glob does not match', async () => {
      const hookConfig: HooksConfig = {
        lifecycle: {
          'pre-task-file': [
            {
              match: 'src/**/*.ts',
              command: `echo "matched"`,
            },
          ],
        },
      };

      const dispatcher = new HookDispatcher(hookConfig);
      const output = await dispatcher.runPre('pre-task-file', {
        file: { path: 'README.md', action: 'edit' },
        sessionId: 'test',
        cwd: tempDir,
      });

      expect(output).toBe('');
    });

    it('should filter hooks by action', async () => {
      const hookConfig: HooksConfig = {
        lifecycle: {
          'pre-task-file': [
            {
              match: 'src/**/*',
              action: 'create',
              command: `echo "create-hook"`,
            },
          ],
        },
      };

      const dispatcher = new HookDispatcher(hookConfig);

      // Should run for create action
      const createOutput = await dispatcher.runPre('pre-task-file', {
        file: { path: 'src/new.ts', action: 'create' },
        sessionId: 'test',
        cwd: tempDir,
      });
      expect(createOutput).toContain('create-hook');

      // Should NOT run for edit action
      const editOutput = await dispatcher.runPre('pre-task-file', {
        file: { path: 'src/new.ts', action: 'edit' },
        sessionId: 'test',
        cwd: tempDir,
      });
      expect(editOutput).toBe('');
    });

    it('should run multiple hooks in order', async () => {
      const logFile = join(tempDir, 'log.txt');
      const hookConfig: HooksConfig = {
        lifecycle: {
          'pre-task': [
            {
              command: `echo "first" >> ${logFile}`,
            },
            {
              command: `echo "second" >> ${logFile}`,
            },
          ],
        },
      };

      const dispatcher = new HookDispatcher(hookConfig);
      await dispatcher.runPre('pre-task', {
        sessionId: 'test',
        cwd: tempDir,
      });

      // Check log file exists and has both entries
      const logs = require('node:fs').readFileSync(logFile, 'utf-8');
      const lines = logs.trim().split('\n');
      expect(lines).toHaveLength(2);
      expect(lines[0]).toContain('first');
      expect(lines[1]).toContain('second');
    });

    it('should wrap pre-hook output with tags', async () => {
      const hookConfig: HooksConfig = {
        lifecycle: {
          'pre-task': [
            {
              command: `echo "hook-output"`,
            },
          ],
        },
      };

      const dispatcher = new HookDispatcher(hookConfig);
      const output = await dispatcher.runPre('pre-task', {
        sessionId: 'test',
        cwd: tempDir,
      });

      expect(output).toContain('<pre-hook output');
      expect(output).toContain('hook-output');
      expect(output).toContain('</pre-hook output>');
      expect(output).toContain('phase="pre-task"');
    });

    it('should support static instructions', async () => {
      const hookConfig: HooksConfig = {
        lifecycle: {
          'pre-task': [
            {
              instructions: 'Do not modify system files',
            },
          ],
        },
      };

      const dispatcher = new HookDispatcher(hookConfig);
      const output = await dispatcher.runPre('pre-task', {
        sessionId: 'test',
        cwd: tempDir,
      });

      expect(output).toContain('<pre-hook output');
      expect(output).toContain('Do not modify system files');
    });
  });

  describe('runPost', () => {
    it('should collect failures from post-hooks', async () => {
      const hookConfig: HooksConfig = {
        lifecycle: {
          'post-task-file': [
            {
              match: '*.ts',
              command: 'exit 1',
            },
          ],
        },
      };

      const dispatcher = new HookDispatcher(hookConfig);
      const failures = await dispatcher.runPost('post-task-file', {
        file: { path: 'test.ts', action: 'edit' },
        sessionId: 'test',
        cwd: tempDir,
      });

      expect(failures).toHaveLength(1);
      expect(failures[0]?.exitCode).toBe(1);
      expect(failures[0]?.category).toBe('hook');
      expect(failures[0]?.onFailure).toBe('retry');
    });

    it('should throw when onFailure is abort', async () => {
      const hookConfig: HooksConfig = {
        lifecycle: {
          'post-task': [
            {
              command: 'exit 1',
              onFailure: 'abort',
            },
          ],
        },
      };

      const dispatcher = new HookDispatcher(hookConfig);

      await expect(
        dispatcher.runPost('post-task', {
          sessionId: 'test',
          cwd: tempDir,
        })
      ).rejects.toThrow();
    });

    it('should not throw when onFailure is warn', async () => {
      const hookConfig: HooksConfig = {
        lifecycle: {
          'post-task': [
            {
              command: 'exit 1',
              onFailure: 'warn',
            },
          ],
        },
      };

      const dispatcher = new HookDispatcher(hookConfig);
      const failures = await dispatcher.runPost('post-task', {
        sessionId: 'test',
        cwd: tempDir,
      });

      expect(failures).toHaveLength(1);
      expect(failures[0]?.onFailure).toBe('warn');
    });

    it('should skip delete action files for post-task-file when hook specifies action', async () => {
      const hookConfig: HooksConfig = {
        lifecycle: {
          'post-task-file': [
            {
              match: '**/*',
              action: 'edit',
              command: 'exit 1',
            },
          ],
        },
      };

      const dispatcher = new HookDispatcher(hookConfig);

      // Should run for edit
      const editFailures = await dispatcher.runPost('post-task-file', {
        file: { path: 'test.ts', action: 'edit' },
        sessionId: 'test',
        cwd: tempDir,
      });
      expect(editFailures).toHaveLength(1);

      // Should NOT run for delete (action filter)
      const deleteFailures = await dispatcher.runPost('post-task-file', {
        file: { path: 'test.ts', action: 'delete' },
        sessionId: 'test',
        cwd: tempDir,
      });
      expect(deleteFailures).toHaveLength(0);
    });

    it('should handle timeout and set timedOut flag', async () => {
      const hookConfig: HooksConfig = {
        lifecycle: {
          'post-task': [
            {
              command: 'sleep 5',
              timeoutMs: 100,
            },
          ],
        },
      };

      const dispatcher = new HookDispatcher(hookConfig);
      const failures = await dispatcher.runPost('post-task', {
        sessionId: 'test',
        cwd: tempDir,
      });

      expect(failures).toHaveLength(1);
      expect(failures[0]?.timedOut).toBe(true);
      expect(failures[0]?.exitCode).toBeNull();
    });

    it('should capture stdout and stderr from failing hooks', async () => {
      const hookConfig: HooksConfig = {
        lifecycle: {
          'post-task': [
            {
              command: 'echo "error output" && exit 1',
            },
          ],
        },
      };

      const dispatcher = new HookDispatcher(hookConfig);
      const failures = await dispatcher.runPost('post-task', {
        sessionId: 'test',
        cwd: tempDir,
      });

      expect(failures[0]?.stdout).toContain('error output');
    });

    it('should set correct phase in failure object', async () => {
      const hookConfig: HooksConfig = {
        lifecycle: {
          'post-task-file': [
            {
              match: '*.ts',
              command: 'exit 1',
            },
          ],
        },
      };

      const dispatcher = new HookDispatcher(hookConfig);
      const failures = await dispatcher.runPost('post-task-file', {
        file: { path: 'test.ts', action: 'edit' },
        sessionId: 'test',
        cwd: tempDir,
      });

      expect(failures[0]?.phase).toBe('post-task-file');
      expect(failures[0]?.file?.path).toBe('test.ts');
    });
  });

  describe('dispatchEvent (fire-and-forget)', () => {
    it('should not block on event dispatch', async () => {
      const hookConfig: HooksConfig = {
        events: {
          'task.abandoned': [
            {
              command: 'sleep 2 && echo "done"',
            },
          ],
        },
      };

      const dispatcher = new HookDispatcher(hookConfig);

      const startTime = Date.now();
      dispatcher.dispatchEvent('task.abandoned', { taskId: 't1' }, { sessionId: 'test', cwd: tempDir });
      const elapsedTime = Date.now() - startTime;

      // Should return immediately (fire-and-forget), not wait 2 seconds
      expect(elapsedTime).toBeLessThan(500);
    });

    it('should set environment variables for event hooks', async () => {
      const outputFile = join(tempDir, 'env-output.txt');
      const hookConfig: HooksConfig = {
        events: {
          'task.started': [
            {
              command: `echo "SID=$DEVFLOW_SESSION_ID" > ${outputFile} && echo "CWD=$DEVFLOW_CWD" >> ${outputFile}`,
            },
          ],
        },
      };

      const dispatcher = new HookDispatcher(hookConfig);
      dispatcher.dispatchEvent(
        'task.started',
        { taskId: 't1' },
        { sessionId: 'test-session-123', cwd: tempDir }
      );

      await dispatcher.drainEventHooks();

      const output = require('node:fs').readFileSync(outputFile, 'utf-8');
      expect(output).toContain('test-session-123');
      expect(output).toContain(tempDir);
    });
  });

  describe('invalid glob patterns', () => {
    it('should gracefully handle invalid glob patterns', async () => {
      const hookConfig: HooksConfig = {
        lifecycle: {
          'pre-task-file': [
            {
              match: '[invalid glob pattern',
              command: 'echo "should not run"',
            },
          ],
        },
      };

      const dispatcher = new HookDispatcher(hookConfig);
      const output = await dispatcher.runPre('pre-task-file', {
        file: { path: 'test.ts', action: 'edit' },
        sessionId: 'test',
        cwd: tempDir,
      });

      // Should gracefully skip rather than throw
      expect(output).toBe('');
    });
  });

  describe('empty config', () => {
    it('should handle empty hooks config', async () => {
      const dispatcher = new HookDispatcher({});

      const preOutput = await dispatcher.runPre('pre-task', { sessionId: 'test', cwd: tempDir });
      expect(preOutput).toBe('');

      const postFailures = await dispatcher.runPost('post-task', { sessionId: 'test', cwd: tempDir });
      expect(postFailures).toEqual([]);
    });

    it('should handle no config at all', async () => {
      const dispatcher = new HookDispatcher();

      const preOutput = await dispatcher.runPre('pre-task', { sessionId: 'test', cwd: tempDir });
      expect(preOutput).toBe('');

      const postFailures = await dispatcher.runPost('post-task', { sessionId: 'test', cwd: tempDir });
      expect(postFailures).toEqual([]);
    });
  });

  describe('EPIPE handling', () => {
    it('should not crash when hook command ignores stdin with large payload', async () => {
      // Reproduces the real-world scenario: user's hooks run `echo ...` which
      // ignores stdin. For large payloads (plan+task context), the write
      // exceeds the pipe buffer (~64KB) and fails with EPIPE when echo exits.
      const hookConfig: HooksConfig = {
        lifecycle: {
          'pre-task': [
            {
              command: 'echo "hook fired"',
              timeoutMs: 5000,
              onFailure: 'warn',
            },
          ],
        },
      };

      const dispatcher = new HookDispatcher(hookConfig);

      // Build a large context payload that will exceed the pipe buffer
      const hugePlan = {
        planId: 'test',
        prompt: 'x'.repeat(200 * 1024), // 200 KB — well beyond pipe buffer
        tasks: Array.from({ length: 20 }, (_, i) => ({
          id: `task-${i}`,
          title: `Task ${i}`,
          instructions: 'y'.repeat(10000),
        })),
      };

      const output = await dispatcher.runPre('pre-task', {
        plan: hugePlan,
        task: { id: 'task-0', title: 'Current' },
        sessionId: 'test-epipe',
        cwd: tempDir,
      });

      expect(output).toContain('hook fired');
    });
  });

  describe('hookInvocationId tracking', () => {
    it('should propagate hookInvocationId to environment variable', async () => {
      const outputFile = join(tempDir, 'invocation-id.txt');
      const hookConfig: HooksConfig = {
        lifecycle: {
          'post-task': [
            {
              command: `echo "$DEVFLOW_HOOK_INVOCATION_ID" > ${outputFile}`,
            },
          ],
        },
      };

      const dispatcher = new HookDispatcher(hookConfig);
      const failures = await dispatcher.runPost('post-task', {
        sessionId: 'test-invocation',
        cwd: tempDir,
      });

      // Verify the UUID was written (UUID v4 format)
      const output = require('node:fs').readFileSync(outputFile, 'utf-8').trim();
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      expect(output).toMatch(uuidRegex);
    });

    it('should attach hookInvocationId to HookFailure', async () => {
      const hookConfig: HooksConfig = {
        lifecycle: {
          'post-task': [
            {
              command: 'exit 1',
              onFailure: 'warn',
            },
          ],
        },
      };

      const dispatcher = new HookDispatcher(hookConfig);
      const failures = await dispatcher.runPost('post-task', {
        sessionId: 'test-failure',
        cwd: tempDir,
      });

      expect(failures).toHaveLength(1);
      expect(failures[0]?.hookInvocationId).toBeDefined();
      // Verify it's a valid UUID
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      expect(failures[0]?.hookInvocationId).toMatch(uuidRegex);
    });

    it('should track invocationDurationMs separately from total durationMs', async () => {
      const hookConfig: HooksConfig = {
        lifecycle: {
          'post-task': [
            {
              command: 'sleep 0.1 && exit 1',
              onFailure: 'warn',
            },
          ],
        },
      };

      const dispatcher = new HookDispatcher(hookConfig);
      const failures = await dispatcher.runPost('post-task', {
        sessionId: 'test-duration',
        cwd: tempDir,
      });

      expect(failures).toHaveLength(1);
      expect(failures[0]?.invocationDurationMs).toBeDefined();
      expect(failures[0]?.invocationDurationMs).toBeGreaterThanOrEqual(100);
      expect(failures[0]?.durationMs).toBeGreaterThanOrEqual(100);
    });
  });

  describe('hook.decision events', () => {
    it('should emit hook.decision event for glob skip on post-task-file', async () => {
      const logDir = join(tempDir, 'logs');
      const logPath = join(logDir, 'runs.jsonl');
      const logger = new Logger({ logsDir: logDir, centralLogPath: logPath });

      const hookConfig: HooksConfig = {
        lifecycle: {
          'post-task-file': [
            {
              match: '*.ts',
              command: 'echo "ts file"',
            },
          ],
        },
      };

      const dispatcher = new HookDispatcher(hookConfig, undefined, logger);
      await dispatcher.runPost('post-task-file', {
        file: { path: 'test.md', action: 'edit' },
        sessionId: 'test-decision-glob',
        cwd: tempDir,
      });

      // Read the log file and verify hook.decision event exists
      const logContent = require('node:fs').readFileSync(logPath, 'utf-8');
      const lines = logContent.trim().split('\n').filter((l: string) => l.length > 0);
      const decisionEvents = lines
        .map((line: string) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter((evt: any) => evt?.type === 'hook.decision');

      expect(decisionEvents.length).toBeGreaterThan(0);
      expect(decisionEvents[0]?.verdict).toBe('skipped-glob');
      expect(decisionEvents[0]?.file).toBe('test.md');
      expect(decisionEvents[0]?.hookInvocationId).toBeDefined();
    });

    it('should emit hook.decision event for action skip on post-task-file', async () => {
      const logDir = join(tempDir, 'logs');
      const logPath = join(logDir, 'runs.jsonl');
      const logger = new Logger({ logsDir: logDir, centralLogPath: logPath });

      const hookConfig: HooksConfig = {
        lifecycle: {
          'post-task-file': [
            {
              match: 'src/**/*',
              action: 'create',
              command: 'echo "create"',
            },
          ],
        },
      };

      const dispatcher = new HookDispatcher(hookConfig, undefined, logger);
      await dispatcher.runPost('post-task-file', {
        file: { path: 'src/test.ts', action: 'edit' },
        sessionId: 'test-decision-action',
        cwd: tempDir,
      });

      // Read the log file and verify hook.decision event for skipped-action
      const logContent = require('node:fs').readFileSync(logPath, 'utf-8');
      const lines = logContent.trim().split('\n').filter((l: string) => l.length > 0);
      const decisionEvents = lines
        .map((line: string) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter((evt: any) => evt?.type === 'hook.decision');

      expect(decisionEvents.length).toBeGreaterThan(0);
      expect(decisionEvents[0]?.verdict).toBe('skipped-action');
      expect(decisionEvents[0]?.action).toBe('edit');
    });

    it('should emit hook.decision event for surprise skip on post-task-file', async () => {
      const logDir = join(tempDir, 'logs');
      const logPath = join(logDir, 'runs.jsonl');
      const logger = new Logger({ logsDir: logDir, centralLogPath: logPath });

      const hookConfig: HooksConfig = {
        lifecycle: {
          'post-task-file': [
            {
              match: '**/*',
              command: 'echo "surprise"',
              // Note: runOnSurprise is NOT set, so should skip surprise paths
            },
          ],
        },
      };

      const dispatcher = new HookDispatcher(hookConfig, undefined, logger);
      await dispatcher.runPost('post-task-file', {
        file: { path: 'unexpected.txt', action: 'create' },
        sessionId: 'test-decision-surprise',
        cwd: tempDir,
        classification: 'surprise',
      });

      // Read the log file and verify hook.decision event for skipped-surprise
      const logContent = require('node:fs').readFileSync(logPath, 'utf-8');
      const lines = logContent.trim().split('\n').filter((l: string) => l.length > 0);
      const decisionEvents = lines
        .map((line: string) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter((evt: any) => evt?.type === 'hook.decision');

      expect(decisionEvents.length).toBeGreaterThan(0);
      expect(decisionEvents[0]?.verdict).toBe('skipped-surprise');
    });
  });
});
