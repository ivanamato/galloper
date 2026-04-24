// Generates galloper-data/plans/adaptive-slices-2-5.json from structured data.
// Run: node dist-scripts/scripts/build-adaptive-full.js
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const __dirname = dirname(fileURLToPath(import.meta.url));
const tasks = [
    {
        id: "t2-prompt-templates",
        title: "Add EVALUATE_PROMPT and REPLAN_PROMPT to PromptTemplates.ts",
        dependsOn: [],
        files: [{ path: "src/lib/PromptTemplates.ts", action: "edit" }],
        verify: "npm run build",
        instructions: `Edit ONLY src/lib/PromptTemplates.ts. Read it first — it currently exports two template constants: PLAN_PROMPT and IMPLEMENT_PROMPT, as backtick-quoted strings with a {{CWD}} placeholder.

APPEND two NEW exported constants at the END of the file, after IMPLEMENT_PROMPT. Each must:
- Be an \`export const\` string literal (backtick-quoted template string).
- Include {{CWD}} placeholder where a path context may be useful.
- Explicitly state the JSON output contract the model MUST emit (no markdown, no prose, just a JSON object).

Add these two constants VERBATIM (the loop driver will treat the JSON shapes as its parsing contract, so these must match exactly):

\`\`\`
export const EVALUATE_PROMPT = \\\`You are an evaluation agent. A task has just been implemented against a plan. Your sole job is to judge whether the REMAINING plan is still right in light of what was just done.

**EXECUTION CONTEXT**
Working directory: \\\\\\\`{{CWD}}\\\\\\\`

**INPUT** (supplied after this preamble as JSON embedded in the USER REQUEST):
- goal: the user's original high-level goal
- task: the task just executed { id, title, instructions, files, verify }
- implementation.patch: a (possibly truncated) git diff of the task's effect on disk
- implementation.filesChanged: full list of files the task modified
- implementation.truncated: true if patch was truncated
- implementation.fullSizeBytes: size of the untruncated diff
- executionExitCode: the executioner subprocess exit code (null or number)
- remainingPlan: the list of tasks still pending after this one

**OUTPUT FORMAT**: Return ONLY a single valid JSON object, no markdown fences, no prose. Shape:

{
  "planStillValid": true | false,
  "surprises": [ "short human-readable strings describing anything unexpected in the diff, or empty array" ],
  "confidence": 0.0 .. 1.0,
  "notes": "optional one-paragraph rationale"
}

**Interpretation:**
- planStillValid=false means the remaining plan must change (missing steps, obsoleted steps, ordering wrong, etc.).
- confidence is your self-rated confidence in the planStillValid claim.
- surprises lists concrete observations from the diff that weren't anticipated by the task's instructions.
- Do NOT assess whether the task itself was done correctly — executionExitCode handles that upstream.
- Return ONLY the JSON.

USER REQUEST:
\\\`;

export const REPLAN_PROMPT = \\\`You are a re-planning agent. An evaluation has flagged that the remaining plan needs to change. Produce a revised list of REMAINING tasks.

**EXECUTION CONTEXT**
Working directory: \\\\\\\`{{CWD}}\\\\\\\`

**INPUT** (supplied after this preamble as JSON embedded in the USER REQUEST):
- goal: the user's original high-level goal
- completedTasks: tasks already done (LOCKED — never modify, never reorder, never drop)
- remainingTasks: current list of remaining tasks
- surprises: observations from the evaluator that motivated this replan

**OUTPUT FORMAT**: Return ONLY a single valid JSON object, no markdown fences, no prose. Shape:

{
  "remainingTasks": [
    { "id": "t-new-or-existing", "title": "...", "files": [...], "instructions": "...", "verify": "...", "dependsOn": [...] }
  ]
}

**Rules:**
- Completed tasks are LOCKED. Do not reference or alter them.
- You MAY: insert NEW remediation tasks at the HEAD of remainingTasks, reorder remainingTasks, drop remainingTasks that are no longer needed.
- You MAY NOT: insert new tasks anywhere except the head, rewrite task content of tasks already in remainingTasks (prefer to drop+re-add if a substantive edit is needed), or reference task ids from completedTasks.
- If nothing should change, return remainingTasks unchanged — the caller detects this as a no-op.
- Each task must conform to the plan schema: non-empty id, title, files (array of { path, action }), instructions, verify, and dependsOn (array).
- Return ONLY the JSON.

USER REQUEST:
\\\`;
\`\`\`

(The quadruple-backticks and triple-backtick escapes in the literal above are for the code-block context of THIS instruction — you emit each template with single backticks around the string, exactly as PLAN_PROMPT / IMPLEMENT_PROMPT are formatted in the existing file.)

DO NOT change PLAN_PROMPT or IMPLEMENT_PROMPT. DO NOT add a renderTemplate helper — each consumer handles rendering.

Out of scope: everything else (the AdaptiveDriver, CLI wiring, tests).`,
    },
    {
        id: "t3a-adaptive-driver-helpers",
        title: "Create AdaptiveDriver.ts with pure helper functions, interfaces, and their unit tests",
        dependsOn: ["t2-prompt-templates"],
        files: [
            { path: "src/lib/AdaptiveDriver.ts", action: "create" },
            { path: "tests/unit/AdaptiveDriver.helpers.test.ts", action: "create" },
        ],
        verify: "npx vitest run tests/unit/AdaptiveDriver.helpers.test.ts",
        instructions: `Create TWO NEW files.

=== PART A — src/lib/AdaptiveDriver.ts ===

This is the first commit of a new module. ONLY create exported types and pure helper functions in this task. The class itself lands in the NEXT task (t3b).

Create the file with:

1. A file-header comment explaining: "AdaptiveDriver — loop orchestrator for the \`galloper adaptive\` subcommand. Spawns galloper subprocesses for plan/implement/single-prompt; evaluates git diffs; gates replans. Pure helpers + types live here; the driver class is appended in the subsequent slice."

2. All interfaces from docs/ADAPTIVE_PIPELINE_PLAN.md §"New interfaces", EXACTLY these exports (all exported):

\`\`\`
export interface AdaptiveInput {
  prompt: string;
  confidenceThreshold?: number;
  maxReplans?: number;
  diffMaxBytes?: number;
  cwd?: string;
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
\`\`\`

3. Hard-coded defaults:

\`\`\`
export const ADAPTIVE_DEFAULTS: AdaptiveResolvedConfig = {
  confidenceThreshold: 0.7,
  maxReplans: 5,
  diffMaxBytes: 32768,
};
\`\`\`

4. THREE pure helper functions, all exported:

\`\`\`
export function shouldReplan(
  ev: EvaluationResult,
  state: { replansUsed: number; lastReplanWasNoOp: boolean },
  cfg: AdaptiveResolvedConfig
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
  maxBytes: number
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
\`\`\`

DO NOT write the AdaptiveDriver class in this task. DO NOT import from child_process. No fs imports, no logger imports — helpers only.

Import style: ESM, .js extensions (even though this file has no relative imports, the module stays ESM-consistent).

=== PART B — tests/unit/AdaptiveDriver.helpers.test.ts ===

Create a new vitest file testing the three helpers. Use this structure (adapt as needed for exactness, this is a faithful spec):

\`\`\`
import { describe, it, expect } from "vitest";
import {
  shouldReplan,
  isNoOpDiff,
  truncateDiff,
  ADAPTIVE_DEFAULTS,
  type EvaluationResult,
  type AdaptiveResolvedConfig,
} from "../../src/lib/AdaptiveDriver.js";

describe("shouldReplan", () => {
  const baseCfg: AdaptiveResolvedConfig = { confidenceThreshold: 0.7, maxReplans: 3, diffMaxBytes: 1024 };
  const baseEval = (over: Partial<EvaluationResult> = {}): EvaluationResult => ({
    planStillValid: true, surprises: [], confidence: 0.95, notes: "", ...over,
  });

  it("returns below-threshold when plan valid, high confidence, no surprises", () => {
    const out = shouldReplan(baseEval(), { replansUsed: 0, lastReplanWasNoOp: false }, baseCfg);
    expect(out).toEqual({ run: false, reason: "below-threshold" });
  });

  it("returns run=true when plan declared invalid", () => {
    const out = shouldReplan(baseEval({ planStillValid: false }), { replansUsed: 0, lastReplanWasNoOp: false }, baseCfg);
    expect(out).toEqual({ run: true });
  });

  it("returns run=true when confidence below threshold", () => {
    const out = shouldReplan(baseEval({ confidence: 0.5 }), { replansUsed: 0, lastReplanWasNoOp: false }, baseCfg);
    expect(out).toEqual({ run: true });
  });

  it("returns run=true when surprises non-empty", () => {
    const out = shouldReplan(baseEval({ surprises: ["x"] }), { replansUsed: 0, lastReplanWasNoOp: false }, baseCfg);
    expect(out).toEqual({ run: true });
  });

  it("returns budget-exhausted when replansUsed == maxReplans", () => {
    const out = shouldReplan(baseEval({ surprises: ["x"] }), { replansUsed: 3, lastReplanWasNoOp: false }, baseCfg);
    expect(out).toEqual({ run: false, reason: "budget-exhausted" });
  });

  it("returns budget-exhausted when replansUsed > maxReplans", () => {
    const out = shouldReplan(baseEval({ surprises: ["x"] }), { replansUsed: 4, lastReplanWasNoOp: false }, baseCfg);
    expect(out).toEqual({ run: false, reason: "budget-exhausted" });
  });

  it("returns convergence when lastReplanWasNoOp even if surprises present", () => {
    const out = shouldReplan(baseEval({ surprises: ["x"] }), { replansUsed: 0, lastReplanWasNoOp: true }, baseCfg);
    expect(out).toEqual({ run: false, reason: "convergence" });
  });

  it("budget exhaustion precedes convergence precedes threshold", () => {
    // Both lastReplanWasNoOp and budget exhausted → budget-exhausted reported first
    const out = shouldReplan(baseEval({ surprises: ["x"] }), { replansUsed: 3, lastReplanWasNoOp: true }, baseCfg);
    expect(out).toEqual({ run: false, reason: "budget-exhausted" });
  });
});

describe("isNoOpDiff", () => {
  it("returns true for structurally identical task arrays", () => {
    expect(isNoOpDiff([{ id: "a" }, { id: "b" }], [{ id: "a" }, { id: "b" }])).toBe(true);
  });
  it("returns false when task order changes", () => {
    expect(isNoOpDiff([{ id: "a" }, { id: "b" }], [{ id: "b" }, { id: "a" }])).toBe(false);
  });
  it("returns false when a task is added", () => {
    expect(isNoOpDiff([{ id: "a" }], [{ id: "a" }, { id: "b" }])).toBe(false);
  });
  it("returns false when a field changes", () => {
    expect(isNoOpDiff([{ id: "a", title: "x" }], [{ id: "a", title: "y" }])).toBe(false);
  });
  it("returns true for two empty arrays", () => {
    expect(isNoOpDiff([], [])).toBe(true);
  });
});

describe("truncateDiff", () => {
  it("returns full patch untouched when under limit", () => {
    const out = truncateDiff("abc", ["f1"], 100);
    expect(out.truncated).toBe(false);
    expect(out.patch).toBe("abc");
    expect(out.fullSizeBytes).toBe(3);
    expect(out.filesChanged).toEqual(["f1"]);
  });
  it("returns exact patch when size equals limit", () => {
    const out = truncateDiff("abcd", ["f1"], 4);
    expect(out.truncated).toBe(false);
    expect(out.patch).toBe("abcd");
  });
  it("truncates and sets truncated flag when over limit", () => {
    const out = truncateDiff("abcdefghij", ["f1", "f2"], 4);
    expect(out.truncated).toBe(true);
    expect(Buffer.byteLength(out.patch, "utf8")).toBeLessThanOrEqual(4);
    expect(out.fullSizeBytes).toBe(10);
    expect(out.filesChanged).toEqual(["f1", "f2"]);
  });
  it("preserves full filesChanged list even when patch truncated", () => {
    const patch = "x".repeat(1000);
    const files = ["a.ts", "b.ts", "c.ts"];
    const out = truncateDiff(patch, files, 10);
    expect(out.filesChanged).toEqual(files);
    expect(out.truncated).toBe(true);
  });
});

describe("ADAPTIVE_DEFAULTS", () => {
  it("exports the documented defaults", () => {
    expect(ADAPTIVE_DEFAULTS).toEqual({ confidenceThreshold: 0.7, maxReplans: 5, diffMaxBytes: 32768 });
  });
});
\`\`\`

DO NOT test AdaptiveDriver class behavior here — it doesn't exist yet. Only the three pure helpers + defaults.`,
    },
    {
        id: "t3b-adaptive-driver-class",
        title: "Add AdaptiveDriver class + default Spawner/GitOps + mock-spawner unit tests",
        dependsOn: ["t3a-adaptive-driver-helpers"],
        files: [
            { path: "src/lib/AdaptiveDriver.ts", action: "edit" },
            { path: "tests/unit/AdaptiveDriver.test.ts", action: "create" },
        ],
        verify: "npx vitest run tests/unit/AdaptiveDriver.test.ts",
        instructions: `Extend src/lib/AdaptiveDriver.ts with the class + default dep implementations, and create its unit test file.

=== PART A — src/lib/AdaptiveDriver.ts ===

APPEND to the existing file (do NOT touch the types or helper functions already there).

1. Add imports at the TOP of the file (preserving the file header comment from t3a):

\`\`\`
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { ConfigManager } from "./ConfigManager.js";
import { Logger } from "./Logger.js";
import { HumanReporter, NullHumanReporter } from "./HumanReporter.js";
import { EVALUATE_PROMPT, REPLAN_PROMPT } from "./PromptTemplates.js";
\`\`\`

2. Add the DEFAULT Spawner below the helpers, above the class:

\`\`\`
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
\`\`\`

3. Add the DEFAULT GitOps below:

\`\`\`
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
        throw new Error(\`adaptive requires a git working tree; '\${cwd}' is not inside one\`);
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
      const filesChanged = names.stdout.split("\\n").map((s) => s.trim()).filter(Boolean);
      return { fullPatch: patch.stdout, filesChanged };
    },
  };
}
\`\`\`

4. Add the AdaptiveDriver class below:

\`\`\`
export interface AdaptiveDriverDeps {
  configManager: ConfigManager;
  logger: Logger;
  humanReporter?: HumanReporter;
  adaptiveDataDir: string;
  spawner?: Spawner;
  gitOps?: GitOps;
}

export class AdaptiveDriver {
  private configManager: ConfigManager;
  private logger: Logger;
  private humanReporter: HumanReporter;
  private adaptiveDataDir: string;
  private spawner: Spawner;
  private gitOps: GitOps;

  constructor(deps: AdaptiveDriverDeps) {
    this.configManager = deps.configManager;
    this.logger = deps.logger;
    this.humanReporter = deps.humanReporter ?? new NullHumanReporter();
    this.adaptiveDataDir = deps.adaptiveDataDir;
    this.spawner = deps.spawner ?? createDefaultSpawner();
    this.gitOps = deps.gitOps ?? createDefaultGitOps();
  }

  async run(input: AdaptiveInput): Promise<AdaptiveResult> {
    const cwd = input.cwd ?? process.cwd();
    const cfg = this.resolveConfig(input);
    const runId = this.generateRunId();
    await fs.mkdir(this.adaptiveDataDir, { recursive: true });
    const stateFilePath = path.join(this.adaptiveDataDir, \`\${runId}.json\`);

    // 1. Plan
    const plannerName = this.configManager.getDefaultPlanner();
    const planEntry = this.configManager.getCommand(plannerName);
    const planRes = await this.spawner({
      subcommand: "plan",
      argv: ["--prompt", input.prompt],
      cwd,
      env: { ...process.env, ...(planEntry.env ?? {}) },
    });
    if (planRes.exitCode !== 0) {
      throw new Error(\`adaptive: plan subprocess failed (exit \${planRes.exitCode}): \${planRes.stderr.slice(-500)}\`);
    }
    const plan = this.parsePlanFromPlannerStdout(planRes.stdout);

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
    while (state.remainingTasks.length > 0) {
      const task = state.remainingTasks[0] as { id: string; [k: string]: unknown };

      const preSnap = await this.gitOps.snapshot(cwd);
      const singleTaskPlanPath = await this.writeSingleTaskPlan(runId, task);
      const execRes = await this.spawner({
        subcommand: "implement",
        argv: ["--plan-file", singleTaskPlanPath],
        cwd,
        env: { ...process.env },
      });
      const postSnap = await this.gitOps.snapshot(cwd);
      const diffRaw = await this.gitOps.diff(preSnap, postSnap, cwd);
      const implementation = truncateDiff(diffRaw.fullPatch, diffRaw.filesChanged, cfg.diffMaxBytes);

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
      const evalRes = await this.spawner({
        subcommand: "single-prompt",
        argv: ["--prompt", evalPrompt],
        cwd,
        env: { ...process.env, ...(evaluatorEntry.env ?? {}) },
      });
      const evaluation = this.parseEvaluation(evalRes.stdout);
      state.evaluations.push(evaluation);

      const decision = shouldReplan(evaluation, { replansUsed: state.replansUsed, lastReplanWasNoOp: state.lastReplanWasNoOp }, cfg);
      if (decision.run) {
        const replannerName = this.configManager.getDefaultReplanner();
        const replannerEntry = this.configManager.getCommand(replannerName);
        const replanPrompt = this.renderReplanPrompt({
          cwd,
          goal: state.goal,
          completedTasks: state.completedTasks,
          remainingTasks: state.remainingTasks,
          surprises: evaluation.surprises,
        });
        const replanRes = await this.spawner({
          subcommand: "single-prompt",
          argv: ["--prompt", replanPrompt],
          cwd,
          env: { ...process.env, ...(replannerEntry.env ?? {}) },
        });
        const newRemaining = this.parseReplan(replanRes.stdout);
        if (isNoOpDiff(state.remainingTasks, newRemaining)) {
          state.lastReplanWasNoOp = true;
          state.replans.push({ taskId: task.id, ran: false, skipReason: "convergence" });
        } else {
          state.replans.push({ taskId: task.id, ran: true, before: state.remainingTasks, after: newRemaining });
          state.remainingTasks = newRemaining;
          state.replansUsed += 1;
          state.lastReplanWasNoOp = false;
          await this.writeState(stateFilePath, state);
          continue; // Re-evaluate head of new remaining on next loop iteration without advancing
        }
      } else {
        state.replans.push({ taskId: task.id, ran: false, skipReason: decision.reason });
      }

      // Advance: the task at head was executed; pop it.
      state.completedTasks.push(task);
      state.remainingTasks = state.remainingTasks.slice(1);
      await this.writeState(stateFilePath, state);
    }

    return {
      runId,
      stateFilePath,
      tasksRun: state.completedTasks.length,
      replansRun: state.replans.filter((r) => r.ran).length,
      replansSkipped: state.replans.filter((r) => !r.ran).length,
      finalPlan: state.completedTasks,
    };
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
    await fs.writeFile(filePath, JSON.stringify(state, null, 2) + "\\n", "utf8");
  }

  private async writeSingleTaskPlan(runId: string, task: unknown): Promise<string> {
    const tmpDir = path.join(this.adaptiveDataDir, "tmp");
    await fs.mkdir(tmpDir, { recursive: true });
    const planPath = path.join(tmpDir, \`\${runId}-task-\${Date.now()}.json\`);
    const inner = {
      planId: \`\${runId}-single-task\`,
      tasks: [task],
    };
    const envelope = {
      id: \`\${runId}-inner\`,
      createdAt: new Date().toISOString(),
      prompt: "",
      command: "",
      sessionId: runId,
      content: JSON.stringify(inner),
    };
    await fs.writeFile(planPath, JSON.stringify(envelope, null, 2) + "\\n", "utf8");
    return planPath;
  }

  private parsePlanFromPlannerStdout(stdout: string): { tasks: unknown[] } {
    // Planner's stdout is a JSON envelope: { sessionId, finalOutput: "<plan JSON string>", ... }
    const parsed = JSON.parse(stdout) as { finalOutput?: string | null };
    const planStr = parsed.finalOutput;
    if (!planStr) throw new Error("adaptive: planner produced no finalOutput");
    const plan = JSON.parse(planStr) as { tasks?: unknown };
    if (!Array.isArray(plan.tasks)) throw new Error("adaptive: parsed plan has no tasks array");
    return { tasks: plan.tasks };
  }

  private parseEvaluation(stdout: string): EvaluationResult {
    const envelope = JSON.parse(stdout) as { finalOutput?: string | null };
    const raw = envelope.finalOutput ?? stdout;
    const trimmed = this.stripFences(raw.trim());
    const obj = JSON.parse(trimmed) as Partial<EvaluationResult>;
    return {
      planStillValid: Boolean(obj.planStillValid),
      surprises: Array.isArray(obj.surprises) ? obj.surprises.map(String) : [],
      confidence: typeof obj.confidence === "number" ? obj.confidence : 0,
      notes: typeof obj.notes === "string" ? obj.notes : "",
    };
  }

  private parseReplan(stdout: string): unknown[] {
    const envelope = JSON.parse(stdout) as { finalOutput?: string | null };
    const raw = envelope.finalOutput ?? stdout;
    const trimmed = this.stripFences(raw.trim());
    const obj = JSON.parse(trimmed) as { remainingTasks?: unknown };
    if (!Array.isArray(obj.remainingTasks)) throw new Error("adaptive: replan output missing remainingTasks array");
    return obj.remainingTasks;
  }

  private stripFences(s: string): string {
    const m = s.match(/\`\`\`(?:json)?\\s*\\n([\\s\\S]*?)\\n\`\`\`/);
    return m ? (m[1] ?? s) : s;
  }

  private renderEvaluatePrompt(ctx: { cwd: string; goal: string; task: unknown; implementation: ImplementationDiff; executionExitCode: number | null; remainingPlan: unknown[] }): string {
    const body = JSON.stringify({
      goal: ctx.goal,
      task: ctx.task,
      implementation: ctx.implementation,
      executionExitCode: ctx.executionExitCode,
      remainingPlan: ctx.remainingTasks,
    }, null, 2);
    return EVALUATE_PROMPT.replace(/{{CWD}}/g, ctx.cwd) + "\\n" + body;
  }

  private renderReplanPrompt(ctx: { cwd: string; goal: string; completedTasks: unknown[]; remainingTasks: unknown[]; surprises: string[] }): string {
    const body = JSON.stringify({
      goal: ctx.goal,
      completedTasks: ctx.completedTasks,
      remainingTasks: ctx.remainingTasks,
      surprises: ctx.surprises,
    }, null, 2);
    return REPLAN_PROMPT.replace(/{{CWD}}/g, ctx.cwd) + "\\n" + body;
  }
}
\`\`\`

ALL of the above is additive. DO NOT modify the helpers or types from t3a.

=== PART B — tests/unit/AdaptiveDriver.test.ts ===

Unit test the driver with a MOCK spawner and MOCK gitOps (zero real subprocess, zero real git). Core scenarios to cover:

1. Happy path with one task and no surprises: verify spawner is called in the right order (plan → implement → single-prompt eval), state file is written with tasksRun=1, replans all skipped with reason "below-threshold", replansRun=0.
2. Replan triggered once: eval returns surprises, replan returns modified remaining; assert state.replans has a ran:true entry with before/after, replansUsed=1, tasksRun eventually matches number of task executions (the replanned remaining drives subsequent iterations — keep the plan small, e.g. 2 tasks that become 2 different tasks).
3. Budget exhaustion: maxReplans=0 in config, eval returns surprises → decision reason "budget-exhausted", replansRun=0, replansSkipped matches.
4. Convergence: first replan produces no-op remaining → lastReplanWasNoOp flag set; on next iteration (same surprise) decision reason is "convergence".
5. Config fallback: no CLI override, no adaptive.confidenceThreshold → uses ADAPTIVE_DEFAULTS.confidenceThreshold.

**Mock strategy**: Build a test helper that creates a fake ConfigManager (minimal — only getCommand/getDefaultPlanner/getDefaultEvaluator/getDefaultReplanner/getAdaptiveConfig are called). Use the existing tests/fixtures/adaptive-config.test.json as a fallback for config paths where needed, OR construct a real ConfigManager pointing at a temp config file written per-test. Prefer the latter — it's more faithful.

**Output envelope shape for mocks**: spawner results must be \`{ exitCode, stdout, stderr }\`. The driver parses \`stdout\` as \`{ finalOutput: "<string>" }\` for plan/evaluate/replan subprocesses (that's galloper's stdout contract). So your fake stdout strings should look like:

- For plan: \`JSON.stringify({ finalOutput: JSON.stringify({ planId: "p1", tasks: [ {id:"t1", title:"...", files:[], instructions:"...", verify:"true", dependsOn:[]} ] }) })\`
- For single-prompt eval: \`JSON.stringify({ finalOutput: JSON.stringify({ planStillValid: true, surprises: [], confidence: 0.95, notes: "" }) })\`
- For single-prompt replan: \`JSON.stringify({ finalOutput: JSON.stringify({ remainingTasks: [...] }) })\`
- For implement: stdout can be anything; only exitCode is inspected by the driver.

**GitOps mock**: trivial — snapshot returns "pre" / "post" strings; diff returns empty patch + empty filesChanged.

**State file path**: pass a per-test temp dir via the \`adaptiveDataDir\` dep (use \`mkdtempSync\`). Clean up in afterEach.

Structure:

\`\`\`
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { AdaptiveDriver, type Spawner, type GitOps } from "../../src/lib/AdaptiveDriver.js";
import { ConfigManager } from "../../src/lib/ConfigManager.js";
import { Logger } from "../../src/lib/Logger.js";

function planEnvelope(tasks: unknown[]): string {
  return JSON.stringify({ finalOutput: JSON.stringify({ planId: "p1", tasks }) });
}
function evalEnvelope(ev: unknown): string {
  return JSON.stringify({ finalOutput: JSON.stringify(ev) });
}
function replanEnvelope(remainingTasks: unknown[]): string {
  return JSON.stringify({ finalOutput: JSON.stringify({ remainingTasks }) });
}

const GIT_OPS_MOCK: GitOps = {
  async snapshot() { return "snap"; },
  async diff() { return { fullPatch: "", filesChanged: [] }; },
};

// Write a minimal config with adaptive knobs the driver needs
function writeConfig(dir: string, adaptive?: Record<string, unknown>): string {
  const configPath = path.join(dir, "galloper.json");
  writeFileSync(configPath, JSON.stringify({
    default: "mock",
    defaultPlanner: "mock",
    commands: {
      mock: { command: "true", allowedSubcommands: [], disallowedSubcommands: [] },
    },
    ...(adaptive ? { adaptive } : {}),
  }));
  return configPath;
}

describe("AdaptiveDriver", () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = mkdtempSync(path.join(tmpdir(), "adaptive-")); });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  it("happy path: plan → implement → evaluate below threshold → complete", async () => {
    const configPath = writeConfig(tmpDir);
    const configManager = new ConfigManager({ configPath });
    await configManager.load();
    const logger = new Logger({ logsDir: tmpDir, centralLogPath: path.join(tmpDir, "log.jsonl") });

    const calls: string[] = [];
    const spawner: Spawner = async ({ subcommand }) => {
      calls.push(subcommand);
      if (subcommand === "plan") {
        return { exitCode: 0, stdout: planEnvelope([
          { id: "t1", title: "Task 1", files: [], instructions: "do", verify: "true", dependsOn: [] },
        ]), stderr: "" };
      }
      if (subcommand === "implement") {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      // single-prompt: decide evaluator vs replanner by number of eval calls seen
      return { exitCode: 0, stdout: evalEnvelope({ planStillValid: true, surprises: [], confidence: 0.95, notes: "" }), stderr: "" };
    };

    const driver = new AdaptiveDriver({ configManager, logger, adaptiveDataDir: tmpDir, spawner, gitOps: GIT_OPS_MOCK });
    const res = await driver.run({ prompt: "goal" });

    expect(res.tasksRun).toBe(1);
    expect(res.replansRun).toBe(0);
    expect(res.replansSkipped).toBeGreaterThanOrEqual(1);
    expect(calls.filter(c => c === "plan").length).toBe(1);
    expect(calls.filter(c => c === "implement").length).toBe(1);

    const state = JSON.parse(readFileSync(res.stateFilePath, "utf8"));
    expect(state.completedTasks.length).toBe(1);
    expect(state.remainingTasks.length).toBe(0);
    expect(state.evaluations.length).toBe(1);
    const replanEntry = state.replans.find((r: {taskId: string}) => r.taskId === "t1");
    expect(replanEntry.ran).toBe(false);
    expect(replanEntry.skipReason).toBe("below-threshold");
  });

  it("forced replan: eval surprises → replan replaces remaining with different tasks", async () => {
    const configPath = writeConfig(tmpDir, { maxReplans: 3, confidenceThreshold: 0.7 });
    const configManager = new ConfigManager({ configPath });
    await configManager.load();
    const logger = new Logger({ logsDir: tmpDir, centralLogPath: path.join(tmpDir, "log.jsonl") });

    let singlePromptCall = 0;
    let replanDone = false;
    const spawner: Spawner = async ({ subcommand }) => {
      if (subcommand === "plan") {
        return { exitCode: 0, stdout: planEnvelope([
          { id: "t1", title: "Task 1", files: [], instructions: "do", verify: "true", dependsOn: [] },
        ]), stderr: "" };
      }
      if (subcommand === "implement") return { exitCode: 0, stdout: "", stderr: "" };
      // single-prompt: alternate eval → replan → eval → eval ...
      singlePromptCall += 1;
      if (singlePromptCall === 1) {
        return { exitCode: 0, stdout: evalEnvelope({ planStillValid: false, surprises: ["missing dep"], confidence: 0.5, notes: "" }), stderr: "" };
      }
      if (singlePromptCall === 2 && !replanDone) {
        replanDone = true;
        return { exitCode: 0, stdout: replanEnvelope([
          { id: "t2", title: "Replanned task", files: [], instructions: "do2", verify: "true", dependsOn: [] },
        ]), stderr: "" };
      }
      // Subsequent evals pass below-threshold
      return { exitCode: 0, stdout: evalEnvelope({ planStillValid: true, surprises: [], confidence: 0.95, notes: "" }), stderr: "" };
    };

    const driver = new AdaptiveDriver({ configManager, logger, adaptiveDataDir: tmpDir, spawner, gitOps: GIT_OPS_MOCK });
    const res = await driver.run({ prompt: "goal" });

    expect(res.replansRun).toBe(1);
    const state = JSON.parse(readFileSync(res.stateFilePath, "utf8"));
    const ranReplan = state.replans.find((r: {ran: boolean}) => r.ran);
    expect(ranReplan).toBeTruthy();
    expect(ranReplan.after[0].id).toBe("t2");
  });

  it("budget exhausted: maxReplans=0 + surprises → replan.skipped reason budget-exhausted", async () => {
    const configPath = writeConfig(tmpDir, { maxReplans: 0 });
    const configManager = new ConfigManager({ configPath });
    await configManager.load();
    const logger = new Logger({ logsDir: tmpDir, centralLogPath: path.join(tmpDir, "log.jsonl") });

    const spawner: Spawner = async ({ subcommand }) => {
      if (subcommand === "plan") {
        return { exitCode: 0, stdout: planEnvelope([
          { id: "t1", title: "Task 1", files: [], instructions: "do", verify: "true", dependsOn: [] },
        ]), stderr: "" };
      }
      if (subcommand === "implement") return { exitCode: 0, stdout: "", stderr: "" };
      return { exitCode: 0, stdout: evalEnvelope({ planStillValid: false, surprises: ["s"], confidence: 0.3, notes: "" }), stderr: "" };
    };

    const driver = new AdaptiveDriver({ configManager, logger, adaptiveDataDir: tmpDir, spawner, gitOps: GIT_OPS_MOCK });
    const res = await driver.run({ prompt: "goal" });

    expect(res.replansRun).toBe(0);
    const state = JSON.parse(readFileSync(res.stateFilePath, "utf8"));
    const skip = state.replans.find((r: {skipReason: string}) => r.skipReason);
    expect(skip.skipReason).toBe("budget-exhausted");
  });

  it("convergence: noop replan → next gate short-circuits with convergence", async () => {
    const configPath = writeConfig(tmpDir, { maxReplans: 5 });
    const configManager = new ConfigManager({ configPath });
    await configManager.load();
    const logger = new Logger({ logsDir: tmpDir, centralLogPath: path.join(tmpDir, "log.jsonl") });

    let sp = 0;
    const spawner: Spawner = async ({ subcommand }) => {
      if (subcommand === "plan") {
        return { exitCode: 0, stdout: planEnvelope([
          { id: "t1", title: "Task 1", files: [], instructions: "do", verify: "true", dependsOn: [] },
          { id: "t2", title: "Task 2", files: [], instructions: "do", verify: "true", dependsOn: [] },
        ]), stderr: "" };
      }
      if (subcommand === "implement") return { exitCode: 0, stdout: "", stderr: "" };
      sp += 1;
      // Call 1: eval says surprise. Call 2: replan returns SAME remaining (no-op).
      // Call 3: eval (on t1 after noop) says surprise again → gate convergence.
      // Call 4: eval on t2 below threshold.
      if (sp === 1) return { exitCode: 0, stdout: evalEnvelope({ planStillValid: false, surprises: ["a"], confidence: 0.5, notes: "" }), stderr: "" };
      if (sp === 2) return { exitCode: 0, stdout: replanEnvelope([
        { id: "t1", title: "Task 1", files: [], instructions: "do", verify: "true", dependsOn: [] },
        { id: "t2", title: "Task 2", files: [], instructions: "do", verify: "true", dependsOn: [] },
      ]), stderr: "" };
      if (sp === 3) return { exitCode: 0, stdout: evalEnvelope({ planStillValid: false, surprises: ["a"], confidence: 0.5, notes: "" }), stderr: "" };
      return { exitCode: 0, stdout: evalEnvelope({ planStillValid: true, surprises: [], confidence: 0.95, notes: "" }), stderr: "" };
    };

    const driver = new AdaptiveDriver({ configManager, logger, adaptiveDataDir: tmpDir, spawner, gitOps: GIT_OPS_MOCK });
    const res = await driver.run({ prompt: "goal" });

    const state = JSON.parse(readFileSync(res.stateFilePath, "utf8"));
    const convergence = state.replans.find((r: {skipReason: string}) => r.skipReason === "convergence");
    expect(convergence).toBeTruthy();
  });
});
\`\`\`

Test requirements:
- All four scenarios must pass.
- No real \`git\` calls, no real subprocess spawns — gitOps and spawner are BOTH mocked.
- State file assertions use \`readFileSync\` to re-parse the on-disk JSON; don't rely on internal state.
- If the exact spawner-call-count or ordering in the replan/convergence tests is hard to get right on the first try, it is ACCEPTABLE to adjust the mock's call counter arithmetic, but do not change the driver logic — fix the mock.`,
    },
    {
        id: "t4a-cli-subcommand-adaptive",
        title: "Extend SubcommandName and KNOWN_SUBCOMMANDS with 'adaptive'; add CLI flag parsing",
        dependsOn: ["t3b-adaptive-driver-class"],
        files: [
            { path: "src/lib/Orchestrator.ts", action: "edit" },
            { path: "src/lib/Doctor.ts", action: "edit" },
            { path: "src/run-llm-session.ts", action: "edit" },
        ],
        verify: "npm run build",
        instructions: `Three small edits, all additive. DO NOT change existing behavior for the other subcommands.

=== src/lib/Orchestrator.ts ===

1. Add 'adaptive' to the SubcommandName union and SUBCOMMANDS array:

\`\`\`
export type SubcommandName = 'single-prompt' | 'plan' | 'implement' | 'pipeline' | 'adaptive';
export const SUBCOMMANDS: readonly SubcommandName[] = ['single-prompt', 'plan', 'implement', 'pipeline', 'adaptive'] as const;
\`\`\`

2. Add optional fields to OrchestratorInput for the adaptive flags:

\`\`\`
export interface OrchestratorInput {
  subcommand: SubcommandName;
  prompt?: string;
  planFile?: string;
  env: NodeJS.ProcessEnv;
  cwd?: string;
  verbosity?: VerbosityLevel;
  concurrency?: number;
  confidenceThreshold?: number;  // NEW
  maxReplans?: number;            // NEW
  diffMaxBytes?: number;          // NEW
}
\`\`\`

DO NOT add routing for the 'adaptive' subcommand in this task — that's t4b. The current Orchestrator.execute() will fall through to the existing error if adaptive is requested; that is acceptable for this task.

=== src/lib/Doctor.ts ===

Add 'adaptive' to KNOWN_SUBCOMMANDS:

\`\`\`
export const KNOWN_SUBCOMMANDS = ['single-prompt', 'plan', 'implement', 'pipeline', 'adaptive'] as const;
\`\`\`

=== src/run-llm-session.ts ===

Read the file first. The CLI parser is argument-driven. Make these changes:

1. In the usage help text around line 47-76, add a line for the adaptive subcommand near the others, e.g.:

\`\`\`
  adaptive          Run an adaptive plan-execute-evaluate-replan loop
\`\`\`

And an example in the examples section:

\`\`\`
  galloper adaptive --prompt "Build and adapt a plan" --max-replans 3
\`\`\`

2. In the arg parser loop, add handlers for the three new flags:

- \`--confidence-threshold <n>\`  → parseFloat, store on parsed.confidenceThreshold
- \`--max-replans <n>\`           → parseInt, store on parsed.maxReplans
- \`--diff-max-bytes <n>\`        → parseInt, store on parsed.diffMaxBytes

Use the existing pattern the file already uses for numeric flags (check how \`-v\` / \`--concurrency\` are parsed). Store them on the \`parsed\` CliArgs object. Extend the CliArgs interface at the top of the file to include the new optional fields (numbers).

3. Where the parser assembles the OrchestratorInput (near line 309), forward the three fields if present.

4. Validation: for 'adaptive' subcommand, require --prompt (or --prompt-file). Pattern: do the same check plan/pipeline do. If prompt missing, throw 'adaptive subcommand requires --prompt or --prompt-file'.

DO NOT change any logic for the existing subcommands' flags. DO NOT add --plan-file support for 'adaptive' (adaptive generates its own plan internally).

Out of scope: Orchestrator.execute() routing to AdaptiveDriver — that is t4b.`,
    },
    {
        id: "t4b-orchestrator-adaptive-route",
        title: "Route 'adaptive' subcommand to AdaptiveDriver from Orchestrator",
        dependsOn: ["t4a-cli-subcommand-adaptive"],
        files: [
            { path: "src/lib/Orchestrator.ts", action: "edit" },
            { path: "tests/unit/Orchestrator.test.ts", action: "edit" },
        ],
        verify: "npx vitest run tests/unit/Orchestrator.test.ts",
        instructions: `=== src/lib/Orchestrator.ts ===

1. Add the import at the top:

\`\`\`
import { AdaptiveDriver, type AdaptiveResult } from './AdaptiveDriver.js';
\`\`\`

2. Inside Orchestrator.execute() where the other subcommand routes are (look for \`if (input.subcommand === 'plan')\` etc.), add BEFORE the fallback single-prompt branch:

\`\`\`
if (input.subcommand === 'adaptive') {
  return this.executeAdaptive(input);
}
\`\`\`

3. Add the private method \`executeAdaptive\` at the bottom of the class (before the closing brace). The shape:

\`\`\`
private async executeAdaptive(input: OrchestratorInput): Promise<OrchestratorResult> {
  if (!input.prompt) {
    throw new Error('adaptive subcommand requires --prompt or --prompt-file');
  }
  const cwd = input.cwd ?? process.cwd();
  const adaptiveDataDir = path.join(this.dataDir, 'adaptive');
  const driver = new AdaptiveDriver({
    configManager: this.configManager,
    logger: this.logger,
    humanReporter: this.humanReporter,
    adaptiveDataDir,
  });
  const sessionId = new Date().toISOString().replace(/[:.]/g, '-');
  await this.logger.append({
    sessionId,
    type: 'run.started',
    timestamp: new Date().toISOString(),
    subcommand: 'adaptive',
    minLevel: 1,
    message: '[adaptive] Starting adaptive loop',
  });
  let result: AdaptiveResult;
  try {
    result = await driver.run({
      prompt: input.prompt,
      confidenceThreshold: input.confidenceThreshold,
      maxReplans: input.maxReplans,
      diffMaxBytes: input.diffMaxBytes,
      cwd,
    });
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    await this.logger.append({
      sessionId,
      type: 'run.failed',
      timestamp: new Date().toISOString(),
      error: errMsg,
      minLevel: 1,
      message: \`[adaptive] Failed: \${errMsg}\`,
    });
    throw error;
  }
  await this.logger.append({
    sessionId,
    type: 'run.completed',
    timestamp: new Date().toISOString(),
    runId: result.runId,
    stateFilePath: result.stateFilePath,
    tasksRun: result.tasksRun,
    replansRun: result.replansRun,
    replansSkipped: result.replansSkipped,
    minLevel: 1,
    message: \`[adaptive] Completed: \${result.tasksRun} tasks, \${result.replansRun} replans, \${result.replansSkipped} skipped\`,
  });
  return {
    sessionId,
    sessionFilePath: result.stateFilePath,
    exitCode: 0,
    finalOutput: JSON.stringify(result, null, 2),
  };
}
\`\`\`

Do NOT break any other subcommand's behavior. Reuse the import of \`path\` from node:path already present in the file.

=== tests/unit/Orchestrator.test.ts ===

Read the file first — match the existing test patterns for module-level imports, setup, and assertion style.

APPEND ONE new test (or a small \`describe("Orchestrator adaptive", () => { ... })\` block) covering: Orchestrator.execute() with subcommand='adaptive' routes through AdaptiveDriver. Strategy: monkey-patch \`AdaptiveDriver.prototype.run\` (via \`vi.spyOn\`) to return a canned AdaptiveResult, then call Orchestrator.execute and assert the returned OrchestratorResult contains { exitCode: 0, sessionFilePath: <the stubbed stateFilePath> } and a non-empty finalOutput.

If the existing Orchestrator test file doesn't already import vi from vitest, add it. Do NOT modify existing tests.

Out of scope: CLI parsing (already done in t4a), docs (t5).`,
    },
    {
        id: "t5-docs",
        title: "Document the adaptive subcommand in CLAUDE.md",
        dependsOn: ["t4b-orchestrator-adaptive-route"],
        files: [{ path: "CLAUDE.md", action: "edit" }],
        verify: "npm run build",
        instructions: `Read CLAUDE.md first. The "CLI Usage" code block ALREADY includes an 'adaptive' example line (see the \`# adaptive: ...\` comment around the pipeline example). Do NOT add a duplicate. Only add the content listed below that is not yet present.

Edits:

1. SKIP if already present: The "CLI Usage" code block should contain one \`# adaptive: plan, execute each task, evaluate diff, replan when signaled\` line followed by an \`npm run run -- adaptive ...\` example. If it's already there (it should be), do not modify that block.

2. Add a new "### Adaptive Subcommand" heading BETWEEN the existing subcommand doc sections (after Pipeline, before Doctor is a natural spot; or wherever reads cleanly). Content:

- **Purpose**: run a plan as an adaptive loop. For each task: execute, evaluate the resulting git diff, replan the REMAINING tasks when the evaluator flags the plan as no longer valid.
- **Requires**: git working tree (v1 is git-only).
- **Subprocess model**: self-spawns \`galloper plan\` (once), \`galloper implement\` (per task), and \`galloper single-prompt\` (for evaluate and replan). Existing config commands apply.
- **Flags**:
  - \`--confidence-threshold <n>\` (float, 0..1) — evaluator confidence below this triggers a replan; default 0.7.
  - \`--max-replans <n>\` (non-negative int) — hard cap; default 5.
  - \`--diff-max-bytes <n>\` (positive int) — patch is truncated beyond this; file list is always preserved. Default 32768.
- **State file**: each run writes \`galloper-data/adaptive/<runId>.json\` with the full execution trace: plan, evaluations[], replans[], completedTasks[], remainingTasks[], replansUsed, lastReplanWasNoOp.
- **Gate logic**: a replan is skipped with a recorded reason when any of:
  - \`replansUsed >= maxReplans\` → \`budget-exhausted\`
  - previous replan produced a no-op diff → \`convergence\`
  - evaluator says plan valid + confidence ≥ threshold + no surprises → \`below-threshold\`
- **Replan authority**: can insert remediation tasks AT THE HEAD of remaining, or reorder/drop remaining. Completed tasks are LOCKED and never modified.

3. In the "Command Resolution" section, add a note:

> The \`adaptive\` subcommand uses \`defaultPlanner\` for the initial plan, \`defaultExecutioner\` for each task, and the evaluator/replanner roles resolve via \`adaptive.defaultEvaluator\` / \`adaptive.defaultReplanner\` → \`defaultPlanner\` → \`default\`.

4. In the "galloper.json Format" section, append an example \`adaptive\` block showing the three numeric knobs plus the two role overrides (reference the already-shipped slice-1 fields; do not change them):

\`\`\`
"adaptive": {
  "confidenceThreshold": 0.7,
  "maxReplans": 5,
  "diffMaxBytes": 32768,
  "defaultEvaluator": "claude-haiku",
  "defaultReplanner": "claude-haiku"
}
\`\`\`

DO NOT modify the EVENTS_AND_HOOKS.md file — v1 of adaptive does NOT add new events or lifecycle phases.

DO NOT remove or edit any existing CLAUDE.md content beyond the insertions above.`,
    },
];
const inner = {
    planId: "adaptive-slices-2-through-5",
    prompt: "Implement slices 2–5 of docs/ADAPTIVE_PIPELINE_PLAN.md: the adaptive subcommand as a driver over galloper's own CLI (plan/implement/single-prompt subprocesses). Slice 1 (types/config/doctor) already shipped in commit 72dfd77. No new LogEvent types, no new lifecycle phases, no SessionRecord changes — the driver writes its own state file. Each task is linear-dependent on the previous; keep changes focused to the listed files.",
    tasks,
};
const envelope = { content: JSON.stringify(inner) };
const outPath = join(__dirname, "..", "..", "galloper-data", "plans", "adaptive-slices-2-5.json");
writeFileSync(outPath, JSON.stringify(envelope, null, 2) + "\n", "utf8");
console.log(`wrote ${outPath}`);
console.log(`${tasks.length} tasks, inner size ${JSON.stringify(inner).length} bytes`);
//# sourceMappingURL=build-adaptive-full.js.map