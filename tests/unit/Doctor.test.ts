import { describe, it, expect } from 'vitest';
import { runDoctor, DoctorIssue } from '../../src/lib/Doctor.js';
import { LlmConfig } from '../../src/lib/ConfigManager.js';
import { createFakeDoctorDeps } from '../helpers/fakePathLookup.js';

function filterErrors(issues: DoctorIssue[], code: string): DoctorIssue[] {
  return issues.filter(i => i.code === code);
}

describe('Doctor', () => {
  it('should return empty errors for valid config with all binaries present', async () => {
    const config: LlmConfig = {
      default: 'claude-haiku',
      defaultPlanner: 'claude-haiku',
      defaultExecutioner: 'claude-haiku',
      commands: {
        'claude-haiku': {
          command: 'claude --model claude-haiku-4-5-20251001',
          allowedSubcommands: [],
          disallowedSubcommands: [],
        },
      },
    };

    const deps = createFakeDoctorDeps(['claude']);
    const report = await runDoctor(config, deps);

    expect(report.errors).toHaveLength(0);
    expect(report.warnings).toHaveLength(0);
  });

  it('should error when default references non-existent command entry', async () => {
    const config: LlmConfig = {
      default: 'missing',
      commands: {
        'claude-haiku': {
          command: 'claude',
          allowedSubcommands: [],
          disallowedSubcommands: [],
        },
      },
    };

    const deps = createFakeDoctorDeps(['claude']);
    const report = await runDoctor(config, deps);

    const errors = filterErrors(report.errors, 'UNKNOWN_DEFAULT');
    expect(errors).toHaveLength(1);
    expect(errors[0].path).toBe('default');
  });

  it('should error when defaultPlanner references non-existent command', async () => {
    const config: LlmConfig = {
      default: 'claude-haiku',
      defaultPlanner: 'missing-planner',
      commands: {
        'claude-haiku': {
          command: 'claude',
          allowedSubcommands: [],
          disallowedSubcommands: [],
        },
      },
    };

    const deps = createFakeDoctorDeps(['claude']);
    const report = await runDoctor(config, deps);

    const errors = filterErrors(report.errors, 'UNKNOWN_PLANNER');
    expect(errors).toHaveLength(1);
    expect(errors[0].path).toBe('defaultPlanner');
  });

  it('should error when defaultExecutioner references non-existent command', async () => {
    const config: LlmConfig = {
      default: 'claude-haiku',
      defaultExecutioner: 'missing-executioner',
      commands: {
        'claude-haiku': {
          command: 'claude',
          allowedSubcommands: [],
          disallowedSubcommands: [],
        },
      },
    };

    const deps = createFakeDoctorDeps(['claude']);
    const report = await runDoctor(config, deps);

    const errors = filterErrors(report.errors, 'UNKNOWN_EXECUTIONER');
    expect(errors).toHaveLength(1);
    expect(errors[0].path).toBe('defaultExecutioner');
  });

  it('should error when command entry first token not on PATH', async () => {
    const config: LlmConfig = {
      default: 'missing-binary',
      commands: {
        'missing-binary': {
          command: 'foonotreal --x',
          allowedSubcommands: [],
          disallowedSubcommands: [],
        },
      },
    };

    const deps = createFakeDoctorDeps();
    const report = await runDoctor(config, deps);

    const errors = filterErrors(report.errors, 'BINARY_NOT_FOUND');
    expect(errors).toHaveLength(1);
    expect(errors[0].path).toBe('commands.missing-binary.command');
  });

  it('should error when allowedSubcommands contains unknown subcommand', async () => {
    const config: LlmConfig = {
      default: 'claude-haiku',
      commands: {
        'claude-haiku': {
          command: 'claude',
          allowedSubcommands: ['plna'], // typo: should be 'plan'
          disallowedSubcommands: [],
        },
      },
    };

    const deps = createFakeDoctorDeps(['claude']);
    const report = await runDoctor(config, deps);

    const errors = filterErrors(report.errors, 'UNKNOWN_SUBCOMMAND');
    expect(errors).toHaveLength(1);
    expect(errors[0].path).toBe('commands.claude-haiku.allowedSubcommands[0]');
  });

  it('should error when disallowedSubcommands contains unknown subcommand', async () => {
    const config: LlmConfig = {
      default: 'claude-haiku',
      commands: {
        'claude-haiku': {
          command: 'claude',
          allowedSubcommands: [],
          disallowedSubcommands: ['imlement'], // typo
        },
      },
    };

    const deps = createFakeDoctorDeps(['claude']);
    const report = await runDoctor(config, deps);

    const errors = filterErrors(report.errors, 'UNKNOWN_SUBCOMMAND');
    expect(errors).toHaveLength(1);
    expect(errors[0].path).toBe('commands.claude-haiku.disallowedSubcommands[0]');
  });

  it('should error when hook event name is unknown', async () => {
    const config: LlmConfig = {
      default: 'claude-haiku',
      commands: {
        'claude-haiku': {
          command: 'claude',
          allowedSubcommands: [],
          disallowedSubcommands: [],
        },
      },
      hooks: {
        events: {
          'post-taks': [], // typo: should be 'post-task'
        },
      },
    };

    const deps = createFakeDoctorDeps(['claude']);
    const report = await runDoctor(config, deps);

    const errors = filterErrors(report.errors, 'UNKNOWN_EVENT');
    expect(errors).toHaveLength(1);
    expect(errors[0].path).toBe('hooks.events.post-taks');
  });

  it('should error when hook glob is syntactically invalid', async () => {
    const config: LlmConfig = {
      default: 'claude-haiku',
      commands: {
        'claude-haiku': {
          command: 'claude',
          allowedSubcommands: [],
          disallowedSubcommands: [],
        },
      },
      hooks: {
        lifecycle: {
          'post-task-file': [
            {
              match: 'src/[unclosed',
            },
          ],
        },
      },
    };

    const deps = createFakeDoctorDeps(['claude']);
    const report = await runDoctor(config, deps);

    const errors = filterErrors(report.errors, 'INVALID_GLOB');
    expect(errors).toHaveLength(1);
    expect(errors[0].path).toBe('hooks.lifecycle.post-task-file[0].match');
  });

  it('should surface all issues simultaneously without hiding any', async () => {
    const config: LlmConfig = {
      default: 'missing-default',
      defaultPlanner: 'missing-planner',
      commands: {
        'bad-cmd': {
          command: 'nonexistent-binary',
          allowedSubcommands: ['invalid-subcommand'],
          disallowedSubcommands: [],
        },
      },
      hooks: {
        events: {
          'bad-event': [],
        },
        lifecycle: {
          'post-task-file': [{ match: '[unclosed' }],
        },
      },
    };

    const deps = createFakeDoctorDeps();
    const report = await runDoctor(config, deps);

    expect(report.errors.length).toBeGreaterThanOrEqual(5);
    expect(filterErrors(report.errors, 'UNKNOWN_DEFAULT')).toHaveLength(1);
    expect(filterErrors(report.errors, 'UNKNOWN_PLANNER')).toHaveLength(1);
    expect(filterErrors(report.errors, 'BINARY_NOT_FOUND')).toHaveLength(1);
    expect(filterErrors(report.errors, 'UNKNOWN_SUBCOMMAND')).toHaveLength(1);
    expect(filterErrors(report.errors, 'UNKNOWN_EVENT')).toHaveLength(1);
    expect(filterErrors(report.errors, 'INVALID_GLOB')).toHaveLength(1);
  });
});

describe('runDoctor workspace.roots', () => {
  it('should emit no workspace errors when config has no workspace key (back-compat)', async () => {
    const config: LlmConfig = {
      default: 'claude-haiku',
      commands: {
        'claude-haiku': {
          command: 'claude',
          allowedSubcommands: [],
          disallowedSubcommands: [],
        },
      },
    };

    const deps = createFakeDoctorDeps(['claude']);
    const report = await runDoctor(config, deps);

    const workspaceErrors = report.errors.filter(
      (e) => e.code === 'WORKSPACE_ROOT_MISSING' || e.code === 'WORKSPACE_ROOT_VCS_MISMATCH'
    );
    expect(workspaceErrors).toHaveLength(0);
  });

  it('should emit no errors for valid workspace root with git vcs', async () => {
    const rootPath = '/test/workspace/root1';
    const gitPath = `${rootPath}/.git`;

    const config: LlmConfig = {
      default: 'claude-haiku',
      commands: {
        'claude-haiku': {
          command: 'claude',
          allowedSubcommands: [],
          disallowedSubcommands: [],
        },
      },
      workspace: {
        roots: [
          {
            path: rootPath,
            label: 'Main Repo',
            vcs: 'git',
          },
        ],
      },
    };

    const deps = createFakeDoctorDeps(['claude'], [rootPath, gitPath]);
    const report = await runDoctor(config, deps);

    const workspaceErrors = report.errors.filter(
      (e) => e.code === 'WORKSPACE_ROOT_MISSING' || e.code === 'WORKSPACE_ROOT_VCS_MISMATCH'
    );
    expect(workspaceErrors).toHaveLength(0);
  });

  it('should error when workspace root path does not exist', async () => {
    const rootPath = '/test/workspace/missing';

    const config: LlmConfig = {
      default: 'claude-haiku',
      commands: {
        'claude-haiku': {
          command: 'claude',
          allowedSubcommands: [],
          disallowedSubcommands: [],
        },
      },
      workspace: {
        roots: [
          {
            path: rootPath,
            label: 'Missing Repo',
            vcs: 'git',
          },
        ],
      },
    };

    const deps = createFakeDoctorDeps(['claude'], []);
    const report = await runDoctor(config, deps);

    const errors = filterErrors(report.errors, 'WORKSPACE_ROOT_MISSING');
    expect(errors).toHaveLength(1);
    expect(errors[0].path).toBe('workspace.roots[0].path');
    expect(errors[0].message).toContain('Missing Repo');
  });

  it('should error when git root has vcs:git but no .git directory', async () => {
    const rootPath = '/test/workspace/nogit';

    const config: LlmConfig = {
      default: 'claude-haiku',
      commands: {
        'claude-haiku': {
          command: 'claude',
          allowedSubcommands: [],
          disallowedSubcommands: [],
        },
      },
      workspace: {
        roots: [
          {
            path: rootPath,
            label: 'No Git Dir',
            vcs: 'git',
          },
        ],
      },
    };

    const deps = createFakeDoctorDeps(['claude'], [rootPath]);
    const report = await runDoctor(config, deps);

    const errors = filterErrors(report.errors, 'WORKSPACE_ROOT_VCS_MISMATCH');
    expect(errors).toHaveLength(1);
    expect(errors[0].path).toBe('workspace.roots[0].vcs');
    expect(errors[0].message).toContain("vcs:'git'");
  });

  it('should error when root with vcs:none has .git directory present', async () => {
    const rootPath = '/test/workspace/nonevcs';
    const gitPath = `${rootPath}/.git`;

    const config: LlmConfig = {
      default: 'claude-haiku',
      commands: {
        'claude-haiku': {
          command: 'claude',
          allowedSubcommands: [],
          disallowedSubcommands: [],
        },
      },
      workspace: {
        roots: [
          {
            path: rootPath,
            label: 'No VCS Root',
            vcs: 'none',
          },
        ],
      },
    };

    const deps = createFakeDoctorDeps(['claude'], [rootPath, gitPath]);
    const report = await runDoctor(config, deps);

    const errors = filterErrors(report.errors, 'WORKSPACE_ROOT_VCS_MISMATCH');
    expect(errors).toHaveLength(1);
    expect(errors[0].path).toBe('workspace.roots[0].vcs');
    expect(errors[0].message).toContain("vcs:'none'");
  });

  it('should report error at correct index when multiple roots and one is missing', async () => {
    const validRoot = '/test/workspace/valid';
    const validGit = `${validRoot}/.git`;
    const missingRoot = '/test/workspace/missing';

    const config: LlmConfig = {
      default: 'claude-haiku',
      commands: {
        'claude-haiku': {
          command: 'claude',
          allowedSubcommands: [],
          disallowedSubcommands: [],
        },
      },
      workspace: {
        roots: [
          {
            path: validRoot,
            label: 'Valid Root',
            vcs: 'git',
          },
          {
            path: missingRoot,
            label: 'Missing Root',
            vcs: 'git',
          },
        ],
      },
    };

    const deps = createFakeDoctorDeps(['claude'], [validRoot, validGit]);
    const report = await runDoctor(config, deps);

    const errors = filterErrors(report.errors, 'WORKSPACE_ROOT_MISSING');
    expect(errors).toHaveLength(1);
    expect(errors[0].path).toBe('workspace.roots[1].path');
  });
});

describe('workspace glob validation', () => {
  it('should emit no warning for glob **/*.ts with root .', async () => {
    const rootPath = '/test/workspace/root';
    const gitPath = `${rootPath}/.git`;

    const config: LlmConfig = {
      default: 'claude-haiku',
      commands: {
        'claude-haiku': {
          command: 'claude',
          allowedSubcommands: [],
          disallowedSubcommands: [],
        },
      },
      hooks: {
        lifecycle: {
          'post-task-file': [
            {
              match: '**/*.ts',
            },
          ],
        },
      },
      workspace: {
        roots: [
          {
            path: '.',
            label: 'Current Directory',
            vcs: 'git',
          },
        ],
      },
    };

    const deps = createFakeDoctorDeps(['claude'], [rootPath, gitPath]);
    const report = await runDoctor(config, deps);

    const warnings = report.warnings.filter((w) => w.code === 'WORKSPACE_GLOB_ORPHAN');
    expect(warnings).toHaveLength(0);
  });

  it('should emit warning for glob api/**/*.ts with only root at ../sibling-frontend', async () => {
    const rootPath = '/test/workspace/sibling-frontend';
    const gitPath = `${rootPath}/.git`;

    const config: LlmConfig = {
      default: 'claude-haiku',
      commands: {
        'claude-haiku': {
          command: 'claude',
          allowedSubcommands: [],
          disallowedSubcommands: [],
        },
      },
      hooks: {
        lifecycle: {
          'post-task-file': [
            {
              match: 'api/**/*.ts',
            },
          ],
        },
      },
      workspace: {
        roots: [
          {
            path: '../sibling-frontend',
            label: 'Sibling Frontend',
            vcs: 'git',
          },
        ],
      },
    };

    const deps = createFakeDoctorDeps(['claude'], [rootPath, gitPath]);
    const report = await runDoctor(config, deps);

    const warnings = filterErrors(report.warnings, 'WORKSPACE_GLOB_ORPHAN');
    expect(warnings).toHaveLength(1);
    expect(warnings[0].path).toBe('hooks.lifecycle.post-task-file[0].match');
    expect(warnings[0].message).toContain('api/**/*.ts');
  });

  it('should emit no warning for glob api/**/*.ts when root can contain api/', async () => {
    const rootPath = '/test/workspace/root';
    const gitPath = `${rootPath}/.git`;

    const config: LlmConfig = {
      default: 'claude-haiku',
      commands: {
        'claude-haiku': {
          command: 'claude',
          allowedSubcommands: [],
          disallowedSubcommands: [],
        },
      },
      hooks: {
        lifecycle: {
          'post-task-file': [
            {
              match: 'api/**/*.ts',
            },
          ],
        },
      },
      workspace: {
        roots: [
          {
            path: '.',
            label: 'Root',
            vcs: 'git',
          },
        ],
      },
    };

    const deps = createFakeDoctorDeps(['claude'], [rootPath, gitPath]);
    const report = await runDoctor(config, deps);

    const warnings = report.warnings.filter((w) => w.code === 'WORKSPACE_GLOB_ORPHAN');
    expect(warnings).toHaveLength(0);
  });
});

describe('Doctor adaptive reference checks', () => {
  it('should error when adaptive.defaultEvaluator references non-existent command', async () => {
    const config: LlmConfig = {
      default: 'claude-haiku',
      commands: {
        'claude-haiku': {
          command: 'claude',
          allowedSubcommands: [],
          disallowedSubcommands: [],
        },
      },
      adaptive: {
        defaultEvaluator: 'missing-eval',
      },
    };

    const deps = createFakeDoctorDeps(['claude']);
    const report = await runDoctor(config, deps);

    const errors = filterErrors(report.errors, 'UNKNOWN_ADAPTIVE_EVALUATOR');
    expect(errors).toHaveLength(1);
    expect(errors[0].path).toBe('adaptive.defaultEvaluator');
  });

  it('should error when adaptive.defaultReplanner references non-existent command', async () => {
    const config: LlmConfig = {
      default: 'claude-haiku',
      commands: {
        'claude-haiku': {
          command: 'claude',
          allowedSubcommands: [],
          disallowedSubcommands: [],
        },
      },
      adaptive: {
        defaultReplanner: 'missing-repl',
      },
    };

    const deps = createFakeDoctorDeps(['claude']);
    const report = await runDoctor(config, deps);

    const errors = filterErrors(report.errors, 'UNKNOWN_ADAPTIVE_REPLANNER');
    expect(errors).toHaveLength(1);
    expect(errors[0].path).toBe('adaptive.defaultReplanner');
  });

  it('should return no adaptive errors when adaptive section absent', async () => {
    const config: LlmConfig = {
      default: 'claude-haiku',
      commands: {
        'claude-haiku': {
          command: 'claude',
          allowedSubcommands: [],
          disallowedSubcommands: [],
        },
      },
    };

    const deps = createFakeDoctorDeps(['claude']);
    const report = await runDoctor(config, deps);

    expect(filterErrors(report.errors, 'UNKNOWN_ADAPTIVE_EVALUATOR')).toHaveLength(0);
    expect(filterErrors(report.errors, 'UNKNOWN_ADAPTIVE_REPLANNER')).toHaveLength(0);
  });

  it('should return no adaptive errors when refs valid', async () => {
    const config: LlmConfig = {
      default: 'claude-haiku',
      commands: {
        'claude-haiku': {
          command: 'claude',
          allowedSubcommands: [],
          disallowedSubcommands: [],
        },
      },
      adaptive: {
        defaultEvaluator: 'claude-haiku',
        defaultReplanner: 'claude-haiku',
      },
    };

    const deps = createFakeDoctorDeps(['claude']);
    const report = await runDoctor(config, deps);

    expect(filterErrors(report.errors, 'UNKNOWN_ADAPTIVE_EVALUATOR')).toHaveLength(0);
    expect(filterErrors(report.errors, 'UNKNOWN_ADAPTIVE_REPLANNER')).toHaveLength(0);
  });
});
