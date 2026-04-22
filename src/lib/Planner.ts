// Planner module: handles plan generation via LLM, validation of plan-eligible commands, and plan file output

import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';
import { ConfigManager } from './ConfigManager.js';
import { CoreRunner } from './CoreRunner.js';
import { Logger } from './Logger.js';
import { parsePlan, Plan, inferFileAction } from './PlanSchema.js';
import { HumanReporter, NullHumanReporter } from './HumanReporter.js';
import { PLAN_PROMPT } from './PromptTemplates.js';
import { stripThinkingBlocks } from './OutputSanitizer.js';

export interface PlanInput {
  prompt: string;
  llmCommand?: string;
  cwd?: string;
}

export interface PlanResult {
  planId: string;
  planFilePath: string;
  sessionId: string;
  exitCode: number | null;
  planContent: string;
  plan: Plan;
}

export interface PlanFile {
  id: string;
  createdAt: string;
  prompt: string;
  command: string;
  sessionId: string;
  content: string;
}

export class Planner {
  private configManager: ConfigManager;
  private coreRunner: CoreRunner;
  private logger: Logger;
  private humanReporter: HumanReporter;
  private plansDir: string;

  constructor({
    configManager,
    coreRunner,
    logger,
    humanReporter,
    plansDir,
  }: {
    configManager: ConfigManager;
    coreRunner: CoreRunner;
    logger: Logger;
    humanReporter?: HumanReporter;
    plansDir: string;
  }) {
    this.configManager = configManager;
    this.coreRunner = coreRunner;
    this.logger = logger;
    this.humanReporter = humanReporter ?? new NullHumanReporter();
    this.plansDir = plansDir;
  }

  async plan(input: PlanInput): Promise<PlanResult> {
    const planId = this.generatePlanId();
    const sessionId = this.generateSessionId();

    // Log start
    await this.logger.append({
      sessionId,
      type: 'run.started',
      timestamp: new Date().toISOString(),
      minLevel: 1,
      message: `[planner] Starting plan generation`,
    });

    // Resolve LLM command
    let commandName = input.llmCommand;
    if (!commandName) {
      const planCommands = this.configManager.getCommandsAllowingSubcommand('plan');
      if (planCommands.length === 0) {
        throw new Error('No commands configured to allow "plan" subcommand');
      }
      commandName = planCommands[0];
    }

    // Validate command explicitly allows 'plan'
    const entry = this.configManager.getCommand(commandName);
    if (!entry.allowedSubcommands.includes('plan')) {
      throw new Error(
        `Command "${commandName}" does not allow "plan" subcommand. Allowed: ${entry.allowedSubcommands.length === 0 ? 'none (not configured)' : entry.allowedSubcommands.join(', ')}`
      );
    }

    // Load plan prompt template and inject CWD context
    const template = await this.loadPromptTemplate();
    await this.logger.append({
      sessionId,
      type: 'task.completed',
      timestamp: new Date().toISOString(),
      minLevel: 2,
      message: `[planner] Loaded prompt template`,
    });

    const cwd = input.cwd || process.cwd();
    const renderedTemplate = this.renderTemplate(template, { CWD: cwd });
    const combinedPrompt = renderedTemplate + input.prompt;

    const result = await this.coreRunner.run({
      llmCommand: entry.command,
      prompt: combinedPrompt,
      sessionId,
      cwd,
      env: { ...process.env, ...(entry.env ?? {}) },
      logger: this.logger,
    });

    // Extract plan content from result
    const planContent = CoreRunner.extractFinalOutput(result.stdout) || result.stdout;

    // Parse and validate plan JSON
    let parsedPlan: Plan;
    try {
      const sanitized = stripThinkingBlocks(planContent);
      const jsonStr = this.stripMarkdownFences(sanitized);
      parsedPlan = parsePlan(jsonStr);
      parsedPlan = this.autoInferActions(parsedPlan);
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      const stderrTail = result.stderr?.trim().slice(-500) || '(empty)';
      const stdoutTail = planContent.slice(-500) || '(empty)';
      throw new Error(
        `Failed to parse plan JSON from LLM output: ${errMsg}\n\n` +
        `Subprocess exitCode: ${result.exitCode}\n` +
        `LLM stdout tail:\n${stdoutTail}\n\n` +
        `LLM stderr tail:\n${stderrTail}`
      );
    }

    this.humanReporter.planSummary(parsedPlan);

    // Write plan file with validated JSON
    const planFile: PlanFile = {
      id: planId,
      createdAt: new Date().toISOString(),
      prompt: input.prompt,
      command: commandName,
      sessionId,
      content: JSON.stringify(parsedPlan, null, 2),
    };

    await fs.mkdir(this.plansDir, { recursive: true });
    const planFilePath = path.join(this.plansDir, `${planId}.json`);
    await fs.writeFile(planFilePath, JSON.stringify(planFile, null, 2) + '\n', 'utf8');

    this.humanReporter.step('plan', `Wrote plan file: ${planFilePath}`);

    await this.logger.append({
      sessionId,
      type: 'task.completed',
      timestamp: new Date().toISOString(),
      minLevel: 2,
      message: `[planner] Wrote plan file: ${planFilePath}`,
    });

    // Log completion
    await this.logger.append({
      sessionId,
      type: 'run.completed',
      timestamp: new Date().toISOString(),
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      planFilePath,
      planId,
      minLevel: 1,
      message: `[planner] Completed plan generation`,
    });

    return {
      planId,
      planFilePath,
      sessionId,
      exitCode: result.exitCode,
      planContent: JSON.stringify(parsedPlan, null, 2),
      plan: parsedPlan,
    };
  }

  private async loadPromptTemplate(): Promise<string> {
    return PLAN_PROMPT;
  }

  private stripMarkdownFences(content: string): string {
    const jsonMatch = content.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
    if (jsonMatch) {
      return jsonMatch[1] ?? content;
    }
    return content;
  }

  private generatePlanId(): string {
    return new Date().toISOString().replace(/[:.]/g, '-');
  }

  private generateSessionId(): string {
    return new Date().toISOString().replace(/[:.]/g, '-') + '-' + Math.random().toString(36).substring(2, 8);
  }

  private renderTemplate(template: string, vars: Record<string, string>): string {
    let result = template;
    for (const [key, value] of Object.entries(vars)) {
      result = result.replace(new RegExp(`{{${key}}}`, 'g'), value);
    }
    return result;
  }

  private autoInferActions(plan: Plan): Plan {
    return {
      ...plan,
      tasks: plan.tasks.map((task) => ({
        ...task,
        files: task.files.map((spec) => {
          if (spec.action === 'edit') {
            return {
              ...spec,
              action: inferFileAction(spec.path, existsSync),
            };
          }
          return spec;
        }),
      })),
    };
  }
}
