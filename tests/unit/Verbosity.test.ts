import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Logger, LogEvent } from '../../src/lib/Logger.js';
import { clampVerbosity, SILENT, BASIC, DETAIL, DEBUG } from '../../src/lib/Verbosity.js';
import { createTempWorkspace, cleanup } from '../helpers/tempDir.js';
import { readJsonlEvents } from '../helpers/readJsonl.js';
import { join } from 'node:path';

describe('Verbosity', () => {
  describe('clampVerbosity', () => {
    it('should clamp values > 3 to 3', () => {
      expect(clampVerbosity(5)).toBe(3);
      expect(clampVerbosity(100)).toBe(3);
    });

    it('should clamp negative values to 0', () => {
      expect(clampVerbosity(-1)).toBe(0);
      expect(clampVerbosity(-10)).toBe(0);
    });

    it('should pass through valid levels 0-3', () => {
      expect(clampVerbosity(0)).toBe(0);
      expect(clampVerbosity(1)).toBe(1);
      expect(clampVerbosity(2)).toBe(2);
      expect(clampVerbosity(3)).toBe(3);
    });
  });

  describe('Verbosity constants', () => {
    it('should export correct constant values', () => {
      expect(SILENT).toBe(0);
      expect(BASIC).toBe(1);
      expect(DETAIL).toBe(2);
      expect(DEBUG).toBe(3);
    });
  });

  describe('Logger with verbosity filtering', () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = createTempWorkspace();
    });

    afterEach(() => {
      cleanup(tempDir);
    });

    it('should not output to stderr with verbosity=0 (silent)', async () => {
      const logger = new Logger({
        logsDir: join(tempDir, 'logs'),
        centralLogPath: join(tempDir, 'logs', 'runs.jsonl'),
        verbosity: 0,
      });

      await logger.ensureDir();

      let stderrOutput = '';
      const originalWrite = process.stderr.write;
      process.stderr.write = (str: string) => {
        stderrOutput += str;
        return true;
      };

      try {
        await logger.append({
          sessionId: 'test-1',
          type: 'run.started',
          timestamp: '2026-04-17T10:00:00Z',
          minLevel: 1,
          message: 'Test message',
        });

        expect(stderrOutput).toBe('');
      } finally {
        process.stderr.write = originalWrite;
      }
    });

    it('should output to stderr when minLevel <= verbosity', async () => {
      const logger = new Logger({
        logsDir: join(tempDir, 'logs'),
        centralLogPath: join(tempDir, 'logs', 'runs.jsonl'),
        verbosity: 2,
      });

      await logger.ensureDir();

      let stderrOutput = '';
      const originalWrite = process.stderr.write;
      process.stderr.write = (str: string) => {
        stderrOutput += str;
        return true;
      };

      try {
        // minLevel 1 should output (1 <= 2)
        await logger.append({
          sessionId: 'test-1',
          type: 'run.started',
          timestamp: '2026-04-17T10:00:00Z',
          minLevel: 1,
          message: 'Message level 1',
        });

        expect(stderrOutput).toContain('Message level 1');
      } finally {
        process.stderr.write = originalWrite;
      }
    });

    it('should not output to stderr when minLevel > verbosity', async () => {
      const logger = new Logger({
        logsDir: join(tempDir, 'logs'),
        centralLogPath: join(tempDir, 'logs', 'runs.jsonl'),
        verbosity: 1,
      });

      await logger.ensureDir();

      let stderrOutput = '';
      const originalWrite = process.stderr.write;
      process.stderr.write = (str: string) => {
        stderrOutput += str;
        return true;
      };

      try {
        // minLevel 3 should not output (3 > 1)
        await logger.append({
          sessionId: 'test-1',
          type: 'process.stdout',
          timestamp: '2026-04-17T10:00:00Z',
          minLevel: 3,
          message: 'Debug message',
        });

        expect(stderrOutput).not.toContain('Debug message');
      } finally {
        process.stderr.write = originalWrite;
      }
    });

    it('should still append to JSONL even with verbosity=0', async () => {
      const logger = new Logger({
        logsDir: join(tempDir, 'logs'),
        centralLogPath: join(tempDir, 'logs', 'runs.jsonl'),
        verbosity: 0,
      });

      await logger.ensureDir();

      await logger.append({
        sessionId: 'test-1',
        type: 'run.started',
        timestamp: '2026-04-17T10:00:00Z',
        minLevel: 1,
        message: 'Test message',
      });

      const events = readJsonlEvents(join(tempDir, 'logs', 'runs.jsonl'));
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('run.started');
    });

    it('should output multiple levels correctly with verbosity=2', async () => {
      const logger = new Logger({
        logsDir: join(tempDir, 'logs'),
        centralLogPath: join(tempDir, 'logs', 'runs.jsonl'),
        verbosity: 2,
      });

      await logger.ensureDir();

      const outputs: string[] = [];
      const originalWrite = process.stderr.write;
      process.stderr.write = (str: string) => {
        outputs.push(str);
        return true;
      };

      try {
        // minLevel 1: should output
        await logger.append({
          sessionId: 'test-1',
          type: 'run.started',
          timestamp: '2026-04-17T10:00:00Z',
          minLevel: 1,
          message: 'Level 1 message',
        });

        // minLevel 2: should output
        await logger.append({
          sessionId: 'test-1',
          type: 'task.completed',
          timestamp: '2026-04-17T10:00:01Z',
          minLevel: 2,
          message: 'Level 2 message',
        });

        // minLevel 3: should not output
        await logger.append({
          sessionId: 'test-1',
          type: 'process.stdout',
          timestamp: '2026-04-17T10:00:02Z',
          minLevel: 3,
          message: 'Level 3 message',
        });

        const combined = outputs.join('');
        expect(combined).toContain('Level 1 message');
        expect(combined).toContain('Level 2 message');
        expect(combined).not.toContain('Level 3 message');
      } finally {
        process.stderr.write = originalWrite;
      }
    });

    it('should handle events without minLevel (backward compatibility)', async () => {
      const logger = new Logger({
        logsDir: join(tempDir, 'logs'),
        centralLogPath: join(tempDir, 'logs', 'runs.jsonl'),
        verbosity: 1,
      });

      await logger.ensureDir();

      let stderrOutput = '';
      const originalWrite = process.stderr.write;
      process.stderr.write = (str: string) => {
        stderrOutput += str;
        return true;
      };

      try {
        // Event without minLevel should not output
        await logger.append({
          sessionId: 'test-1',
          type: 'run.started',
          timestamp: '2026-04-17T10:00:00Z',
        });

        expect(stderrOutput).toBe('');
      } finally {
        process.stderr.write = originalWrite;
      }
    });

    it('should default verbosity to 0 when not specified', async () => {
      const logger = new Logger({
        logsDir: join(tempDir, 'logs'),
        centralLogPath: join(tempDir, 'logs', 'runs.jsonl'),
      });

      await logger.ensureDir();

      let stderrOutput = '';
      const originalWrite = process.stderr.write;
      process.stderr.write = (str: string) => {
        stderrOutput += str;
        return true;
      };

      try {
        await logger.append({
          sessionId: 'test-1',
          type: 'run.started',
          timestamp: '2026-04-17T10:00:00Z',
          minLevel: 1,
          message: 'Should not output',
        });

        expect(stderrOutput).toBe('');
      } finally {
        process.stderr.write = originalWrite;
      }
    });
  });
});
