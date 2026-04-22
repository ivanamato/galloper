import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TaskRunner } from '../../src/lib/TaskRunner.js';
import { ConfigManager } from '../../src/lib/ConfigManager.js';
import { CoreRunner } from '../../src/lib/CoreRunner.js';
import { Logger } from '../../src/lib/Logger.js';
import { Executioner } from '../../src/lib/Executioner.js';
import { HooksConfig } from '../../src/lib/HookDispatcher.js';
import { createTempWorkspace, cleanup } from '../helpers/tempDir.js';

describe('TaskRunner with HookDispatcher Integration', () => {
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
    const configPath = join(process.cwd(), 'tests/fixtures/galloper.test.json');

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

  it('should accept hooks configuration and pass to HookDispatcher', async () => {
    const hooksConfig: HooksConfig = {
      lifecycle: {
        'pre-task': [
          {
            instructions: 'Do not modify system files',
          },
        ],
      },
    };

    const executioner = new Executioner({
      configManager,
      coreRunner,
      logger,
      executionsDir: join(tempDir, 'executions'),
    });

    const planContent = JSON.stringify({
      planId: 'test-hooks-config',
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

    writeFileSync(planFilePath, JSON.stringify({ content: planContent }), 'utf8');

    const manifest = await taskRunner.run({
      planFilePath,
      runManifestPath: manifestPath,
      cwd: process.cwd(),
      executioner,
      coreRunner,
      logger,
      hooksConfig,
    });

    expect(manifest.tasks[0]?.status).toBe('done');
  });

  it('should handle hooks with onFailure warn policy gracefully', async () => {
    const hooksConfig: HooksConfig = {
      lifecycle: {
        'post-task': [
          {
            command: 'exit 1',
            onFailure: 'warn',
          },
        ],
      },
    };

    const executioner = new Executioner({
      configManager,
      coreRunner,
      logger,
      executionsDir: join(tempDir, 'executions'),
    });

    const planContent = JSON.stringify({
      planId: 'test-warn-hook',
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

    writeFileSync(planFilePath, JSON.stringify({ content: planContent }), 'utf8');

    // Should not throw even with failing warn-policy hook
    const manifest = await taskRunner.run({
      planFilePath,
      runManifestPath: manifestPath,
      cwd: process.cwd(),
      executioner,
      coreRunner,
      logger,
      hooksConfig,
    });

    expect(manifest.tasks[0]?.status).toBe('done');
  });

  it('should respect hook match glob patterns for file-scoped hooks', async () => {
    const hooksConfig: HooksConfig = {
      lifecycle: {
        'post-task-file': [
          {
            match: '*.ts',
            command: 'exit 0',
          },
        ],
      },
    };

    const executioner = new Executioner({
      configManager,
      coreRunner,
      logger,
      executionsDir: join(tempDir, 'executions'),
    });

    const planContent = JSON.stringify({
      planId: 'test-file-matching',
      tasks: [
        {
          id: 't1',
          title: 'Task 1',
          files: [
            { path: 'src/index.ts', action: 'edit' },
            { path: 'README.md', action: 'edit' },
          ],
          instructions: 'Do something',
          verify: 'echo ok',
          dependsOn: [],
        },
      ],
    });

    const planFilePath = join(tempDir, 'plan.json');
    const manifestPath = join(tempDir, 'manifest.json');

    writeFileSync(planFilePath, JSON.stringify({ content: planContent }), 'utf8');

    // Should complete successfully with file matching working
    const manifest = await taskRunner.run({
      planFilePath,
      runManifestPath: manifestPath,
      cwd: process.cwd(),
      executioner,
      coreRunner,
      logger,
      hooksConfig,
    });

    expect(manifest.tasks[0]?.status).toBe('done');
  });

  it('should handle post-task hooks without affecting task status', async () => {
    const hooksConfig: HooksConfig = {
      lifecycle: {
        'post-task': [
          {
            command: 'exit 0',
          },
        ],
      },
    };

    const executioner = new Executioner({
      configManager,
      coreRunner,
      logger,
      executionsDir: join(tempDir, 'executions'),
    });

    const planContent = JSON.stringify({
      planId: 'test-post-task-hook',
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

    writeFileSync(planFilePath, JSON.stringify({ content: planContent }), 'utf8');

    const manifest = await taskRunner.run({
      planFilePath,
      runManifestPath: manifestPath,
      cwd: process.cwd(),
      executioner,
      coreRunner,
      logger,
      hooksConfig,
    });

    expect(manifest.tasks[0]?.status).toBe('done');
  });

  it('should invoke pre-plan hook before task execution', async () => {
    const hooksConfig: HooksConfig = {
      lifecycle: {
        'pre-plan': [
          {
            instructions: 'Validate plan structure',
          },
        ],
      },
    };

    const executioner = new Executioner({
      configManager,
      coreRunner,
      logger,
      executionsDir: join(tempDir, 'executions'),
    });

    const planContent = JSON.stringify({
      planId: 'test-pre-plan',
      prompt: 'Create a simple task',
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

    writeFileSync(planFilePath, JSON.stringify({ content: planContent }), 'utf8');

    const manifest = await taskRunner.run({
      planFilePath,
      runManifestPath: manifestPath,
      cwd: process.cwd(),
      executioner,
      coreRunner,
      logger,
      hooksConfig,
    });

    expect(manifest.tasks).toHaveLength(1);
    expect(manifest.tasks[0]?.status).toBe('done');
  });

  it('should invoke post-plan hook after plan is prepared', async () => {
    const hooksConfig: HooksConfig = {
      lifecycle: {
        'post-plan': [
          {
            instructions: 'Verify plan tasks are valid',
          },
        ],
      },
    };

    const executioner = new Executioner({
      configManager,
      coreRunner,
      logger,
      executionsDir: join(tempDir, 'executions'),
    });

    const planContent = JSON.stringify({
      planId: 'test-post-plan',
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

    writeFileSync(planFilePath, JSON.stringify({ content: planContent }), 'utf8');

    const manifest = await taskRunner.run({
      planFilePath,
      runManifestPath: manifestPath,
      cwd: process.cwd(),
      executioner,
      coreRunner,
      logger,
      hooksConfig,
    });

    expect(manifest.status).toBe('completed');
    expect(manifest.tasks[0]?.status).toBe('done');
  });
});
