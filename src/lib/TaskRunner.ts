// TaskRunner module: orchestrates sequential task execution from a plan
// Loads plan JSON, executes tasks in order, runs verify commands, persists run manifest

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parsePlan, topoSort, readyTasks, descendantsOf, Plan, PlanTask, RetryPolicy } from './PlanSchema.js';
import { Executioner } from './Executioner.js';
import { CoreRunner } from './CoreRunner.js';
import { Logger } from './Logger.js';
import { HumanReporter, NullHumanReporter } from './HumanReporter.js';
import { HookDispatcher, type HooksConfig } from './HookDispatcher.js';
import { WorkerPool } from './WorkerPool.js';
import { WriteLock } from './WriteLock.js';
import type { CommandResolver } from './CommandResolver.js';

export interface TaskRunnerInput {
  planFilePath: string;
  runManifestPath: string;
  cwd: string;
  executioner: Executioner;
  coreRunner: CoreRunner;
  logger: Logger;
  humanReporter?: HumanReporter;
  commandResolver?: CommandResolver;
  defaultMaxAttempts?: number;
  hooksConfig?: HooksConfig;
  sessionId?: string;
  manifestWriteLock?: WriteLock;
  concurrency?: number;
}

export interface FileSpec {
  path: string;
  action: 'create' | 'edit' | 'delete';
}

export interface HookFailure {
  hookId: string;
  phase?: string;
  file?: FileSpec;
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
  onFailure?: 'retry' | 'warn' | 'abort';
  category: 'hook' | 'verify' | 'executor-crash';
}

export interface Attempt {
  attemptNumber: number;
  startedAt: string;
  endedAt: string | null;
  executionSessionId: string | null;
  command: string;
  verifyExitCode: number | null;
  hookFailures: HookFailure[];
  status: 'completed' | 'failed' | 'aborted';
}

export interface TaskState {
  id: string;
  title: string;
  status: 'pending' | 'running' | 'done' | 'abandoned' | 'aborted';
  attempts: Attempt[];
  startedAt: string | null;
  endedAt: string | null;
}

export interface RunManifest {
  runId: string;
  planId: string;
  createdAt: string;
  endedAt: string | null;
  status: 'running' | 'completed' | 'aborted' | 'partial';
  tasks: TaskState[];
}

export class TaskRunner {
  async run(input: TaskRunnerInput): Promise<RunManifest> {
    // Load plan file
    const planContent = await fs.readFile(input.planFilePath, 'utf8');
    const planFile = JSON.parse(planContent) as Record<string, unknown>;
    const planData = (planFile as Record<string, unknown>).content ?? JSON.stringify(planFile);
    const plan: Plan = parsePlan(typeof planData === 'string' ? planData : JSON.stringify(planData));

    // Apply concurrency from input if provided (overrides plan setting)
    if (input.concurrency !== undefined) {
      plan.concurrency = input.concurrency;
    }

    // Topo-sort tasks
    const sortedTasks = topoSort(plan.tasks);

    // Fire pre-plan hook (early hook that fires once per plan)
    // Note: we create hookDispatcher early so pre-plan can run before manifest initialization
    const hookDispatcher = new HookDispatcher(input.hooksConfig);
    try {
      const prePlanOutput = await hookDispatcher.runPre('pre-plan', {
        plan: { prompt: plan.prompt },
        sessionId: input.sessionId || '',
        cwd: input.cwd,
      });
      if (prePlanOutput.trim()) {
        await input.logger.append({
          sessionId: input.sessionId || '',
          type: 'task.started',
          timestamp: new Date().toISOString(),
          message: `[plan] Pre-plan hook executed`,
        });
      }
    } catch (error) {
      // Log but don't fail on pre-plan errors
      console.warn('Pre-plan hook error:', error);
    }

    // Try to load existing manifest for idempotency
    let existingManifest: RunManifest | null = null;
    try {
      const manifestContent = await fs.readFile(input.runManifestPath, 'utf8');
      existingManifest = JSON.parse(manifestContent) as RunManifest;
    } catch {
      // Manifest doesn't exist or can't be read, proceed with new run
    }

    // Initialize manifest
    const runId = this.generateRunId();
    const manifest: RunManifest = existingManifest ?? {
      runId,
      planId: plan.planId,
      createdAt: new Date().toISOString(),
      endedAt: null,
      status: 'running',
      tasks: sortedTasks.map((task) => ({
        id: task.id,
        title: task.title,
        status: 'pending' as const,
        attempts: [],
        startedAt: null,
        endedAt: null,
      })),
    };

    // Build set of completed task IDs for idempotency
    const completedTasks = new Set<string>(
      manifest.tasks.filter(t => t.status === 'done').map(t => t.id)
    );

    const humanReporter = input.humanReporter ?? new NullHumanReporter();
    const total = sortedTasks.length;
    const defaultMaxAttempts = input.defaultMaxAttempts ?? 3;
    // hookDispatcher already created above for pre-plan hook
    const manifestWriteLock = input.manifestWriteLock ?? new WriteLock();
    const sessionId = input.sessionId ?? runId;

    // Fire post-plan hook (after plan is fully prepared, before tasks execute)
    try {
      const postPlanFailures = await hookDispatcher.runPost('post-plan', {
        plan: { ...plan, planFilePath: input.planFilePath },
        sessionId,
        cwd: input.cwd,
      });
      if (postPlanFailures.length > 0) {
        await input.logger.append({
          sessionId,
          type: 'task.started',
          timestamp: new Date().toISOString(),
          message: `[plan] Post-plan hook failures detected (${postPlanFailures.length})`,
        });
      }
    } catch (error) {
      if (error instanceof Error && (error.message.includes('aborted') || error.message.includes('Abort'))) {
        throw error; // post-plan abort is fatal
      }
      console.warn('Post-plan hook error:', error);
    }

    // Execute tasks sequentially (respecting DAG via topoSort)
    for (let i = 0; i < sortedTasks.length; i += 1) {
      const task = sortedTasks[i];
      const taskState = manifest.tasks[i];
      if (!task || !taskState) continue;

      // Skip already-completed tasks (idempotency)
      if (completedTasks.has(task.id)) {
        continue;
      }

      humanReporter.taskStarted(task.title, { current: i + 1, total });
      taskState.status = 'running';
      taskState.startedAt = new Date().toISOString();

      try {
        // Fire pre-task hook
        const preTaskOutput = await hookDispatcher.runPre('pre-task', {
          plan,
          task,
          sessionId,
          cwd: input.cwd,
        });
        if (preTaskOutput.trim()) {
          await input.logger.append({
            sessionId,
            type: 'hook.pre-task',
            timestamp: new Date().toISOString(),
            taskId: task.id,
            output: preTaskOutput,
          });
        }
      } catch (error) {
        console.warn(`Pre-task hook failed for ${task.id}:`, error);
      }

      // Retry loop
      const maxAttempts = task.maxAttempts ?? plan.maxAttempts ?? defaultMaxAttempts;
      let previousFailures: HookFailure[] = [];

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const attemptRecord: Attempt = {
          attemptNumber: attempt,
          startedAt: new Date().toISOString(),
          endedAt: null,
          executionSessionId: null,
          command: '',
          verifyExitCode: null,
          hookFailures: [],
          status: 'failed',
        };

        try {
          // Resolve command per-attempt with escalation
          const commandName = input.commandResolver
            ? input.commandResolver.resolveEscalated('implement', attempt)
            : null;
          attemptRecord.command = commandName ?? 'claude --model claude-opus-4-7';

          // Log command resolution
          if (commandName) {
            await input.logger.append({
              sessionId,
              type: 'run.command_resolved',
              timestamp: new Date().toISOString(),
              taskId: task.id,
              attempt,
              commandName,
            });
          }

          // Fire pre-task-file hooks for each declared file
          const preFileOutput: string[] = [];
          for (const fileSpec of task.files) {
            try {
              const output = await hookDispatcher.runPre('pre-task-file', {
                plan,
                task,
                file: fileSpec,
                attempt,
                sessionId,
                cwd: input.cwd,
                previousFailures,
              });
              if (output.trim()) {
                preFileOutput.push(output);
              }
            } catch (error) {
              console.warn(`Pre-task-file hook failed for ${fileSpec.path}:`, error);
            }
          }

          // Build prompt with retry context
          const contextPrompt = this.buildTaskPrompt({
            plan,
            sortedTasks,
            currentIndex: i,
            taskStates: manifest.tasks,
            attempt,
            maxAttempts,
            previousFailures,
          });

          // Execute task
          await input.logger.append({
            sessionId: `task-${task.id}-attempt-${attempt}`,
            type: 'task.attempt.started',
            timestamp: new Date().toISOString(),
            taskId: task.id,
            attempt,
          });

          let executionResult;
          try {
            executionResult = await input.executioner.implement({
              prompt: contextPrompt,
              cwd: input.cwd,
              llmCommand: commandName ?? undefined,
            });
          } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            attemptRecord.hookFailures.push({
              hookId: 'executor-crash',
              command: attemptRecord.command,
              exitCode: null,
              stdout: '',
              stderr: errorMsg,
              timedOut: false,
              durationMs: Date.now() - new Date(attemptRecord.startedAt).getTime(),
              onFailure: 'retry',
              category: 'executor-crash',
            });
            attemptRecord.endedAt = new Date().toISOString();
            taskState.attempts.push(attemptRecord);
            previousFailures = attemptRecord.hookFailures;
            continue; // Skip verify and post-task-file hooks when executor crashed
          }

          attemptRecord.executionSessionId = executionResult.sessionId;

          // Run verify command
          const verifyResult = await input.coreRunner.run({
            llmCommand: task.verify,
            prompt: '',
            sessionId: `verify-${task.id}-${attempt}`,
            cwd: input.cwd,
            env: process.env,
            logger: input.logger,
          });

          attemptRecord.verifyExitCode = verifyResult.exitCode ?? 1;
          if (verifyResult.exitCode === 0) {
            attemptRecord.status = 'completed';
          } else {
            attemptRecord.hookFailures.push({
              hookId: 'verify',
              command: task.verify,
              exitCode: verifyResult.exitCode,
              stdout: verifyResult.stdout,
              stderr: verifyResult.stderr,
              timedOut: false,
              durationMs: verifyResult.durationMs,
              onFailure: 'retry',
              category: 'verify',
            });
          }

          // Fire post-task-file hooks for each declared file
          for (const fileSpec of task.files) {
            try {
              const postFileFailures = await hookDispatcher.runPost('post-task-file', {
                plan,
                task,
                file: fileSpec,
                attempt,
                sessionId,
                cwd: input.cwd,
                previousFailures: attemptRecord.hookFailures,
              });
              attemptRecord.hookFailures.push(...postFileFailures);
            } catch (error) {
              if (error instanceof Error && (error.message.includes('aborted') || error.message.includes('Abort'))) {
                throw error;
              }
              console.warn(`Post-task-file hook failed for ${fileSpec.path}:`, error);
            }
          }

          attemptRecord.endedAt = new Date().toISOString();
          taskState.attempts.push(attemptRecord);

          // Check if done or should retry
          const retryable = attemptRecord.hookFailures.filter(f => f.onFailure !== 'warn');

          if (retryable.length === 0) {
            taskState.status = 'done';
            await input.logger.append({
              sessionId: `task-${task.id}`,
              type: attemptRecord.hookFailures.length > 0 ? 'task.warned' : 'task.completed',
              timestamp: new Date().toISOString(),
              taskId: task.id,
              ...(attemptRecord.hookFailures.length > 0 && { failures: attemptRecord.hookFailures.filter(f => f.onFailure === 'warn') }),
            });
            humanReporter.taskCompleted(task.title, { current: i + 1, total });
            break; // Task completed (or completed with warnings), exit retry loop
          }

          // Check category-aware retry policy
          const retryPolicy = plan.retryPolicy;
          let shouldAbortByPolicy = false;

          if (retryPolicy) {
            for (const failure of retryable) {
              const categoryPolicy = retryPolicy[failure.category as keyof RetryPolicy];
              if (categoryPolicy === 'abort') {
                shouldAbortByPolicy = true;
                break;
              }
            }
          }

          if (shouldAbortByPolicy) {
            taskState.status = 'aborted';
            await input.logger.append({
              sessionId: `task-${task.id}`,
              type: 'task.aborted_by_policy',
              timestamp: new Date().toISOString(),
              taskId: task.id,
              failures: retryable,
              policy: retryPolicy,
            });

            // Check onTaskAbandoned policy
            const policy = plan.onTaskAbandoned ?? 'continue';
            if (policy === 'abort') {
              await manifestWriteLock.acquire(async () => {
                manifest.endedAt = new Date().toISOString();
                manifest.status = 'aborted';
                await fs.mkdir(path.dirname(input.runManifestPath), { recursive: true });
                await fs.writeFile(input.runManifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
              });
              throw new Error(`Task ${task.id} aborted by policy; plan onTaskAbandoned policy is abort`);
            } else if (policy === 'abort-branch') {
              // Mark descendants as aborted
              const descendants = descendantsOf(task.id, sortedTasks);
              for (const desc of descendants) {
                const descState = manifest.tasks.find(t => t.id === desc.id);
                if (descState && descState.status === 'pending') {
                  descState.status = 'aborted';
                }
              }
            }
            break; // Continue to next task
          }

          // Task failed, check if should retry
          await input.logger.append({
            sessionId: `task-${task.id}-attempt-${attempt}`,
            type: 'task.attempt.failed',
            timestamp: new Date().toISOString(),
            taskId: task.id,
            attempt,
            failures: retryable,
          });

          previousFailures = retryable;

          if (attempt === maxAttempts) {
            // Budget exhausted
            taskState.status = 'abandoned';
            await input.logger.append({
              sessionId: `task-${task.id}`,
              type: 'task.abandoned',
              timestamp: new Date().toISOString(),
              taskId: task.id,
              finalFailures: previousFailures,
            });

            // Check onTaskAbandoned policy
            const policy = plan.onTaskAbandoned ?? 'continue';
            if (policy === 'abort') {
              await manifestWriteLock.acquire(async () => {
                manifest.endedAt = new Date().toISOString();
                manifest.status = 'aborted';
                await fs.mkdir(path.dirname(input.runManifestPath), { recursive: true });
                await fs.writeFile(input.runManifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
              });
              throw new Error(`Task ${task.id} abandoned; plan onTaskAbandoned policy is abort`);
            } else if (policy === 'abort-branch') {
              // Mark descendants as aborted
              const descendants = descendantsOf(task.id, sortedTasks);
              for (const desc of descendants) {
                const descState = manifest.tasks.find(t => t.id === desc.id);
                if (descState && descState.status === 'pending') {
                  descState.status = 'aborted';
                }
              }
            }
            break; // Continue to next task
          }
        } catch (error) {
          if (attemptRecord.status !== 'completed' && attemptRecord.status !== 'failed') {
            attemptRecord.status = 'failed';
            attemptRecord.endedAt = new Date().toISOString();
            taskState.attempts.push(attemptRecord);
          }
          const errorMsg = error instanceof Error ? error.message : String(error);
          if (!errorMsg.includes('abandoned; plan')) {
            await input.logger.append({
              sessionId: `task-${task.id}-attempt-${attempt}`,
              type: 'task.attempt.failed',
              timestamp: new Date().toISOString(),
              taskId: task.id,
              attempt,
              error: errorMsg,
            });
          }
          if (errorMsg.includes('abandoned; plan')) {
            throw error;
          }
        }
      }

      // Fire post-task hook
      try {
        const postTaskFailures = await hookDispatcher.runPost('post-task', {
          plan,
          task,
          sessionId,
          cwd: input.cwd,
          previousFailures: taskState.attempts[taskState.attempts.length - 1]?.hookFailures,
        });
        if (postTaskFailures.length > 0) {
          // Log post-task hook failures but don't affect task status
          // (task status is already determined by attempt results)
          await input.logger.append({
            sessionId,
            type: 'hook.post-task.failed',
            timestamp: new Date().toISOString(),
            taskId: task.id,
            failures: postTaskFailures,
          });
        }
      } catch (error) {
        if (error instanceof Error && (error.message.includes('aborted') || error.message.includes('Abort'))) {
          // post-task abort should not override task status
          console.warn(`Post-task hook aborted for ${task.id}:`, error);
        } else {
          console.warn(`Post-task hook failed for ${task.id}:`, error);
        }
      }

      taskState.endedAt = new Date().toISOString();

      // Write manifest after each task (incremental persistence, with lock for concurrency safety)
      await manifestWriteLock.acquire(async () => {
        await fs.mkdir(path.dirname(input.runManifestPath), { recursive: true });
        await fs.writeFile(input.runManifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
      });

      // Mark task as processed in DAG tracker (for next iteration)
      // Include done, abandoned, and aborted states
      if (taskState.status === 'done' || taskState.status === 'abandoned' || taskState.status === 'aborted') {
        completedTasks.add(task.id);
      }
    }

    // Finalize manifest status
    manifest.endedAt = new Date().toISOString();
    manifest.status = manifest.tasks.some(t => t.status === 'abandoned' || t.status === 'aborted')
      ? manifest.tasks.some(t => t.status === 'aborted') ? 'aborted' : 'partial'
      : 'completed';

    return manifest;
  }

  private generateRunId(): string {
    return new Date().toISOString().replace(/[:.]/g, '-');
  }

  private buildTaskPrompt(args: {
    plan: Plan;
    sortedTasks: PlanTask[];
    currentIndex: number;
    taskStates: TaskState[];
    attempt?: number;
    maxAttempts?: number;
    previousFailures?: HookFailure[];
  }): string {
    const { plan, sortedTasks, currentIndex, taskStates, attempt, maxAttempts, previousFailures } = args;
    const current = sortedTasks[currentIndex];
    if (!current) return '';

    const statusById = new Map<string, TaskState>();
    for (const state of taskStates) statusById.set(state.id, state);

    const statusMarker = (taskId: string, isCurrent: boolean): string => {
      if (isCurrent) return '[>]';
      const s = statusById.get(taskId)?.status ?? 'pending';
      if (s === 'done') return '[x]';
      if (s === 'abandoned' || s === 'aborted') return '[!]';
      return '[ ]';
    };

    const planSummary = sortedTasks
      .map((t, idx) => {
        const marker = statusMarker(t.id, idx === currentIndex);
        const suffix = idx === currentIndex ? ' (CURRENT TASK)' : '';
        return `- ${marker} ${t.id} — ${t.title}${suffix}`;
      })
      .join('\n');

    const filesBlock =
      current.files.length > 0
        ? current.files.map((f) => {
            const action = f.action !== 'edit' ? ` (${f.action})` : '';
            return `  - ${f.path}${action}`;
          }).join('\n')
        : '  (none explicitly listed)';

    const dependsOn =
      current.dependsOn.length > 0 ? current.dependsOn.join(', ') : '(none)';

    const sections: string[] = [
      '# Plan context',
      '',
      `Plan ID: ${plan.planId}`,
      `Executing task ${currentIndex + 1} of ${sortedTasks.length}: ${current.id} — ${current.title}`,
      '',
      '## All tasks (in execution order)',
      '',
      'Legend: [x] done, [!] failed, [>] current, [ ] pending',
      '',
      planSummary,
      '',
      '## Current task',
      '',
      `- ID: ${current.id}`,
      `- Title: ${current.title}`,
      `- Depends on: ${dependsOn}`,
      '- Target files (absolute paths — create/edit EXACTLY these, nothing else):',
      filesBlock,
      '- Verify command (will be executed after your work; MUST exit 0):',
      '  ```sh',
      `  ${current.verify}`,
      '  ```',
      '',
      '## Instructions',
      '',
      current.instructions,
      '',
      '## Constraints',
      '',
      '- Write files ONLY to the absolute paths listed under "Target files". Do NOT create files anywhere else.',
      '- Do NOT modify files that belong to other tasks unless they are also listed under "Target files" for the current task.',
      '- Your work will be validated by running the verify command above. It MUST exit 0.',
      '- Completed tasks ([x] above) have already produced their files; treat them as existing. Do not recreate them from scratch unless the current task explicitly requires it.',
      '',
    ];

    // Add retry context if on attempt > 1
    if (attempt && attempt > 1 && previousFailures && previousFailures.length > 0) {
      sections.push('## Previous attempt (attempt ' + (attempt - 1) + ' of ' + maxAttempts + ')');
      sections.push('');
      sections.push('The following issues were found and need to be fixed:');
      sections.push('');
      for (const failure of previousFailures) {
        sections.push(`- **${failure.hookId}**: ${failure.command}`);
        sections.push(`  Exit code: ${failure.exitCode}`);
        if (failure.stdout) sections.push(`  Output: ${failure.stdout}`);
        sections.push('');
      }
      sections.push('Fix only the listed issues. Do not modify files outside the declared list.');
      sections.push('');
    }

    return sections.join('\n');
  }
}
