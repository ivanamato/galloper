import type { HumanReporter } from './HumanReporter.js';

/**
 * Wires a `CoreRunner.run()` subprocess to a `HumanReporter`:
 * - every newline-delimited stdout line is JSON-parsed and routed to
 *   `reporter.llmEvent` (Claude Code `-p` streaming shape). Non-JSON lines
 *   are ignored.
 * - while the subprocess is running, an idle timer fires
 *   `reporter.idleTick(elapsedMs)` every `heartbeatMs` when no output has
 *   arrived. The timer resets on each line and is stopped by `close()`.
 *
 * Typical usage:
 *   const narrator = new LlmStreamNarrator(reporter);
 *   const result = await coreRunner.run({ ..., onStdoutLine: narrator.onLine });
 *   narrator.close();
 */
export class LlmStreamNarrator {
  private timer: NodeJS.Timeout | null = null;
  private startedAt: number = Date.now();
  private lastActivity: number = Date.now();
  private closed = false;

  constructor(
    private reporter: HumanReporter,
    private heartbeatMs: number = 15000,
  ) {
    this.startedAt = Date.now();
    this.lastActivity = this.startedAt;
    this.timer = setInterval(() => {
      if (this.closed) return;
      const idle = Date.now() - this.lastActivity;
      if (idle >= this.heartbeatMs) {
        this.reporter.idleTick(Date.now() - this.startedAt);
        this.lastActivity = Date.now();
      }
    }, Math.max(1000, Math.floor(this.heartbeatMs / 3)));
    // Don't keep the event loop alive on the heartbeat alone.
    this.timer.unref?.();
  }

  onLine = (line: string): void => {
    this.lastActivity = Date.now();
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    if (trimmed[0] !== '{' && trimmed[0] !== '[') return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return;
    }
    this.reporter.llmEvent(parsed);
  };

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
