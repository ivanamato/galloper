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
    defaultEvaluator: "mock",
    defaultReplanner: "mock",
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
