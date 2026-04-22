// HookDispatcher: lifecycle + event hooks for contract enforcement and side effects
import { spawn } from 'node:child_process';
import picomatch from 'picomatch';
import { HookFailure } from './TaskRunner.js';

export type LifecyclePhase =
  | 'pre-plan' | 'post-plan'
  | 'pre-task' | 'post-task'
  | 'pre-task-file' | 'post-task-file';

export type FileAction = 'create' | 'edit' | 'delete';

export interface EventHookConfig {
  command: string;
  timeoutMs?: number;
  cwd?: string;
}

export interface LifecycleHookConfig {
  match?: string;
  action?: FileAction;
  instructions?: string;
  command?: string;
  timeoutMs?: number;
  onFailure?: 'retry' | 'warn' | 'abort';
}

export interface HookContext {
  plan?: any;
  task?: any;
  file?: { path: string; action: FileAction };
  attempt?: number;
  sessionId: string;
  cwd: string;
  previousFailures?: HookFailure[];
}

export interface HooksConfig {
  events?: Record<string, EventHookConfig[]>;
  lifecycle?: Partial<Record<LifecyclePhase, LifecycleHookConfig[]>>;
}

export class HookDispatcher {
  private config: HooksConfig;
  private lifecycleHooks: Map<LifecyclePhase, LifecycleHookConfig[]>;
  private eventHooks: Map<string, EventHookConfig[]>;

  constructor(hooksConfig?: HooksConfig) {
    this.config = hooksConfig ?? {};
    this.lifecycleHooks = new Map();
    this.eventHooks = new Map();

    // Load lifecycle hooks
    if (this.config.lifecycle) {
      for (const [phase, hooks] of Object.entries(this.config.lifecycle)) {
        if (hooks && Array.isArray(hooks)) {
          this.lifecycleHooks.set(phase as LifecyclePhase, hooks);
        }
      }
    }

    // Load event hooks
    if (this.config.events) {
      for (const [eventType, hooks] of Object.entries(this.config.events)) {
        if (hooks && Array.isArray(hooks)) {
          this.eventHooks.set(eventType, hooks);
        }
      }
    }
  }

  async runPre(phase: 'pre-plan' | 'pre-task' | 'pre-task-file', ctx: HookContext): Promise<string> {
    const hooks = this.lifecycleHooks.get(phase) ?? [];
    const outputs: string[] = [];

    for (let i = 0; i < hooks.length; i++) {
      const hook = hooks[i];
      if (!hook) continue;

      // Skip if file-scoped and glob doesn't match
      if (phase === 'pre-task-file' && ctx.file) {
        if (hook.match) {
          const isMatch = this.matchGlob(ctx.file.path, hook.match);
          if (!isMatch) continue;
        }
        if (hook.action && ctx.file.action !== hook.action) continue;
      }

      // Static instructions
      if (hook.instructions) {
        const wrapped = `<pre-hook output phase="${phase}" ${ctx.file ? `path="${ctx.file.path}"` : ''}>
${hook.instructions}
</pre-hook output>`;
        outputs.push(wrapped);
      }

      // Dynamic command
      if (hook.command) {
        try {
          const result = await this.execCommand(hook.command, ctx, hook.timeoutMs ?? 30000);
          if (result.stdout.trim()) {
            const wrapped = `<pre-hook output phase="${phase}" ${ctx.file ? `path="${ctx.file.path}"` : ''}>
${result.stdout}
</pre-hook output>`;
            outputs.push(wrapped);
          }
        } catch (err) {
          // Log but don't fail pre-hooks
          console.warn(`Pre-hook command failed: ${hook.command}`, err);
        }
      }
    }

    return outputs.join('\n\n');
  }

  async runPost(phase: 'post-plan' | 'post-task' | 'post-task-file', ctx: HookContext): Promise<HookFailure[]> {
    const hooks = this.lifecycleHooks.get(phase) ?? [];
    const failures: HookFailure[] = [];

    for (let i = 0; i < hooks.length; i++) {
      const hook = hooks[i];
      if (!hook) continue;

      // Skip if file-scoped and glob doesn't match
      if (phase === 'post-task-file' && ctx.file) {
        if (hook.match) {
          const isMatch = this.matchGlob(ctx.file.path, hook.match);
          if (!isMatch) continue;
        }
        if (hook.action && ctx.file.action !== hook.action) continue;
      }

      if (!hook.command) continue;

      try {
        const startMs = Date.now();
        const { exitCode, stdout, stderr, timedOut } = await this.execCommand(
          hook.command,
          ctx,
          hook.timeoutMs ?? 120000
        );
        const durationMs = Date.now() - startMs;

        if (exitCode !== 0) {
          failures.push({
            hookId: `${phase}[${i}]`,
            phase,
            file: ctx.file,
            command: hook.command,
            exitCode,
            stdout: typeof stdout === 'string' ? stdout : '',
            stderr: typeof stderr === 'string' ? stderr : '',
            timedOut,
            durationMs,
            onFailure: hook.onFailure ?? 'retry',
            category: 'hook',
          });

          if (hook.onFailure === 'abort') {
            throw new Error(`Post-hook aborted: ${hook.command}`);
          }
        }
      } catch (err) {
        if ((err instanceof Error && err.message.includes('aborted')) || (err instanceof Error && err.message.includes('Abort'))) {
          throw err;
        }
        // Log but continue
        console.warn(`Post-hook error: ${hook.command}`, err);
      }
    }

    return failures;
  }

  dispatchEvent(eventType: string, payload: Record<string, unknown>, ctx: { sessionId: string; cwd: string }): void {
    const hooks = this.eventHooks.get(eventType) ?? [];
    if (hooks.length === 0) return;

    // Fire and forget (non-blocking)
    setImmediate(() => {
      for (const hook of hooks) {
        if (!hook) continue;
        this.execCommand(hook.command, { ...ctx, plan: payload }, hook.timeoutMs ?? 10000)
          .catch((err) => console.warn(`Event hook failed: ${eventType}`, err));
      }
    });
  }

  private matchGlob(filepath: string, pattern: string): boolean {
    try {
      const isMatch = picomatch.isMatch(filepath, pattern);
      return isMatch;
    } catch {
      return false;
    }
  }

  private execCommand(
    command: string,
    ctx: HookContext,
    timeoutMs: number
  ): Promise<{ exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }> {
    return new Promise((resolve) => {
      let timedOut = false;
      let stdout = '';
      let stderr = '';

      const { sessionId, cwd, ...ctxRest } = ctx;
      const payloadJson = JSON.stringify({
        phase: 'unknown',
        sessionId,
        cwd,
        ...ctxRest,
      });

      const proc = spawn('/bin/sh', ['-c', command], {
        cwd: ctx.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          DEVFLOW_SESSION_ID: ctx.sessionId,
          DEVFLOW_CWD: ctx.cwd,
          ...(ctx.file ? { DEVFLOW_FILE_PATH: ctx.file.path, DEVFLOW_FILE_ACTION: ctx.file.action } : {}),
        },
      });

      const timeoutHandle = setTimeout(() => {
        timedOut = true;
        proc.kill('SIGTERM');
      }, timeoutMs);

      proc.stdout?.on('data', (data) => {
        stdout += data.toString();
      });

      proc.stderr?.on('data', (data) => {
        stderr += data.toString();
      });

      // Swallow EPIPE: hook command (e.g. `echo ...`) may ignore stdin and
      // exit before we finish writing the payload, especially for large plans.
      proc.stdin?.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code !== 'EPIPE') {
          // Unknown stdin error — surface via stderr for observability
          stderr += `stdin error: ${err.message}\n`;
        }
      });

      try {
        proc.stdin?.write(payloadJson, (err) => {
          if (err && (err as NodeJS.ErrnoException).code !== 'EPIPE') {
            stderr += `stdin write error: ${err.message}\n`;
          }
          try {
            proc.stdin?.end();
          } catch {
            // already destroyed; 'close' handler will still resolve
          }
        });
      } catch {
        // synchronous write failure — let 'close' resolve with exit code
      }

      proc.on('close', (exitCode) => {
        clearTimeout(timeoutHandle);
        resolve({
          exitCode: timedOut ? null : (exitCode ?? 1),
          stdout,
          stderr,
          timedOut,
        });
      });

      proc.on('error', (err) => {
        clearTimeout(timeoutHandle);
        resolve({
          exitCode: null,
          stdout,
          stderr: `Process error: ${err.message}`,
          timedOut: false,
        });
      });
    });
  }
}
