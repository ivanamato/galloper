export interface ProgressInfo {
  current: number;
  total: number;
}

export interface HookFiredInfo {
  phase: string;
  kind: 'lifecycle' | 'event';
  command?: string;
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
  durationMs?: number;
  timedOut?: boolean;
  file?: { path: string; action: string };
  skipped?: { reason: string };
  instructionsOnly?: boolean;
}

export interface HumanReporter {
  info(message: string): void;
  step(context: string, message: string): void;
  planSummary(plan: unknown): void;
  taskStarted(title: string, progress?: ProgressInfo): void;
  taskCompleted(title: string, progress?: ProgressInfo): void;
  done(summary: string): void;
  hookFired(info: HookFiredInfo): void;
  /**
   * Narrate one parsed streaming event from an LLM subprocess (Claude Code
   * `-p` shape). Unknown shapes and non-JSON lines are ignored silently.
   */
  llmEvent(event: unknown): void;
  /**
   * Emit a one-line "still running" heartbeat with elapsed seconds. Callers
   * drive the cadence (typically an interval timer reset on each `llmEvent`).
   */
  idleTick(elapsedMs: number): void;
  /**
   * Echo the full prompt that will be written to the LLM subprocess stdin,
   * so callers tailing `-H` can see exactly what the model is being asked.
   * Lines are timestamped and indented under a header with the byte count.
   */
  promptSent(prompt: string): void;
}

export class ConsoleHumanReporter implements HumanReporter {
  private stream: NodeJS.WritableStream;
  private enabled: boolean;
  private now: () => Date;

  constructor({
    enabled = true,
    stream = process.stderr,
    now = () => new Date(),
  }: { enabled?: boolean; stream?: NodeJS.WritableStream; now?: () => Date } = {}) {
    this.enabled = enabled;
    this.stream = stream;
    this.now = now;
  }

  private writeLine(line: string): void {
    this.stream.write(`${this.now().toISOString()} ${line}\n`);
  }

  info(message: string): void {
    if (!this.enabled) return;
    this.writeLine(`› ${message}`);
  }

  step(context: string, message: string): void {
    if (!this.enabled) return;
    this.writeLine(`  [${context}] ${message}`);
  }

  planSummary(plan: unknown): void {
    if (!this.enabled) return;
    if (typeof plan !== 'object' || plan === null) {
      this.info('Plan parsed');
      return;
    }

    const planObj = plan as Record<string, unknown>;
    const tasks = Array.isArray(planObj.tasks) ? planObj.tasks : [];
    this.info(`Plan contains ${tasks.length} task(s):`);

    tasks.forEach((task, idx) => {
      const title = typeof task === 'object' && task !== null && 'title' in task ? (task as Record<string, unknown>).title : `Task ${idx + 1}`;
      this.writeLine(`  ${idx + 1}. ${title}`);
    });
  }

  taskStarted(title: string, progress?: ProgressInfo): void {
    if (!this.enabled) return;
    const prefix = progress ? `▶ Task [${progress.current}/${progress.total}]` : `▶ Task`;
    this.writeLine(`${prefix}: ${title}`);
  }

  taskCompleted(title: string, progress?: ProgressInfo): void {
    if (!this.enabled) return;
    const prefix = progress ? `✓ Task [${progress.current}/${progress.total}]` : `✓ Task`;
    this.writeLine(`${prefix}: ${title}`);
  }

  done(summary: string): void {
    if (!this.enabled) return;
    this.writeLine(`✓ ${summary}`);
  }

  hookFired(info: HookFiredInfo): void {
    if (!this.enabled) return;

    if (info.instructionsOnly) {
      this.writeLine(`⚑ hook [${info.phase}] instructions injected`);
      return;
    }

    const token = firstCommandToken(info.command);
    const tokenSuffix = token ? `: ${token}` : '';

    if (info.skipped) {
      this.writeLine(`⚑ hook [${info.phase}] skipped (${info.skipped.reason})${tokenSuffix}`);
      return;
    }

    this.writeLine(`⚑ hook [${info.phase}] fired${tokenSuffix}`);
  }

  llmEvent(event: unknown): void {
    if (!this.enabled) return;
    if (typeof event !== 'object' || event === null) return;
    const e = event as Record<string, unknown>;

    if (e.type === 'system' && e.subtype === 'init') {
      const model = typeof e.model === 'string' ? ` model=${e.model}` : '';
      this.writeLine(`  ⟳ llm session init${model}`);
      return;
    }

    if (e.type === 'assistant') {
      const msg = (e.message ?? {}) as Record<string, unknown>;
      const content = Array.isArray(msg.content) ? msg.content : [];
      for (const block of content) {
        if (typeof block !== 'object' || block === null) continue;
        const b = block as Record<string, unknown>;
        if (b.type === 'text' && typeof b.text === 'string') {
          const snippet = b.text.replace(/\s+/g, ' ').trim().slice(0, 120);
          if (snippet) this.writeLine(`  » ${snippet}`);
        } else if (b.type === 'tool_use' && typeof b.name === 'string') {
          this.writeLine(`  → ${formatToolUse(b.name, b.input)}`);
        }
      }
      return;
    }

    if (e.type === 'result') {
      const turns = typeof e.num_turns === 'number' ? ` turns=${e.num_turns}` : '';
      const cost = typeof e.total_cost_usd === 'number' ? ` cost=$${e.total_cost_usd.toFixed(4)}` : '';
      this.writeLine(`  ⟲ llm result${turns}${cost}`);
      return;
    }

    // Other shapes (user/tool_result, stream_event, unknown) are intentionally ignored.
  }

  idleTick(elapsedMs: number): void {
    if (!this.enabled) return;
    const secs = Math.round(elapsedMs / 1000);
    this.writeLine(`  … still running (elapsed ${secs}s)`);
  }

  promptSent(prompt: string): void {
    if (!this.enabled) return;
    const lines = prompt.split('\n');
    this.writeLine(`  ✎ prompt (${prompt.length} chars, ${lines.length} lines):`);
    for (const line of lines) {
      this.writeLine(`  │ ${line}`);
    }
  }
}

/**
 * Extract a short identifier from a hook's raw command string — typically the
 * executable name — so multiple hooks in the same phase can be told apart
 * without echoing the whole command. Returns `''` when no sensible token
 * exists (empty, undefined, or argv with leading flag only).
 *
 * Skips leading `NAME=value` shell env-var assignments so `API_KEY=x npm ...`
 * surfaces `npm`, not `API_KEY=x`.
 */
function firstCommandToken(cmd: string | undefined): string {
  if (!cmd) return '';
  const tokens = cmd.trim().split(/\s+/);
  for (const t of tokens) {
    if (/^[A-Z_][A-Z0-9_]*=/.test(t)) continue;
    return t;
  }
  return '';
}

function formatToolUse(name: string, input: unknown): string {
  const inp = (typeof input === 'object' && input !== null) ? (input as Record<string, unknown>) : {};
  const s = (v: unknown, max = 80): string => {
    if (typeof v !== 'string') return '';
    const flat = v.replace(/\s+/g, ' ').trim();
    return flat.length > max ? flat.slice(0, max) + '…' : flat;
  };
  switch (name) {
    case 'Read':
    case 'Edit':
    case 'Write':
    case 'NotebookEdit':
      return `${name} ${s(inp.file_path, 120)}`;
    case 'Glob':
      return `Glob ${s(inp.pattern, 120)}`;
    case 'Grep': {
      const pat = s(inp.pattern, 60);
      const path = s(inp.path, 60);
      return path ? `Grep "${pat}" in ${path}` : `Grep "${pat}"`;
    }
    case 'Bash':
      return `Bash: ${s(inp.command, 100)}`;
    case 'TodoWrite':
      return 'TodoWrite';
    case 'WebFetch':
      return `WebFetch ${s(inp.url, 120)}`;
    case 'WebSearch':
      return `WebSearch ${s(inp.query, 100)}`;
    case 'Task':
      return `Task: ${s(inp.description, 80)}`;
    default:
      return name;
  }
}

export class NullHumanReporter implements HumanReporter {
  info(): void {}
  step(): void {}
  planSummary(): void {}
  taskStarted(): void {}
  taskCompleted(): void {}
  done(): void {}
  hookFired(): void {}
  llmEvent(): void {}
  idleTick(): void {}
  promptSent(): void {}
}
