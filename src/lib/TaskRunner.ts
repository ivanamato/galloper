// TaskRunner module: orchestrates sequential task execution from a plan
// Loads plan JSON, executes tasks in order, runs verify commands, persists run manifest

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parsePlan, topoSort, readyTasks, descendantsOf, Plan, PlanTask, RetryPolicy } from './PlanSchema.js';
import { Executioner } from './Executioner.js';
import { CoreRunner } from './CoreRunner.js';
import { Logger } from './Logger.js';
import { HumanReporter, NullHumanReporter } from './HumanReporter.js';
import { HookDispatcher, AbortHookError, type HooksConfig } from './HookDispatcher.js';
import { WorkerPool } from './WorkerPool.js';
import { WriteLock } from './WriteLock.js';
import type { CommandResolver } from './CommandResolver.js';
import { captureBaseline, reconcile, classify, classifyAcrossRoots, revertToBaseline, captureBaselines, reconcileAll, type Baseline, type WorkspaceRoot, type ReconciledPath } from './WorkspaceReconciler.js';
import type { TaskManifest } from './SessionManager.js';
import { FileWatcher } from './FileWatcher.js';

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
  /**
   * Max concurrent `post-task-file` hook dispatches ACROSS files within a
   * single task. Hooks for the same file are still serialized by `PathLock`
   * inside `HookDispatcher`. Default `4`: conservative enough for typical
   * laptop-bound hook IO (linters, formatters) without thrashing. Set to `1`
   * for strict sequential behavior equivalent to pre-Step-6.
   */
  concurrency?: number;
  /**
   * Workspace roots to track (Step 3C). If absent, falls back to a synthetic
   * single root at `{ path: cwd, vcs: 'git', label: 'main' }`.
   */
  workspaceRoots?: WorkspaceRoot[];
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
  /**
   * Populated by per-hook retry (§Step 6) when `LifecycleHookConfig.retry` is
   * set. Number of attempts actually made (>=1). Absent for hooks without
   * retry, and for categories other than 'hook'.
   */
  hookRetryCount?: number;
  /**
   * Unique invocation ID for this hook execution (§Step 7). Propagated as
   * DEVFLOW_HOOK_INVOCATION_ID to the hook's environment.
   */
  hookInvocationId?: string;
  /**
   * Duration in milliseconds of the hook invocation (execCommand call).
   * Distinct from durationMs which may include retry attempt timing.
   */
  invocationDurationMs?: number;
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
  taskManifests: Record<string, TaskManifest>;
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
    const hookDispatcher = new HookDispatcher(input.hooksConfig, input.humanReporter ?? new NullHumanReporter(), input.logger);
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
      taskManifests: {},
    };
    if (!manifest.taskManifests) manifest.taskManifests = {};

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
    // Default: 4 concurrent post-task-file hook dispatches across files.
    // Same-file hooks are still serialized by the PathLock inside HookDispatcher.
    const concurrency = input.concurrency ?? 4;

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

      // Capture workspace baselines for all configured roots (Step 3C).
      // Falls back to synthetic single root at cwd if workspaceRoots not provided.
      const rootsToTrack = input.workspaceRoots ?? [
        { path: input.cwd, vcs: 'git' as const, label: 'main' },
      ];
      const baselines = await captureBaselines(rootsToTrack);
      for (const rb of baselines) {
        if (rb.baseline) {
          await input.logger.append({
            sessionId,
            type: 'workspace.baseline.captured',
            timestamp: new Date().toISOString(),
            taskId: task.id,
            root: rb.path,
            label: rb.label,
            vcs: rb.vcs,
            ref: rb.baseline.head,
          });
        }
      }

      // Start FileWatcher to detect background activity (Step 4)
      const fileWatcher = new FileWatcher();
      try {
        await fileWatcher.start(rootsToTrack, {});
      } catch (error) {
        console.warn('FileWatcher startup warning:', error);
      }

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

      // Quiesce gate (Step 4): wait for workspace to be quiet before proceeding
      // Use hardcoded defaults: quiesceMs=250, quiesceTimeoutMs=5000
      const quiesceMs = 250;
      const quiesceTimeoutMs = 5000;

      try {
        // Wait for each root to be idle
        for (const root of rootsToTrack) {
          try {
            await fileWatcher.waitForIdle(root.label, quiesceMs, quiesceTimeoutMs);
          } catch (quiesceError) {
            // Quiesce failed - emit workspace.noisy and abort task
            const watcherEvents = await fileWatcher.stop();
            const sampleEvents = watcherEvents[root.label] ?? [];
            await input.logger.append({
              sessionId,
              type: 'workspace.noisy',
              timestamp: new Date().toISOString(),
              taskId: task.id,
              root: root.path,
              label: root.label,
              quiesceMs,
              quiesceTimeoutMs,
              sampleEventCount: sampleEvents.length,
            });
            taskState.status = 'aborted';
            taskState.endedAt = new Date().toISOString();
            await manifestWriteLock.acquire(async () => {
              manifest.endedAt = new Date().toISOString();
              manifest.status = 'aborted';
              await fs.mkdir(path.dirname(input.runManifestPath), { recursive: true });
              await fs.writeFile(input.runManifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
            });
            throw new Error(`Task ${task.id} aborted: workspace too noisy. Unable to achieve quiescence of ${quiesceMs}ms within ${quiesceTimeoutMs}ms timeout`);
          }
        }
      } catch (error) {
        if (error instanceof Error && error.message.includes('aborted')) {
          throw error;
        }
        console.warn(`Quiesce gate error for ${task.id}:`, error);
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

          // Stop FileWatcher after executioner and collect its event set (Step 4)
          // Give chokidar time to emit events with awaitWriteFinish
          await new Promise(resolve => setTimeout(resolve, 150));
          // This captures all file system activity during task execution
          const watcherEvents = await fileWatcher.stop();

          // Reconcile all roots (Step 3C): for each root with a baseline, classify
          // net-changed paths as declared|surprise|churn. Hooks fire on the
          // RECONCILED set per root, closing the trust boundary. Falls back to
          // the declared manifest only when baseline capture failed.
          const reconciledByRoot = await reconcileAll(baselines);

          // Compute churn from watcher data (Step 4):
          // A path is churn if it was seen by the watcher but NOT in reconciliation (net-zero change on disk).
          // Churn is distinguished from surprise (new gitignored files) by checking baseline:
          //   - If path was in baseline: file existed, was modified, and reverted → churn
          //   - If path was NOT in baseline AND watcher action is 'deleted': file was created then deleted → churn
          //   - If path was NOT in baseline AND watcher action is NOT 'deleted': new undeclared file → surprise (handled by classify)
          // For each root, build watcher → reconciled classification.
          const churnSet: Record<string, Set<string>> = {};
          const droppedByRoot: Record<string, ReconciledPath[]> = {};
          const watcherMap: Record<string, Map<string, string>> = {}; // path -> final action

          for (const rootBaseline of baselines) {
            const root = rootsToTrack.find((r) => r.label === rootBaseline.label);
            if (!root) continue;

            // Build a map of watcher events by path to check final action
            const watcherByPath = new Map<string, 'created' | 'modified' | 'deleted'>();
            for (const evt of watcherEvents[root.label] || []) {
              watcherByPath.set(evt.path, evt.action);
            }
            watcherMap[root.label] = watcherByPath;

            const baselineEntries = rootBaseline.baseline?.entries ?? {};
            const reconciledPaths = (reconciledByRoot[root.label] || []).map((e) => e.path);
            const reconciledSet = new Set(reconciledPaths);

            // Churn: in watcher only, AND either:
            //   1. action is 'deleted' (created then deleted, net-zero)
            //   2. action is 'modified' AND path exists in git HEAD (modified then reverted)
            const churnInRoot: string[] = [];
            for (const [p, action] of watcherByPath) {
              if (reconciledSet.has(p)) continue; // Not churn if reconcile sees it

              if (action === 'deleted') {
                // Deleted files are always churn (net-zero on disk)
                churnInRoot.push(p);
              } else if (action === 'modified') {
                // Check if this file exists in git HEAD (was committed)
                // If it does, it was modified then reverted = churn
                // If not, it's a surprise (gitignored or similar)
                try {
                  execFileSync('git', ['show', `HEAD:${p}`], { cwd: root.path, stdio: 'pipe' });
                  // File exists in HEAD, so it was modified and reverted
                  churnInRoot.push(p);
                } catch (error) {
                  // File doesn't exist in HEAD, so it's a surprise (new file)
                }
              }
              // Note: 'created' action with path not in baseline = new file, will be classified as surprise by classify()
            }
            churnSet[root.label] = new Set(churnInRoot);

            // Dropped: in reconcile only (detected as change but watcher missed it)
            const droppedInRoot: ReconciledPath[] = [];
            for (const p of reconciledByRoot[root.label] || []) {
              if (!watcherByPath.has(p.path)) {
                droppedInRoot.push(p);
              }
            }
            droppedByRoot[root.label] = droppedInRoot;
          }

          // Emit workspace.watcher.dropped events for paths reconcile found but watcher missed
          for (const root of rootsToTrack) {
            for (const p of droppedByRoot[root.label] || []) {
              await input.logger.append({
                sessionId,
                type: 'workspace.watcher.dropped',
                timestamp: new Date().toISOString(),
                taskId: task.id,
                root: root.path,
                label: root.label,
                path: p.path,
                action: p.action,
              });
            }
          }

          // Emit task.file.churn events for watcher-detected churn
          for (const root of rootsToTrack) {
            for (const p of churnSet[root.label] || []) {
              const action = watcherMap[root.label]?.get(p) || 'delete';
              await input.logger.append({
                sessionId,
                type: 'task.file.churn',
                timestamp: new Date().toISOString(),
                taskId: task.id,
                root: root.path,
                label: root.label,
                path: p,
                action,
              });
            }
          }

          // Flatten churn into a single set and add watcher-only (non-churn) paths to reconciled for classification
          const watcherChurn: ReconciledPath[] = [];
          const reconcileWithWatcher: Record<string, ReconciledPath[]> = {};

          for (const root of rootsToTrack) {
            const churnInRoot = churnSet[root.label] || new Set<string>();
            const watcherInRoot = watcherMap[root.label] || new Map<string, string>();
            const reconciledInRoot = reconciledByRoot[root.label] || [];
            const reconciledSet = new Set(reconciledInRoot.map((r) => r.path));

            // Build the enhanced reconciled set that includes watcher-only paths
            const enhanced = [...reconciledInRoot];

            // For watcher-only paths that are NOT churn (new files like gitignored), add them to reconciled
            for (const [p, action] of watcherInRoot) {
              if (!reconciledSet.has(p) && !churnInRoot.has(p)) {
                // Watcher saw this, reconcile didn't, and it's not churn → add as a path for classification
                enhanced.push({ path: p, action: action as 'create' | 'edit' | 'delete' });
              }
            }

            reconcileWithWatcher[root.label] = enhanced;

            // Add churn paths to the churn set (use the actual watcher action)
            for (const p of churnInRoot) {
              const action = watcherInRoot.get(p) || 'delete';
              watcherChurn.push({ path: p, action: action as 'create' | 'edit' | 'delete' });
            }
          }

          // Classify across roots to detect out-of-workspace paths (Step 3D)
          // Now with watcher-based churn to authoritatively classify net-zero writes,
          // and watcher-only paths included for classification as surprise
          const classified = classifyAcrossRoots(reconcileWithWatcher, task.files, rootsToTrack, watcherChurn);

          // Check for out-of-workspace writes before post-task-file hooks
          if (classified.outOfWorkspace.length > 0) {
            // Emit events for each out-of-workspace path
            for (const p of classified.outOfWorkspace) {
              await input.logger.append({
                sessionId,
                type: 'task.file.out-of-workspace',
                timestamp: new Date().toISOString(),
                taskId: task.id,
                path: p.path,
                action: p.action,
              });
            }

            // Add synthetic HookFailure to abort the task
            attemptRecord.hookFailures.push({
              hookId: 'out-of-workspace',
              command: 'workspace-boundary-check',
              exitCode: 1,
              stdout: '',
              stderr: `Out-of-workspace writes detected: ${classified.outOfWorkspace.map((p) => p.path).join(', ')}`,
              timedOut: false,
              durationMs: 0,
              onFailure: 'abort',
              category: 'hook',
            });

            // Set status to aborted and skip post-task-file hooks
            attemptRecord.status = 'aborted';
            attemptRecord.endedAt = new Date().toISOString();
            taskState.attempts.push(attemptRecord);
            taskState.status = 'aborted';

            // Fire post-task hook with enriched payload containing failure info
            try {
              const postTaskFailures = await hookDispatcher.runPost('post-task', {
                plan,
                task,
                sessionId,
                cwd: input.cwd,
                previousFailures: attemptRecord.hookFailures,
              });
              if (postTaskFailures.length > 0) {
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
                console.warn(`Post-task hook aborted for ${task.id}:`, error);
              } else {
                console.warn(`Post-task hook failed for ${task.id}:`, error);
              }
            }

            taskState.endedAt = new Date().toISOString();

            // Write manifest after aborting
            await manifestWriteLock.acquire(async () => {
              await fs.mkdir(path.dirname(input.runManifestPath), { recursive: true });
              await fs.writeFile(input.runManifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
            });

            // Skip post-task-file hooks and continue to next task
            continue;
          }

          // Build per-root manifest for reporting (back-compat with Step 3C)
          const perRootManifest: Record<string, { declared: { path: string; action: 'create' | 'edit' | 'delete' }[]; surprise: { path: string; action: 'create' | 'edit' | 'delete' }[]; churn: { path: string; action: 'create' | 'edit' | 'delete' }[] }> = {};
          for (const rb of baselines) {
            // Extract per-root data from the global classified result
            // Use the enhanced reconciled set (reconcileWithWatcher) which includes watcher-only paths
            const enhanced = reconcileWithWatcher[rb.label] ?? [];
            perRootManifest[rb.label] = {
              declared: classified.declared.filter((p) =>
                enhanced.some((r) => r.path === p.path),
              ),
              surprise: classified.surprise.filter((p) =>
                enhanced.some((r) => r.path === p.path),
              ),
              churn: classified.churn.filter((p) =>
                enhanced.some((r) => r.path === p.path),
              ),
            };
          }

          // Log events per-root
          for (const rb of baselines) {
            const perRoot = perRootManifest[rb.label] || { declared: [], surprise: [] };

            for (const p of perRoot.declared) {
              await input.logger.append({
                sessionId,
                type: 'task.file.declared',
                timestamp: new Date().toISOString(),
                taskId: task.id,
                root: rb.path,
                label: rb.label,
                path: p.path,
                action: p.action,
                via: 'reconcile',
              });
            }
            for (const p of perRoot.surprise) {
              await input.logger.append({
                sessionId,
                type: 'task.file.surprise',
                timestamp: new Date().toISOString(),
                taskId: task.id,
                root: rb.path,
                label: rb.label,
                path: p.path,
                action: p.action,
                via: 'reconcile',
              });
            }

            // Log workspace.reconciled summary per root
            const reconciled = reconciledByRoot[rb.label] ?? [];
            const churn = classified.churn.filter((p) => reconciled.some((r) => r.path === p.path));
            await input.logger.append({
              sessionId,
              type: 'workspace.reconciled',
              timestamp: new Date().toISOString(),
              taskId: task.id,
              root: rb.path,
              label: rb.label,
              declared: perRoot.declared.length,
              surprise: perRoot.surprise.length,
              churn: churn.length,
            });
          }

          // Compute union of all roots for top-level manifest (back-compat)
          const allDeclared: { path: string; action: 'create' | 'edit' | 'delete' }[] = [];
          const allSurprise: { path: string; action: 'create' | 'edit' | 'delete' }[] = [];
          const allChurn: { path: string; action: 'create' | 'edit' | 'delete' }[] = [];

          allDeclared.push(...classified.declared);
          allSurprise.push(...classified.surprise);
          allChurn.push(...classified.churn);

          manifest.taskManifests[task.id] = {
            declared: allDeclared,
            surprise: allSurprise,
            churn: allChurn,
            perRoot: perRootManifest,
          };

          // Fire post-task-file hooks for declared ∪ surprise paths from all roots.
          // Dispatch fans out across files via WorkerPool (concurrency N); per-file
          // serialization of matching hooks is guaranteed by the PathLock
          // inside HookDispatcher.runPost. Failure ordering is restored to
          // dispatchSet order after Promise.all so concurrency=1 is
          // behaviorally identical to the pre-Step-6 sequential loop.
          const dispatchSet: { file: { path: string; action: 'create' | 'edit' | 'delete' }; classification: 'declared' | 'surprise' }[] = [
            ...allDeclared.map((f) => ({ file: { path: f.path, action: f.action }, classification: 'declared' as const })),
            ...allSurprise.map((f) => ({ file: { path: f.path, action: f.action }, classification: 'surprise' as const })),
          ];
          const pool = new WorkerPool<{ index: number; failures: HookFailure[]; abortError?: Error; abortHookIndex?: number }>(Math.max(1, concurrency));
          let abortError: Error | null = null;
          let abortHookIndex: number | undefined;
          const pooled = dispatchSet.map((item, index) =>
            pool.enqueue(async () => {
              try {
                const failures = await hookDispatcher.runPost('post-task-file', {
                  plan,
                  task,
                  file: item.file,
                  attempt,
                  sessionId,
                  cwd: input.cwd,
                  previousFailures: attemptRecord.hookFailures,
                  classification: item.classification,
                });
                return { index, failures };
              } catch (error) {
                if (error instanceof AbortHookError) {
                  return { index, failures: [], abortError: error, abortHookIndex: error.hookIndex };
                }
                if (error instanceof Error && (error.message.includes('aborted') || error.message.includes('Abort'))) {
                  return { index, failures: [], abortError: error };
                }
                console.warn(`Post-task-file hook failed for ${item.file.path}:`, error);
                return { index, failures: [] };
              }
            }),
          );
          const results = await Promise.all(pooled);
          results.sort((a, b) => a.index - b.index);
          for (const r of results) {
            if (r.abortError && !abortError) {
              abortError = r.abortError;
              abortHookIndex = r.abortHookIndex;
            }
            attemptRecord.hookFailures.push(...r.failures);
          }
          if (abortError) {
            // Before propagating, consult the aborting hook's onAbort policy.
            // If `revert` AND we have usable baselines, restore all roots
            // so partial task writes don't leak into the tree. Revert errors
            // are logged but do not mask the original abort.
            const postHooks = input.hooksConfig?.lifecycle?.['post-task-file'] ?? [];
            const abortingHook = abortHookIndex !== undefined ? postHooks[abortHookIndex] : undefined;
            if (abortingHook?.onAbort === 'revert') {
              for (const rb of baselines) {
                if (rb.baseline != null) {
                  const revertRes = await revertToBaseline(rb.path, rb.baseline);
                  await input.logger.append({
                    sessionId,
                    type: 'workspace.reverted',
                    timestamp: new Date().toISOString(),
                    taskId: task.id,
                    root: rb.path,
                    label: rb.label,
                    reverted: revertRes.reverted,
                    ...(revertRes.reason ? { reason: revertRes.reason } : {}),
                  });
                }
              }
            }
            throw abortError;
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
