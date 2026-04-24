import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Orchestrator } from '../../src/lib/Orchestrator.js';
import type { ConfigManager } from '../../src/lib/ConfigManager.js';
import type { CoreRunner } from '../../src/lib/CoreRunner.js';
import type { SessionManager, SessionRecord } from '../../src/lib/SessionManager.js';
import type { Logger } from '../../src/lib/Logger.js';
import type { Planner } from '../../src/lib/Planner.js';
import type { Executioner } from '../../src/lib/Executioner.js';
import { AdaptiveDriver } from '../../src/lib/AdaptiveDriver.js';

interface CapturedLog {
  type: string;
  payload: Record<string, unknown>;
}

function makeHarness() {
  const logs: CapturedLog[] = [];
  const sessions: Record<string, SessionRecord> = {};

  const logger = {
    append: async (entry: Record<string, unknown>) => {
      logs.push({ type: entry.type as string, payload: entry });
    },
    on: (_eventType: string, _handler: (e: unknown) => void) => {
      return () => {};
    },
  } as unknown as Logger;

  const sessionManager = {
    createSessionId: () => 'sess-test',
    writeSession: async (id: string, record: SessionRecord) => {
      sessions[id] = record;
      return `/fake/sessions/${id}.json`;
    },
  } as unknown as SessionManager;

  const configManager = {
    getHooks: () => ({}),
    getCommand: (_name: string) => ({
      command: 'echo resolved',
      allowedSubcommands: [],
      disallowedSubcommands: [],
    }),
    resolveForSubcommand: (_sc: string) => 'mock-cli',
    validateSubcommand: () => {},
    getExecutionerEscalation: () => [],
  } as unknown as ConfigManager;

  let runCalls = 0;
  let lastRunOptions: Record<string, unknown> | null = null;
  const coreRunner = {
    run: async (opts: Record<string, unknown>) => {
      runCalls += 1;
      lastRunOptions = opts;
      return {
        stdout: '{"type":"item.completed","item":{"type":"agent_message","text":"hello"}}',
        stderr: '',
        exitCode: 0,
        startedAt: '2026-04-22T00:00:00.000Z',
        endedAt: '2026-04-22T00:00:01.000Z',
        durationMs: 1000,
        parsedStdoutEvents: [],
        parsedStderrEvents: [],
      };
    },
  } as unknown as CoreRunner;

  const planner = {
    plan: async () => {
      throw new Error('planner.plan should not be called in this test');
    },
  } as unknown as Planner;

  const executioner = {} as Executioner;

  const orchestrator = new Orchestrator({
    configManager,
    coreRunner,
    sessionManager,
    logger,
    planner,
    executioner,
    rootDir: '/fake/root',
    dataDir: '/fake/root/galloper-data',
  });

  return {
    orchestrator,
    logs,
    sessions,
    get runCalls() {
      return runCalls;
    },
    get lastRunOptions() {
      return lastRunOptions;
    },
  };
}

describe('Orchestrator.execute (unit)', () => {
  let harness: ReturnType<typeof makeHarness>;

  beforeEach(() => {
    harness = makeHarness();
  });

  it('single-prompt without --prompt throws a clear error', async () => {
    await expect(
      harness.orchestrator.execute({ subcommand: 'single-prompt', env: process.env }),
    ).rejects.toThrow(/single-prompt subcommand requires/);
  });

  it('plan without --prompt throws a clear error', async () => {
    await expect(
      harness.orchestrator.execute({ subcommand: 'plan', env: process.env }),
    ).rejects.toThrow(/plan subcommand requires/);
  });

  it('implement without --plan-file throws a clear error', async () => {
    await expect(
      harness.orchestrator.execute({ subcommand: 'implement', env: process.env }),
    ).rejects.toThrow(/implement subcommand requires --plan-file/);
  });

  it('pipeline without --prompt throws a clear error', async () => {
    await expect(
      harness.orchestrator.execute({ subcommand: 'pipeline', env: process.env }),
    ).rejects.toThrow(/pipeline subcommand requires/);
  });

  it('single-prompt happy path: calls coreRunner.run with resolved command and prompt', async () => {
    await harness.orchestrator.execute({
      subcommand: 'single-prompt',
      prompt: 'what is 2+2?',
      env: process.env,
    });

    expect(harness.runCalls).toBe(1);
    expect(harness.lastRunOptions).toMatchObject({
      llmCommand: 'echo resolved',
      prompt: 'what is 2+2?',
      sessionId: 'sess-test',
      cwd: '/fake/root',
    });
  });

  it('single-prompt persists a SessionRecord with parsed final output', async () => {
    await harness.orchestrator.execute({
      subcommand: 'single-prompt',
      prompt: 'hi',
      env: process.env,
    });

    const record = harness.sessions['sess-test'];
    expect(record).toBeDefined();
    expect(record.id).toBe('sess-test');
    expect(record.prompt).toBe('hi');
    expect(record.exitCode).toBe(0);
    expect(record.finalOutput).toBe('hello');
  });

  it('single-prompt emits run.started, run.command_resolved, and run.completed in order', async () => {
    await harness.orchestrator.execute({
      subcommand: 'single-prompt',
      prompt: 'hi',
      env: process.env,
    });

    const types = harness.logs.map((l) => l.type);
    const startedIdx = types.indexOf('run.started');
    const resolvedIdx = types.indexOf('run.command_resolved');
    const completedIdx = types.indexOf('run.completed');

    expect(startedIdx).toBeGreaterThanOrEqual(0);
    expect(resolvedIdx).toBeGreaterThan(startedIdx);
    expect(completedIdx).toBeGreaterThan(resolvedIdx);
  });

  it('single-prompt returns OrchestratorResult with sessionId, sessionFilePath, and exitCode', async () => {
    const result = await harness.orchestrator.execute({
      subcommand: 'single-prompt',
      prompt: 'hi',
      env: process.env,
    });

    expect(result.sessionId).toBe('sess-test');
    expect(result.sessionFilePath).toBe('/fake/sessions/sess-test.json');
    expect(result.exitCode).toBe(0);
    expect(result.finalOutput).toBe('hello');
  });

  it('single-prompt on subprocess failure logs run.failed and rethrows', async () => {
    const failing = new Orchestrator({
      configManager: {
        getHooks: () => ({}),
        getCommand: () => {
          throw new Error('config explosion');
        },
        resolveForSubcommand: () => 'mock-cli',
        validateSubcommand: () => {},
        getExecutionerEscalation: () => [],
      } as unknown as ConfigManager,
      coreRunner: harness.orchestrator['coreRunner'] as CoreRunner,
      sessionManager: harness.orchestrator['sessionManager'] as SessionManager,
      logger: harness.orchestrator['logger'] as Logger,
      planner: harness.orchestrator['planner'] as Planner,
      executioner: harness.orchestrator['executioner'] as Executioner,
      rootDir: '/fake/root',
      dataDir: '/fake/root/galloper-data',
    });

    await expect(
      failing.execute({ subcommand: 'single-prompt', prompt: 'hi', env: process.env }),
    ).rejects.toThrow(/config explosion/);

    const failed = harness.logs.find((l) => l.type === 'run.failed');
    expect(failed).toBeDefined();
  });

  it('merges command-level env into subprocess env', async () => {
    const customConfig = {
      getHooks: () => ({}),
      getCommand: () => ({
        command: 'echo resolved',
        allowedSubcommands: [],
        disallowedSubcommands: [],
        env: { INJECTED: 'yes' },
      }),
      resolveForSubcommand: () => 'mock-cli',
      validateSubcommand: () => {},
      getExecutionerEscalation: () => [],
    } as unknown as ConfigManager;

    let captured: Record<string, unknown> | null = null;
    const mockRunner = {
      run: async (opts: Record<string, unknown>) => {
        captured = opts;
        return {
          stdout: '',
          stderr: '',
          exitCode: 0,
          startedAt: 'a',
          endedAt: 'b',
          durationMs: 0,
          parsedStdoutEvents: [],
          parsedStderrEvents: [],
        };
      },
    } as unknown as CoreRunner;

    const o = new Orchestrator({
      configManager: customConfig,
      coreRunner: mockRunner,
      sessionManager: harness.orchestrator['sessionManager'] as SessionManager,
      logger: harness.orchestrator['logger'] as Logger,
      planner: harness.orchestrator['planner'] as Planner,
      executioner: harness.orchestrator['executioner'] as Executioner,
      rootDir: '/fake/root',
      dataDir: '/fake/root/galloper-data',
    });

    await o.execute({
      subcommand: 'single-prompt',
      prompt: 'hi',
      env: { OUTER: 'yes' },
    });

    expect((captured as any).env.OUTER).toBe('yes');
    expect((captured as any).env.INJECTED).toBe('yes');
  });
});

describe('Orchestrator adaptive', () => {
  it('adaptive without --prompt throws a clear error', async () => {
    const harness = makeHarness();
    await expect(
      harness.orchestrator.execute({ subcommand: 'adaptive', env: process.env }),
    ).rejects.toThrow(/adaptive subcommand requires/);
  });

  it('adaptive routes through AdaptiveDriver and returns OrchestratorResult', async () => {
    const harness = makeHarness();
    const mockResult = {
      runId: 'test-run-123',
      stateFilePath: '/fake/adaptive/test-run-123.json',
      tasksRun: 3,
      replansRun: 1,
      replansSkipped: 0,
      finalPlan: [{ id: 'task1' }, { id: 'task2' }, { id: 'task3' }],
    };

    const runSpy = vi.spyOn(AdaptiveDriver.prototype, 'run').mockResolvedValue(mockResult);

    const result = await harness.orchestrator.execute({
      subcommand: 'adaptive',
      prompt: 'build a feature',
      env: process.env,
      confidenceThreshold: 0.8,
      maxReplans: 10,
    });

    expect(runSpy).toHaveBeenCalledTimes(1);
    expect(result.exitCode).toBe(0);
    expect(result.sessionFilePath).toBe(mockResult.stateFilePath);
    expect(result.finalOutput).toBeDefined();
    expect(result.finalOutput).toContain('"runId": "test-run-123"');

    const parsedFinal = JSON.parse(result.finalOutput as string);
    expect(parsedFinal).toEqual(mockResult);

    runSpy.mockRestore();
  });

  it('adaptive logs run.started, run.completed events', async () => {
    const harness = makeHarness();
    const mockResult = {
      runId: 'test-run-456',
      stateFilePath: '/fake/adaptive/test-run-456.json',
      tasksRun: 1,
      replansRun: 0,
      replansSkipped: 0,
      finalPlan: [{ id: 'task1' }],
    };

    vi.spyOn(AdaptiveDriver.prototype, 'run').mockResolvedValue(mockResult);

    await harness.orchestrator.execute({
      subcommand: 'adaptive',
      prompt: 'test task',
      env: process.env,
    });

    const types = harness.logs.map((l) => l.type);
    expect(types).toContain('run.started');
    expect(types).toContain('run.completed');

    const started = harness.logs.find((l) => l.type === 'run.started');
    expect(started?.payload).toMatchObject({ subcommand: 'adaptive' });

    const completed = harness.logs.find((l) => l.type === 'run.completed');
    expect(completed?.payload).toMatchObject({
      runId: 'test-run-456',
      tasksRun: 1,
    });

    vi.restoreAllMocks();
  });

  it('adaptive on error logs run.failed and rethrows', async () => {
    const harness = makeHarness();
    const error = new Error('adaptive loop failed');
    vi.spyOn(AdaptiveDriver.prototype, 'run').mockRejectedValue(error);

    await expect(
      harness.orchestrator.execute({
        subcommand: 'adaptive',
        prompt: 'failing task',
        env: process.env,
      }),
    ).rejects.toThrow('adaptive loop failed');

    const failed = harness.logs.find((l) => l.type === 'run.failed');
    expect(failed).toBeDefined();
    expect(failed?.payload.error).toBe('adaptive loop failed');

    vi.restoreAllMocks();
  });
});
