import { promises as fs } from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { VerbosityLevel } from './Verbosity.js';

export interface LogEvent {
  sessionId: string;
  timestamp: string;
  type: 'run.started' | 'run.completed' | 'run.failed' | 'run.crashed' | 'process.spawn' | 'process.stdout' | 'process.stderr' | 'run.command_resolved' | 'task.completed' | 'task.failed' | 'hook.failed' | 'task.started' | 'task.attempt.started' | 'task.attempt.completed' | 'task.attempt.failed' | 'task.abandoned' | 'task.aborted' | 'plan.started' | 'plan.completed' | 'plan.aborted';
  minLevel?: VerbosityLevel;
  message?: string;
  [key: string]: unknown;
}

export class Logger {
  private logsDir: string;
  private centralLogPath: string;
  private verbosity: VerbosityLevel;
  private eventBus: EventEmitter;
  private inHookFailed = false;

  constructor({ logsDir, centralLogPath, verbosity = 0 as VerbosityLevel }: { logsDir: string; centralLogPath: string; verbosity?: VerbosityLevel }) {
    this.logsDir = logsDir;
    this.centralLogPath = centralLogPath;
    this.verbosity = verbosity;
    this.eventBus = new EventEmitter();
  }

  async ensureDir(): Promise<void> {
    await fs.mkdir(this.logsDir, { recursive: true });
  }

  async append(entry: Omit<LogEvent, 'timestamp'> & { timestamp?: string }): Promise<void> {
    const logDir = path.dirname(this.centralLogPath);
    await fs.mkdir(logDir, { recursive: true });
    const line = `${JSON.stringify(entry)}\n`;
    await fs.appendFile(this.centralLogPath, line, 'utf8');

    const minLevel = entry.minLevel as VerbosityLevel | undefined;
    if (minLevel !== undefined && minLevel <= this.verbosity && entry.message) {
      process.stderr.write(`${entry.message}\n`);
    }

    // Emit on bus unless this is a hook.failed event (guard against re-entry)
    if (entry.type !== 'hook.failed' && !this.inHookFailed) {
      this.eventBus.emit(entry.type as string, entry as LogEvent);
    }
  }

  on(eventType: string, handler: (event: LogEvent) => void): () => void {
    this.eventBus.on(eventType, handler);
    return () => {
      this.eventBus.off(eventType, handler);
    };
  }
}
