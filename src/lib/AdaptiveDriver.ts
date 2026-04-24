/**
 * AdaptiveDriver — loop orchestrator for the `galloper adaptive` subcommand.
 * Spawns galloper subprocesses for plan/implement/single-prompt; evaluates git diffs;
 * gates replans. Pure helpers + types live here; the driver class is appended in
 * the subsequent slice.
 */

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { ConfigManager } from "./ConfigManager.js";
import { Logger } from "./Logger.js";
import { HumanReporter, NullHumanReporter } from "./HumanReporter.js";
import { HookDispatcher, type PreLifecyclePhase, type PostLifecyclePhase } from "./HookDispatcher.js";
import { EVALUATE_PROMPT, REPLAN_PROMPT } from "./PromptTemplates.js";

export interface AdaptiveInput {
  prompt: string;
  confidenceThreshold?: number;
  maxReplans?: number;
  diffMaxBytes?: number;
  cwd?: string;
  humanFriendly?: boolean;
}

export interface EvaluationResult {
  planStillValid: boolean;
  surprises: string[];
  confidence: number;
  notes: string;
}

export interface ImplementationDiff {
  patch: string;
  filesChanged: string[];
  truncated: boolean;
  fullSizeBytes: number;
}

export type ReplanSkipReason = "budget-exhausted" | "convergence" | "below-threshold";

export interface ReplanRecord {
  taskId: string;
  ran: boolean;
  skipReason?: ReplanSkipReason;
  before?: unknown[];
  after?: unknown[];
}

export interface AdaptiveState {
  runId: string;
  goal: string;
  completedTasks: unknown[];
  remainingTasks: unknown[];
  evaluations: EvaluationResult[];
  replans: ReplanRecord[];
  replansUsed: number;
  lastReplanWasNoOp: boolean;
}

export interface AdaptiveResolvedConfig {
  confidenceThreshold: number;
  maxReplans: number;
  diffMaxBytes: number;
}

export interface AdaptiveResult {
  runId: string;
  stateFilePath: string;
  tasksRun: number;
  replansRun: number;
  replansSkipped: number;
  finalPlan: unknown[];
}

export type Spawner = (args: {
  subcommand: "plan" | "implement" | "single-prompt";
  argv: string[];
  stdinPrompt?: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
}) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

export interface GitOps {
  snapshot(cwd: string): Promise<string>;
  diff(pre: string, post: string, cwd: string): Promise<{ fullPatch: string; filesChanged: string[] }>;
}

export const ADAPTIVE_DEFAULTS: AdaptiveResolvedConfig = {
  confidenceThreshold: 0.7,
  maxReplans: 5,
  diffMaxBytes: 32768,
};

export function shouldReplan(
  ev: EvaluationResult,
  state: { replansUsed: number; lastReplanWasNoOp: boolean },
  cfg: AdaptiveResolvedConfig,
): { run: true } | { run: false; reason: ReplanSkipReason } {
  if (state.replansUsed >= cfg.maxReplans) return { run: false, reason: "budget-exhausted" };
  if (state.lastReplanWasNoOp) return { run: false, reason: "convergence" };
  if (ev.planStillValid && ev.confidence >= cfg.confidenceThreshold && ev.surprises.length === 0) {
    return { run: false, reason: "below-threshold" };
  }
  return { run: true };
}

export function isNoOpDiff(prev: unknown[], next: unknown[]): boolean {
  return JSON.stringify(prev) === JSON.stringify(next);
}

export function truncateDiff(
  fullPatch: string,
  filesChanged: string[],
  maxBytes: number,
): ImplementationDiff {
  const fullSizeBytes = Buffer.byteLength(fullPatch, "utf8");
  if (fullSizeBytes <= maxBytes) {
    return { patch: fullPatch, filesChanged, truncated: false, fullSizeBytes };
  }
  // Slice by bytes, not chars — must not split multi-byte sequences mid-codepoint.
  // Use Buffer to get an exact byte prefix, then decode with 'utf8' which replaces any
  // trailing broken sequence with U+FFFD; callers are fine with that since the patch is
  // already truncated.
  const buf = Buffer.from(fullPatch, "utf8").subarray(0, maxBytes);
  return {
    patch: buf.toString("utf8"),
    filesChanged,
    truncated: true,
    fullSizeBytes,
  };
}

export function createDefaultSpawner(): Spawner {
  return async ({ subcommand, argv, stdinPrompt, cwd, env }) => {
    return new Promise((resolve, reject) => {
      const nodeBin = process.execPath;
      const entry = process.argv[1];
      if (!entry) {
        reject(new Error("Cannot locate galloper entrypoint (process.argv[1] empty)"));
        return;
      }
      const child = spawn(nodeBin, [entry, subcommand, ...argv], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => { stdout += d.toString("utf8"); });
      child.stderr.on("data", (d) => { stderr += d.toString("utf8"); });
      child.on("error", reject);
      child.on("close", (code) => { resolve({ exitCode: code ?? 0, stdout, stderr }); });
      if (stdinPrompt !== undefined) {
        child.stdin.end(stdinPrompt, "utf8");
      } else {
        child.stdin.end();
      }
    });
  };
}

export function createDefaultGitOps(): GitOps {
  const runGit = (args: string[], cwd: string): Promise<{ stdout: string; stderr: string; code: number }> =>
    new Promise((resolve, reject) => {
      const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => { stdout += d.toString("utf8"); });
      child.stderr.on("data", (d) => { stderr += d.toString("utf8"); });
      child.on("error", reject);
      child.on("close", (code) => resolve({ stdout, stderr, code: code ?? 0 }));
    });
  return {
    async snapshot(cwd) {
      const isRepo = await runGit(["rev-parse", "--is-inside-work-tree"], cwd);
      if (isRepo.code !== 0) {
        throw new Error(`adaptive requires a git working tree; '${cwd}' is not inside one`);
      }
      await runGit(["add", "-A"], cwd);
      const snap = await runGit(["stash", "create"], cwd);
      // When there is nothing to stash git stash create prints empty — fall back to HEAD tree.
      const sha = snap.stdout.trim();
      if (sha) return sha;
      const head = await runGit(["rev-parse", "HEAD^{tree}"], cwd);
      return head.stdout.trim();
    },
    async diff(pre, post, cwd) {
      const patch = await runGit(["diff", "--no-color", pre, post], cwd);
      const names = await runGit(["diff", "--name-only", pre, post], cwd);
      const filesChanged = names.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
      return { fullPatch: patch.stdout, filesChanged };
    },
  };
}

export interface AdaptiveDriverDeps {
  configManager: ConfigManager;
  logger: Logger;
  humanReporter?: HumanReporter;
  adaptiveDataDir: string;
  spawner?: Spawner;
  gitOps?: GitOps;
  /**
   * Optional hook dispatcher. When provided, AdaptiveDriver fires lifecycle
   * phases (pre/post-iteration, pre/post-evaluate, pre/post-replan) and
   * dispatches `adaptive.*` events at the corresponding loop checkpoints.
   * When omitted, the loop runs unchanged (no hooks fire).
   */
  hookDispatcher?: HookDispatcher;
  /** Outer adaptive run sessionId, used as the ctx.sessionId for hook firings. */
  sessionId?: string;
}

export class AdaptiveDriver {
  private configManager: ConfigManager;
  private logger: Logger;
  private humanReporter: HumanReporter;
  private adaptiveDataDir: string;
  private spawner: Spawner;
  private gitOps: GitOps;
  private hookDispatcher?: HookDispatcher;
  private sessionId?: string;

  constructor(deps: AdaptiveDriverDeps) {
    this.configManager = deps.configManager;
    this.logger = deps.logger;
    this.humanReporter = deps.humanReporter ?? new NullHumanReporter();
    this.adaptiveDataDir = deps.adaptiveDataDir;
    this.spawner = deps.spawner ?? createDefaultSpawner();
    this.gitOps = deps.gitOps ?? createDefaultGitOps();
    this.hookDispatcher = deps.hookDispatcher;
    this.sessionId = deps.sessionId;
  }

  async run(input: AdaptiveInput): Promise<AdaptiveResult> {
    const cwd = input.cwd ?? process.cwd();
    const cfg = this.resolveConfig(input);
    const runId = this.generateRunId();
    await fs.mkdir(this.adaptiveDataDir, { recursive: true });
    const stateFilePath = path.join(this.adaptiveDataDir, `${runId}.json`);
    const hf = input.humanFriendly === true;
    const forwardHf = (argv: string[]): string[] => (hf ? [...argv, '-H'] : argv);

    const goalPreview = input.prompt.length > 120 ? `${input.prompt.slice(0, 120)}…` : input.prompt;
    this.humanReporter.info(`Starting adaptive: ${goalPreview}`);
    this.humanReporter.step('adaptive', `runId=${runId} threshold=${cfg.confidenceThreshold} maxReplans=${cfg.maxReplans} diffMaxBytes=${cfg.diffMaxBytes}`);

    // 1. Plan
    const plannerName = this.configManager.getDefaultPlanner();
    const planEntry = this.configManager.getCommand(plannerName);
    this.humanReporter.step('adaptive', `Generating initial plan via '${plannerName}'`);
    const planRes = await this.spawner({
      subcommand: "plan",
      argv: forwardHf(["--prompt", input.prompt]),
      cwd,
      env: { ...process.env, ...(planEntry.env ?? {}) },
    });
    const plan = this.parsePlanFromPlannerStdout(planRes);
    this.humanReporter.step('adaptive', `Initial plan: ${plan.tasks.length} task(s)`);
    this.humanReporter.planSummary(plan);
    this.fireEvent(cwd, 'adaptive.plan.completed', { runId, taskCount: plan.tasks.length });

    const state: AdaptiveState = {
      runId,
      goal: input.prompt,
      completedTasks: [],
      remainingTasks: [...plan.tasks],
      evaluations: [],
      replans: [],
      replansUsed: 0,
      lastReplanWasNoOp: false,
    };
    await this.writeState(stateFilePath, state);

    // 2. Loop
    let iteration = 0;
    while (state.remainingTasks.length > 0) {
      const task = state.remainingTasks[0] as { id: string; title?: string; [k: string]: unknown };
      const taskTitle = typeof task.title === 'string' ? task.title : task.id;
      const total = state.completedTasks.length + state.remainingTasks.length;
      const current = state.completedTasks.length + 1;
      this.humanReporter.taskStarted(`[${task.id}] ${taskTitle}`, { current, total });

      await this.firePre(cwd, 'pre-iteration', { task, iteration });
      this.fireEvent(cwd, 'adaptive.iteration.started', {
        runId, iteration, taskId: task.id,
        completedCount: state.completedTasks.length,
        remainingCount: state.remainingTasks.length,
      });

      const preSnap = await this.gitOps.snapshot(cwd);
      const singleTaskPlanPath = await this.writeSingleTaskPlan(runId, task);
      this.humanReporter.step('adaptive', `Executing task ${task.id} via 'implement'`);
      const execRes = await this.spawner({
        subcommand: "implement",
        argv: forwardHf(["--plan-file", singleTaskPlanPath]),
        cwd,
        env: { ...process.env },
      });
      const postSnap = await this.gitOps.snapshot(cwd);
      const diffRaw = await this.gitOps.diff(preSnap, postSnap, cwd);
      const implementation = truncateDiff(diffRaw.fullPatch, diffRaw.filesChanged, cfg.diffMaxBytes);
      this.humanReporter.step('adaptive', `Task ${task.id} executed (exit ${execRes.exitCode}, ${diffRaw.filesChanged.length} file(s) changed${implementation.truncated ? ', diff truncated' : ''})`);

      await this.firePre(cwd, 'pre-evaluate', { task, iteration });
      const evalPrompt = this.renderEvaluatePrompt({
        cwd,
        goal: state.goal,
        task,
        implementation,
        executionExitCode: execRes.exitCode,
        remainingPlan: state.remainingTasks,
      });
      const evaluatorName = this.configManager.getDefaultEvaluator();
      const evaluatorEntry = this.configManager.getCommand(evaluatorName);
      this.humanReporter.step('adaptive', `Evaluating via '${evaluatorName}'`);
      const evalRes = await this.spawner({
        subcommand: "single-prompt",
        argv: forwardHf(["--prompt", evalPrompt]),
        cwd,
        env: { ...process.env, ...(evaluatorEntry.env ?? {}) },
      });
      const evaluation = this.parseEvaluation(evalRes);
      state.evaluations.push(evaluation);
      this.humanReporter.step('adaptive', `Evaluation: planStillValid=${evaluation.planStillValid} confidence=${evaluation.confidence.toFixed(2)} surprises=${evaluation.surprises.length}`);
      this.fireEvent(cwd, 'adaptive.evaluation.completed', {
        runId, iteration, taskId: task.id,
        planStillValid: evaluation.planStillValid,
        confidence: evaluation.confidence,
        surprises: evaluation.surprises,
        notes: evaluation.notes,
      });
      await this.firePost(cwd, 'post-evaluate', { task, iteration });

      const decision = shouldReplan(evaluation, { replansUsed: state.replansUsed, lastReplanWasNoOp: state.lastReplanWasNoOp }, cfg);
      let replanContinue = false;
      if (decision.run) {
        await this.firePre(cwd, 'pre-replan', { task, iteration });
        const replannerName = this.configManager.getDefaultReplanner();
        const replannerEntry = this.configManager.getCommand(replannerName);
        this.humanReporter.step('adaptive', `Replanning via '${replannerName}' (used ${state.replansUsed}/${cfg.maxReplans})`);
        const replanPrompt = this.renderReplanPrompt({
          cwd,
          goal: state.goal,
          completedTasks: state.completedTasks,
          remainingTasks: state.remainingTasks,
          surprises: evaluation.surprises,
        });
        const replanRes = await this.spawner({
          subcommand: "single-prompt",
          argv: forwardHf(["--prompt", replanPrompt]),
          cwd,
          env: { ...process.env, ...(replannerEntry.env ?? {}) },
        });
        const newRemaining = this.parseReplan(replanRes);
        if (isNoOpDiff(state.remainingTasks, newRemaining)) {
          state.lastReplanWasNoOp = true;
          state.replans.push({ taskId: task.id, ran: false, skipReason: "convergence" });
          this.humanReporter.step('adaptive', 'Replan was a no-op; marking convergence');
          this.fireEvent(cwd, 'adaptive.replan.decision', {
            runId, iteration, taskId: task.id, decision: 'noop', replansUsed: state.replansUsed,
          });
        } else {
          state.replans.push({ taskId: task.id, ran: true, before: state.remainingTasks, after: newRemaining });
          const before = state.remainingTasks;
          state.remainingTasks = newRemaining;
          state.replansUsed += 1;
          state.lastReplanWasNoOp = false;
          this.humanReporter.step('adaptive', `Replan applied: ${newRemaining.length} remaining task(s); re-evaluating new head`);
          this.fireEvent(cwd, 'adaptive.replan.decision', {
            runId, iteration, taskId: task.id, decision: 'applied',
            replansUsed: state.replansUsed, before, after: newRemaining,
          });
          await this.writeState(stateFilePath, state);
          replanContinue = true; // Re-evaluate head of new remaining on next loop iteration without advancing
        }
        await this.firePost(cwd, 'post-replan', { task, iteration });
      } else {
        const reason = (decision as { run: false; reason: ReplanSkipReason }).reason;
        state.replans.push({ taskId: task.id, ran: false, skipReason: reason });
        this.humanReporter.step('adaptive', `Replan skipped (${reason})`);
        this.fireEvent(cwd, 'adaptive.replan.decision', {
          runId, iteration, taskId: task.id, decision: 'skipped', reason,
          replansUsed: state.replansUsed,
        });
      }

      if (!replanContinue) {
        // Advance: the task at head was executed; pop it.
        state.completedTasks.push(task);
        state.remainingTasks = state.remainingTasks.slice(1);
        await this.writeState(stateFilePath, state);
        this.humanReporter.taskCompleted(`[${task.id}] ${taskTitle}`, { current, total: state.completedTasks.length + state.remainingTasks.length });
      }

      await this.firePost(cwd, 'post-iteration', { task, iteration });
      this.fireEvent(cwd, 'adaptive.iteration.completed', {
        runId, iteration, taskId: task.id, replanContinue,
        completedCount: state.completedTasks.length,
        remainingCount: state.remainingTasks.length,
      });
      iteration += 1;
    }

    const result: AdaptiveResult = {
      runId,
      stateFilePath,
      tasksRun: state.completedTasks.length,
      replansRun: state.replans.filter((r) => r.ran).length,
      replansSkipped: state.replans.filter((r) => !r.ran).length,
      finalPlan: state.completedTasks,
    };
    this.humanReporter.done(`Adaptive completed: ${result.tasksRun} task(s), ${result.replansRun} replan(s), ${result.replansSkipped} skipped`);
    return result;
  }

  private async firePre(
    cwd: string,
    phase: PreLifecyclePhase,
    extra: { task?: unknown; iteration?: number },
  ): Promise<void> {
    if (!this.hookDispatcher) return;
    await this.hookDispatcher.runPre(phase, {
      sessionId: this.sessionId ?? '',
      cwd,
      task: extra.task,
      iteration: extra.iteration,
    });
  }

  private async firePost(
    cwd: string,
    phase: PostLifecyclePhase,
    extra: { task?: unknown; iteration?: number },
  ): Promise<void> {
    if (!this.hookDispatcher) return;
    const failures = await this.hookDispatcher.runPost(phase, {
      sessionId: this.sessionId ?? '',
      cwd,
      task: extra.task,
      iteration: extra.iteration,
    });
    if (failures.length > 0) {
      this.humanReporter.step('adaptive', `${phase} hooks reported ${failures.length} failure(s)`);
    }
  }

  private fireEvent(cwd: string, eventType: string, payload: Record<string, unknown>): void {
    if (!this.hookDispatcher) return;
    this.hookDispatcher.dispatchEvent(eventType, payload, {
      sessionId: this.sessionId ?? '',
      cwd,
    });
  }

  private resolveConfig(input: AdaptiveInput): AdaptiveResolvedConfig {
    const cfgAdaptive = this.configManager.getAdaptiveConfig();
    return {
      confidenceThreshold: input.confidenceThreshold ?? cfgAdaptive?.confidenceThreshold ?? ADAPTIVE_DEFAULTS.confidenceThreshold,
      maxReplans: input.maxReplans ?? cfgAdaptive?.maxReplans ?? ADAPTIVE_DEFAULTS.maxReplans,
      diffMaxBytes: input.diffMaxBytes ?? cfgAdaptive?.diffMaxBytes ?? ADAPTIVE_DEFAULTS.diffMaxBytes,
    };
  }

  private generateRunId(): string {
    return new Date().toISOString().replace(/[:.]/g, "-");
  }

  private async writeState(filePath: string, state: AdaptiveState): Promise<void> {
    await fs.writeFile(filePath, JSON.stringify(state, null, 2) + "\n", "utf8");
  }

  private async writeSingleTaskPlan(runId: string, task: unknown): Promise<string> {
    const tmpDir = path.join(this.adaptiveDataDir, "tmp");
    await fs.mkdir(tmpDir, { recursive: true });
    const planPath = path.join(tmpDir, `${runId}-task-${Date.now()}.json`);
    const inner = {
      planId: `${runId}-single-task`,
      tasks: [task],
    };
    const envelope = {
      id: `${runId}-inner`,
      createdAt: new Date().toISOString(),
      prompt: "",
      command: "",
      sessionId: runId,
      content: JSON.stringify(inner),
    };
    await fs.writeFile(planPath, JSON.stringify(envelope, null, 2) + "\n", "utf8");
    return planPath;
  }

  private parsePlanFromPlannerStdout(res: { exitCode: number; stdout: string; stderr: string }): { tasks: unknown[] } {
    const finalOutput = this.extractFinalOutput('planner', res);
    const plan = this.parseJsonPayload<{ tasks?: unknown }>('planner', finalOutput);
    if (!Array.isArray(plan.tasks)) {
      throw new Error(`adaptive: parsed plan has no tasks array; finalOutput head: ${finalOutput.slice(0, 400)}`);
    }
    return { tasks: plan.tasks };
  }

  private parseEvaluation(res: { exitCode: number; stdout: string; stderr: string }): EvaluationResult {
    const finalOutput = this.extractFinalOutput('evaluator', res);
    const obj = this.parseJsonPayload<Partial<EvaluationResult>>('evaluator', finalOutput);
    if (typeof obj.planStillValid !== 'boolean') {
      throw new Error(`adaptive: evaluator output missing 'planStillValid' boolean; finalOutput head: ${finalOutput.slice(0, 400)}`);
    }
    return {
      planStillValid: obj.planStillValid,
      surprises: Array.isArray(obj.surprises) ? obj.surprises.map(String) : [],
      confidence: typeof obj.confidence === 'number' ? obj.confidence : 0,
      notes: typeof obj.notes === 'string' ? obj.notes : '',
    };
  }

  private parseReplan(res: { exitCode: number; stdout: string; stderr: string }): unknown[] {
    const finalOutput = this.extractFinalOutput('replanner', res);
    const obj = this.parseJsonPayload<{ remainingTasks?: unknown }>('replanner', finalOutput);
    if (!Array.isArray(obj.remainingTasks)) {
      throw new Error(`adaptive: replan output missing remainingTasks array; finalOutput head: ${finalOutput.slice(0, 400)}`);
    }
    return obj.remainingTasks;
  }

  /**
   * Validate a subprocess's stdout envelope and return the `finalOutput` string.
   * Surfaces the subprocess's exit code and stderr when things go wrong, so
   * adaptive errors are diagnosable instead of bare "Unexpected end of JSON input".
   */
  private extractFinalOutput(
    role: 'planner' | 'evaluator' | 'replanner',
    res: { exitCode: number; stdout: string; stderr: string },
  ): string {
    const stderrTail = res.stderr.trim().slice(-500) || '<empty>';
    if (res.exitCode !== 0) {
      throw new Error(`adaptive: ${role} subprocess failed (exit ${res.exitCode}); stderr tail: ${stderrTail}`);
    }
    const trimmed = res.stdout.trim();
    if (!trimmed) {
      throw new Error(`adaptive: ${role} subprocess produced empty stdout; stderr tail: ${stderrTail}`);
    }
    let envelope: { finalOutput?: string | null };
    try {
      envelope = JSON.parse(trimmed) as { finalOutput?: string | null };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`adaptive: ${role} stdout is not a JSON envelope (${msg}); stdout head: ${trimmed.slice(0, 400)}; stderr tail: ${stderrTail}`);
    }
    const finalOutput = envelope.finalOutput;
    if (typeof finalOutput !== 'string' || finalOutput.trim().length === 0) {
      throw new Error(`adaptive: ${role} envelope missing non-empty finalOutput; stderr tail: ${stderrTail}`);
    }
    return finalOutput;
  }

  /**
   * Parse the LLM's finalOutput as JSON, tolerating Markdown fences and leading/trailing prose.
   * Falls back to extracting the first balanced {...} object when direct parse fails.
   */
  private parseJsonPayload<T>(role: string, finalOutput: string): T {
    const stripped = this.stripFences(finalOutput.trim());
    try {
      return JSON.parse(stripped) as T;
    } catch {
      // fall through
    }
    const extracted = this.extractFirstJsonObject(stripped);
    if (extracted) {
      try {
        return JSON.parse(extracted) as T;
      } catch {
        // fall through
      }
    }
    throw new Error(`adaptive: ${role} output is not valid JSON; finalOutput head: ${finalOutput.slice(0, 400)}`);
  }

  private stripFences(s: string): string {
    const m = s.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    return m ? (m[1] ?? s).trim() : s;
  }

  /**
   * Scan `text` for the first balanced JSON object literal and return it as a substring,
   * or null if none is found. Respects string literals and escapes so braces inside strings
   * don't confuse the counter.
   */
  private extractFirstJsonObject(text: string): string | null {
    const start = text.indexOf('{');
    if (start < 0) return null;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (inStr) {
        if (esc) { esc = false; continue; }
        if (c === '\\') { esc = true; continue; }
        if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') { inStr = true; continue; }
      if (c === '{') { depth++; continue; }
      if (c === '}') {
        depth--;
        if (depth === 0) return text.slice(start, i + 1);
      }
    }
    return null;
  }

  private renderEvaluatePrompt(ctx: { cwd: string; goal: string; task: unknown; implementation: ImplementationDiff; executionExitCode: number | null; remainingPlan: unknown[] }): string {
    const body = JSON.stringify({
      goal: ctx.goal,
      task: ctx.task,
      implementation: ctx.implementation,
      executionExitCode: ctx.executionExitCode,
      remainingPlan: ctx.remainingPlan,
    }, null, 2);
    return EVALUATE_PROMPT.replace(/{{CWD}}/g, ctx.cwd) + "\n" + body;
  }

  private renderReplanPrompt(ctx: { cwd: string; goal: string; completedTasks: unknown[]; remainingTasks: unknown[]; surprises: string[] }): string {
    const body = JSON.stringify({
      goal: ctx.goal,
      completedTasks: ctx.completedTasks,
      remainingTasks: ctx.remainingTasks,
      surprises: ctx.surprises,
    }, null, 2);
    return REPLAN_PROMPT.replace(/{{CWD}}/g, ctx.cwd) + "\n" + body;
  }
}
