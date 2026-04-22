import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TaskRunner } from '../../src/lib/TaskRunner.js';
import { ConfigManager } from '../../src/lib/ConfigManager.js';
import { CoreRunner } from '../../src/lib/CoreRunner.js';
import { Logger } from '../../src/lib/Logger.js';
import { Executioner } from '../../src/lib/Executioner.js';
import { CommandResolver } from '../../src/lib/CommandResolver.js';
import { createTempWorkspace, cleanup } from '../helpers/tempDir.js';

describe('TaskRunner Retry Loop', () => {
  let tempDir: string;
  let taskRunner: TaskRunner;
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
    taskRunner = new TaskRunner();
  });

  afterEach(() => {
    cleanup(tempDir);
  });

  it('should pass first try with verify success', async () => {
    const executioner = new Executioner({
      configManager,
      coreRunner,
      logger,
      executionsDir: join(tempDir, 'executions'),
    });

    const planContent = JSON.stringify({
      planId: 'test-first-try-pass',
      tasks: [
        {
          id: 't1',
          title: 'Task 1',
          files: [],
          instructions: 'Do something',
          verify: 'echo ok',
          dependsOn: [],
        },
      ],
    });

    const planFilePath = join(tempDir, 'plan.json');
    const manifestPath = join(tempDir, 'manifest.json');

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

    expect(manifest.tasks[0]?.status).toBe('done');
    expect(manifest.tasks[0]?.attempts).toHaveLength(1);
    expect(manifest.tasks[0]?.attempts[0]?.status).toBe('completed');
    expect(manifest.tasks[0]?.attempts[0]?.verifyExitCode).toBe(0);
  });

  it('should fail then pass on retry', async () => {
    let verifyCallCount = 0;
    const mockCoreRunner = {
      run: async (opts: any) => {
        verifyCallCount++;
        // First verify fails, second succeeds
        const shouldSucceed = verifyCallCount > 1;
        return {
          exitCode: shouldSucceed ? 0 : 1,
          stdout: shouldSucceed ? 'ok' : 'verify failed',
          stderr: '',
          durationMs: 50,
        };
      },
    };

    const executioner = new Executioner({
      configManager,
      coreRunner,
      logger,
      executionsDir: join(tempDir, 'executions'),
    });

    const planContent = JSON.stringify({
      planId: 'test-fail-then-pass',
      maxAttempts: 2,
      tasks: [
        {
          id: 't1',
          title: 'Task 1',
          files: [],
          instructions: 'Do something',
          verify: 'test-cmd',
          dependsOn: [],
        },
      ],
    });

    const planFilePath = join(tempDir, 'plan.json');
    const manifestPath = join(tempDir, 'manifest.json');

    const { promises: fs } = await import('node:fs');
    await fs.writeFile(planFilePath, JSON.stringify({ content: planContent }), 'utf8');

    const manifest = await taskRunner.run({
      planFilePath,
      runManifestPath: manifestPath,
      cwd: process.cwd(),
      executioner,
      coreRunner: mockCoreRunner as any,
      logger,
    });

    expect(manifest.tasks[0]?.status).toBe('done');
    expect(manifest.tasks[0]?.attempts).toHaveLength(2);
    expect(manifest.tasks[0]?.attempts[0]?.status).toBe('failed');
    expect(manifest.tasks[0]?.attempts[0]?.verifyExitCode).toBe(1);
    expect(manifest.tasks[0]?.attempts[1]?.status).toBe('completed');
    expect(manifest.tasks[0]?.attempts[1]?.verifyExitCode).toBe(0);
  });

  it('should exhaust budget and mark task abandoned', async () => {
    const mockCoreRunner = {
      run: async (opts: any) => ({
        exitCode: 1,
        stdout: 'always fails',
        stderr: '',
        durationMs: 50,
      }),
    };

    const executioner = new Executioner({
      configManager,
      coreRunner,
      logger,
      executionsDir: join(tempDir, 'executions'),
    });

    const planContent = JSON.stringify({
      planId: 'test-exhaust-budget',
      maxAttempts: 2,
      tasks: [
        {
          id: 't1',
          title: 'Task 1',
          files: [],
          instructions: 'Do something',
          verify: 'test-cmd',
          dependsOn: [],
        },
      ],
    });

    const planFilePath = join(tempDir, 'plan.json');
    const manifestPath = join(tempDir, 'manifest.json');

    const { promises: fs } = await import('node:fs');
    await fs.writeFile(planFilePath, JSON.stringify({ content: planContent }), 'utf8');

    const manifest = await taskRunner.run({
      planFilePath,
      runManifestPath: manifestPath,
      cwd: process.cwd(),
      executioner,
      coreRunner: mockCoreRunner as any,
      logger,
    });

    expect(manifest.tasks[0]?.status).toBe('abandoned');
    expect(manifest.tasks[0]?.attempts).toHaveLength(2);
    expect(manifest.tasks[0]?.attempts[0]?.status).toBe('failed');
    expect(manifest.tasks[0]?.attempts[1]?.status).toBe('failed');
  });

  it('should abort plan when onTaskAbandoned is abort', async () => {
    const mockCoreRunner = {
      run: async (opts: any) => ({
        exitCode: 1,
        stdout: 'always fails',
        stderr: '',
        durationMs: 50,
      }),
    };

    const executioner = new Executioner({
      configManager,
      coreRunner,
      logger,
      executionsDir: join(tempDir, 'executions'),
    });

    const planContent = JSON.stringify({
      planId: 'test-abort-policy',
      maxAttempts: 1,
      onTaskAbandoned: 'abort',
      tasks: [
        {
          id: 't1',
          title: 'Task 1',
          files: [],
          instructions: 'Do something',
          verify: 'test-cmd',
          dependsOn: [],
        },
        {
          id: 't2',
          title: 'Task 2',
          files: [],
          instructions: 'Never runs',
          verify: 'echo ok',
          dependsOn: [],
        },
      ],
    });

    const planFilePath = join(tempDir, 'plan.json');
    const manifestPath = join(tempDir, 'manifest.json');

    const { promises: fs } = await import('node:fs');
    await fs.writeFile(planFilePath, JSON.stringify({ content: planContent }), 'utf8');

    // Should throw because of abort policy
    await expect(
      taskRunner.run({
        planFilePath,
        runManifestPath: manifestPath,
        cwd: process.cwd(),
        executioner,
        coreRunner: mockCoreRunner as any,
        logger,
      })
    ).rejects.toThrow();

    // Second task should not have been started
    const content = readFileSync(manifestPath, 'utf-8');
    const manifest = JSON.parse(content);
    expect(manifest.tasks[1]?.status).toBe('pending');
  });

  it('should persist manifest after each attempt', async () => {
    let verifyCallCount = 0;
    const mockCoreRunner = {
      run: async (opts: any) => {
        verifyCallCount++;
        return {
          exitCode: verifyCallCount === 2 ? 0 : 1,
          stdout: 'output',
          stderr: '',
          durationMs: 50,
        };
      },
    };

    const executioner = new Executioner({
      configManager,
      coreRunner,
      logger,
      executionsDir: join(tempDir, 'executions'),
    });

    const planContent = JSON.stringify({
      planId: 'test-persist-manifest',
      maxAttempts: 2,
      tasks: [
        {
          id: 't1',
          title: 'Task 1',
          files: [],
          instructions: 'Do something',
          verify: 'test-cmd',
          dependsOn: [],
        },
      ],
    });

    const planFilePath = join(tempDir, 'plan.json');
    const manifestPath = join(tempDir, 'manifest.json');

    const { promises: fs } = await import('node:fs');
    await fs.writeFile(planFilePath, JSON.stringify({ content: planContent }), 'utf8');

    const manifest = await taskRunner.run({
      planFilePath,
      runManifestPath: manifestPath,
      cwd: process.cwd(),
      executioner,
      coreRunner: mockCoreRunner as any,
      logger,
    });

    // Manifest should exist and be valid JSON
    expect(existsSync(manifestPath)).toBe(true);
    const content = readFileSync(manifestPath, 'utf-8');
    const persistedManifest = JSON.parse(content);

    // Both attempts should be recorded
    expect(persistedManifest.tasks[0]?.attempts).toHaveLength(2);
    expect(persistedManifest.tasks[0]?.status).toBe('done');
  });

  it('should resolve command with attempt number', async () => {
    const resolveEscalatedCalls: { subcommand: string; attempt: number }[] = [];
    const mockCommandResolver = {
      resolveEscalated: (subcommand: string, attempt: number) => {
        resolveEscalatedCalls.push({ subcommand, attempt });
        return null;
      },
    };

    let verifyCallCount = 0;
    const mockCoreRunner = {
      run: async (opts: any) => {
        verifyCallCount++;
        return {
          exitCode: verifyCallCount === 2 ? 0 : 1,
          stdout: 'output',
          stderr: '',
          durationMs: 50,
        };
      },
    };

    const executioner = new Executioner({
      configManager,
      coreRunner,
      logger,
      executionsDir: join(tempDir, 'executions'),
    });

    const planContent = JSON.stringify({
      planId: 'test-command-resolver',
      maxAttempts: 2,
      tasks: [
        {
          id: 't1',
          title: 'Task 1',
          files: [],
          instructions: 'Do something',
          verify: 'test-cmd',
          dependsOn: [],
        },
      ],
    });

    const planFilePath = join(tempDir, 'plan.json');
    const manifestPath = join(tempDir, 'manifest.json');

    const { promises: fs } = await import('node:fs');
    await fs.writeFile(planFilePath, JSON.stringify({ content: planContent }), 'utf8');

    await taskRunner.run({
      planFilePath,
      runManifestPath: manifestPath,
      cwd: process.cwd(),
      executioner,
      coreRunner: mockCoreRunner as any,
      logger,
      commandResolver: mockCommandResolver as any,
    });

    // Should have called resolveEscalated for each attempt with attempt number
    expect(resolveEscalatedCalls.length).toBeGreaterThanOrEqual(1);
    expect(resolveEscalatedCalls[0]).toEqual({ subcommand: 'implement', attempt: 1 });
    if (resolveEscalatedCalls.length > 1) {
      expect(resolveEscalatedCalls[1]).toEqual({ subcommand: 'implement', attempt: 2 });
    }
  });
});
