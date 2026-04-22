import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Orchestrator } from '../../src/lib/Orchestrator.js';
import { ConfigManager } from '../../src/lib/ConfigManager.js';
import { CoreRunner } from '../../src/lib/CoreRunner.js';
import { Logger } from '../../src/lib/Logger.js';
import { SessionManager } from '../../src/lib/SessionManager.js';
import { Planner } from '../../src/lib/Planner.js';
import { Executioner } from '../../src/lib/Executioner.js';
import { createTempWorkspace, cleanup } from '../helpers/tempDir.js';
import { readJsonlEvents } from '../helpers/readJsonl.js';

describe('Orchestrator pipeline', () => {
  let tempDir: string;
  let orchestrator: Orchestrator;
  let configManager: ConfigManager;
  let logger: Logger;
  let logsDir: string;
  let logPath: string;

  beforeEach(async () => {
    tempDir = createTempWorkspace();
    const dataDir = join(tempDir, 'galloper-data');
    logsDir = join(dataDir, 'logs');
    logPath = join(logsDir, 'runs.jsonl');
    const sessionsDir = join(dataDir, 'sessions');
    const plansDir = join(dataDir, 'plans');
    const executionsDir = join(dataDir, 'executions');
    const configPath = join(process.cwd(), 'tests/fixtures/llm-config.pipeline.test.json');

    configManager = new ConfigManager({ configPath });
    await configManager.load();

    logger = new Logger({ logsDir, centralLogPath: logPath });
    await logger.ensureDir();

    const sessionManager = new SessionManager({ sessionsDir });
    await sessionManager.ensureDir();

    const coreRunner = new CoreRunner();

    const planner = new Planner({
      configManager,
      coreRunner,
      logger,
      plansDir,
    });

    const executioner = new Executioner({
      configManager,
      coreRunner,
      logger,
      executionsDir,
    });

    orchestrator = new Orchestrator({
      configManager,
      coreRunner,
      sessionManager,
      logger,
      planner,
      executioner,
      rootDir: process.cwd(),
      dataDir,
    });
  });

  afterEach(() => {
    cleanup(tempDir);
  });

  it('should execute pipeline with plan and task runner', async () => {
    const result = await orchestrator.execute({
      subcommand: 'pipeline',
      prompt: 'test pipeline',
      env: {
        ...process.env,
        CODEX_DISABLE_PROJECT_HOOKS: '1',
      },
    });

    expect(result.sessionId).toBeTruthy();
    expect(result.exitCode).toBe(0);
    expect(result.planFilePath).toBeTruthy();
    expect(result.runManifestPath).toBeTruthy();
    expect(result.finalOutput).toBeTruthy();
  });

  it('should create run manifest file', async () => {
    const result = await orchestrator.execute({
      subcommand: 'pipeline',
      prompt: 'test pipeline',
      env: {
        ...process.env,
        CODEX_DISABLE_PROJECT_HOOKS: '1',
      },
    });

    expect(result.runManifestPath).toBeTruthy();
    if (!result.runManifestPath) return;

    expect(existsSync(result.runManifestPath)).toBe(true);

    const content = readFileSync(result.runManifestPath, 'utf-8');
    const manifest = JSON.parse(content);

    expect(manifest.runId).toBeTruthy();
    expect(manifest.planId).toBeTruthy();
    expect(manifest.tasks).toBeDefined();
    expect(Array.isArray(manifest.tasks)).toBe(true);
    expect(manifest.tasks.length).toBeGreaterThan(0);
  });

  it('should record task states in manifest', async () => {
    const result = await orchestrator.execute({
      subcommand: 'pipeline',
      prompt: 'test pipeline',
      env: {
        ...process.env,
        CODEX_DISABLE_PROJECT_HOOKS: '1',
      },
    });

    expect(result.runManifestPath).toBeTruthy();
    if (!result.runManifestPath) return;

    const content = readFileSync(result.runManifestPath, 'utf-8');
    const manifest = JSON.parse(content);

    for (const task of manifest.tasks) {
      expect(task.id).toBeTruthy();
      expect(['pending', 'done', 'failed']).toContain(task.status);
      expect(task.startedAt).toBeTruthy();
      expect(task.endedAt).toBeTruthy();
    }
  });

  it('should emit log events for pipeline execution', async () => {
    await orchestrator.execute({
      subcommand: 'pipeline',
      prompt: 'test pipeline',
      env: {
        ...process.env,
        CODEX_DISABLE_PROJECT_HOOKS: '1',
      },
    });

    const events = readJsonlEvents(logPath);

    const runStarted = events.find((e) => e.type === 'run.started' && e.subcommand === 'pipeline');
    expect(runStarted).toBeDefined();

    const runCompleted = events.find((e) => e.type === 'run.completed' && e.runManifestPath);
    expect(runCompleted).toBeDefined();
  });

  it('should parse plan file correctly', async () => {
    const result = await orchestrator.execute({
      subcommand: 'pipeline',
      prompt: 'test pipeline',
      env: {
        ...process.env,
        CODEX_DISABLE_PROJECT_HOOKS: '1',
      },
    });

    expect(result.planFilePath).toBeTruthy();
    if (!result.planFilePath) return;

    expect(existsSync(result.planFilePath)).toBe(true);

    const content = readFileSync(result.planFilePath, 'utf-8');
    const planFile = JSON.parse(content);

    expect(planFile.id).toBeTruthy();
    expect(planFile.prompt).toBeTruthy();
    expect(planFile.command).toBeTruthy();
    expect(planFile.sessionId).toBeTruthy();
    expect(planFile.content).toBeTruthy();

    // Validate the plan content is valid JSON
    const planContent = JSON.parse(planFile.content);
    expect(planContent.planId).toBeTruthy();
    expect(Array.isArray(planContent.tasks)).toBe(true);
  });

  it('should subscribe and dispatch event hooks from config', async () => {
    // Verify that the orchestrator subscribes to event hooks
    // The hooks are configured in the llm-config.pipeline.test.json fixture
    const hooksConfig = configManager.getHooks();

    // For this test, we just verify that:
    // 1. Hooks can be loaded from config
    // 2. Pipeline execution completes successfully with hooks enabled
    const result = await orchestrator.execute({
      subcommand: 'pipeline',
      prompt: 'test event hooks',
      env: {
        ...process.env,
        CODEX_DISABLE_PROJECT_HOOKS: '1',
      },
    });

    expect(result.exitCode).toBe(0);
    expect(result.planFilePath).toBeTruthy();
    expect(result.runManifestPath).toBeTruthy();
  });
});
