import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Orchestrator } from '../../src/lib/Orchestrator.js';
import { ConfigManager } from '../../src/lib/ConfigManager.js';
import { CoreRunner } from '../../src/lib/CoreRunner.js';
import { SessionManager, SessionRecord } from '../../src/lib/SessionManager.js';
import { Logger } from '../../src/lib/Logger.js';
import { Planner } from '../../src/lib/Planner.js';
import { Executioner } from '../../src/lib/Executioner.js';
import { createTempWorkspace, cleanup } from '../helpers/tempDir.js';
import { readJsonlEvents } from '../helpers/readJsonl.js';

describe('Orchestrator - Happy Path Integration', () => {
  let tempDir: string;
  let orchestrator: Orchestrator;
  let configPath: string;
  let logsDir: string;
  let logPath: string;
  let sessionsDir: string;
  let plansDir: string;
  let executionsDir: string;

  beforeEach(async () => {
    tempDir = createTempWorkspace();
    const dataDir = join(tempDir, 'galloper-data');
    logsDir = join(dataDir, 'logs');
    logPath = join(logsDir, 'runs.jsonl');
    sessionsDir = join(dataDir, 'sessions');
    plansDir = join(dataDir, 'plans');
    executionsDir = join(dataDir, 'executions');
    // Uses pipeline config because this test runs the planner which needs valid plan JSON
    configPath = join(process.cwd(), 'tests/fixtures/llm-config.pipeline.test.json');

    const configManager = new ConfigManager({ configPath });
    await configManager.load();

    const logger = new Logger({ logsDir, centralLogPath: logPath });
    await logger.ensureDir();

    const coreRunner = new CoreRunner();
    const sessionManager = new SessionManager({ sessionsDir });
    await sessionManager.ensureDir();

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
      rootDir: process.cwd(), // Use project root so relative paths in config work
      dataDir,
    });
  });

  afterEach(() => {
    cleanup(tempDir);
  });

  it('should execute single-prompt and return OrchestratorResult with exitCode 0', async () => {
    const result = await orchestrator.execute({
      subcommand: 'single-prompt',
      prompt: 'test prompt',
      env: process.env,
    });

    expect(result.sessionId).toBeTruthy();
    expect(result.sessionFilePath).toBeTruthy();
    expect(result.exitCode).toBe(0);
    expect(existsSync(result.sessionFilePath)).toBe(true);
  });

  it('should create session file with complete SessionRecord', async () => {
    const result = await orchestrator.execute({
      subcommand: 'single-prompt',
      prompt: 'test prompt',
      env: process.env,
    });

    expect(existsSync(result.sessionFilePath)).toBe(true);

    const content = readFileSync(result.sessionFilePath, 'utf-8');
    const sessionRecord = JSON.parse(content) as SessionRecord;

    expect(sessionRecord.id).toBe(result.sessionId);
    expect(sessionRecord.prompt).toBe('test prompt');
    expect(sessionRecord.command).toBeTruthy();
    expect(sessionRecord.cwd).toBe(process.cwd());
    expect(sessionRecord.exitCode).toBe(0);
    expect(sessionRecord.stdout).toBeTruthy();
    expect(typeof sessionRecord.startedAt).toBe('string');
    expect(typeof sessionRecord.endedAt).toBe('string');
    expect(sessionRecord.durationMs).toBeGreaterThan(0);
  });

  it('should log run.started, run.command_resolved, and run.completed events in order', async () => {
    await orchestrator.execute({
      subcommand: 'single-prompt',
      prompt: 'test',
      env: process.env,
    });

    const events = readJsonlEvents(logPath);

    const startedEvent = events.find((e) => e.type === 'run.started');
    const resolvedEvent = events.find((e) => e.type === 'run.command_resolved');
    const completedEvent = events.find((e) => e.type === 'run.completed');

    expect(startedEvent).toBeDefined();
    expect(startedEvent?.prompt).toBe('test');
    expect(startedEvent?.subcommand).toBe('single-prompt');

    expect(resolvedEvent).toBeDefined();
    expect(typeof resolvedEvent?.resolvedCommand).toBe('string');
    expect(resolvedEvent?.resolvedCommand).toBeTruthy();

    expect(completedEvent).toBeDefined();
    expect(completedEvent?.exitCode).toBe(0);
    expect(completedEvent?.durationMs).toBeGreaterThan(0);
  });

  it('should log process.spawn event with correct command', async () => {
    await orchestrator.execute({
      subcommand: 'single-prompt',
      prompt: 'test',
      env: process.env,
    });

    const events = readJsonlEvents(logPath);
    const spawnEvent = events.find((e) => e.type === 'process.spawn');

    expect(spawnEvent).toBeDefined();
    expect(spawnEvent?.command).toBeTruthy();
    expect(typeof spawnEvent?.command).toBe('string');
  });

  it('should extract and return finalOutput', async () => {
    const result = await orchestrator.execute({
      subcommand: 'single-prompt',
      prompt: 'test',
      env: process.env,
    });

    expect(result.finalOutput).toBeTruthy();
    expect(typeof result.finalOutput).toBe('string');
  });

  it('should preserve session file path in logs', async () => {
    const result = await orchestrator.execute({
      subcommand: 'single-prompt',
      prompt: 'test',
      env: process.env,
    });

    const events = readJsonlEvents(logPath);
    const completedEvent = events.find((e) => e.type === 'run.completed');

    expect(completedEvent?.sessionFilePath).toBe(result.sessionFilePath);
  });

  it('should execute plan subcommand and create plan file', async () => {
    const result = await orchestrator.execute({
      subcommand: 'plan',
      prompt: 'test plan',
      env: process.env,
    });

    expect(result.sessionId).toBeTruthy();
    expect(result.planFilePath).toBeTruthy();
    expect(existsSync(result.planFilePath)).toBe(true);

    const content = readFileSync(result.planFilePath, 'utf-8');
    const plan = JSON.parse(content);
    expect(plan).toBeDefined();
  });

  it('should execute implement subcommand', async () => {
    // Create a plan file for the implement command
    const planFile = {
      id: 'test-plan-3',
      createdAt: new Date().toISOString(),
      prompt: 'test',
      command: 'mock-implement',
      sessionId: 'test-session',
      content: JSON.stringify({
        planId: 'test-plan-3',
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
      }),
    };
    const planFilePath = join(tempDir, 'test-plan-3.json');
    writeFileSync(planFilePath, JSON.stringify(planFile), 'utf-8');

    const result = await orchestrator.execute({
      subcommand: 'implement',
      planFile: planFilePath,
      env: process.env,
    });

    expect(result.sessionId).toBeTruthy();
    expect(result.sessionFilePath).toBeTruthy();
    expect(existsSync(result.sessionFilePath)).toBe(true);
  });

  it('should capture stdout in session record', async () => {
    const result = await orchestrator.execute({
      subcommand: 'single-prompt',
      prompt: 'test',
      env: process.env,
    });

    const content = readFileSync(result.sessionFilePath, 'utf-8');
    const sessionRecord = JSON.parse(content) as SessionRecord;

    expect(sessionRecord.stdout).toBeTruthy();
  });

  it('should record correct timing information', async () => {
    const result = await orchestrator.execute({
      subcommand: 'single-prompt',
      prompt: 'test',
      env: process.env,
    });

    const content = readFileSync(result.sessionFilePath, 'utf-8');
    const sessionRecord = JSON.parse(content) as SessionRecord;

    expect(sessionRecord.startedAt).toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(sessionRecord.endedAt).toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(sessionRecord.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('should log process.stdout events', async () => {
    await orchestrator.execute({
      subcommand: 'single-prompt',
      prompt: 'test',
      env: process.env,
    });

    const events = readJsonlEvents(logPath);
    const stdoutEvents = events.filter((e) => e.type === 'process.stdout');

    expect(stdoutEvents.length).toBeGreaterThan(0);
    expect(stdoutEvents[0]).toHaveProperty('chunk');
  });
});
