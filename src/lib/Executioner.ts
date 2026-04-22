// Executioner module: handles implementation/execution via LLM, validation of implement-eligible commands, and execution file output

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ConfigManager } from './ConfigManager.js';
import { CoreRunner } from './CoreRunner.js';
import { Logger } from './Logger.js';
import { HumanReporter, NullHumanReporter } from './HumanReporter.js';
import { IMPLEMENT_PROMPT } from './PromptTemplates.js';

export interface ExecutionerInput {
  prompt: string;
  llmCommand?: string;
  cwd?: string;
}

export interface ExecutionResult {
  executionId: string;
  executionFilePath: string;
  sessionId: string;
  exitCode: number | null;
  executionContent: string;
}

export interface ExecutionFile {
  id: string;
  createdAt: string;
  prompt: string;
  command: string;
  sessionId: string;
  content: string;
}

export class Executioner {
  private configManager: ConfigManager;
  private coreRunner: CoreRunner;
  private logger: Logger;
  private humanReporter: HumanReporter;
  private executionsDir: string;

  constructor({
    configManager,
    coreRunner,
    logger,
    humanReporter,
    executionsDir,
  }: {
    configManager: ConfigManager;
    coreRunner: CoreRunner;
    logger: Logger;
    humanReporter?: HumanReporter;
    executionsDir: string;
  }) {
    this.configManager = configManager;
    this.coreRunner = coreRunner;
    this.logger = logger;
    this.humanReporter = humanReporter ?? new NullHumanReporter();
    this.executionsDir = executionsDir;
  }

  async implement(input: ExecutionerInput): Promise<ExecutionResult> {
    const executionId = this.generateExecutionId();
    const sessionId = this.generateSessionId();

    // Log start
    await this.logger.append({
      sessionId,
      type: 'run.started',
      timestamp: new Date().toISOString(),
      minLevel: 1,
      message: `[executioner] Starting implementation`,
    });

    // Resolve LLM command
    let commandName = input.llmCommand;
    if (!commandName) {
      const implementCommands = this.configManager.getCommandsAllowingSubcommand('implement');
      if (implementCommands.length === 0) {
        throw new Error('No commands configured to allow "implement" subcommand');
      }
      commandName = implementCommands[0];
    }

    // Validate command explicitly allows 'implement'
    const entry = this.configManager.getCommand(commandName);
    if (!entry.allowedSubcommands.includes('implement')) {
      throw new Error(
        `Command "${commandName}" does not allow "implement" subcommand. Allowed: ${entry.allowedSubcommands.length === 0 ? 'none (not configured)' : entry.allowedSubcommands.join(', ')}`
      );
    }

    // Load implement prompt template and inject CWD context
    const template = await this.loadPromptTemplate();
    this.humanReporter.step('implement', `Loaded prompt template for ${commandName}`);

    await this.logger.append({
      sessionId,
      type: 'task.completed',
      timestamp: new Date().toISOString(),
      minLevel: 2,
      message: `[executioner] Loaded prompt template`,
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

    // Extract execution content from result
    const executionContent = CoreRunner.extractFinalOutput(result.stdout) || result.stdout;

    // Write execution file
    const executionFile: ExecutionFile = {
      id: executionId,
      createdAt: new Date().toISOString(),
      prompt: input.prompt,
      command: commandName,
      sessionId,
      content: executionContent,
    };

    await fs.mkdir(this.executionsDir, { recursive: true });
    const executionFilePath = path.join(this.executionsDir, `${executionId}.json`);
    await fs.writeFile(executionFilePath, JSON.stringify(executionFile, null, 2) + '\n', 'utf8');

    this.humanReporter.step('implement', `Wrote execution file: ${executionFilePath}`);

    await this.logger.append({
      sessionId,
      type: 'task.completed',
      timestamp: new Date().toISOString(),
      minLevel: 2,
      message: `[executioner] Wrote execution file: ${executionFilePath}`,
    });

    // Log completion
    await this.logger.append({
      sessionId,
      type: 'run.completed',
      timestamp: new Date().toISOString(),
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      executionFilePath,
      executionId,
      minLevel: 1,
      message: `[executioner] Completed implementation`,
    });

    this.humanReporter.done(`Implementation completed (exit ${result.exitCode})`);

    return {
      executionId,
      executionFilePath,
      sessionId,
      exitCode: result.exitCode,
      executionContent,
    };
  }

  private async loadPromptTemplate(): Promise<string> {
    return IMPLEMENT_PROMPT;
  }

  private generateExecutionId(): string {
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
}
