// HookDispatcher: lifecycle + event hooks for contract enforcement and side effects
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import picomatch from 'picomatch';
import { HookFailure } from './TaskRunner.js';
import { substitute, isPathSafeForShell, type TemplateContext } from './HookTemplate.js';
import { PathLock } from './PathLock.js';
import { type HumanReporter, NullHumanReporter } from './HumanReporter.js';
import { type Logger } from './Logger.js';

/**
 * Thrown by `runPost` when a hook with `onFailure:'abort'` exits non-zero.
 * Carries the aborting hook's phase-local index so `TaskRunner` can look up
 * the full `LifecycleHookConfig` (and its `onAbort` policy) without parsing
 * the error message.
 */
export class AbortHookError extends Error {
  constructor(message: string, public readonly hookIndex: number) {
    super(message);
    this.name = 'AbortHookError';
  }
}

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
  /**
   * Acknowledgement that the command contains a pattern flagged by
   * `DestructivePatterns`. Without this flag, config-load fails when the
   * command matches any destructive regex. The flag does not change
   * behavior — it just proves the author read the command once.
   */
  destructive?: boolean;
  /**
   * `revert` → if this hook causes the task to abort (via `onFailure:'abort'`),
   * TaskRunner calls `revertToBaseline` to restore the working tree to the
   * state captured pre-task. `keep` (default) → abort preserves whatever
   * the aborted task already wrote. No-op when `onFailure !== 'abort'`.
   */
  onAbort?: 'revert' | 'keep';
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
  private humanReporter: HumanReporter;
  private inflightEventHooks: Set<Promise<void>> = new Set();
  private logger?: Logger;

  constructor(hooksConfig?: HooksConfig, humanReporter?: HumanReporter, logger?: Logger) {
    this.config = hooksConfig ?? {};
    this.lifecycleHooks = new Map();
    this.eventHooks = new Map();
    this.humanReporter = humanReporter ?? new NullHumanReporter();
    this.logger = logger;

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

      const hookInvocationId = randomUUID();

      // Skip if file-scoped and glob doesn't match
      if (phase === 'pre-task-file' && ctx.file) {
        if (hook.match) {
          const isMatch = this.matchGlob(ctx.file.path, hook.match);
          if (!isMatch) {
            await this.emitDecisionEvent(ctx, phase, i, 'skipped-glob', hookInvocationId);
            continue;
          }
        }
        if (hook.action && ctx.file.action !== hook.action) {
          await this.emitDecisionEvent(ctx, phase, i, 'skipped-action', hookInvocationId);
          continue;
        }
      }

      // Static instructions
      if (hook.instructions) {
        const wrapped = `<pre-hook output phase="${phase}" ${ctx.file ? `path="${ctx.file.path}"` : ''}>
${hook.instructions}
</pre-hook output>`;
        outputs.push(wrapped);
        this.humanReporter.hookFired({ phase, kind: 'lifecycle', instructionsOnly: true, file: ctx.file });
      }

      // Dynamic command
      if (hook.command) {
        try {
          const templateCtx = this.buildTemplateCtx(ctx);
          const resolved = this.resolveCommand(hook.command, hook.shell !== false, templateCtx);
          if ('skip' in resolved) {
            console.warn(`Pre-hook skipped for ${phase}[${i}]: ${resolved.reason} (path=${ctx.file?.path ?? ''})`);
            const cmdStr = typeof hook.command === 'string' ? hook.command : hook.command.join(' ');
            this.humanReporter.hookFired({ phase, kind: 'lifecycle', skipped: { reason: resolved.reason }, file: ctx.file, command: cmdStr });
            await this.emitDecisionEvent(ctx, phase, i, 'skipped-glob', hookInvocationId);
            continue;
          }
          const start = Date.now();
          const result = await this.execCommand(resolved.command, ctx, hook.timeoutMs ?? 30000, { shell: resolved.shell, hookInvocationId });
          const durationMs = Date.now() - start;
          const cmdStr = typeof hook.command === 'string' ? hook.command : hook.command.join(' ');
          this.humanReporter.hookFired({ phase, kind: 'lifecycle', command: cmdStr, exitCode: 0, stdout: result.stdout, stderr: '', durationMs, file: ctx.file });
          await this.emitDecisionEvent(ctx, phase, i, 'matched', hookInvocationId);
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
      } else {
        // No command, emit matched decision
        await this.emitDecisionEvent(ctx, phase, i, 'matched', hookInvocationId);
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

      const hookInvocationId = randomUUID();

      // Skip if file-scoped and glob doesn't match
      if (phase === 'post-task-file' && ctx.file) {
        // Surprise-classified paths only trigger hooks that opt in via
        // runOnSurprise. Default (undefined / false) keeps pre-§11 behavior
        // where hooks only run for declared paths.
        if (ctx.classification === 'surprise' && hook.runOnSurprise !== true) {
          await this.emitDecisionEvent(ctx, phase, i, 'skipped-surprise', hookInvocationId);
          continue;
        }
        if (hook.match) {
          const isMatch = this.matchGlob(ctx.file.path, hook.match);
          if (!isMatch) {
            await this.emitDecisionEvent(ctx, phase, i, 'skipped-glob', hookInvocationId);
            continue;
          }
        }
        if (hook.action && ctx.file.action !== hook.action) {
          await this.emitDecisionEvent(ctx, phase, i, 'skipped-action', hookInvocationId);
          continue;
        }
      }

      if (!hook.command) {
        // No command, emit matched decision
        await this.emitDecisionEvent(ctx, phase, i, 'matched', hookInvocationId);
        continue;
      }

      try {
        const templateCtx = this.buildTemplateCtx(ctx);
        const resolved = this.resolveCommand(hook.command, hook.shell !== false, templateCtx);
        if ('skip' in resolved) {
          const cmdStr = typeof hook.command === 'string' ? hook.command : hook.command.join(' ');
          this.humanReporter.hookFired({ phase, kind: 'lifecycle', skipped: { reason: resolved.reason }, file: ctx.file, command: cmdStr });
          await this.emitDecisionEvent(ctx, phase, i, 'skipped-glob', hookInvocationId);
          failures.push({
            hookId: `${phase}[${i}]`,
            phase,
            file: ctx.file,
            command: cmdStr,
            exitCode: null,
            stdout: '',
            stderr: `skipped: ${resolved.reason}`,
            timedOut: false,
            durationMs: 0,
            onFailure: hook.onFailure ?? 'warn',
            category: 'hook',
            hookInvocationId,
            invocationDurationMs: 0,
          });
          continue;
        }

        const { result, attempts, invocationDurationMs } = await this.runWithRetry(hook, ctx, resolved, hookInvocationId);
        const { exitCode, stdout, stderr, timedOut, durationMs } = result;
        const cmdStr = typeof hook.command === 'string' ? hook.command : hook.command.join(' ');
        this.humanReporter.hookFired({ phase, kind: 'lifecycle', command: cmdStr, exitCode, stdout, stderr, timedOut, durationMs, file: ctx.file });

        if (exitCode !== 0) {
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
            hookInvocationId,
            invocationDurationMs,
          });

          if (hook.onFailure === 'abort') {
            throw new AbortHookError(`Post-hook aborted: ${cmdStr}`, i);
          }
        } else {
          await this.emitDecisionEvent(ctx, phase, i, 'matched', hookInvocationId);
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
    // Hooks execute sequentially to preserve order.
    let resolveHookPromise: (() => void) | undefined;
    const hookPromise = new Promise<void>((resolve) => {
      resolveHookPromise = resolve;
    });

    this.inflightEventHooks.add(hookPromise);

    setImmediate(async () => {
      try {
        for (const hook of hooks) {
          if (!hook) continue;
          const start = Date.now();
          try {
            const result = await this.execCommand(hook.command, { ...ctx, plan: payload }, hook.timeoutMs ?? 10000, { shell: true });
            const durationMs = Date.now() - start;
            this.humanReporter.hookFired({
              phase: eventType,
              kind: 'event',
              command: hook.command,
              exitCode: result.exitCode,
              stdout: result.stdout,
              stderr: result.stderr,
              timedOut: result.timedOut,
              durationMs,
            });
          } catch (err) {
            console.warn(`Event hook failed: ${eventType}`, err);
          }
        }
      } finally {
        this.inflightEventHooks.delete(hookPromise);
        resolveHookPromise?.();
      }
    });
  }

  async drainEventHooks(): Promise<void> {
    while (this.inflightEventHooks.size > 0) {
      await Promise.all(Array.from(this.inflightEventHooks));
    }
  }

  /**
   * Runs a (pre-resolved) hook command with per-hook retry-with-backoff.
   * Retry triggers only when: the hook declares `retry`, the last attempt
   * exited non-zero, and `onFailure` is (explicitly or by default) `'retry'`.
   * Between attempts: `backoffMs * 2^(n-1) + rand(-1,1) * backoffMs * jitter`.
   * Returns the final attempt's result plus the count of attempts made and the
   * invocation duration of the first/successful attempt.
   */
  private async runWithRetry(
    hook: LifecycleHookConfig,
    ctx: HookContext,
    resolved: { command: string | string[]; shell: boolean },
    hookInvocationId: string,
  ): Promise<{ result: { exitCode: number | null; stdout: string; stderr: string; timedOut: boolean; durationMs: number }; attempts: number; invocationDurationMs: number }> {
    const maxAttempts = hook.retry?.maxAttempts ?? 1;
    const effectiveOnFailure = hook.onFailure ?? 'retry';
    let attempts = 0;
    let firstAttemptDurationMs = 0;
    let lastResult: { exitCode: number | null; stdout: string; stderr: string; timedOut: boolean; durationMs: number } = {
      exitCode: null, stdout: '', stderr: '', timedOut: false, durationMs: 0,
    };

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      attempts = attempt;
      const start = Date.now();
      const r = await this.execCommand(resolved.command, ctx, hook.timeoutMs ?? 120000, { shell: resolved.shell, hookInvocationId });
      const invocationDurationMs = Date.now() - start;
      if (attempt === 1) {
        firstAttemptDurationMs = invocationDurationMs;
      }
      lastResult = { ...r, durationMs: invocationDurationMs };
      if (lastResult.exitCode === 0) return { result: lastResult, attempts, invocationDurationMs: firstAttemptDurationMs };
      if (!hook.retry) break;
      if (effectiveOnFailure !== 'retry') break;
      if (attempt >= maxAttempts) break;
      const base = hook.retry.backoffMs * Math.pow(2, attempt - 1);
      const jitterMag = hook.retry.backoffMs * (hook.retry.jitter ?? 0);
      const delayMs = Math.max(0, base + (Math.random() * 2 - 1) * jitterMag);
      await new Promise((r) => setTimeout(r, delayMs));
    }

    return { result: lastResult, attempts, invocationDurationMs: firstAttemptDurationMs };
  }

  private matchGlob(filepath: string, pattern: string): boolean {
    try {
      const isMatch = picomatch.isMatch(filepath, pattern);
      return isMatch;
    } catch {
      return false;
    }
  }

  private async emitDecisionEvent(
    ctx: HookContext,
    phase: string,
    hookIndex: number,
    verdict: 'matched' | 'skipped-glob' | 'skipped-action' | 'skipped-surprise',
    hookInvocationId: string,
  ): Promise<void> {
    if (!this.logger || !ctx.file) return;
    await this.logger.append({
      sessionId: ctx.sessionId,
      timestamp: new Date().toISOString(),
      type: 'hook.decision',
      phase,
      hookIndex,
      file: ctx.file.path,
      action: ctx.file.action,
      verdict,
      hookInvocationId,
    });
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
    opts: { shell: boolean; hookInvocationId?: string } = { shell: true },
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
        ...(opts.hookInvocationId ? { DEVFLOW_HOOK_INVOCATION_ID: opts.hookInvocationId } : {}),
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
