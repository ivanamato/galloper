import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import { Logger } from './Logger.js';
import { SessionManager } from './SessionManager.js';

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  parsedStdoutEvents: unknown[];
  parsedStderrEvents: unknown[];
}

export interface RunOptions {
  llmCommand: string;
  prompt: string;
  sessionId: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  logger: Logger;
  /**
   * Invoked once per complete newline-delimited stdout line, as the subprocess
   * streams output. Exceptions thrown by the callback are swallowed so a bad
   * consumer cannot break the run. The trailing partial (no newline) is
   * flushed before `close` resolves.
   */
  onStdoutLine?: (line: string) => void;
}

export class CoreRunner {
  async run(options: RunOptions): Promise<RunResult> {
    const startedAtMs = Date.now();
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    const startedAt = new Date(startedAtMs).toISOString();
    const pendingLogs: Promise<void>[] = [];

    await options.logger.append({
      sessionId: options.sessionId,
      type: 'process.spawn',
      timestamp: startedAt,
      command: options.llmCommand,
      minLevel: 2,
      message: `[subprocess] Spawned: /bin/sh -c ${options.llmCommand.substring(0, 50)}...`,
    });

    let stdoutLineBuf = '';
    const emitLine = (line: string): void => {
      if (!options.onStdoutLine || line.length === 0) return;
      try {
        options.onStdoutLine(line);
      } catch {
        // swallow — a broken consumer must not break the run
      }
    };

    return new Promise((resolve, reject) => {
      const child = spawn('/bin/sh', ['-c', options.llmCommand], {
        cwd: options.cwd,
        env: options.env,
        stdio: 'pipe',
      }) as ChildProcessWithoutNullStreams;

      child.stdout.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        stdoutChunks.push(text);
        if (options.onStdoutLine) {
          stdoutLineBuf += text;
          let nlIdx: number;
          while ((nlIdx = stdoutLineBuf.indexOf('\n')) !== -1) {
            emitLine(stdoutLineBuf.slice(0, nlIdx));
            stdoutLineBuf = stdoutLineBuf.slice(nlIdx + 1);
          }
        }
        pendingLogs.push(options.logger.append({
          sessionId: options.sessionId,
          type: 'process.stdout',
          timestamp: new Date().toISOString(),
          chunk: text,
          minLevel: 3,
          message: `[subprocess] stdout: ${text.substring(0, 80).replace(/\n/g, '\\n')}${text.length > 80 ? '...' : ''}`,
        }).catch(() => {}));
      });

      child.stderr.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        stderrChunks.push(text);
        pendingLogs.push(options.logger.append({
          sessionId: options.sessionId,
          type: 'process.stderr',
          timestamp: new Date().toISOString(),
          chunk: text,
          minLevel: 3,
          message: `[subprocess] stderr: ${text.substring(0, 80).replace(/\n/g, '\\n')}${text.length > 80 ? '...' : ''}`,
        }).catch(() => {}));
      });

      child.on('error', (error: Error) => {
        reject(error);
      });

      child.on('close', (code: number | null) => {
        const endedAt = new Date().toISOString();
        if (stdoutLineBuf.length > 0) {
          emitLine(stdoutLineBuf);
          stdoutLineBuf = '';
        }
        Promise.all(pendingLogs).finally(() => {
          resolve({
            stdout: stdoutChunks.join(''),
            stderr: stderrChunks.join(''),
            exitCode: code ?? 1,
            startedAt,
            endedAt,
            durationMs: Date.now() - startedAtMs,
            parsedStdoutEvents: CoreRunner.parseJsonLines(stdoutChunks.join('')),
            parsedStderrEvents: CoreRunner.parseJsonLines(stderrChunks.join('')),
          });
        });
      });

      // Swallow EPIPE: subprocess may exit before we finish writing to stdin
      // (e.g. claude CLI rejecting args). The 'close' handler will surface
      // the real failure via exitCode + stderr.
      child.stdin.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code !== 'EPIPE') {
          reject(err);
        }
      });

      try {
        child.stdin.write(options.prompt, (err) => {
          if (err && (err as NodeJS.ErrnoException).code !== 'EPIPE') {
            reject(err);
            return;
          }
          try {
            child.stdin.end();
          } catch {
            // stdin already destroyed; 'close' handler will resolve with exitCode/stderr
          }
        });
      } catch {
        // Synchronous write failure (stdin destroyed); ignore and let 'close' surface it
      }
    });
  }

  static parseJsonLines(content: string): unknown[] {
    return content
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter((entry): entry is unknown => entry !== null);
  }

  static extractFinalOutput(stdout: string): string | null {
    const events = CoreRunner.parseJsonLines(stdout);
    const completedMessages = events
      .filter((event): event is Record<string, unknown> => {
        return typeof event === 'object' && event !== null && 'type' in event && event.type === 'item.completed';
      })
      .filter((event): boolean => {
        const item = event.item as Record<string, unknown> | undefined;
        return item !== null && typeof item === 'object' && 'type' in item && item.type === 'agent_message';
      })
      .map((event) => {
        const item = event.item as Record<string, unknown>;
        return item.text;
      })
      .filter((text): text is string => typeof text === 'string' && text.trim().length > 0);

    if (completedMessages.length > 0) {
      return completedMessages[completedMessages.length - 1] ?? null;
    }

    return stdout.trim();
  }
}
