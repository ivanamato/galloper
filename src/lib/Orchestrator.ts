import { promises as fs } from 'node:fs';
import path from 'node:path';
import { CoreRunner } from './CoreRunner.js';
import { ConfigManager, CommandEntry } from './ConfigManager.js';
import { SessionManager, SessionRecord } from './SessionManager.js';
import { Logger } from './Logger.js';
import { Planner } from './Planner.js';
import { Executioner } from './Executioner.js';
import { CommandResolver } from './CommandResolver.js';
import { TaskRunner } from './TaskRunner.js';
import { HookDispatcher } from './HookDispatcher.js';
import { VerbosityLevel } from './Verbosity.js';
import { HumanReporter, NullHumanReporter } from './HumanReporter.js';

export type SubcommandName = 'single-prompt' | 'plan' | 'implement' | 'pipeline';

export const SUBCOMMANDS: readonly SubcommandName[] = ['single-prompt', 'plan', 'implement', 'pipeline'] as const;

export function isSubcommand(v: string): v is SubcommandName {
  return SUBCOMMANDS.includes(v as SubcommandName);
}

export interface OrchestratorInput {
  subcommand: SubcommandName;
  prompt?: string;
  planFile?: string;
  env: NodeJS.ProcessEnv;
  cwd?: string;
  verbosity?: VerbosityLevel;
  concurrency?: number;
}

export interface OrchestratorResult {
  sessionId: string;
  sessionFilePath: string;
  exitCode: number | null;
  finalOutput: string | null;
  planFilePath?: string;
  runManifestPath?: string;
}

export class Orchestrator {
  private configManager: ConfigManager;
  private coreRunner: CoreRunner;
  private sessionManager: SessionManager;
  private logger: Logger;
  private humanReporter: HumanReporter;
  private planner: Planner;
  private executioner: Executioner;
  private commandResolver: CommandResolver;
  private rootDir: string;
  private dataDir: string;

  constructor({
    configManager,
    coreRunner,
    sessionManager,
    logger,
    humanReporter,
    planner,
    executioner,
    rootDir,
    dataDir,
  }: {
    configManager: ConfigManager;
    coreRunner: CoreRunner;
    sessionManager: SessionManager;
    logger: Logger;
    humanReporter?: HumanReporter;
    planner: Planner;
    executioner: Executioner;
    rootDir: string;
    dataDir: string;
  }) {
    this.configManager = configManager;
    this.coreRunner = coreRunner;
    this.sessionManager = sessionManager;
    this.logger = logger;
    this.humanReporter = humanReporter ?? new NullHumanReporter();
    this.planner = planner;
    this.executioner = executioner;
    this.commandResolver = new CommandResolver({ configManager });
    this.rootDir = rootDir;
    this.dataDir = dataDir;
  }

  private subscribeEventHooks(
    hookDispatcher: HookDispatcher,
    hooksConfig: ReturnType<ConfigManager['getHooks']>,
    sessionId: string,
    cwd: string,
  ): () => void {
    const unsubscribers: Array<() => void> = [];
    const events = hooksConfig.events;
    if (events) {
      for (const [eventType] of Object.entries(events)) {
        const unsubscribe = this.logger.on(eventType, (event) => {
          hookDispatcher.dispatchEvent(eventType, event as Record<string, unknown>, {
            sessionId,
            cwd,
          });
        });
        unsubscribers.push(unsubscribe);
      }
    }
    return () => {
      for (const unsubscribe of unsubscribers) {
        unsubscribe();
      }
    };
  }

  async execute(input: OrchestratorInput): Promise<OrchestratorResult> {
    // Route to appropriate handler based on subcommand
    if (input.subcommand === 'plan') {
      return this.executePlan(input);
    }

    if (input.subcommand === 'implement') {
      return this.executeImplement(input);
    }

    if (input.subcommand === 'pipeline') {
      return this.executePipeline(input);
    }

    // Handle single-prompt
    return this.executeSinglePrompt(input);
  }

  private async executeSinglePrompt(input: OrchestratorInput): Promise<OrchestratorResult> {
    if (!input.prompt) {
      throw new Error('single-prompt subcommand requires --prompt or --prompt-file');
    }
    const sessionId = this.sessionManager.createSessionId();
    const startedAt = new Date().toISOString();
    const promptPreview = input.prompt.substring(0, 50) + (input.prompt.length > 50 ? '...' : '');
    this.humanReporter.info(`Starting single-prompt: ${promptPreview}`);

    await this.logger.append({
      sessionId,
      type: 'run.started',
      timestamp: startedAt,
      prompt: input.prompt,
      subcommand: 'single-prompt',
      cwd: this.rootDir,
      minLevel: 1,
      message: `[single-prompt] Starting orchestration`,
    });

    try {
      const hooksConfig = this.configManager.getHooks();
      const hookDispatcher = new HookDispatcher(hooksConfig);
      this.subscribeEventHooks(hookDispatcher, hooksConfig, sessionId, this.rootDir);

      const commandName = this.commandResolver.resolve('single-prompt');
      const entry = this.configManager.getCommand(commandName);
      const resolvedCommand = entry.command;
      this.humanReporter.step('single-prompt', `Command resolved: ${commandName}`);

      await this.logger.append({
        sessionId,
        type: 'run.command_resolved',
        timestamp: new Date().toISOString(),
        resolvedCommand,
        minLevel: 2,
        message: `[single-prompt] Command resolved: ${commandName}`,
      });

      const result = await this.coreRunner.run({
        llmCommand: resolvedCommand,
        prompt: input.prompt,
        sessionId,
        cwd: this.rootDir,
        env: { ...input.env, ...(entry.env ?? {}) },
        logger: this.logger,
      });

      const sessionRecord: SessionRecord = {
        id: sessionId,
        prompt: input.prompt,
        command: resolvedCommand,
        cwd: this.rootDir,
        startedAt,
        endedAt: result.endedAt,
        durationMs: result.durationMs,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        parsedStdoutEvents: result.parsedStdoutEvents,
        parsedStderrEvents: result.parsedStderrEvents,
        finalOutput: CoreRunner.extractFinalOutput(result.stdout),
      };

      const sessionFilePath = await this.sessionManager.writeSession(sessionId, sessionRecord);

      await this.logger.append({
        sessionId,
        type: 'run.completed',
        timestamp: result.endedAt,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        sessionFilePath,
        finalOutput: sessionRecord.finalOutput,
        minLevel: 1,
        message: `[single-prompt] Completed with exit code ${result.exitCode} (${result.durationMs}ms)`,
      });

      this.humanReporter.done(`Completed (exit ${result.exitCode}, ${result.durationMs}ms)`);

      return {
        sessionId,
        sessionFilePath,
        exitCode: result.exitCode,
        finalOutput: sessionRecord.finalOutput,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.humanReporter.info(`Failed: ${errorMsg}`);

      await this.logger.append({
        sessionId,
        type: 'run.failed',
        timestamp: new Date().toISOString(),
        error: errorMsg,
        minLevel: 1,
        message: `[single-prompt] Failed: ${errorMsg}`,
      });
      throw error;
    }
  }

  private async executePlan(input: OrchestratorInput): Promise<OrchestratorResult> {
    if (!input.prompt) {
      throw new Error('plan subcommand requires --prompt or --prompt-file');
    }
    const sessionId = this.sessionManager.createSessionId();
    const startedAt = new Date().toISOString();
    const cwd = input.cwd || process.cwd();
    const promptPreview = input.prompt.substring(0, 50) + (input.prompt.length > 50 ? '...' : '');
    this.humanReporter.info(`Starting plan: ${promptPreview}`);

    await this.logger.append({
      sessionId,
      type: 'run.started',
      timestamp: startedAt,
      prompt: input.prompt,
      subcommand: 'plan',
      cwd,
      minLevel: 1,
      message: `[plan] Starting orchestration`,
    });

    try {
      const hooksConfig = this.configManager.getHooks();
      const hookDispatcher = new HookDispatcher(hooksConfig);
      this.subscribeEventHooks(hookDispatcher, hooksConfig, sessionId, cwd);

      const commandName = this.commandResolver.resolve('plan');
      this.humanReporter.step('plan', `Command resolved: ${commandName}`);

      const planResult = await this.planner.plan({
        prompt: input.prompt,
        llmCommand: commandName,
        cwd,
      });

      this.humanReporter.done(`Plan completed (exit ${planResult.exitCode})`);

      return {
        sessionId: planResult.sessionId,
        sessionFilePath: planResult.planFilePath,
        exitCode: planResult.exitCode,
        finalOutput: planResult.planContent,
        planFilePath: planResult.planFilePath,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.humanReporter.info(`Failed: ${errorMsg}`);

      await this.logger.append({
        sessionId,
        type: 'run.failed',
        timestamp: new Date().toISOString(),
        error: errorMsg,
        minLevel: 1,
        message: `[plan] Failed: ${errorMsg}`,
      });
      throw error;
    }
  }

  private async executeImplement(input: OrchestratorInput): Promise<OrchestratorResult> {
    if (!input.planFile) {
      throw new Error('implement subcommand requires --plan-file');
    }
    const sessionId = this.sessionManager.createSessionId();
    const startedAt = new Date().toISOString();
    const cwd = input.cwd || process.cwd();
    const planFilePreview = input.planFile.substring(0, 50) + (input.planFile.length > 50 ? '...' : '');
    this.humanReporter.info(`Starting implement: ${planFilePreview}`);

    await this.logger.append({
      sessionId,
      type: 'run.started',
      timestamp: startedAt,
      planFile: input.planFile,
      subcommand: 'implement',
      cwd,
      minLevel: 1,
      message: `[implement] Starting orchestration`,
    });

    try {
      // Load the plan from the provided file
      const hooksConfig = this.configManager.getHooks();
      const hookDispatcher = new HookDispatcher(hooksConfig);
      this.subscribeEventHooks(hookDispatcher, hooksConfig, sessionId, cwd);
      const runManifestPath = `${input.planFile}.manifest.json`;

      // Create TaskRunner and execute the plan
      const taskRunner = new TaskRunner();
      const manifest = await taskRunner.run({
        planFilePath: input.planFile,
        runManifestPath,
        cwd,
        executioner: this.executioner,
        coreRunner: new CoreRunner(),
        logger: this.logger,
        humanReporter: this.humanReporter,
        commandResolver: this.commandResolver,
        defaultMaxAttempts: 3,
        hooksConfig,
        sessionId,
        concurrency: input.concurrency,
      });

      const durationMs = Date.now() - new Date(startedAt).getTime();
      this.humanReporter.done(`Implementation completed (exit ${manifest.status === 'completed' ? 0 : 1})`);

      await this.logger.append({
        sessionId,
        type: 'run.completed',
        timestamp: new Date().toISOString(),
        exitCode: manifest.status === 'completed' ? 0 : 1,
        durationMs,
        runManifestPath,
        minLevel: 1,
        message: `[implement] Completed with status ${manifest.status} (${durationMs}ms)`,
      });

      return {
        sessionId,
        sessionFilePath: runManifestPath,
        exitCode: manifest.status === 'completed' ? 0 : 1,
        finalOutput: JSON.stringify(manifest, null, 2),
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.humanReporter.info(`Failed: ${errorMsg}`);

      await this.logger.append({
        sessionId,
        type: 'run.failed',
        timestamp: new Date().toISOString(),
        error: errorMsg,
        minLevel: 1,
        message: `[implement] Failed: ${errorMsg}`,
      });
      throw error;
    }
  }

  private async executePipeline(input: OrchestratorInput): Promise<OrchestratorResult> {
    if (!input.prompt) {
      throw new Error('pipeline subcommand requires --prompt or --prompt-file');
    }
    const sessionId = this.sessionManager.createSessionId();
    const startedAt = new Date().toISOString();
    const cwd = input.cwd || process.cwd();

    const promptPreview = input.prompt.substring(0, 50) + (input.prompt.length > 50 ? '...' : '');
    this.humanReporter.info(`Starting pipeline: ${promptPreview}`);

    await this.logger.append({
      sessionId,
      type: 'run.started',
      timestamp: startedAt,
      prompt: input.prompt,
      subcommand: 'pipeline',
      cwd,
      minLevel: 1,
      message: `[pipeline] Starting orchestration`,
    });

    try {
      // Setup hooks for plan-level lifecycle
      const hooksConfig = this.configManager.getHooks();
      const hookDispatcher = new HookDispatcher(hooksConfig);
      this.subscribeEventHooks(hookDispatcher, hooksConfig, sessionId, cwd);

      // Fire pre-plan hook
      try {
        const prePlanOutput = await hookDispatcher.runPre('pre-plan', {
          sessionId,
          cwd,
        });
        if (prePlanOutput.trim()) {
          this.humanReporter.step('pipeline', 'Pre-plan hook executed');
          await this.logger.append({
            sessionId,
            type: 'hook.pre-plan',
            timestamp: new Date().toISOString(),
            output: prePlanOutput,
          });
        }
      } catch (error) {
        console.warn('Pre-plan hook failed:', error);
      }

      // Step 1: Generate plan
      const commandName = this.commandResolver.resolve('plan');
      this.humanReporter.step('pipeline', `Command resolved: ${commandName}`);

      const planResult = await this.planner.plan({
        prompt: input.prompt,
        llmCommand: commandName,
        cwd,
      });

      // Fire post-plan hook
      try {
        const postPlanFailures = await hookDispatcher.runPost('post-plan', {
          sessionId,
          cwd,
        });
        if (postPlanFailures.length > 0) {
          this.humanReporter.step('pipeline', `Post-plan hook: ${postPlanFailures.length} issue(s) found`);
          await this.logger.append({
            sessionId,
            type: 'hook.post-plan.failed',
            timestamp: new Date().toISOString(),
            failures: postPlanFailures,
          });
          // Log but don't fail pipeline on post-plan failures (warn/retry logic applies)
          for (const failure of postPlanFailures) {
            if (failure.onFailure === 'abort') {
              throw new Error(`Post-plan hook aborted: ${failure.command}`);
            }
          }
        }
      } catch (error) {
        if (error instanceof Error && (error.message.includes('aborted') || error.message.includes('Abort'))) {
          throw error;
        }
        console.warn('Post-plan hook failed:', error);
      }

      // Step 2: Execute plan with TaskRunner
      const plansDir = path.join(this.dataDir, 'plans');
      const runsDir = path.join(this.dataDir, 'runs');
      const runManifestPath = path.join(runsDir, `${sessionId}-manifest.json`);

      const taskRunner = new TaskRunner();
      const manifest = await taskRunner.run({
        planFilePath: planResult.planFilePath,
        runManifestPath,
        cwd,
        executioner: this.executioner,
        coreRunner: this.coreRunner,
        logger: this.logger,
        humanReporter: this.humanReporter,
        commandResolver: this.commandResolver,
        defaultMaxAttempts: 3,
        hooksConfig,
        sessionId,
        concurrency: input.concurrency,
      });

      const durationMs = Date.now() - new Date(startedAt).getTime();

      // Log completion
      await this.logger.append({
        sessionId,
        type: 'run.completed',
        timestamp: new Date().toISOString(),
        exitCode: 0,
        durationMs,
        planFilePath: planResult.planFilePath,
        runManifestPath,
        minLevel: 1,
        message: `[pipeline] Completed with exit code 0 (${durationMs}ms)`,
      });

      this.humanReporter.done(`Pipeline completed (exit 0, ${durationMs}ms)`);

      return {
        sessionId,
        sessionFilePath: runManifestPath,
        exitCode: 0,
        finalOutput: JSON.stringify(manifest, null, 2),
        planFilePath: planResult.planFilePath,
        runManifestPath,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.humanReporter.info(`Failed: ${errorMsg}`);

      await this.logger.append({
        sessionId,
        type: 'run.failed',
        timestamp: new Date().toISOString(),
        error: errorMsg,
        minLevel: 1,
        message: `[pipeline] Failed: ${errorMsg}`,
      });
      throw error;
    }
  }
}
