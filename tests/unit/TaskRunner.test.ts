import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TaskRunner } from '../../src/lib/TaskRunner.js';
import { ConfigManager } from '../../src/lib/ConfigManager.js';
import { CoreRunner } from '../../src/lib/CoreRunner.js';
import { Logger } from '../../src/lib/Logger.js';
import { Executioner } from '../../src/lib/Executioner.js';
import { createTempWorkspace, cleanup } from '../helpers/tempDir.js';

describe('TaskRunner', () => {
  let tempDir: string;
  let taskRunner: TaskRunner;
  let executioner: Executioner;
  let coreRunner: CoreRunner;
  let logger: Logger;
  let configManager: ConfigManager;

  beforeEach(async () => {
    tempDir = createTempWorkspace();
    const logsDir = join(tempDir, 'logs');
    const logPath = join(logsDir, 'runs.jsonl');
    const executionsDir = join(tempDir, 'executions');
    const configPath = join(process.cwd(), 'tests/fixtures/llm-config.test.json');

    configManager = new ConfigManager({ configPath });
    await configManager.load();

    logger = new Logger({ logsDir, centralLogPath: logPath });
    await logger.ensureDir();

    coreRunner = new CoreRunner();

    executioner = new Executioner({
      configManager,
      coreRunner,
      logger,
      executionsDir,
    });

    taskRunner = new TaskRunner();
  });

  afterEach(() => {
    cleanup(tempDir);
  });

  it('should execute tasks sequentially from valid plan', async () => {
    const planContent = JSON.stringify({
      planId: 'test-plan-1',
      tasks: [
        {
          id: 't1',
          title: 'Task 1',
          files: [],
          instructions: 'First task',
          verify: 'echo success',
          dependsOn: [],
        },
        {
          id: 't2',
          title: 'Task 2',
          files: [],
          instructions: 'Second task',
          verify: 'echo ok',
          dependsOn: ['t1'],
        },
      ],
    });

    const planFilePath = join(tempDir, 'test-plan.json');
    const manifestPath = join(tempDir, 'run-manifest.json');

    const { promises: fs } = await import('node:fs');
    await fs.writeFile(planFilePath, JSON.stringify({ content: planContent }), 'utf8');

    const manifest = await taskRunner.run({
      planFilePath,
      runManifestPath: manifestPath,
      cwd: process.cwd(),
      executioner,
      coreRunner,
      logger,
    });

    expect(manifest.runId).toBeTruthy();
    expect(manifest.planId).toBe('test-plan-1');
    expect(manifest.tasks).toHaveLength(2);
    expect(manifest.tasks[0]?.status).toBe('done');
    expect(manifest.tasks[0]?.attempts).toHaveLength(1);
    expect(manifest.tasks[0]?.attempts[0]?.verifyExitCode).toBe(0);
    expect(manifest.tasks[1]?.status).toBe('done');
    expect(manifest.tasks[1]?.attempts).toHaveLength(1);
    expect(manifest.tasks[1]?.attempts[0]?.verifyExitCode).toBe(0);
  });

  it('should mark task failed when verify command exits with nonzero', async () => {
    const planContent = JSON.stringify({
      planId: 'test-plan-fail',
      maxAttempts: 1,
      tasks: [
        {
          id: 't1',
          title: 'Task 1',
          files: [],
          instructions: 'Task',
          verify: 'exit 1',
          dependsOn: [],
        },
      ],
    });

    const planFilePath = join(tempDir, 'test-plan-fail.json');
    const manifestPath = join(tempDir, 'run-manifest-fail.json');

    const { promises: fs } = await import('node:fs');
    await fs.writeFile(planFilePath, JSON.stringify({ content: planContent }), 'utf8');

    const manifest = await taskRunner.run({
      planFilePath,
      runManifestPath: manifestPath,
      cwd: process.cwd(),
      executioner,
      coreRunner,
      logger,
    });

    expect(manifest.tasks[0]?.status).toBe('abandoned');
    expect(manifest.tasks[0]?.attempts).toHaveLength(1);
    expect(manifest.tasks[0]?.attempts[0]?.verifyExitCode).toBe(1);
  });

  it('should write manifest file with correct structure', async () => {
    const planContent = JSON.stringify({
      planId: 'test-plan-manifest',
      tasks: [
        {
          id: 't1',
          title: 'Task',
          files: [],
          instructions: 'Do it',
          verify: 'echo ok',
          dependsOn: [],
        },
      ],
    });

    const planFilePath = join(tempDir, 'test-plan-manifest.json');
    const manifestPath = join(tempDir, 'run-manifest-manifest.json');

    const { promises: fs } = await import('node:fs');
    await fs.writeFile(planFilePath, JSON.stringify({ content: planContent }), 'utf8');

    const manifest = await taskRunner.run({
      planFilePath,
      runManifestPath: manifestPath,
      cwd: process.cwd(),
      executioner,
      coreRunner,
      logger,
    });

    expect(existsSync(manifestPath)).toBe(true);

    const content = readFileSync(manifestPath, 'utf-8');
    const writtenManifest = JSON.parse(content);

    expect(writtenManifest.runId).toBe(manifest.runId);
    expect(writtenManifest.planId).toBe('test-plan-manifest');
    expect(writtenManifest.tasks).toHaveLength(1);
    expect(writtenManifest.tasks[0]?.id).toBe('t1');
    expect(writtenManifest.tasks[0]?.status).toBe('done');
    expect(writtenManifest.createdAt).toBeTruthy();
  });

  it('should execute tasks in dependency order', async () => {
    const planContent = JSON.stringify({
      planId: 'test-plan-order',
      tasks: [
        {
          id: 't3',
          title: 'Task 3',
          files: [],
          instructions: 'Task 3',
          verify: 'echo ok',
          dependsOn: ['t1', 't2'],
        },
        {
          id: 't1',
          title: 'Task 1',
          files: [],
          instructions: 'Task 1',
          verify: 'echo ok',
          dependsOn: [],
        },
        {
          id: 't2',
          title: 'Task 2',
          files: [],
          instructions: 'Task 2',
          verify: 'echo ok',
          dependsOn: ['t1'],
        },
      ],
    });

    const planFilePath = join(tempDir, 'test-plan-order.json');
    const manifestPath = join(tempDir, 'run-manifest-order.json');

    const { promises: fs } = await import('node:fs');
    await fs.writeFile(planFilePath, JSON.stringify({ content: planContent }), 'utf8');

    const manifest = await taskRunner.run({
      planFilePath,
      runManifestPath: manifestPath,
      cwd: process.cwd(),
      executioner,
      coreRunner,
      logger,
    });

    // All should be done
    const allDone = manifest.tasks.every((t) => t.status === 'done');
    expect(allDone).toBe(true);

    // All should have startedAt and endedAt
    const allHaveTimestamps = manifest.tasks.every((t) => t.startedAt && t.endedAt);
    expect(allHaveTimestamps).toBe(true);
  });

  it('should handle plan with no dependencies', async () => {
    const planContent = JSON.stringify({
      planId: 'test-plan-independent',
      tasks: [
        {
          id: 't1',
          title: 'Task 1',
          files: [],
          instructions: 'Task 1',
          verify: 'echo ok',
          dependsOn: [],
        },
        {
          id: 't2',
          title: 'Task 2',
          files: [],
          instructions: 'Task 2',
          verify: 'echo ok',
          dependsOn: [],
        },
        {
          id: 't3',
          title: 'Task 3',
          files: [],
          instructions: 'Task 3',
          verify: 'echo ok',
          dependsOn: [],
        },
      ],
    });

    const planFilePath = join(tempDir, 'test-plan-independent.json');
    const manifestPath = join(tempDir, 'run-manifest-independent.json');

    const { promises: fs } = await import('node:fs');
    await fs.writeFile(planFilePath, JSON.stringify({ content: planContent }), 'utf8');

    const manifest = await taskRunner.run({
      planFilePath,
      runManifestPath: manifestPath,
      cwd: process.cwd(),
      executioner,
      coreRunner,
      logger,
    });

    expect(manifest.tasks).toHaveLength(3);
    expect(manifest.tasks.every((t) => t.status === 'done')).toBe(true);
  });

  it('should render FileSpec paths and actions in task prompt', async () => {
    const capturedPrompts: string[] = [];
    const mockExecutioner = {
      ...executioner,
      implement: async ({ prompt }: { prompt: string }) => {
        capturedPrompts.push(prompt);
        return { sessionId: 'mock-session' };
      },
    };

    const planContent = JSON.stringify({
      planId: 'test-prompt-filespec',
      tasks: [
        {
          id: 't1',
          title: 'Create files',
          files: [
            { path: '/new.ts', action: 'create' },
            { path: '/edit.ts', action: 'edit' },
            { path: '/delete.ts', action: 'delete' },
          ],
          instructions: 'Create some files',
          verify: 'echo ok',
          dependsOn: [],
        },
      ],
    });

    const planFilePath = join(tempDir, 'test-prompt-filespec.json');
    const manifestPath = join(tempDir, 'manifest-prompt-filespec.json');

    const { promises: fs } = await import('node:fs');
    await fs.writeFile(planFilePath, JSON.stringify({ content: planContent }), 'utf8');

    await taskRunner.run({
      planFilePath,
      runManifestPath: manifestPath,
      cwd: process.cwd(),
      executioner: mockExecutioner as any,
      coreRunner,
      logger,
    });

    expect(capturedPrompts).toHaveLength(1);
    const prompt = capturedPrompts[0];
    expect(prompt).toContain('/new.ts');
    expect(prompt).toContain('(create)');
    expect(prompt).toContain('/edit.ts');
    expect(prompt).toContain('/delete.ts');
    expect(prompt).toContain('(delete)');
    expect(prompt).toContain('Target files');
  });

  it('should include "Previous attempt" section on retry with failures', async () => {
    const capturedPrompts: string[] = [];
    let attemptCount = 0;

    const mockExecutioner = {
      ...executioner,
      implement: async ({ prompt }: { prompt: string }) => {
        capturedPrompts.push(prompt);
        return { sessionId: `mock-session-${++attemptCount}` };
      },
    };

    const mockCoreRunner = {
      ...coreRunner,
      run: async (opts: any) => {
        // First attempt fails, second attempt succeeds
        const isRetry = capturedPrompts.length > 1;
        return {
          exitCode: isRetry ? 0 : 1,
          stdout: isRetry ? 'ok' : 'failed',
          stderr: '',
          durationMs: 100,
        };
      },
    };

    const planContent = JSON.stringify({
      planId: 'test-retry-prompt',
      maxAttempts: 2,
      tasks: [
        {
          id: 't1',
          title: 'Retry task',
          files: [{ path: '/file.ts', action: 'edit' }],
          instructions: 'Do something',
          verify: 'test-verify',
          dependsOn: [],
        },
      ],
    });

    const planFilePath = join(tempDir, 'test-retry-prompt.json');
    const manifestPath = join(tempDir, 'manifest-retry-prompt.json');

    const { promises: fs } = await import('node:fs');
    await fs.writeFile(planFilePath, JSON.stringify({ content: planContent }), 'utf8');

    const manifest = await taskRunner.run({
      planFilePath,
      runManifestPath: manifestPath,
      cwd: process.cwd(),
      executioner: mockExecutioner as any,
      coreRunner: mockCoreRunner as any,
      logger,
    });

    expect(manifest.tasks[0]?.attempts).toHaveLength(2);
    expect(capturedPrompts).toHaveLength(2);

    // First attempt should not have "Previous attempt" section
    expect(capturedPrompts[0]).not.toContain('Previous attempt');

    // Second attempt should have "Previous attempt" section with failure info
    const retryPrompt = capturedPrompts[1];
    expect(retryPrompt).toContain('Previous attempt');
    expect(retryPrompt).toContain('attempt 1 of 2');
    expect(retryPrompt).toContain('verify');
  });

  it('should render delete action files with explicit instruction', async () => {
    const capturedPrompts: string[] = [];
    const mockExecutioner = {
      ...executioner,
      implement: async ({ prompt }: { prompt: string }) => {
        capturedPrompts.push(prompt);
        return { sessionId: 'mock-session' };
      },
    };

    const planContent = JSON.stringify({
      planId: 'test-delete-action',
      tasks: [
        {
          id: 't1',
          title: 'Delete file',
          files: [{ path: '/old.ts', action: 'delete' }],
          instructions: 'Delete the old file',
          verify: 'echo ok',
          dependsOn: [],
        },
      ],
    });

    const planFilePath = join(tempDir, 'test-delete-action.json');
    const manifestPath = join(tempDir, 'manifest-delete-action.json');

    const { promises: fs } = await import('node:fs');
    await fs.writeFile(planFilePath, JSON.stringify({ content: planContent }), 'utf8');

    await taskRunner.run({
      planFilePath,
      runManifestPath: manifestPath,
      cwd: process.cwd(),
      executioner: mockExecutioner as any,
      coreRunner,
      logger,
    });

    expect(capturedPrompts.length).toBeGreaterThan(0);
    const prompt = capturedPrompts[0];
    expect(prompt).toContain('/old.ts');
    expect(prompt).toContain('(delete)');
  });
});
