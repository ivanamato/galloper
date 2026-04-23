import { promises as fs } from 'node:fs';
import path from 'node:path';
import picomatch from 'picomatch';
import { ConfigManager, LlmConfig } from './ConfigManager.js';
import { PlanFile } from './Planner.js';
import { parsePlan, Plan, FileAction } from './PlanSchema.js';

export interface HookMatch {
  taskId: string;
  file: string;
  hook: {
    phase: 'pre-task-file' | 'post-task-file';
    index: number;
    match: string | undefined;
    action: FileAction | undefined;
    command: string | string[] | undefined;
    runOnSurprise: boolean | undefined;
  };
}

export interface DryRunHooksResult {
  planId: string;
  matches: HookMatch[];
}

export class DryRunHooks {
  private configManager: ConfigManager;

  constructor(configManager: ConfigManager) {
    this.configManager = configManager;
  }

  async run(planFilePath: string): Promise<DryRunHooksResult> {
    // Load plan file
    const planFileContent = await fs.readFile(planFilePath, 'utf8');
    const planFile = JSON.parse(planFileContent) as PlanFile;
    const plan = parsePlan(planFile.content);

    // Load config
    const config = await this.configManager.load();

    // Analyze hooks for each task × file
    const matches: HookMatch[] = [];

    for (const task of plan.tasks) {
      for (const fileSpec of task.files) {
        // Check pre-task-file hooks
        const preTaskFileHooks = config.hooks?.lifecycle?.['pre-task-file'] ?? [];
        for (let i = 0; i < preTaskFileHooks.length; i++) {
          const hook = preTaskFileHooks[i];
          if (!hook) continue;

          if (this.hookMatches(hook, fileSpec.path, fileSpec.action)) {
            matches.push({
              taskId: task.id,
              file: fileSpec.path,
              hook: {
                phase: 'pre-task-file',
                index: i,
                match: hook.match,
                action: hook.action,
                command: hook.command,
                runOnSurprise: hook.runOnSurprise,
              },
            });
          }
        }

        // Check post-task-file hooks
        const postTaskFileHooks = config.hooks?.lifecycle?.['post-task-file'] ?? [];
        for (let i = 0; i < postTaskFileHooks.length; i++) {
          const hook = postTaskFileHooks[i];
          if (!hook) continue;

          if (this.hookMatches(hook, fileSpec.path, fileSpec.action)) {
            matches.push({
              taskId: task.id,
              file: fileSpec.path,
              hook: {
                phase: 'post-task-file',
                index: i,
                match: hook.match,
                action: hook.action,
                command: hook.command,
                runOnSurprise: hook.runOnSurprise,
              },
            });
          }
        }
      }
    }

    return {
      planId: plan.planId,
      matches,
    };
  }

  private hookMatches(hook: any, filePath: string, fileAction: FileAction): boolean {
    // Check glob match
    if (hook.match) {
      if (!this.matchGlob(filePath, hook.match)) {
        return false;
      }
    }

    // Check action match
    if (hook.action && hook.action !== fileAction) {
      return false;
    }

    return true;
  }

  private matchGlob(filepath: string, pattern: string): boolean {
    try {
      const isMatch = picomatch.isMatch(filepath, pattern);
      return isMatch;
    } catch {
      return false;
    }
  }
}
