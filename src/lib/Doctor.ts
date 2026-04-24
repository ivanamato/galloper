import { promises as fs, constants as fsConstants } from 'node:fs';
import { platform } from 'node:os';
import { resolve as resolvePath } from 'node:path';
import picomatch from 'picomatch';
import { LlmConfig } from './ConfigManager.js';
import { nearest } from './Suggest.js';

export const KNOWN_SUBCOMMANDS = ['single-prompt', 'plan', 'implement', 'pipeline', 'adaptive'] as const;

export const KNOWN_EVENTS = [
  'run.started',
  'run.completed',
  'run.failed',
  'run.crashed',
  'run.command_resolved',
  'process.spawn',
  'process.stdout',
  'process.stderr',
  'plan.started',
  'plan.completed',
  'plan.aborted',
  'task.started',
  'task.completed',
  'task.failed',
  'task.attempt.started',
  'task.attempt.completed',
  'task.attempt.failed',
  'task.abandoned',
  'task.aborted',
  'task.file.out-of-workspace',
  'workspace.noisy',
  'workspace.watcher.dropped',
  'hook.failed',
  'hook.decision',
  'adaptive.plan.completed',
  'adaptive.iteration.started',
  'adaptive.iteration.completed',
  'adaptive.evaluation.completed',
  'adaptive.replan.decision',
] as const;

function extractFirstToken(command: string): string {
  return command.split(/\s+/)[0] ?? '';
}

function isValidGlob(glob: string): boolean {
  let bracketCount = 0;
  let braceCount = 0;

  for (let i = 0; i < glob.length; i++) {
    const char = glob[i];
    if (char === '[') bracketCount++;
    else if (char === ']') {
      bracketCount--;
      if (bracketCount < 0) return false;
    } else if (char === '{') braceCount++;
    else if (char === '}') {
      braceCount--;
      if (braceCount < 0) return false;
    } else if (char === '\\') {
      i++; // Skip escaped character
    }
  }

  return bracketCount === 0 && braceCount === 0;
}

function extractFirstPathComponent(glob: string): string {
  // Extract first literal path component that doesn't contain wildcards
  // E.g., 'api' from 'api/**/*.ts'
  // E.g., '' from '**/*.ts' or './**/*.ts'
  let current = '';
  for (const char of glob) {
    if (char === '/') break;
    if (char === '*' || char === '[' || char === '{') break;
    current += char;
  }
  // Ignore . and .. as they don't represent glob content
  if (current === '.' || current === '..') {
    return '';
  }
  return current;
}

function normalizePathForMatching(p: string): string {
  // Remove leading ./ for consistency
  if (p.startsWith('./')) {
    return p.slice(2);
  }
  return p;
}

function couldGlobMatchInRoot(glob: string, rootPath: string): boolean {
  // Check if glob could match something under this root
  try {
    const matcher = picomatch(glob, { dot: true });
    const firstComponent = extractFirstPathComponent(glob);

    // If glob has no literal first component, it's broad (e.g., **/* or *.ts)
    if (!firstComponent) {
      return true;
    }

    // Construct plausible test paths that would exist under this root
    let testPath: string;
    if (rootPath === '.' || rootPath === './') {
      testPath = `${firstComponent}/testfile.ts`;
    } else {
      testPath = `${rootPath}/${firstComponent}/testfile.ts`;
    }

    testPath = normalizePathForMatching(testPath);
    return matcher(testPath);
  } catch {
    // If glob is invalid or matching fails, assume it could match
    return true;
  }
}

export interface DoctorIssue {
  code: string;
  message: string;
  path: string;
}

export interface DoctorReport {
  errors: DoctorIssue[];
  warnings: DoctorIssue[];
}

export interface DoctorDeps {
  lookupOnPath(bin: string): Promise<boolean>;
  readFile(path: string): Promise<string>;
  pathExists(p: string): Promise<boolean>;
}

export async function runDoctor(config: LlmConfig, deps: DoctorDeps): Promise<DoctorReport> {
  const errors: DoctorIssue[] = [];
  const warnings: DoctorIssue[] = [];

  // Check default command exists
  if (!(config.default in config.commands)) {
    const candidates = Object.keys(config.commands);
    const suggestion = nearest(config.default, candidates)[0];
    const suggestionText = suggestion ? ` (did you mean '${suggestion}'?)` : '';
    errors.push({
      code: 'UNKNOWN_DEFAULT',
      message: `default command '${config.default}' does not exist in commands${suggestionText}`,
      path: 'default',
    });
  }

  // Check defaultPlanner command exists (if set)
  if (config.defaultPlanner && !(config.defaultPlanner in config.commands)) {
    const candidates = Object.keys(config.commands);
    const suggestion = nearest(config.defaultPlanner, candidates)[0];
    const suggestionText = suggestion ? ` (did you mean '${suggestion}'?)` : '';
    errors.push({
      code: 'UNKNOWN_PLANNER',
      message: `defaultPlanner command '${config.defaultPlanner}' does not exist in commands${suggestionText}`,
      path: 'defaultPlanner',
    });
  }

  // Check defaultExecutioner command exists (if set)
  if (config.defaultExecutioner && !(config.defaultExecutioner in config.commands)) {
    const candidates = Object.keys(config.commands);
    const suggestion = nearest(config.defaultExecutioner, candidates)[0];
    const suggestionText = suggestion ? ` (did you mean '${suggestion}'?)` : '';
    errors.push({
      code: 'UNKNOWN_EXECUTIONER',
      message: `defaultExecutioner command '${config.defaultExecutioner}' does not exist in commands${suggestionText}`,
      path: 'defaultExecutioner',
    });
  }

  // Check adaptive.defaultEvaluator command exists (if set)
  if (config.adaptive?.defaultEvaluator && !(config.adaptive.defaultEvaluator in config.commands)) {
    const candidates = Object.keys(config.commands);
    const suggestion = nearest(config.adaptive.defaultEvaluator, candidates)[0];
    const suggestionText = suggestion ? ` (did you mean '${suggestion}'?)` : '';
    errors.push({
      code: 'UNKNOWN_ADAPTIVE_EVALUATOR',
      message: `adaptive.defaultEvaluator command '${config.adaptive.defaultEvaluator}' does not exist in commands${suggestionText}`,
      path: 'adaptive.defaultEvaluator',
    });
  }

  // Check adaptive.defaultReplanner command exists (if set)
  if (config.adaptive?.defaultReplanner && !(config.adaptive.defaultReplanner in config.commands)) {
    const candidates = Object.keys(config.commands);
    const suggestion = nearest(config.adaptive.defaultReplanner, candidates)[0];
    const suggestionText = suggestion ? ` (did you mean '${suggestion}'?)` : '';
    errors.push({
      code: 'UNKNOWN_ADAPTIVE_REPLANNER',
      message: `adaptive.defaultReplanner command '${config.adaptive.defaultReplanner}' does not exist in commands${suggestionText}`,
      path: 'adaptive.defaultReplanner',
    });
  }

  // Check each command entry's first token exists on PATH
  for (const [name, entry] of Object.entries(config.commands)) {
    const token = extractFirstToken(entry.command);
    if (token && !(await deps.lookupOnPath(token))) {
      errors.push({
        code: 'BINARY_NOT_FOUND',
        message: `command '${token}' not found on $PATH`,
        path: `commands.${name}.command`,
      });
    }

    // Check allowedSubcommands validity
    for (let i = 0; i < entry.allowedSubcommands.length; i++) {
      const subcommand = entry.allowedSubcommands[i];
      if (!KNOWN_SUBCOMMANDS.includes(subcommand as any)) {
        const suggestion = nearest(subcommand, [...KNOWN_SUBCOMMANDS])[0];
        const suggestionText = suggestion ? ` (did you mean '${suggestion}'?)` : '';
        errors.push({
          code: 'UNKNOWN_SUBCOMMAND',
          message: `unknown subcommand '${subcommand}'${suggestionText}`,
          path: `commands.${name}.allowedSubcommands[${i}]`,
        });
      }
    }

    // Check disallowedSubcommands validity
    for (let i = 0; i < entry.disallowedSubcommands.length; i++) {
      const subcommand = entry.disallowedSubcommands[i];
      if (!KNOWN_SUBCOMMANDS.includes(subcommand as any)) {
        const suggestion = nearest(subcommand, [...KNOWN_SUBCOMMANDS])[0];
        const suggestionText = suggestion ? ` (did you mean '${suggestion}'?)` : '';
        errors.push({
          code: 'UNKNOWN_SUBCOMMAND',
          message: `unknown subcommand '${subcommand}'${suggestionText}`,
          path: `commands.${name}.disallowedSubcommands[${i}]`,
        });
      }
    }
  }

  // Check hook event names validity
  if (config.hooks?.events) {
    for (const eventName of Object.keys(config.hooks.events)) {
      if (!KNOWN_EVENTS.includes(eventName as any)) {
        const suggestion = nearest(eventName, [...KNOWN_EVENTS])[0];
        const suggestionText = suggestion ? ` (did you mean '${suggestion}'?)` : '';
        errors.push({
          code: 'UNKNOWN_EVENT',
          message: `unknown event '${eventName}'${suggestionText}`,
          path: `hooks.events.${eventName}`,
        });
      }
    }
  }

  // Check hook glob patterns validity
  if (config.hooks?.lifecycle) {
    const lifecyclePhases = Object.keys(config.hooks.lifecycle) as Array<keyof typeof config.hooks.lifecycle>;
    for (const phase of lifecyclePhases) {
      const phaseHooks = config.hooks.lifecycle[phase];
      if (Array.isArray(phaseHooks)) {
        for (let i = 0; i < phaseHooks.length; i++) {
          const hook = phaseHooks[i];
          if (hook.match && !isValidGlob(hook.match)) {
            errors.push({
              code: 'INVALID_GLOB',
              message: `invalid glob pattern '${hook.match}'`,
              path: `hooks.lifecycle.${phase}[${i}].match`,
            });
          }
        }
      }
    }
  }

  // Check workspace roots validity
  if (config.workspace?.roots) {
    for (let i = 0; i < config.workspace.roots.length; i++) {
      const root = config.workspace.roots[i];
      const resolvedPath = resolvePath(process.cwd(), root.path);

      // Check that root path exists
      if (!(await deps.pathExists(resolvedPath))) {
        errors.push({
          code: 'WORKSPACE_ROOT_MISSING',
          message: `workspace root '${root.label}' at '${root.path}' does not exist on disk`,
          path: `workspace.roots[${i}].path`,
        });
        continue;
      }

      // Check VCS claim matches reality
      const gitPath = resolvePath(resolvedPath, '.git');
      const gitExists = await deps.pathExists(gitPath);

      if (root.vcs === 'git' && !gitExists) {
        errors.push({
          code: 'WORKSPACE_ROOT_VCS_MISMATCH',
          message: `workspace root '${root.label}' declared vcs:'git' but no .git found at '${root.path}'`,
          path: `workspace.roots[${i}].vcs`,
        });
      } else if (root.vcs === 'none' && gitExists) {
        errors.push({
          code: 'WORKSPACE_ROOT_VCS_MISMATCH',
          message: `workspace root '${root.label}' declared vcs:'none' but .git present at '${root.path}'`,
          path: `workspace.roots[${i}].vcs`,
        });
      }
    }
  }

  // Check that lifecycle hook globs could match paths under workspace roots
  if (config.hooks?.lifecycle && config.workspace?.roots) {
    const lifecyclePhases = Object.keys(config.hooks.lifecycle) as Array<keyof typeof config.hooks.lifecycle>;
    for (const phase of lifecyclePhases) {
      const phaseHooks = config.hooks.lifecycle[phase];
      if (Array.isArray(phaseHooks)) {
        for (let i = 0; i < phaseHooks.length; i++) {
          const hook = phaseHooks[i];
          if (hook.match) {
            // Check if this glob could match anything under any workspace root
            let couldMatch = false;
            for (const root of config.workspace.roots) {
              if (couldGlobMatchInRoot(hook.match, root.path)) {
                couldMatch = true;
                break;
              }
            }

            if (!couldMatch) {
              warnings.push({
                code: 'WORKSPACE_GLOB_ORPHAN',
                message: `hook glob pattern '${hook.match}' in ${phase} cannot match anything under any declared workspace root`,
                path: `hooks.lifecycle.${phase}[${i}].match`,
              });
            }
          }
        }
      }
    }
  }

  return {
    errors,
    warnings,
  };
}

async function lookupOnPath(bin: string): Promise<boolean> {
  // If absolute path, check directly
  if (bin.startsWith('/')) {
    try {
      await fs.access(bin, fsConstants.X_OK);
      return true;
    } catch {
      return false;
    }
  }

  // Parse PATH environment variable
  const pathEnv = process.env.PATH ?? '';
  const separator = platform() === 'win32' ? ';' : ':';
  const pathDirs = pathEnv.split(separator);

  // Check in each PATH directory
  for (const dir of pathDirs) {
    if (!dir) continue;
    const fullPath = resolvePath(dir, bin);
    try {
      await fs.access(fullPath, fsConstants.X_OK);
      return true;
    } catch {
      continue;
    }
  }

  return false;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export const defaultDoctorDeps: DoctorDeps = {
  lookupOnPath,
  readFile: (path: string) => fs.readFile(path, 'utf8'),
  pathExists,
};
