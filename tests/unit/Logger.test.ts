import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { Logger, LogEvent } from '../../src/lib/Logger.js';
import { createTempWorkspace, cleanup } from '../helpers/tempDir.js';
import { readJsonlEvents } from '../helpers/readJsonl.js';
import { join } from 'node:path';

describe('Logger', () => {
  let tempDir: string;
  let logger: Logger;

  beforeEach(() => {
    tempDir = createTempWorkspace();
    const logsDir = join(tempDir, 'logs');
    const centralLogPath = join(logsDir, 'runs.jsonl');
    logger = new Logger({ logsDir, centralLogPath });
  });

  afterEach(() => {
    cleanup(tempDir);
  });

  it('should create logs directory if missing', async () => {
    await logger.ensureDir();
    const events = readJsonlEvents(join(tempDir, 'logs', 'runs.jsonl'));
    expect(events).toEqual([]);
  });

  it('should append one JSON line per call, newline-terminated', async () => {
    await logger.ensureDir();
    const logPath = join(tempDir, 'logs', 'runs.jsonl');

    await logger.append({
      sessionId: 'test-1',
      type: 'run.started',
      timestamp: '2026-04-17T10:00:00Z',
      prompt: 'test prompt',
    });

    const content = readFileSync(logPath, 'utf-8');
    const lines = content.split('\n');
    expect(lines[0]).toBeTruthy();
    expect(lines[0]).toContain('"type":"run.started"');
    expect(content.endsWith('\n')).toBe(true);
  });

  it('should produce valid JSONL with multiple appends', async () => {
    await logger.ensureDir();
    const logPath = join(tempDir, 'logs', 'runs.jsonl');

    await logger.append({
      sessionId: 'test-1',
      type: 'run.started',
      timestamp: '2026-04-17T10:00:00Z',
      prompt: 'test',
    });

    await logger.append({
      sessionId: 'test-1',
      type: 'process.spawn',
      timestamp: '2026-04-17T10:00:01Z',
      command: 'echo hello',
    });

    await logger.append({
      sessionId: 'test-1',
      type: 'run.completed',
      timestamp: '2026-04-17T10:00:02Z',
      exitCode: 0,
    });

    const events = readJsonlEvents(logPath);
    expect(events).toHaveLength(3);
    expect(events[0].type).toBe('run.started');
    expect(events[1].type).toBe('process.spawn');
    expect(events[2].type).toBe('run.completed');
  });

  it('should preserve LogEvent shape with required fields', async () => {
    await logger.ensureDir();
    const logPath = join(tempDir, 'logs', 'runs.jsonl');

    const event: LogEvent = {
      sessionId: 'test-1',
      timestamp: '2026-04-17T10:00:00Z',
      type: 'run.started',
      prompt: 'test prompt',
      cwd: '/test/path',
    };

    await logger.append(event);

    const events = readJsonlEvents(logPath) as LogEvent[];
    expect(events).toHaveLength(1);
    expect(events[0].type).toMatch(
      /^(run\.started|run\.completed|run\.failed|run\.crashed|process\.spawn|process\.stdout|process\.stderr|run\.command_resolved)$/
    );
    expect(events[0].sessionId).toBe('test-1');
    expect(events[0].timestamp).toBe('2026-04-17T10:00:00Z');
  });

  it('should support event subscriptions via on() method', async () => {
    await logger.ensureDir();
    const capturedEvents: LogEvent[] = [];

    logger.on('run.started', (event: LogEvent) => {
      capturedEvents.push(event);
    });

    await logger.append({
      sessionId: 'test-sub',
      type: 'run.started',
      timestamp: '2026-04-17T10:00:00Z',
      prompt: 'test',
    });

    expect(capturedEvents).toHaveLength(1);
    expect(capturedEvents[0].type).toBe('run.started');
  });

  it('should still write to disk when emitting on bus', async () => {
    await logger.ensureDir();
    const logPath = join(tempDir, 'logs', 'runs.jsonl');

    const handler = () => {};
    logger.on('run.started', handler);

    await logger.append({
      sessionId: 'test-disk',
      type: 'run.started',
      timestamp: '2026-04-17T10:00:00Z',
      prompt: 'test',
    });

    const events = readJsonlEvents(logPath);
    expect(events).toHaveLength(1);
  });

  it('should guard hook.failed events from triggering bus handlers', async () => {
    await logger.ensureDir();
    const capturedEvents: LogEvent[] = [];

    logger.on('hook.failed', (event: LogEvent) => {
      capturedEvents.push(event);
    });

    // Hook.failed should not trigger subscribers (direct write only)
    await logger.append({
      sessionId: 'test-hook',
      type: 'hook.failed' as any,
      timestamp: '2026-04-17T10:00:00Z',
      command: 'failing-cmd',
    });

    expect(capturedEvents).toHaveLength(0);
  });

  it('should return unsubscribe function from on()', async () => {
    await logger.ensureDir();
    const capturedEvents: LogEvent[] = [];

    const unsubscribe = logger.on('run.started', (event: LogEvent) => {
      capturedEvents.push(event);
    });

    await logger.append({
      sessionId: 'test-unsub-1',
      type: 'run.started',
      timestamp: '2026-04-17T10:00:00Z',
      prompt: 'test',
    });

    expect(capturedEvents).toHaveLength(1);

    unsubscribe();

    await logger.append({
      sessionId: 'test-unsub-2',
      type: 'run.started',
      timestamp: '2026-04-17T10:00:01Z',
      prompt: 'test',
    });

    expect(capturedEvents).toHaveLength(1); // Still 1, not 2
  });

  it('should handle all LogEvent types', async () => {
    await logger.ensureDir();
    const logPath = join(tempDir, 'logs', 'runs.jsonl');

    const types: LogEvent['type'][] = [
      'run.started',
      'run.command_resolved',
      'process.spawn',
      'process.stdout',
      'process.stderr',
      'run.completed',
      'run.failed',
      'run.crashed',
    ];

    for (const type of types) {
      await logger.append({
        sessionId: 'test-1',
        timestamp: '2026-04-17T10:00:00Z',
        type,
        data: `test-${type}`,
      });
    }

    const events = readJsonlEvents(logPath);
    expect(events).toHaveLength(types.length);
    expect(events.map((e) => e.type)).toEqual(types);
  });

  it('should append without timestamp override', async () => {
    await logger.ensureDir();
    const logPath = join(tempDir, 'logs', 'runs.jsonl');

    await logger.append({
      sessionId: 'test-1',
      type: 'run.started',
      prompt: 'test',
    });

    const events = readJsonlEvents(logPath);
    expect(events[0].sessionId).toBe('test-1');
    expect(events[0].type).toBe('run.started');
  });
});
