// HookDispatcher: lifecycle + event hooks for contract enforcement and side effects
import { spawn } from 'node:child_process';
import picomatch from 'picomatch';
import { HookFailure } from './TaskRunner.js';
import { substitute, isPathSafeForShell, type TemplateContext } from './HookTemplate.js';
import { PathLock } from './PathLock.js';

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
  /**
   * In shell mode (default, or `shell: true`) this must be a string passed
   * verbatim to `/bin/sh -c`. In argv mode (`shell: false`) this must be a
   * non-empty string[] spawned directly without a shell — argv[0] is the
   * executable and the rest are arguments.
   *
   * Supports `{file}`, `{path}`, `{action}`, `{classification}`,
   * `{sessionId}`, `{taskId}`, `{attempt}`, `{root}` placeholders. See
   * `HookTemplate.substitute`.
   */
  command?: string | string[];
  timeoutMs?: number;
  onFailure?: 'retry' | 'warn' | 'abort';
  /**
   * Post-task-file hooks only. When true, this hook fires on paths classified
   * as `surprise` (written but not declared in the task's files manifest).
   * Default (undefined / false): hook skips surprise paths.
   */
  runOnSurprise?: boolean;
  /**
   * `false` → argv mode: `command` is a string[] spawned directly, no shell.
   * Default (`true`) → shell mode: `command` is a string passed to `/bin/sh -c`.
   * Argv mode bypasses the path-safety check since argv strings are not
   * word-split by a shell.
   */
  shell?: boolean;
  /**
   * Per-hook retry policy. Activates when `onFailure` would otherwise be
   * `'retry'`. Each attempt re-substitutes templates with the updated
   * `{attempt}`; between attempts the dispatcher sleeps
   * `backoffMs * 2^(attemptIndex) ± backoffMs * jitter * rand(-1,1)`.
   * Absent/undefined → one attempt (current behavior).
   */
  retry?: {
    maxAttempts: number;
    backoffMs: number;
    jitter?: number;
  };
}

export interface HookContext {
  plan?: any;
  task?: any;
  file?: { path: string; action: FileAction };
  attempt?: number;
  sessionId: string;
  cwd: string;
  previousFailures?: HookFailure[];
  classification?: 'declared' | 'surprise' | 'churn';
}

export interface HooksConfig {
  events?: Record<string, EventHookConfig[]>;
  lifecycle?: Partial<Record<LifecyclePhase, LifecycleHookConfig[]>>;
}

export class HookDispatcher {
  private config: HooksConfig;
  private lifecycleHooks: Map<LifecyclePhase, LifecycleHookConfig[]>;
  private eventHooks: Map<string, EventHookConfig[]>;
  private pathLock: PathLock = new PathLock();

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
          const templateCtx = this.buildTemplateCtx(ctx);
          const resolved = this.resolveCommand(hook.command, hook.shell !== false, templateCtx);
          if ('skip' in resolved) {
            console.warn(`Pre-hook skipped for ${phase}[${i}]: ${resolved.reason} (path=${ctx.file?.path ?? ''})`);
            continue;
          }
          const result = await this.execCommand(resolved.command, ctx, hook.timeoutMs ?? 30000, { shell: resolved.shell });
          if (result.stdout.trim()) {
            const wrapped = `<pre-hook output phase="${phase}" ${ctx.file ? `path="${ctx.file.path}"` : ''}>
${result.stdout}
</pre-hook output>`;
            outputs.push(wrapped);
          }
        } catch (err) {
          // Log but don't fail pre-hooks
          console.warn(`Pre-hook command failed: ${JSON.stringify(hook.command)}`, err);
        }
      }
    }

    return outputs.join('\n\n');
  }

  async runPost(phase: 'post-plan' | 'post-task' | 'post-task-file', ctx: HookContext): Promise<HookFailure[]> {
    const hooks = this.lifecycleHooks.get(phase) ?? [];

    // For post-task-file, serialize all matching hooks for a given path.
    // Different paths run freely (parallelism lives in the caller's WorkerPool).
    if (phase === 'post-task-file' && ctx.file) {
      return this.pathLock.acquire(ctx.file.path, () => this.runPostBody(phase, ctx, hooks));
    }
    return this.runPostBody(phase, ctx, hooks);
  }

  private async runPostBody(
    phase: 'post-plan' | 'post-task' | 'post-task-file',
    ctx: HookContext,
    hooks: LifecycleHookConfig[],
  ): Promise<HookFailure[]> {
    const failures: HookFailure[] = [];

    for (let i = 0; i < hooks.length; i++) {
      const hook = hooks[i];
      if (!hook) continue;

      // Skip if file-scoped and glob doesn't match
      if (phase === 'post-task-file' && ctx.file) {
        // Surprise-classified paths only trigger hooks that opt in via
        // runOnSurprise. Default (undefined / false) keeps pre-§11 behavior
        // where hooks only run for declared paths.
        if (ctx.classification === 'surprise' && hook.runOnSurprise !== true) continue;
        if (hook.match) {
          const isMatch = this.matchGlob(ctx.file.path, hook.match);
          if (!isMatch) continue;
        }
        if (hook.action && ctx.file.action !== hook.action) continue;
      }

      if (!hook.command) continue;

      try {
        const templateCtx = this.buildTemplateCtx(ctx);
        const resolved = this.resolveCommand(hook.command, hook.shell !== false, templateCtx);
        if ('skip' in resolved) {
          failures.push({
            hookId: `${phase}[${i}]`,
            phase,
            file: ctx.file,
            command: typeof hook.command === 'string' ? hook.command : hook.command.join(' '),
            exitCode: null,
            stdout: '',
            stderr: `skipped: ${resolved.reason}`,
            timedOut: false,
            durationMs: 0,
            onFailure: hook.onFailure ?? 'warn',
            category: 'hook',
          });
          continue;
        }

        const { result, attempts } = await this.runWithRetry(hook, ctx, resolved);
        const { exitCode, stdout, stderr, timedOut, durationMs } = result;

        if (exitCode !== 0) {
          const cmdStr = typeof hook.command === 'string' ? hook.command : hook.command.join(' ');
          failures.push({
            hookId: `${phase}[${i}]`,
            phase,
            file: ctx.file,
            command: cmdStr,
            exitCode,
            stdout: typeof stdout === 'string' ? stdout : '',
            stderr: typeof stderr === 'string' ? stderr : '',
            timedOut,
            durationMs,
            onFailure: hook.onFailure ?? 'retry',
            category: 'hook',
            ...(hook.retry ? { hookRetryCount: attempts } : {}),
          });

          if (hook.onFailure === 'abort') {
            throw new Error(`Post-hook aborted: ${cmdStr}`);
          }
        }
      } catch (err) {
        if ((err instanceof Error && err.message.includes('aborted')) || (err instanceof Error && err.message.includes('Abort'))) {
          throw err;
        }
        // Log but continue
        console.warn(`Post-hook error: ${JSON.stringify(hook.command)}`, err);
      }
    }

    return failures;
  }

  dispatchEvent(eventType: string, payload: Record<string, unknown>, ctx: { sessionId: string; cwd: string }): void {
    const hooks = this.eventHooks.get(eventType) ?? [];
    if (hooks.length === 0) return;

    // Fire and forget (non-blocking). Event hooks stay string-only (no argv
    // mode, no template substitution) to keep the event payload's env-var
    // contract stable — event hook authors read payload via DEVFLOW_* env.
    setImmediate(() => {
      for (const hook of hooks) {
        if (!hook) continue;
        this.execCommand(hook.command, { ...ctx, plan: payload }, hook.timeoutMs ?? 10000, { shell: true })
          .catch((err) => console.warn(`Event hook failed: ${eventType}`, err));
      }
    });
  }

  /**
   * Runs a (pre-resolved) hook command with per-hook retry-with-backoff.
   * Retry triggers only when: the hook declares `retry`, the last attempt
   * exited non-zero, and `onFailure` is (explicitly or by default) `'retry'`.
   * Between attempts: `backoffMs * 2^(n-1) + rand(-1,1) * backoffMs * jitter`.
   * Returns the final attempt's result plus the count of attempts made.
   */
  private async runWithRetry(
    hook: LifecycleHookConfig,
    ctx: HookContext,
    resolved: { command: string | string[]; shell: boolean },
  ): Promise<{ result: { exitCode: number | null; stdout: string; stderr: string; timedOut: boolean; durationMs: number }; attempts: number }> {
    const maxAttempts = hook.retry?.maxAttempts ?? 1;
    const effectiveOnFailure = hook.onFailure ?? 'retry';
    let attempts = 0;
    let lastResult: { exitCode: number | null; stdout: string; stderr: string; timedOut: boolean; durationMs: number } = {
      exitCode: null, stdout: '', stderr: '', timedOut: false, durationMs: 0,
    };

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      attempts = attempt;
      const start = Date.now();
      const r = await this.execCommand(resolved.command, ctx, hook.timeoutMs ?? 120000, { shell: resolved.shell });
      lastResult = { ...r, durationMs: Date.now() - start };
      if (lastResult.exitCode === 0) return { result: lastResult, attempts };
      if (!hook.retry) break;
      if (effectiveOnFailure !== 'retry') break;
      if (attempt >= maxAttempts) break;
      const base = hook.retry.backoffMs * Math.pow(2, attempt - 1);
      const jitterMag = hook.retry.backoffMs * (hook.retry.jitter ?? 0);
      const delayMs = Math.max(0, base + (Math.random() * 2 - 1) * jitterMag);
      await new Promise((r) => setTimeout(r, delayMs));
    }

    return { result: lastResult, attempts };
  }

  private matchGlob(filepath: string, pattern: string): boolean {
    try {
      const isMatch = picomatch.isMatch(filepath, pattern);
      return isMatch;
    } catch {
      return false;
    }
  }

  private buildTemplateCtx(ctx: HookContext): TemplateContext {
    return {
      file: ctx.file?.path,
      action: ctx.file?.action,
      classification: ctx.classification,
      sessionId: ctx.sessionId,
      taskId: ctx.task?.id as string | undefined,
      attempt: ctx.attempt,
      root: ctx.cwd,
    };
  }

  /**
   * Returns the command ready for execCommand, or a `{ skip, reason }` sentinel
   * when path-safety validation rejects shell-mode interpolation.
   */
  private resolveCommand(
    rawCommand: string | string[],
    shell: boolean,
    templateCtx: TemplateContext,
  ): { command: string | string[]; shell: boolean } | { skip: true; reason: 'path-injection-risk' } {
    if (shell) {
      if (typeof rawCommand !== 'string') {
        // Should have been caught by validator; treat as skip defensively.
        return { skip: true, reason: 'path-injection-risk' };
      }
      const hasFileToken = /\{(file|path)\}/.test(rawCommand);
      if (hasFileToken && templateCtx.file && !isPathSafeForShell(templateCtx.file)) {
        return { skip: true, reason: 'path-injection-risk' };
      }
      return { command: substitute(rawCommand, templateCtx), shell: true };
    }
    const argv = Array.isArray(rawCommand) ? rawCommand : [rawCommand];
    return { command: argv.map((s) => substitute(s, templateCtx)), shell: false };
  }

  private execCommand(
    command: string | string[],
    ctx: HookContext,
    timeoutMs: number,
    opts: { shell: boolean } = { shell: true },
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

      const spawnEnv = {
        ...process.env,
        DEVFLOW_SESSION_ID: ctx.sessionId,
        DEVFLOW_CWD: ctx.cwd,
        ...(ctx.file ? { DEVFLOW_FILE_PATH: ctx.file.path, DEVFLOW_FILE_ACTION: ctx.file.action } : {}),
      };

      let proc;
      if (opts.shell) {
        const shellCmd = typeof command === 'string' ? command : command.join(' ');
        proc = spawn('/bin/sh', ['-c', shellCmd], {
          cwd: ctx.cwd,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: spawnEnv,
        });
      } else {
        const argv = Array.isArray(command) ? command : [command];
        const exe = argv[0];
        if (!exe) {
          resolve({ exitCode: null, stdout: '', stderr: 'empty argv', timedOut: false });
          return;
        }
        proc = spawn(exe, argv.slice(1), {
          cwd: ctx.cwd,
          stdio: ['pipe', 'pipe', 'pipe'],
          shell: false,
          env: spawnEnv,
        });
      }

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
