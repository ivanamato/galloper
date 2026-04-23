import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { SessionManager, SessionRecord } from '../../src/lib/SessionManager.js';
import { createTempWorkspace, cleanup, waitForFile } from '../helpers/tempDir.js';
import { join } from 'node:path';

describe('SessionManager', () => {
  let tempDir: string;
  let sessionManager: SessionManager;
  let sessionsDir: string;

  beforeEach(() => {
    tempDir = createTempWorkspace();
    sessionsDir = join(tempDir, 'sessions');
    sessionManager = new SessionManager({ sessionsDir });
  });

  afterEach(() => {
    cleanup(tempDir);
  });

  it('should create sessions directory if missing', async () => {
    await sessionManager.ensureDir();
    // Should not throw
    const record: SessionRecord = {
      id: 'test-1',
      prompt: 'test prompt',
      command: 'echo test',
      cwd: '/test',
      startedAt: '2026-04-17T10:00:00Z',
      endedAt: '2026-04-17T10:00:01Z',
      durationMs: 1000,
      exitCode: 0,
      stdout: 'output',
      stderr: '',
      parsedStdoutEvents: [],
      parsedStderrEvents: [],
      finalOutput: 'result',
      taskManifests: {},
    };
    const path = await sessionManager.writeSession('test-1', record);
    expect(path).toBeTruthy();
  });

  it('should create unique session IDs based on timestamp', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-17T10:00:00.000Z'));
    const id1 = sessionManager.createSessionId();
    vi.setSystemTime(new Date('2026-04-17T10:00:00.010Z'));
    const id2 = sessionManager.createSessionId();
    vi.useRealTimers();

    expect(id1).not.toBe(id2);
    // Session IDs should match ISO format with dashes
    expect(id1).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z/);
    expect(id2).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z/);
  });

  it('should write session record with complete SessionRecord structure', async () => {
    await sessionManager.ensureDir();

    const record: SessionRecord = {
      id: 'test-session-1',
      prompt: 'test prompt',
      command: 'echo hello',
      cwd: '/home/test',
      startedAt: '2026-04-17T10:00:00Z',
      endedAt: '2026-04-17T10:00:01Z',
      durationMs: 1000,
      exitCode: 0,
      stdout: 'hello\n',
      stderr: '',
      parsedStdoutEvents: [{ type: 'event', data: 'test' }],
      parsedStderrEvents: [],
      finalOutput: 'hello',
      taskManifests: {},
    };

    const filePath = await sessionManager.writeSession('test-session-1', record);

    expect(filePath).toContain('test-session-1.json');
    const content = readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(content) as SessionRecord;

    expect(parsed.id).toBe('test-session-1');
    expect(parsed.prompt).toBe('test prompt');
    expect(parsed.command).toBe('echo hello');
    expect(parsed.cwd).toBe('/home/test');
    expect(parsed.startedAt).toBe('2026-04-17T10:00:00Z');
    expect(parsed.endedAt).toBe('2026-04-17T10:00:01Z');
    expect(parsed.durationMs).toBe(1000);
    expect(parsed.exitCode).toBe(0);
    expect(parsed.stdout).toBe('hello\n');
    expect(parsed.stderr).toBe('');
    expect(parsed.parsedStdoutEvents).toEqual([{ type: 'event', data: 'test' }]);
    expect(parsed.parsedStderrEvents).toEqual([]);
    expect(parsed.finalOutput).toBe('hello');
  });

  it('should preserve null exitCode (not serialize as 0)', async () => {
    await sessionManager.ensureDir();

    const record: SessionRecord = {
      id: 'test-null-exit',
      prompt: 'test',
      command: 'cmd',
      cwd: '/test',
      startedAt: '2026-04-17T10:00:00Z',
      endedAt: '2026-04-17T10:00:01Z',
      durationMs: 1000,
      exitCode: null,
      stdout: '',
      stderr: '',
      parsedStdoutEvents: [],
      parsedStderrEvents: [],
      finalOutput: null,
      taskManifests: {},
    };

    const filePath = await sessionManager.writeSession('test-null-exit', record);
    const content = readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(content);

    expect(parsed.exitCode).toBeNull();
    expect(parsed.finalOutput).toBeNull();
  });

  it('should get correct session file path', () => {
    const sessionId = 'test-session-123';
    const filePath = sessionManager.getSessionPath(sessionId);

    expect(filePath).toContain('test-session-123.json');
    expect(filePath).toContain(sessionsDir);
  });

  it('should handle session records with empty arrays', async () => {
    await sessionManager.ensureDir();

    const record: SessionRecord = {
      id: 'test-empty-arrays',
      prompt: '',
      command: '',
      cwd: '',
      startedAt: '2026-04-17T10:00:00Z',
      endedAt: '2026-04-17T10:00:01Z',
      durationMs: 0,
      exitCode: 0,
      stdout: '',
      stderr: '',
      parsedStdoutEvents: [],
      parsedStderrEvents: [],
      finalOutput: null,
      taskManifests: {},
    };

    const filePath = await sessionManager.writeSession('test-empty-arrays', record);
    const content = readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(content) as SessionRecord;

    expect(parsed.parsedStdoutEvents).toEqual([]);
    expect(parsed.parsedStderrEvents).toEqual([]);
  });

  it('should format JSON with pretty-printing (indentation)', async () => {
    await sessionManager.ensureDir();

    const record: SessionRecord = {
      id: 'test-pretty',
      prompt: 'test',
      command: 'cmd',
      cwd: '/',
      startedAt: '2026-04-17T10:00:00Z',
      endedAt: '2026-04-17T10:00:01Z',
      durationMs: 1000,
      exitCode: 0,
      stdout: '',
      stderr: '',
      parsedStdoutEvents: [],
      parsedStderrEvents: [],
      finalOutput: 'result',
      taskManifests: {},
    };

    const filePath = await sessionManager.writeSession('test-pretty', record);
    const content = readFileSync(filePath, 'utf-8');

    // Should contain indentation (2 spaces)
    expect(content).toContain('  "id"');
    expect(content).toContain('  "prompt"');
  });

  it('should handle large stdout/stderr content', async () => {
    await sessionManager.ensureDir();

    const largeOutput = 'x'.repeat(10000);
    const record: SessionRecord = {
      id: 'test-large',
      prompt: 'test',
      command: 'cmd',
      cwd: '/',
      startedAt: '2026-04-17T10:00:00Z',
      endedAt: '2026-04-17T10:00:01Z',
      durationMs: 1000,
      exitCode: 0,
      stdout: largeOutput,
      stderr: largeOutput,
      parsedStdoutEvents: [],
      parsedStderrEvents: [],
      finalOutput: 'result',
      taskManifests: {},
    };

    const filePath = await sessionManager.writeSession('test-large', record);
    const content = readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(content) as SessionRecord;

    expect(parsed.stdout).toBe(largeOutput);
    expect(parsed.stderr).toBe(largeOutput);
  });
});
