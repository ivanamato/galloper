import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HookDispatcher, type HooksConfig } from '../../src/lib/HookDispatcher.js';
import { type HumanReporter, type HookFiredInfo } from '../../src/lib/HumanReporter.js';

describe('HookDispatcher hookFired emissions', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'hook-humanreporter-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  /**
   * Creates a spy HumanReporter that records all hookFired calls
   */
  function createSpyReporter(): { reporter: HumanReporter; hookFiredCalls: HookFiredInfo[] } {
    const hookFiredCalls: HookFiredInfo[] = [];
    const reporter: HumanReporter = {
      info: vi.fn(),
      step: vi.fn(),
      planSummary: vi.fn(),
      taskStarted: vi.fn(),
      taskCompleted: vi.fn(),
      done: vi.fn(),
      hookFired: vi.fn((info: HookFiredInfo) => {
        hookFiredCalls.push(info);
      }),
      llmEvent: vi.fn(),
      idleTick: vi.fn(),
    };
    return { reporter, hookFiredCalls };
  }


  describe('runPre', () => {
    it('should emit hookFired with instructionsOnly=true for pre-hook with instructions only', async () => {
      const { reporter, hookFiredCalls } = createSpyReporter();
      const hookConfig: HooksConfig = {
        lifecycle: {
          'pre-task': [
            {
              instructions: 'This is a pre-hook instruction',
            },
          ],
        },
      };

      const dispatcher = new HookDispatcher(hookConfig, reporter);
      await dispatcher.runPre('pre-task', {
        sessionId: 'test-session',
        cwd: tempDir,
      });

      expect(hookFiredCalls).toHaveLength(1);
      const call = hookFiredCalls[0]!;
      expect(call.phase).toBe('pre-task');
      expect(call.kind).toBe('lifecycle');
      expect(call.instructionsOnly).toBe(true);
      expect(call.command).toBeUndefined();
    });

    it('should emit hookFired with command execution details for successful pre-hook', async () => {
      const { reporter, hookFiredCalls } = createSpyReporter();
      const hookConfig: HooksConfig = {
        lifecycle: {
          'pre-task': [
            {
              command: 'echo "pre-hook output"',
            },
          ],
        },
      };

      const dispatcher = new HookDispatcher(hookConfig, reporter);
      await dispatcher.runPre('pre-task', {
        sessionId: 'test-session',
        cwd: tempDir,
      });

      expect(hookFiredCalls).toHaveLength(1);
      const call = hookFiredCalls[0]!;
      expect(call.phase).toBe('pre-task');
      expect(call.kind).toBe('lifecycle');
      expect(call.command).toBe('echo "pre-hook output"');
      expect(call.exitCode).toBe(0);
      expect(call.stdout).toBe('pre-hook output\n');
      expect(call.durationMs).toBeGreaterThanOrEqual(0);
      expect(call.instructionsOnly).toBeUndefined();
    });
  });

  describe('runPost', () => {
    it('should emit hookFired with exitCode=0 and stdout for successful post-hook', async () => {
      const { reporter, hookFiredCalls } = createSpyReporter();
      const hookConfig: HooksConfig = {
        lifecycle: {
          'post-task': [
            {
              command: 'echo "post-hook success"',
            },
          ],
        },
      };

      const dispatcher = new HookDispatcher(hookConfig, reporter);
      await dispatcher.runPost('post-task', {
        sessionId: 'test-session',
        cwd: tempDir,
      });

      expect(hookFiredCalls).toHaveLength(1);
      const call = hookFiredCalls[0]!;
      expect(call.phase).toBe('post-task');
      expect(call.kind).toBe('lifecycle');
      expect(call.command).toBe('echo "post-hook success"');
      expect(call.exitCode).toBe(0);
      expect(call.stdout).toBe('post-hook success\n');
      expect(call.stderr).toBe('');
      expect(call.timedOut).toBe(false);
      expect(call.durationMs).toBeGreaterThan(0);
    });

    it('should emit hookFired with non-zero exitCode and stderr for failing post-hook with onFailure=warn', async () => {
      const { reporter, hookFiredCalls } = createSpyReporter();
      const hookConfig: HooksConfig = {
        lifecycle: {
          'post-task': [
            {
              command: 'sh -c "echo error-message >&2; exit 1"',
              onFailure: 'warn',
            },
          ],
        },
      };

      const dispatcher = new HookDispatcher(hookConfig, reporter);
      await dispatcher.runPost('post-task', {
        sessionId: 'test-session',
        cwd: tempDir,
      });

      expect(hookFiredCalls).toHaveLength(1);
      const call = hookFiredCalls[0]!;
      expect(call.phase).toBe('post-task');
      expect(call.kind).toBe('lifecycle');
      expect(call.command).toBe('sh -c "echo error-message >&2; exit 1"');
      expect(call.exitCode).toBe(1);
      expect(call.exitCode).not.toBe(0);
      expect(call.stderr).toContain('error-message');
      expect(call.durationMs).toBeGreaterThan(0);
    });
  });

  describe('dispatchEvent', () => {
    it('should emit hookFired with kind=event and phase matching event type', async () => {
      const { reporter, hookFiredCalls } = createSpyReporter();
      const hookConfig: HooksConfig = {
        events: {
          'run.completed': [
            {
              command: 'echo "event-hook-fired"',
            },
          ],
        },
      };

      const dispatcher = new HookDispatcher(hookConfig, reporter);
      dispatcher.dispatchEvent('run.completed', { result: 'success' }, {
        sessionId: 'test-session',
        cwd: tempDir,
      });

      // Event hooks fire asynchronously; wait for completion
      await dispatcher.drainEventHooks();
      expect(hookFiredCalls).toHaveLength(1);

      const call = hookFiredCalls[0]!;
      expect(call.phase).toBe('run.completed');
      expect(call.kind).toBe('event');
      expect(call.command).toBe('echo "event-hook-fired"');
      expect(call.exitCode).toBe(0);
      expect(call.stdout).toBe('event-hook-fired\n');
    });

    it('should emit hookFired for multiple event hooks in order', async () => {
      const { reporter, hookFiredCalls } = createSpyReporter();
      const hookConfig: HooksConfig = {
        events: {
          'plan.started': [
            {
              command: 'echo "first-event-hook"',
            },
            {
              command: 'echo "second-event-hook"',
            },
          ],
        },
      };

      const dispatcher = new HookDispatcher(hookConfig, reporter);
      dispatcher.dispatchEvent('plan.started', { planId: 'plan-123' }, {
        sessionId: 'test-session',
        cwd: tempDir,
      });

      // Wait for both event hooks to complete
      await dispatcher.drainEventHooks();
      expect(hookFiredCalls).toHaveLength(2);

      expect(hookFiredCalls[0]!.phase).toBe('plan.started');
      expect(hookFiredCalls[0]!.kind).toBe('event');
      expect(hookFiredCalls[0]!.stdout).toBe('first-event-hook\n');

      expect(hookFiredCalls[1]!.phase).toBe('plan.started');
      expect(hookFiredCalls[1]!.kind).toBe('event');
      expect(hookFiredCalls[1]!.stdout).toBe('second-event-hook\n');
    });
  });

  describe('mixed lifecycle and event hooks', () => {
    it('should emit hookFired for both pre-hook and post-hook in sequence', async () => {
      const { reporter, hookFiredCalls } = createSpyReporter();
      const hookConfig: HooksConfig = {
        lifecycle: {
          'pre-task': [
            {
              instructions: 'Pre-task instruction',
            },
          ],
          'post-task': [
            {
              command: 'echo "post-task-output"',
            },
          ],
        },
      };

      const dispatcher = new HookDispatcher(hookConfig, reporter);

      // Run pre-hook
      await dispatcher.runPre('pre-task', {
        sessionId: 'test-session',
        cwd: tempDir,
      });

      expect(hookFiredCalls).toHaveLength(1);
      expect(hookFiredCalls[0]!.instructionsOnly).toBe(true);

      // Run post-hook
      await dispatcher.runPost('post-task', {
        sessionId: 'test-session',
        cwd: tempDir,
      });

      expect(hookFiredCalls).toHaveLength(2);
      expect(hookFiredCalls[1]!.exitCode).toBe(0);
      expect(hookFiredCalls[1]!.command).toBe('echo "post-task-output"');
    });

    it('should emit hookFired with file context in lifecycle hooks', async () => {
      const { reporter, hookFiredCalls } = createSpyReporter();
      const hookConfig: HooksConfig = {
        lifecycle: {
          'post-task-file': [
            {
              match: '**/*.ts',
              command: 'echo "file-hook"',
            },
          ],
        },
      };

      const dispatcher = new HookDispatcher(hookConfig, reporter);
      await dispatcher.runPost('post-task-file', {
        file: { path: 'src/main.ts', action: 'edit' },
        sessionId: 'test-session',
        cwd: tempDir,
      });

      expect(hookFiredCalls).toHaveLength(1);
      const call = hookFiredCalls[0]!;
      expect(call.file).toEqual({ path: 'src/main.ts', action: 'edit' });
      expect(call.command).toBe('echo "file-hook"');
    });
  });
});
