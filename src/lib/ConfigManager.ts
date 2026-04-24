import { promises as fs } from 'node:fs';
import picomatch from 'picomatch';
import { HooksConfig, LifecyclePhase } from './HookDispatcher.js';
import { nearest } from './Suggest.js';
import { KNOWN_SUBCOMMANDS, KNOWN_EVENTS } from './Doctor.js';
import { detectDestructive } from './DestructivePatterns.js';

export interface CommandEntry {
  command: string;
  allowedSubcommands: string[];
  disallowedSubcommands: string[];
  env?: Record<string, string>;
  [key: string]: unknown;
}

export interface WorkspaceRoot {
  path: string;
  vcs: 'git' | 'none';
  label: string;
  ignore?: string[];
}

export interface WorkspaceConfig {
  roots: WorkspaceRoot[];
  ignore?: string[];
  quiesceMs?: number;
  quiesceTimeoutMs?: number;
}

export interface AdaptiveConfig {
  confidenceThreshold?: number;
  maxReplans?: number;
  diffMaxBytes?: number;
  defaultEvaluator?: string;
  defaultReplanner?: string;
}

export interface LlmConfig {
  default: string;
  defaultPlanner?: string;
  defaultExecutioner?: string;
  commands: Record<string, CommandEntry>;
  hooks?: HooksConfig;
  executionerEscalation?: string[];
  workspace?: WorkspaceConfig;
  adaptive?: AdaptiveConfig;
}

function isSubcommandAllowedForEntry(entry: CommandEntry, subcommand: string): boolean {
  if (entry.disallowedSubcommands?.includes(subcommand)) {
    return false;
  }
  if (!entry.allowedSubcommands || entry.allowedSubcommands.length === 0) {
    return true;
  }
  return entry.allowedSubcommands.includes(subcommand);
}

export function validateLlmConfig(config: LlmConfig): void {
  if (config.defaultPlanner && !config.commands[config.defaultPlanner]) {
    const candidates = Object.keys(config.commands);
    const suggestion = nearest(config.defaultPlanner, candidates)[0];
    const suggestionText = suggestion ? ` (did you mean '${suggestion}'?)` : '';
    throw new Error(`defaultPlanner "${config.defaultPlanner}" does not exist in commands${suggestionText}`);
  }

  if (config.defaultExecutioner && !config.commands[config.defaultExecutioner]) {
    const candidates = Object.keys(config.commands);
    const suggestion = nearest(config.defaultExecutioner, candidates)[0];
    const suggestionText = suggestion ? ` (did you mean '${suggestion}'?)` : '';
    throw new Error(`defaultExecutioner "${config.defaultExecutioner}" does not exist in commands${suggestionText}`);
  }

  for (const [cmdName, entry] of Object.entries(config.commands)) {
    if ((entry as Record<string, unknown>).env !== undefined) {
      const env = (entry as Record<string, unknown>).env;
      if (typeof env !== 'object' || env === null || Array.isArray(env)) {
        throw new Error(`Command "${cmdName}" env must be an object (map of strings)`);
      }
      for (const [key, value] of Object.entries(env as Record<string, unknown>)) {
        if (typeof value !== 'string') {
          throw new Error(`Command "${cmdName}" env.${key} must be a string, got ${typeof value}`);
        }
      }
    }

    const allowed = (entry as Record<string, unknown>).allowedSubcommands as string[] | undefined;
    if (allowed && Array.isArray(allowed)) {
      for (let i = 0; i < allowed.length; i++) {
        const subcommand = allowed[i];
        if (!KNOWN_SUBCOMMANDS.includes(subcommand as any)) {
          const suggestion = nearest(subcommand, [...KNOWN_SUBCOMMANDS])[0];
          const suggestionText = suggestion ? ` (did you mean '${suggestion}'?)` : '';
          throw new Error(`Command "${cmdName}" allowedSubcommands[${i}]: unknown subcommand "${subcommand}"${suggestionText}`);
        }
      }
    }

    const disallowed = (entry as Record<string, unknown>).disallowedSubcommands as string[] | undefined;
    if (disallowed && Array.isArray(disallowed)) {
      for (let i = 0; i < disallowed.length; i++) {
        const subcommand = disallowed[i];
        if (!KNOWN_SUBCOMMANDS.includes(subcommand as any)) {
          const suggestion = nearest(subcommand, [...KNOWN_SUBCOMMANDS])[0];
          const suggestionText = suggestion ? ` (did you mean '${suggestion}'?)` : '';
          throw new Error(`Command "${cmdName}" disallowedSubcommands[${i}]: unknown subcommand "${subcommand}"${suggestionText}`);
        }
      }
    }
  }

  if (config.executionerEscalation) {
    if (!Array.isArray(config.executionerEscalation)) {
      throw new Error('executionerEscalation must be an array of command names');
    }

    for (let i = 0; i < config.executionerEscalation.length; i++) {
      const cmdName = config.executionerEscalation[i];
      if (typeof cmdName !== 'string') {
        throw new Error(`executionerEscalation[${i}] must be a string command name, got ${typeof cmdName}`);
      }

      const entry = config.commands[cmdName];
      if (!entry) {
        throw new Error(`executionerEscalation[${i}]: command "${cmdName}" does not exist`);
      }

      if (!isSubcommandAllowedForEntry(entry, 'implement')) {
        throw new Error(`executionerEscalation[${i}]: command "${cmdName}" does not allow implement subcommand`);
      }
    }
  }

  if (config.hooks) {
    validateHooksConfigPure(config.hooks);
  }

  if (config.workspace) {
    const workspace = config.workspace as unknown as Record<string, unknown>;

    if (typeof workspace !== 'object' || workspace === null || Array.isArray(workspace)) {
      throw new Error('workspace must be an object');
    }

    const roots = workspace.roots;
    if (!Array.isArray(roots)) {
      throw new Error('workspace.roots must be an array');
    }

    const seenLabels = new Set<string>();

    for (let i = 0; i < roots.length; i++) {
      const root = roots[i];

      if (typeof root !== 'object' || root === null || Array.isArray(root)) {
        throw new Error(`workspace.roots[${i}]: must be an object`);
      }

      const rootObj = root as Record<string, unknown>;

      // Validate path
      if (typeof rootObj.path !== 'string' || (rootObj.path as string).trim() === '') {
        throw new Error(`workspace.roots[${i}].path: must be a non-empty string`);
      }

      // Validate label
      if (typeof rootObj.label !== 'string' || (rootObj.label as string).trim() === '') {
        throw new Error(`workspace.roots[${i}].label: must be a non-empty string`);
      }

      const label = rootObj.label as string;
      if (seenLabels.has(label)) {
        throw new Error(`workspace.roots[${i}].label: label "${label}" is not unique`);
      }
      seenLabels.add(label);

      // Validate vcs
      const vcs = rootObj.vcs;
      if (typeof vcs !== 'string' || (vcs !== 'git' && vcs !== 'none')) {
        throw new Error(`workspace.roots[${i}].vcs: must be either 'git' or 'none'`);
      }

      // Validate ignore (optional)
      if (rootObj.ignore !== undefined) {
        if (!Array.isArray(rootObj.ignore)) {
          throw new Error(`workspace.roots[${i}].ignore: must be a string array when present`);
        }
        for (let j = 0; j < (rootObj.ignore as unknown[]).length; j++) {
          if (typeof (rootObj.ignore as unknown[])[j] !== 'string') {
            throw new Error(`workspace.roots[${i}].ignore[${j}]: must be a string`);
          }
        }
      }
    }

    // Validate workspace.ignore (top-level, optional)
    if (workspace.ignore !== undefined) {
      if (!Array.isArray(workspace.ignore)) {
        throw new Error('workspace.ignore: must be a string array when present');
      }
      for (let i = 0; i < (workspace.ignore as unknown[]).length; i++) {
        if (typeof (workspace.ignore as unknown[])[i] !== 'string') {
          throw new Error(`workspace.ignore[${i}]: must be a string`);
        }
      }
    }

    // Validate quiesceMs (optional)
    if (workspace.quiesceMs !== undefined) {
      const quiesceMs = workspace.quiesceMs as unknown;
      if (typeof quiesceMs !== 'number' || !Number.isInteger(quiesceMs) || quiesceMs < 0) {
        throw new Error('workspace.quiesceMs: must be a non-negative integer when present');
      }
    }

    // Validate quiesceTimeoutMs (optional)
    if (workspace.quiesceTimeoutMs !== undefined) {
      const quiesceTimeoutMs = workspace.quiesceTimeoutMs as unknown;
      if (typeof quiesceTimeoutMs !== 'number' || !Number.isInteger(quiesceTimeoutMs) || quiesceTimeoutMs < 0) {
        throw new Error('workspace.quiesceTimeoutMs: must be a non-negative integer when present');
      }
    }
  }

  if (config.adaptive) {
    const adaptive = config.adaptive as unknown as Record<string, unknown>;

    if (typeof adaptive !== 'object' || adaptive === null || Array.isArray(adaptive)) {
      throw new Error('adaptive must be an object');
    }

    if (adaptive.confidenceThreshold !== undefined) {
      const confidenceThreshold = adaptive.confidenceThreshold as unknown;
      if (typeof confidenceThreshold !== 'number' || !Number.isFinite(confidenceThreshold) || confidenceThreshold < 0 || confidenceThreshold > 1) {
        throw new Error('adaptive.confidenceThreshold: must be a number in [0, 1]');
      }
    }

    if (adaptive.maxReplans !== undefined) {
      const maxReplans = adaptive.maxReplans as unknown;
      if (typeof maxReplans !== 'number' || !Number.isInteger(maxReplans) || maxReplans < 0) {
        throw new Error('adaptive.maxReplans: must be a non-negative integer');
      }
    }

    if (adaptive.diffMaxBytes !== undefined) {
      const diffMaxBytes = adaptive.diffMaxBytes as unknown;
      if (typeof diffMaxBytes !== 'number' || !Number.isInteger(diffMaxBytes) || diffMaxBytes <= 0) {
        throw new Error('adaptive.diffMaxBytes: must be a positive integer');
      }
    }

    if (adaptive.defaultEvaluator !== undefined) {
      const defaultEvaluator = adaptive.defaultEvaluator as string;
      if (typeof defaultEvaluator !== 'string') {
        throw new Error('adaptive.defaultEvaluator: must be a string');
      }
      if (!config.commands[defaultEvaluator]) {
        const candidates = Object.keys(config.commands);
        const suggestion = nearest(defaultEvaluator, candidates)[0];
        const suggestionText = suggestion ? ` (did you mean '${suggestion}'?)` : '';
        throw new Error(`adaptive.defaultEvaluator "${defaultEvaluator}" does not exist in commands${suggestionText}`);
      }
    }

    if (adaptive.defaultReplanner !== undefined) {
      const defaultReplanner = adaptive.defaultReplanner as string;
      if (typeof defaultReplanner !== 'string') {
        throw new Error('adaptive.defaultReplanner: must be a string');
      }
      if (!config.commands[defaultReplanner]) {
        const candidates = Object.keys(config.commands);
        const suggestion = nearest(defaultReplanner, candidates)[0];
        const suggestionText = suggestion ? ` (did you mean '${suggestion}'?)` : '';
        throw new Error(`adaptive.defaultReplanner "${defaultReplanner}" does not exist in commands${suggestionText}`);
      }
    }
  }
}

function validateHooksConfigPure(config: HooksConfig): void {
  const validPhases = new Set<LifecyclePhase>([
    'pre-plan', 'post-plan',
    'pre-task', 'post-task',
    'pre-task-file', 'post-task-file',
    'pre-iteration', 'post-iteration',
    'pre-evaluate', 'post-evaluate',
    'pre-replan', 'post-replan',
  ]);

  if (config.lifecycle) {
    for (const [phase, hooks] of Object.entries(config.lifecycle)) {
      if (!validPhases.has(phase as LifecyclePhase)) {
        throw new Error(`Unknown lifecycle phase: ${phase}. Valid phases: ${Array.from(validPhases).join(', ')}`);
      }

      if (!Array.isArray(hooks)) continue;

      for (let i = 0; i < hooks.length; i++) {
        const hook = hooks[i];
        if (!hook) continue;

        if (phase === 'post-plan' && hook.onFailure === 'retry') {
          throw new Error(`post-plan hooks cannot have onFailure: 'retry' (hook index ${i})`);
        }

        if (phase.startsWith('pre-') && !hook.instructions && !hook.command) {
          throw new Error(`${phase} hook ${i} must have either 'instructions' or 'command'`);
        }

        if (phase.startsWith('post-') && !hook.command) {
          throw new Error(`${phase} hook ${i} must have a 'command' property`);
        }

        if (hook.command !== undefined) {
          const shellMode = (hook as Record<string, unknown>).shell !== false;
          if (shellMode && typeof hook.command !== 'string') {
            throw new Error(`${phase} hook ${i}: when shell:true (default), command must be a string`);
          }
          if (!shellMode) {
            if (!Array.isArray(hook.command) || hook.command.length === 0 || hook.command.some((x: unknown) => typeof x !== 'string')) {
              throw new Error(`${phase} hook ${i}: when shell:false, command must be a non-empty string[]`);
            }
          }
        }

        if ((hook as Record<string, unknown>).shell !== undefined && typeof (hook as Record<string, unknown>).shell !== 'boolean') {
          throw new Error(`${phase} hook ${i}: shell must be a boolean`);
        }

        if ((hook as Record<string, unknown>).destructive !== undefined) {
          if (typeof (hook as Record<string, unknown>).destructive !== 'boolean') {
            throw new Error(`${phase} hook ${i}: destructive must be a boolean`);
          }
        }

        if (hook.command !== undefined) {
          const hits = detectDestructive(hook.command as string | string[]);
          if (hits.length > 0 && (hook as Record<string, unknown>).destructive !== true) {
            throw new Error(`${phase} hook ${i}: command contains destructive pattern '${hits.join("', '")}'. Add "destructive": true to acknowledge, or rewrite the command.`);
          }
        }

        const onAbort = (hook as Record<string, unknown>).onAbort;
        if (onAbort !== undefined) {
          if (onAbort !== 'revert' && onAbort !== 'keep') {
            throw new Error(`${phase} hook ${i}: onAbort must be 'revert' or 'keep', got '${String(onAbort)}'`);
          }
        }

        const retry = (hook as Record<string, unknown>).retry;
        if (retry !== undefined) {
          if (typeof retry !== 'object' || retry === null || Array.isArray(retry)) {
            throw new Error(`${phase} hook ${i}: retry must be an object`);
          }
          const r = retry as Record<string, unknown>;
          const maxAttempts = r.maxAttempts;
          const backoffMs = r.backoffMs;
          const jitter = r.jitter;
          if (typeof maxAttempts !== 'number' || !Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 20) {
            throw new Error(`${phase} hook ${i}: retry.maxAttempts must be an integer in [1, 20]`);
          }
          if (typeof backoffMs !== 'number' || !Number.isInteger(backoffMs) || backoffMs < 0) {
            throw new Error(`${phase} hook ${i}: retry.backoffMs must be a non-negative integer`);
          }
          if (jitter !== undefined) {
            if (typeof jitter !== 'number' || !Number.isFinite(jitter) || jitter < 0 || jitter > 1) {
              throw new Error(`${phase} hook ${i}: retry.jitter must be a number in [0, 1]`);
            }
          }
        }

        if ((phase === 'pre-task-file' || phase === 'post-task-file') && !hook.match) {
          throw new Error(`${phase} hook ${i} must have a 'match' glob pattern`);
        }

        if (hook.match) {
          try {
            picomatch.makeRe(hook.match);
          } catch (error) {
            throw new Error(`${phase} hook ${i} has invalid glob pattern "${hook.match}": ${error instanceof Error ? error.message : String(error)}`);
          }
        }

        if ((hook as Record<string, unknown>).runOnSurprise !== undefined) {
          if (typeof (hook as Record<string, unknown>).runOnSurprise !== 'boolean') {
            throw new Error(`${phase} hook ${i}: runOnSurprise must be a boolean`);
          }
          if (phase !== 'post-task-file') {
            throw new Error(`${phase} hook ${i}: runOnSurprise is only valid on post-task-file hooks`);
          }
        }
      }
    }
  }

  if (config.events) {
    for (const [eventType, hooks] of Object.entries(config.events)) {
      if (!KNOWN_EVENTS.includes(eventType as any)) {
        const suggestion = nearest(eventType, [...KNOWN_EVENTS])[0];
        const suggestionText = suggestion ? ` (did you mean '${suggestion}'?)` : '';
        throw new Error(`Unknown event type: ${eventType}${suggestionText}`);
      }

      if (!Array.isArray(hooks)) continue;

      for (let i = 0; i < hooks.length; i++) {
        const hook = hooks[i];
        if (!hook) continue;

        if (!hook.command) {
          throw new Error(`${eventType} event hook ${i} must have a 'command' property`);
        }
      }
    }
  }
}

export class ConfigManager {
  private configPath: string;
  private config: LlmConfig | null = null;
  private hooks: HooksConfig | null = null;

  constructor({ configPath }: { configPath: string }) {
    this.configPath = configPath;
  }

  async load(): Promise<LlmConfig> {
    if (this.config) {
      return this.config;
    }

    try {
      const content = await fs.readFile(this.configPath, 'utf8');
      this.config = JSON.parse(content) as LlmConfig;
      validateLlmConfig(this.config);
      if (this.config.hooks) {
        this.hooks = this.config.hooks;
      }
      return this.config;
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error(`Invalid JSON in galloper.json: ${error.message}`);
      }
      throw new Error(`Failed to load galloper.json: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  getDefaultCommandName(): string {
    if (!this.config) {
      throw new Error('Config not loaded. Call load() first.');
    }
    return this.config.default;
  }

  getCommand(name: string): CommandEntry {
    if (!this.config) {
      throw new Error('Config not loaded. Call load() first.');
    }

    if (!this.config.commands || !this.config.commands[name]) {
      const available = Object.keys(this.config.commands || {}).join(', ') || 'none';
      const candidates = Object.keys(this.config.commands || {});
      const suggestion = nearest(name, candidates)[0];
      const suggestionText = suggestion ? ` (did you mean '${suggestion}'?)` : '';
      throw new Error(`Unknown command: ${name}. Available: ${available}${suggestionText}`);
    }

    return this.resolveCommandEntry(this.config.commands[name]);
  }

  private resolveCommandEntry(entry: unknown): CommandEntry {
    if (entry === null || entry === undefined || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error('Command entry must be an object');
    }

    const obj = entry as Record<string, unknown>;
    if (typeof obj.command !== 'string' || (obj.command as string).trim() === '') {
      throw new Error('Command entry must have a non-empty "command" property');
    }

    // Validate env if present
    if (obj.env !== undefined && obj.env !== null) {
      if (typeof obj.env !== 'object' || Array.isArray(obj.env)) {
        throw new Error('Command entry "env" must be an object (map of strings)');
      }
      for (const [key, value] of Object.entries(obj.env)) {
        if (typeof value !== 'string') {
          throw new Error(`Command entry env.${key} must be a string, got ${typeof value}`);
        }
      }
    }

    return {
      command: obj.command as string,
      allowedSubcommands: (obj.allowedSubcommands as string[]) || [],
      disallowedSubcommands: (obj.disallowedSubcommands as string[]) || [],
      env: (obj.env as Record<string, string>) || undefined,
      ...Object.fromEntries(
        Object.entries(obj).filter(([key]) => !['command', 'allowedSubcommands', 'disallowedSubcommands', 'env'].includes(key))
      ),
    };
  }

  resolveForSubcommand(subcommand: 'single-prompt' | 'plan' | 'implement' | 'pipeline' | 'adaptive'): string {
    if (!this.config) {
      throw new Error('Config not loaded. Call load() first.');
    }

    // For single-prompt, use default
    if (subcommand === 'single-prompt') {
      return this.config.default;
    }

    // For plan, use defaultPlanner or fall back to default
    if (subcommand === 'plan') {
      return this.config.defaultPlanner || this.config.default;
    }

    // For implement, use defaultExecutioner or fall back to default
    if (subcommand === 'implement') {
      return this.config.defaultExecutioner || this.config.default;
    }

    // For pipeline, use defaultPlanner (same as plan) since pipeline starts with planning
    if (subcommand === 'pipeline') {
      return this.config.defaultPlanner || this.config.default;
    }

    // For adaptive, use defaultPlanner (starts with planning) or fall back to default
    if (subcommand === 'adaptive') {
      return this.config.defaultPlanner || this.config.default;
    }

    throw new Error(`Unknown subcommand: ${subcommand}`);
  }

  validateSubcommand(normalizedEntry: CommandEntry, subcommand: string | undefined): void {
    if (!subcommand) {
      return;
    }

    if (normalizedEntry.disallowedSubcommands.includes(subcommand)) {
      throw new Error(`Command is not allowed for subcommand "${subcommand}"`);
    }

    if (normalizedEntry.allowedSubcommands.length > 0 && !normalizedEntry.allowedSubcommands.includes(subcommand)) {
      throw new Error(`Command is not allowed for subcommand "${subcommand}". Allowed: ${normalizedEntry.allowedSubcommands.join(', ')}`);
    }
  }

  getCommandsAllowingSubcommand(subcommand: string): string[] {
    if (!this.config) {
      throw new Error('Config not loaded. Call load() first.');
    }

    return Object.entries(this.config.commands)
      .filter(([_, entry]) => entry.allowedSubcommands.includes(subcommand))
      .map(([name]) => name);
  }

  isSubcommandAllowed(commandName: string, subcommand: string): boolean {
    if (!this.config) {
      throw new Error('Config not loaded. Call load() first.');
    }

    const entry = this.config.commands[commandName];
    if (!entry) {
      return false;
    }

    if (entry.disallowedSubcommands.includes(subcommand)) {
      return false;
    }

    if (entry.allowedSubcommands.length === 0) {
      return true;
    }

    return entry.allowedSubcommands.includes(subcommand);
  }

  getDefaultPlanner(): string {
    if (!this.config) {
      throw new Error('Config not loaded. Call load() first.');
    }

    const planner = this.config.defaultPlanner || this.config.default;
    if (!this.config.commands[planner]) {
      throw new Error(`Resolved default planner "${planner}" does not exist in commands`);
    }

    return planner;
  }

  getDefaultExecutioner(): string {
    if (!this.config) {
      throw new Error('Config not loaded. Call load() first.');
    }

    const executioner = this.config.defaultExecutioner || this.config.default;
    if (!this.config.commands[executioner]) {
      throw new Error(`Resolved default executioner "${executioner}" does not exist in commands`);
    }

    return executioner;
  }

  getHooks(): HooksConfig {
    if (!this.config) {
      throw new Error('Config not loaded. Call load() first.');
    }

    return this.config.hooks ?? {};
  }

  getExecutionerEscalation(): string[] {
    if (!this.config) {
      throw new Error('Config not loaded. Call load() first.');
    }

    return this.config.executionerEscalation ?? [];
  }

  getWorkspace(): WorkspaceConfig | undefined {
    if (!this.config) {
      throw new Error('Config not loaded. Call load() first.');
    }

    return this.config.workspace;
  }

  getAdaptiveConfig(): AdaptiveConfig | undefined {
    if (!this.config) {
      throw new Error('Config not loaded. Call load() first.');
    }
    return this.config.adaptive;
  }

  getDefaultEvaluator(): string {
    if (!this.config) {
      throw new Error('Config not loaded. Call load() first.');
    }
    const evaluator = this.config.adaptive?.defaultEvaluator
      ?? this.config.defaultPlanner
      ?? this.config.default;
    if (!this.config.commands[evaluator]) {
      throw new Error(`Resolved default evaluator "${evaluator}" does not exist in commands`);
    }
    return evaluator;
  }

  getDefaultReplanner(): string {
    if (!this.config) {
      throw new Error('Config not loaded. Call load() first.');
    }
    const replanner = this.config.adaptive?.defaultReplanner
      ?? this.config.defaultPlanner
      ?? this.config.default;
    if (!this.config.commands[replanner]) {
      throw new Error(`Resolved default replanner "${replanner}" does not exist in commands`);
    }
    return replanner;
  }

}
