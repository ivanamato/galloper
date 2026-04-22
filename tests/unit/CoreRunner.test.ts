import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CoreRunner, RunResult } from '../../src/lib/CoreRunner.js';
import { Logger } from '../../src/lib/Logger.js';
import { createTempWorkspace, cleanup } from '../helpers/tempDir.js';
import { readJsonlEvents } from '../helpers/readJsonl.js';
import { join } from 'node:path';

describe('CoreRunner', () => {
  let tempDir: string;
  let logger: Logger;
  let coreRunner: CoreRunner;

  beforeEach(async () => {
    tempDir = createTempWorkspace();
    const logsDir = join(tempDir, 'logs');
    const logPath = join(logsDir, 'runs.jsonl');
    logger = new Logger({ logsDir, centralLogPath: logPath });
    await logger.ensureDir();
    coreRunner = new CoreRunner();
  });

  afterEach(() => {
    cleanup(tempDir);
  });

  it('should execute simple echo command and capture stdout', async () => {
    const result = await coreRunner.run({
      llmCommand: 'echo hello',
      prompt: '',
      sessionId: 'test-1',
      cwd: tempDir,
      env: process.env,
      logger,
    });

    expect(result.stdout).toContain('hello');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBeTruthy();
  });

  it('should deliver prompt text to subprocess stdin', async () => {
    const testPrompt = 'this is my prompt';
    const result = await coreRunner.run({
      llmCommand: 'cat',
      prompt: testPrompt,
      sessionId: 'test-2',
      cwd: tempDir,
      env: process.env,
      logger,
    });

    expect(result.stdout).toContain(testPrompt);
  });

  it('should capture stderr separately from stdout', async () => {
    const result = await coreRunner.run({
      llmCommand: "sh -c 'echo stderr message >&2'",
      prompt: '',
      sessionId: 'test-3',
      cwd: tempDir,
      env: process.env,
      logger,
    });

    expect(result.stderr).toContain('stderr message');
    expect(result.exitCode).toBe(0);
  });

  it('should capture non-zero exit codes', async () => {
    const result = await coreRunner.run({
      llmCommand: 'sh -c "exit 42"',
      prompt: '',
      sessionId: 'test-4',
      cwd: tempDir,
      env: process.env,
      logger,
    });

    expect(result.exitCode).toBe(42);
  });

  it('should parse JSON lines from stdout', async () => {
    const result = await coreRunner.run({
      llmCommand: 'bash tests/fixtures/mock-commands/echo-json.sh',
      prompt: '',
      sessionId: 'test-5',
      cwd: process.cwd(),
      env: process.env,
      logger,
    });

    expect(result.parsedStdoutEvents.length).toBeGreaterThan(0);
    expect(result.parsedStdoutEvents[0]).toHaveProperty('type');
  });

  it('should skip malformed JSON lines during parsing', async () => {
    const result = await coreRunner.run({
      llmCommand: 'bash tests/fixtures/mock-commands/malformed-json.sh',
      prompt: '',
      sessionId: 'test-6',
      cwd: process.cwd(),
      env: process.env,
      logger,
    });

    // Should have parsed only valid JSON lines
    expect(result.parsedStdoutEvents.length).toBe(3);
    expect(result.stdout).toContain('This is not JSON');
    expect(result.stdout).toContain('garbage line');
  });

  it('should log process.spawn event', async () => {
    await coreRunner.run({
      llmCommand: 'echo test',
      prompt: '',
      sessionId: 'test-7',
      cwd: tempDir,
      env: process.env,
      logger,
    });

    const logPath = join(tempDir, 'logs', 'runs.jsonl');
    const events = readJsonlEvents(logPath);
    const spawnEvent = events.find((e) => e.type === 'process.spawn');

    expect(spawnEvent).toBeDefined();
    expect(spawnEvent?.command).toContain('echo');
  });

  it('should log process.stdout events', async () => {
    await coreRunner.run({
      llmCommand: 'echo "output line"',
      prompt: '',
      sessionId: 'test-8',
      cwd: tempDir,
      env: process.env,
      logger,
    });

    // Wait for async logger.append() calls to complete
    await new Promise((resolve) => setTimeout(resolve, 50));

    const logPath = join(tempDir, 'logs', 'runs.jsonl');
    const events = readJsonlEvents(logPath);
    const stdoutEvents = events.filter((e) => e.type === 'process.stdout');

    expect(stdoutEvents.length).toBeGreaterThan(0);
    expect(stdoutEvents[0]).toHaveProperty('chunk');
  });

  it('should log process.stderr events', async () => {
    await coreRunner.run({
      llmCommand: "sh -c 'echo error >&2'",
      prompt: '',
      sessionId: 'test-9',
      cwd: tempDir,
      env: process.env,
      logger,
    });

    // Wait for async logger.append() calls to complete
    await new Promise((resolve) => setTimeout(resolve, 50));

    const logPath = join(tempDir, 'logs', 'runs.jsonl');
    const events = readJsonlEvents(logPath);
    const stderrEvents = events.filter((e) => e.type === 'process.stderr');

    expect(stderrEvents.length).toBeGreaterThan(0);
  });

  it('should set timestamps on start and end', async () => {
    const result = await coreRunner.run({
      llmCommand: 'echo test',
      prompt: '',
      sessionId: 'test-10',
      cwd: tempDir,
      env: process.env,
      logger,
    });

    expect(result.startedAt).toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(result.endedAt).toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('should handle multiline stdout', async () => {
    const result = await coreRunner.run({
      llmCommand: "sh -c 'echo line1; echo line2; echo line3'",
      prompt: '',
      sessionId: 'test-11',
      cwd: tempDir,
      env: process.env,
      logger,
    });

    expect(result.stdout).toContain('line1');
    expect(result.stdout).toContain('line2');
    expect(result.stdout).toContain('line3');
  });

  it('should not crash with unhandled EPIPE when subprocess closes stdin before prompt is fully written', async () => {
    // Simulates a subprocess (e.g. claude CLI rejecting args) that closes
    // stdin and exits immediately, causing EPIPE on our write.
    // Must use a prompt larger than the pipe buffer (~64KB on macOS/Linux)
    // so the write can't complete in a single flush.
    const largePrompt = 'x'.repeat(2 * 1024 * 1024); // 2 MB

    const result = await coreRunner.run({
      // Close stdin from the subprocess side, then exit non-zero.
      // `exec` in the sh replaces with /bin/true which ignores stdin.
      llmCommand: "sh -c 'exec 0<&-; exit 7'",
      prompt: largePrompt,
      sessionId: 'test-epipe',
      cwd: tempDir,
      env: process.env,
      logger,
    });

    // Must not crash with unhandled 'error'. 'close' handler should
    // resolve with the subprocess exit code.
    expect(result.exitCode).toBe(7);
  });

  it('should join multiple stdout chunks', async () => {
    const result = await coreRunner.run({
      llmCommand: 'bash tests/fixtures/mock-commands/echo-success.sh',
      prompt: 'test input',
      sessionId: 'test-12',
      cwd: process.cwd(),
      env: process.env,
      logger,
    });

    // Should have both the input and the success message
    expect(result.stdout).toContain('test input');
    expect(result.stdout).toContain('successfully');
  });

  describe('parseJsonLines', () => {
    it('should parse single JSON line', () => {
      const events = CoreRunner.parseJsonLines('{"type":"test"}');
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({ type: 'test' });
    });

    it('should parse multiple JSON lines', () => {
      const content = '{"a":1}\n{"b":2}\n{"c":3}';
      const events = CoreRunner.parseJsonLines(content);
      expect(events).toHaveLength(3);
    });

    it('should skip empty lines', () => {
      const content = '{"a":1}\n\n{"b":2}\n\n';
      const events = CoreRunner.parseJsonLines(content);
      expect(events).toHaveLength(2);
    });

    it('should skip malformed JSON', () => {
      const content = '{"valid":true}\nNOT JSON\n{"also":"valid"}';
      const events = CoreRunner.parseJsonLines(content);
      expect(events).toHaveLength(2);
      expect(events[0]).toEqual({ valid: true });
      expect(events[1]).toEqual({ also: 'valid' });
    });

    it('should handle lines with whitespace', () => {
      const content = '  {"a":1}  \n  {"b":2}  ';
      const events = CoreRunner.parseJsonLines(content);
      expect(events).toHaveLength(2);
    });
  });

  describe('extractFinalOutput', () => {
    it('should extract from item.completed event with agent_message', () => {
      const stdout = JSON.stringify({
        type: 'item.completed',
        item: { type: 'agent_message', text: 'Final answer' },
      });
      const output = CoreRunner.extractFinalOutput(stdout);
      expect(output).toBe('Final answer');
    });

    it('should fallback to stdout if no item.completed found', () => {
      const stdout = 'Just plain text output';
      const output = CoreRunner.extractFinalOutput(stdout);
      expect(output).toBe('Just plain text output');
    });

    it('should ignore non-agent_message items and fallback to raw stdout', () => {
      const stdout =
        JSON.stringify({
          type: 'item.completed',
          item: { type: 'user_message', text: 'Should be ignored' },
        }) +
        '\n' +
        'Plain text output';
      const output = CoreRunner.extractFinalOutput(stdout);
      // Should fallback to raw stdout since no agent_message matches
      expect(output).toBeTruthy();
      expect(output).toContain('Plain text output');
    });

    it('should use last agent_message if multiple exist', () => {
      const stdout =
        JSON.stringify({
          type: 'item.completed',
          item: { type: 'agent_message', text: 'First' },
        }) +
        '\n' +
        JSON.stringify({
          type: 'item.completed',
          item: { type: 'agent_message', text: 'Last' },
        });
      const output = CoreRunner.extractFinalOutput(stdout);
      expect(output).toBe('Last');
    });
  });
});
