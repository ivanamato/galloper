import { ConfigManager } from './ConfigManager.js';
import { SubcommandName } from './Orchestrator.js';
import type { HookFailure } from './TaskRunner.js';

export interface ResolveContext {
  attempt?: number;
  previousFailures?: HookFailure[];
}

export class CommandResolver {
  private configManager: ConfigManager;

  constructor({ configManager }: { configManager: ConfigManager }) {
    this.configManager = configManager;
  }

  resolve(subcommand: SubcommandName, context?: ResolveContext): string {
    // Default behavior: ignore context, return standard resolved command
    const commandName = this.configManager.resolveForSubcommand(subcommand);
    const entry = this.configManager.getCommand(commandName);

    if (!entry) {
      throw new Error(`Resolved command "${commandName}" not found in config`);
    }

    // Validate that this command allows the requested subcommand
    this.configManager.validateSubcommand(entry, subcommand);

    return commandName;
  }

  resolveEscalated(subcommand: SubcommandName, attempt: number): string {
    // Get escalation array from config
    const escalation = this.configManager.getExecutionerEscalation();

    // If no escalation configured, use standard resolution
    if (escalation.length === 0) {
      return this.resolve(subcommand, { attempt });
    }

    // Pick command from escalation array, clamped to list length
    const index = Math.min(attempt - 1, escalation.length - 1);
    const commandName = escalation[index];

    if (!commandName) {
      throw new Error(`escalation[${index}] is undefined`);
    }

    const entry = this.configManager.getCommand(commandName);
    if (!entry) {
      throw new Error(`Escalated command "${commandName}" not found in config`);
    }

    // Validate that this command allows the requested subcommand
    this.configManager.validateSubcommand(entry, subcommand);

    return commandName;
  }

  resolveEvaluator(): string {
    const commandName = this.configManager.getDefaultEvaluator();
    const entry = this.configManager.getCommand(commandName);
    if (!entry) {
      throw new Error(`Resolved evaluator command "${commandName}" not found in config`);
    }
    return commandName;
  }

  resolveReplanner(): string {
    const commandName = this.configManager.getDefaultReplanner();
    const entry = this.configManager.getCommand(commandName);
    if (!entry) {
      throw new Error(`Resolved replanner command "${commandName}" not found in config`);
    }
    return commandName;
  }
}
