import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { AdaptiveDriver, type Spawner, type GitOps } from "../../src/lib/AdaptiveDriver.js";
import { ConfigManager } from "../../src/lib/ConfigManager.js";
import { Logger } from "../../src/lib/Logger.js";
import { HookDispatcher } from "../../src/lib/HookDispatcher.js";

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

async function makeDriverWithSpyDispatcher(tmpDir: string, spawner: Spawner) {
  const configPath = writeConfig(tmpDir);
  const configManager = new ConfigManager({ configPath });
  await configManager.load();
  const logger = new Logger({ logsDir: tmpDir, centralLogPath: path.join(tmpDir, "log.jsonl") });
  const dispatcher = new HookDispatcher({});
  const runPre = vi.spyOn(dispatcher, "runPre");
  const runPost = vi.spyOn(dispatcher, "runPost");
  const dispatchEvent = vi.spyOn(dispatcher, "dispatchEvent");
  const driver = new AdaptiveDriver({
    configManager,
    logger,
    adaptiveDataDir: tmpDir,
    spawner,
    gitOps: GIT_OPS_MOCK,
    hookDispatcher: dispatcher,
    sessionId: "test-session",
  });
  return { driver, runPre, runPost, dispatchEvent };
}

describe("AdaptiveDriver hooks", () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = mkdtempSync(path.join(tmpdir(), "adaptive-hooks-")); });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  it("happy path (single task, no replan): fires the expected pre/post phases and events, but NOT pre-replan/post-replan", async () => {
    const spawner: Spawner = async ({ subcommand }) => {
      if (subcommand === "plan") {
        return { exitCode: 0, stdout: planEnvelope([
          { id: "t1", title: "Task 1", files: [], instructions: "do", verify: "true", dependsOn: [] },
        ]), stderr: "" };
      }
      if (subcommand === "implement") return { exitCode: 0, stdout: "", stderr: "" };
      return { exitCode: 0, stdout: evalEnvelope({ planStillValid: true, surprises: [], confidence: 0.95, notes: "" }), stderr: "" };
    };
    const { driver, runPre, runPost, dispatchEvent } = await makeDriverWithSpyDispatcher(tmpDir, spawner);
    await driver.run({ prompt: "goal" });

    const prePhases = runPre.mock.calls.map(c => c[0]);
    const postPhases = runPost.mock.calls.map(c => c[0]);
    expect(prePhases).toEqual(["pre-iteration", "pre-evaluate"]);
    expect(postPhases).toEqual(["post-evaluate", "post-iteration"]);

    const events = dispatchEvent.mock.calls.map(c => c[0]);
    expect(events).toContain("adaptive.plan.completed");
    expect(events).toContain("adaptive.iteration.started");
    expect(events).toContain("adaptive.evaluation.completed");
    expect(events).toContain("adaptive.replan.decision");
    expect(events).toContain("adaptive.iteration.completed");

    const replanDecision = dispatchEvent.mock.calls.find(c => c[0] === "adaptive.replan.decision");
    expect(replanDecision?.[1]).toMatchObject({ decision: "skipped", reason: "below-threshold" });
  });

  it("forced replan: fires pre-replan and post-replan, and adaptive.replan.decision payload says 'applied'", async () => {
    let sp = 0;
    const spawner: Spawner = async ({ subcommand }) => {
      if (subcommand === "plan") {
        return { exitCode: 0, stdout: planEnvelope([
          { id: "t1", title: "Task 1", files: [], instructions: "do", verify: "true", dependsOn: [] },
        ]), stderr: "" };
      }
      if (subcommand === "implement") return { exitCode: 0, stdout: "", stderr: "" };
      sp += 1;
      if (sp === 1) return { exitCode: 0, stdout: evalEnvelope({ planStillValid: false, surprises: ["x"], confidence: 0.4, notes: "" }), stderr: "" };
      if (sp === 2) return { exitCode: 0, stdout: replanEnvelope([
        { id: "t2", title: "Repaired task", files: [], instructions: "do", verify: "true", dependsOn: [] },
      ]), stderr: "" };
      return { exitCode: 0, stdout: evalEnvelope({ planStillValid: true, surprises: [], confidence: 0.95, notes: "" }), stderr: "" };
    };
    const { driver, runPre, runPost, dispatchEvent } = await makeDriverWithSpyDispatcher(tmpDir, spawner);
    await driver.run({ prompt: "goal" });

    const prePhases = runPre.mock.calls.map(c => c[0]);
    const postPhases = runPost.mock.calls.map(c => c[0]);
    expect(prePhases).toContain("pre-replan");
    expect(postPhases).toContain("post-replan");

    const replanEvents = dispatchEvent.mock.calls.filter(c => c[0] === "adaptive.replan.decision");
    const decisions = replanEvents.map(c => (c[1] as { decision: string }).decision);
    expect(decisions).toContain("applied");
  });

  it("budget exhausted: replan skipped → does NOT fire pre-replan or post-replan", async () => {
    const spawner: Spawner = async ({ subcommand }) => {
      if (subcommand === "plan") {
        return { exitCode: 0, stdout: planEnvelope([
          { id: "t1", title: "Task 1", files: [], instructions: "do", verify: "true", dependsOn: [] },
        ]), stderr: "" };
      }
      if (subcommand === "implement") return { exitCode: 0, stdout: "", stderr: "" };
      return { exitCode: 0, stdout: evalEnvelope({ planStillValid: false, surprises: ["x"], confidence: 0.3, notes: "" }), stderr: "" };
    };
    // tighten the config: maxReplans=0
    writeFileSync(path.join(tmpDir, "galloper.json"), JSON.stringify({
      default: "mock", defaultPlanner: "mock", defaultEvaluator: "mock", defaultReplanner: "mock",
      adaptive: { maxReplans: 0 },
      commands: { mock: { command: "true", allowedSubcommands: [], disallowedSubcommands: [] } },
    }));
    const configManager = new ConfigManager({ configPath: path.join(tmpDir, "galloper.json") });
    await configManager.load();
    const logger = new Logger({ logsDir: tmpDir, centralLogPath: path.join(tmpDir, "log.jsonl") });
    const dispatcher = new HookDispatcher({});
    const runPre = vi.spyOn(dispatcher, "runPre");
    const runPost = vi.spyOn(dispatcher, "runPost");
    const dispatchEvent = vi.spyOn(dispatcher, "dispatchEvent");
    const driver = new AdaptiveDriver({
      configManager, logger, adaptiveDataDir: tmpDir,
      spawner, gitOps: GIT_OPS_MOCK,
      hookDispatcher: dispatcher, sessionId: "test-session",
    });
    await driver.run({ prompt: "goal" });

    const prePhases = runPre.mock.calls.map(c => c[0]);
    const postPhases = runPost.mock.calls.map(c => c[0]);
    expect(prePhases).not.toContain("pre-replan");
    expect(postPhases).not.toContain("post-replan");

    const replanDecision = dispatchEvent.mock.calls.find(c => c[0] === "adaptive.replan.decision");
    expect(replanDecision?.[1]).toMatchObject({ decision: "skipped", reason: "budget-exhausted" });
  });

  it("hook context carries iteration index and the current task", async () => {
    const spawner: Spawner = async ({ subcommand }) => {
      if (subcommand === "plan") {
        return { exitCode: 0, stdout: planEnvelope([
          { id: "t1", title: "T1", files: [], instructions: "x", verify: "true", dependsOn: [] },
          { id: "t2", title: "T2", files: [], instructions: "x", verify: "true", dependsOn: [] },
        ]), stderr: "" };
      }
      if (subcommand === "implement") return { exitCode: 0, stdout: "", stderr: "" };
      return { exitCode: 0, stdout: evalEnvelope({ planStillValid: true, surprises: [], confidence: 0.95, notes: "" }), stderr: "" };
    };
    const { driver, runPre } = await makeDriverWithSpyDispatcher(tmpDir, spawner);
    await driver.run({ prompt: "goal" });

    const preIters = runPre.mock.calls.filter(c => c[0] === "pre-iteration");
    expect(preIters.length).toBe(2);
    expect((preIters[0]?.[1] as { iteration: number; task: { id: string } })).toMatchObject({ iteration: 0, task: { id: "t1" } });
    expect((preIters[1]?.[1] as { iteration: number; task: { id: string } })).toMatchObject({ iteration: 1, task: { id: "t2" } });
  });

  it("driver runs unchanged when no hookDispatcher is provided (back-compat)", async () => {
    const configPath = writeConfig(tmpDir);
    const configManager = new ConfigManager({ configPath });
    await configManager.load();
    const logger = new Logger({ logsDir: tmpDir, centralLogPath: path.join(tmpDir, "log.jsonl") });
    const spawner: Spawner = async ({ subcommand }) => {
      if (subcommand === "plan") {
        return { exitCode: 0, stdout: planEnvelope([
          { id: "t1", title: "T1", files: [], instructions: "x", verify: "true", dependsOn: [] },
        ]), stderr: "" };
      }
      if (subcommand === "implement") return { exitCode: 0, stdout: "", stderr: "" };
      return { exitCode: 0, stdout: evalEnvelope({ planStillValid: true, surprises: [], confidence: 0.95, notes: "" }), stderr: "" };
    };
    const driver = new AdaptiveDriver({
      configManager, logger, adaptiveDataDir: tmpDir,
      spawner, gitOps: GIT_OPS_MOCK,
      // no hookDispatcher
    });
    const res = await driver.run({ prompt: "goal" });
    expect(res.tasksRun).toBe(1);
  });
});
