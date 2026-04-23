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
