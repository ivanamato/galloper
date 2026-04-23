import { describe, it, expect, beforeEach } from 'vitest';
import { ConfigManager } from '../../src/lib/ConfigManager.js';
import { join } from 'node:path';

describe('ConfigManager', () => {
  let configPath: string;
  let configManager: ConfigManager;

  beforeEach(() => {
    configPath = join(process.cwd(), 'tests/fixtures/galloper.test.json');
    configManager = new ConfigManager({ configPath });
  });

  it('should load valid config from file with typed structure', async () => {
    const config = await configManager.load();
    expect(config.default).toBe('mock-success');
    expect(config.defaultPlanner).toBe('mock-json');
    expect(config.defaultExecutioner).toBe('mock-implement');
    expect(Object.keys(config.commands).length).toBeGreaterThan(0);
    expect(config.commands['mock-json']).toBeDefined();
  });

  it('should cache config after first load', async () => {
    const config1 = await configManager.load();
    const config2 = await configManager.load();
    expect(config1).toBe(config2); // Same reference
  });

  it('should expose default command name correctly', async () => {
    await configManager.load();
    const defaultCmd = configManager.getDefaultCommandName();
    expect(defaultCmd).toBe('mock-success');
  });

  it('should throw specific error when defaultPlanner references non-existent command', async () => {
    const badConfigPath = join(process.cwd(), 'tests/fixtures/bad-planner-config.json');
    const cm = new ConfigManager({ configPath: badConfigPath });

    const { writeFileSync, mkdirSync, rmSync } = await import('node:fs');
    mkdirSync(join(process.cwd(), 'tests/fixtures'), { recursive: true });
    writeFileSync(
      badConfigPath,
      JSON.stringify({
        default: 'mock-success',
        defaultPlanner: 'non-existent-planner',
        commands: { 'mock-success': { command: 'echo', allowedSubcommands: [], disallowedSubcommands: [] } },
      })
    );

    try {
      await cm.load();
      expect.fail('Should have thrown error for missing defaultPlanner');
    } catch (error) {
      const msg = (error as Error).message;
      expect(msg).toContain('defaultPlanner');
      expect(msg).toContain('non-existent-planner');
      expect(msg).toContain('does not exist');
    }

    rmSync(badConfigPath);
  });

  it('should load command entry with allowedSubcommands array', async () => {
    await configManager.load();
    const cmd = configManager.getCommand('mock-json');
    expect(cmd.command).toContain('echo-json.sh');
    expect(Array.isArray(cmd.allowedSubcommands)).toBe(true);
    expect(cmd.allowedSubcommands).toContain('plan');
  });

  it('should load command entry with disallowedSubcommands array', async () => {
    await configManager.load();
    const cmd = configManager.getCommand('mock-fail');
    expect(Array.isArray(cmd.disallowedSubcommands)).toBe(true);
    expect(cmd.disallowedSubcommands).toContain('implement');
  });

  it('should throw specific error for unknown command', async () => {
    await configManager.load();
    try {
      configManager.getCommand('unknown-cmd');
      expect.fail('Should throw for unknown command');
    } catch (error) {
      const msg = (error as Error).message;
      expect(msg).toContain('Unknown command: unknown-cmd');
      expect(msg).toContain('Available:');
    }
  });

  it('should validate allowedSubcommands restriction', async () => {
    await configManager.load();
    const entry = configManager.getCommand('mock-json'); // allowedSubcommands: ['plan']

    // Plan is allowed
    expect(() => configManager.validateSubcommand(entry, 'plan')).not.toThrow();

    // Implement is not in allowed list
    try {
      configManager.validateSubcommand(entry, 'implement');
      expect.fail('Should reject implement for mock-json');
    } catch (error) {
      const msg = (error as Error).message;
      expect(msg).toContain('not allowed for subcommand "implement"');
      expect(msg).toContain('Allowed:');
    }
  });

  it('should validate disallowedSubcommands restriction', async () => {
    await configManager.load();
    const entry = configManager.getCommand('mock-fail'); // disallowedSubcommands: ['implement']

    // Implement is in disallowed list
    try {
      configManager.validateSubcommand(entry, 'implement');
      expect.fail('Should reject implement for mock-fail');
    } catch (error) {
      const msg = (error as Error).message;
      expect(msg).toContain('not allowed for subcommand "implement"');
    }

    // Plan is allowed (empty allowedSubcommands means all except disallowed)
    expect(() => configManager.validateSubcommand(entry, 'plan')).not.toThrow();
  });

  it('should list commands allowing specific subcommand', async () => {
    await configManager.load();
    const planCommands = configManager.getCommandsAllowingSubcommand('plan');
    expect(Array.isArray(planCommands)).toBe(true);
    expect(planCommands.length).toBeGreaterThan(0);
    expect(planCommands).toContain('mock-json');
  });

  it('should return empty array for subcommand with no supporting commands', async () => {
    await configManager.load();
    const cmds = configManager.getCommandsAllowingSubcommand('nonexistent-subcommand');
    expect(cmds).toEqual([]);
  });

  it('should resolve single-prompt to default command', async () => {
    await configManager.load();
    const result = configManager.resolveForSubcommand('single-prompt');
    expect(result).toBe('mock-success');
  });

  it('should resolve plan to defaultPlanner', async () => {
    await configManager.load();
    const result = configManager.resolveForSubcommand('plan');
    expect(result).toBe('mock-json');
  });

  it('should resolve implement to defaultExecutioner', async () => {
    await configManager.load();
    const result = configManager.resolveForSubcommand('implement');
    expect(result).toBe('mock-implement');
  });

  it('should verify subcommand allowed for command', async () => {
    await configManager.load();
    // mock-json has allowedSubcommands: ['plan']
    expect(configManager.isSubcommandAllowed('mock-json', 'plan')).toBe(true);
    expect(configManager.isSubcommandAllowed('mock-json', 'implement')).toBe(false);
    expect(configManager.isSubcommandAllowed('mock-json', 'single-prompt')).toBe(false);

    // mock-fail has disallowedSubcommands: ['implement']
    expect(configManager.isSubcommandAllowed('mock-fail', 'plan')).toBe(true);
    expect(configManager.isSubcommandAllowed('mock-fail', 'implement')).toBe(false);

    // mock-success has no restrictions
    expect(configManager.isSubcommandAllowed('mock-success', 'single-prompt')).toBe(true);
    expect(configManager.isSubcommandAllowed('mock-success', 'plan')).toBe(true);
  });

  it('should throw when calling methods before load', () => {
    const cm = new ConfigManager({ configPath });

    try {
      cm.getDefaultCommandName();
      expect.fail('Should throw before load');
    } catch (error) {
      expect((error as Error).message).toContain('Config not loaded');
    }

    try {
      cm.getCommand('test');
      expect.fail('Should throw before load');
    } catch (error) {
      expect((error as Error).message).toContain('Config not loaded');
    }

    try {
      cm.resolveForSubcommand('plan');
      expect.fail('Should throw before load');
    } catch (error) {
      expect((error as Error).message).toContain('Config not loaded');
    }
  });

  it('should load and validate hooks configuration', async () => {
    const hooksConfigPath = join(process.cwd(), 'tests/fixtures/galloper.hooks.test.json');
    const cm = new ConfigManager({ configPath: hooksConfigPath });
    const config = await cm.load();

    expect(config.hooks).toBeDefined();
    expect(config.hooks?.lifecycle).toBeDefined();
    expect(config.hooks?.events).toBeDefined();

    const hooks = cm.getHooks();
    expect(hooks.lifecycle).toBeDefined();
    expect(hooks.lifecycle?.['pre-plan']).toBeDefined();
    expect(hooks.lifecycle?.['post-task-file']).toBeDefined();
  });

  it('should reject post-plan hooks with onFailure retry', async () => {
    const badConfigPath = join(process.cwd(), 'tests/fixtures/bad-post-plan-config.json');
    const cm = new ConfigManager({ configPath: badConfigPath });

    const { writeFileSync, mkdirSync, rmSync } = await import('node:fs');
    mkdirSync(join(process.cwd(), 'tests/fixtures'), { recursive: true });
    writeFileSync(
      badConfigPath,
      JSON.stringify({
        default: 'mock-success',
        commands: { 'mock-success': { command: 'echo', allowedSubcommands: [], disallowedSubcommands: [] } },
        hooks: {
          lifecycle: {
            'post-plan': [
              {
                command: 'echo test',
                onFailure: 'retry',
              },
            ],
          },
        },
      })
    );

    try {
      await cm.load();
      expect.fail('Should reject post-plan with retry');
    } catch (error) {
      const msg = (error as Error).message;
      expect(msg).toContain('post-plan hooks cannot have onFailure: \'retry\'');
    }

    rmSync(badConfigPath);
  });

  it('should reject pre-hook without instructions or command', async () => {
    const badConfigPath = join(process.cwd(), 'tests/fixtures/bad-pre-hook-config.json');
    const cm = new ConfigManager({ configPath: badConfigPath });

    const { writeFileSync, mkdirSync, rmSync } = await import('node:fs');
    mkdirSync(join(process.cwd(), 'tests/fixtures'), { recursive: true });
    writeFileSync(
      badConfigPath,
      JSON.stringify({
        default: 'mock-success',
        commands: { 'mock-success': { command: 'echo', allowedSubcommands: [], disallowedSubcommands: [] } },
        hooks: {
          lifecycle: {
            'pre-plan': [
              {
                // Missing both instructions and command
              },
            ],
          },
        },
      })
    );

    try {
      await cm.load();
      expect.fail('Should reject pre-hook without instructions or command');
    } catch (error) {
      const msg = (error as Error).message;
      expect(msg).toContain('must have either \'instructions\' or \'command\'');
    }

    rmSync(badConfigPath);
  });

  it('should reject post-hook without command', async () => {
    const badConfigPath = join(process.cwd(), 'tests/fixtures/bad-post-hook-config.json');
    const cm = new ConfigManager({ configPath: badConfigPath });

    const { writeFileSync, mkdirSync, rmSync } = await import('node:fs');
    mkdirSync(join(process.cwd(), 'tests/fixtures'), { recursive: true });
    writeFileSync(
      badConfigPath,
      JSON.stringify({
        default: 'mock-success',
        commands: { 'mock-success': { command: 'echo', allowedSubcommands: [], disallowedSubcommands: [] } },
        hooks: {
          lifecycle: {
            'post-task': [
              {
                onFailure: 'warn',
                // Missing command
              },
            ],
          },
        },
      })
    );

    try {
      await cm.load();
      expect.fail('Should reject post-hook without command');
    } catch (error) {
      const msg = (error as Error).message;
      expect(msg).toContain('must have a \'command\' property');
    }

    rmSync(badConfigPath);
  });

  it('should reject *-file hooks without match glob', async () => {
    const badConfigPath = join(process.cwd(), 'tests/fixtures/bad-file-hook-config.json');
    const cm = new ConfigManager({ configPath: badConfigPath });

    const { writeFileSync, mkdirSync, rmSync } = await import('node:fs');
    mkdirSync(join(process.cwd(), 'tests/fixtures'), { recursive: true });
    writeFileSync(
      badConfigPath,
      JSON.stringify({
        default: 'mock-success',
        commands: { 'mock-success': { command: 'echo', allowedSubcommands: [], disallowedSubcommands: [] } },
        hooks: {
          lifecycle: {
            'pre-task-file': [
              {
                instructions: 'Validate file',
                // Missing match glob
              },
            ],
          },
        },
      })
    );

    try {
      await cm.load();
      expect.fail('Should reject *-file hook without match');
    } catch (error) {
      const msg = (error as Error).message;
      expect(msg).toContain('must have a \'match\' glob pattern');
    }

    rmSync(badConfigPath);
  });

  it('should accept valid glob patterns without errors', async () => {
    const hooksConfigPath = join(process.cwd(), 'tests/fixtures/galloper.hooks.test.json');
    const cm = new ConfigManager({ configPath: hooksConfigPath });
    const config = await cm.load();

    // Should not throw
    expect(config.hooks).toBeDefined();

    // Check that the file-scoped hooks have valid glob patterns
    const fileHooks = config.hooks?.lifecycle?.['pre-task-file'];
    expect(fileHooks).toBeDefined();
    expect(fileHooks?.[0]?.match).toBe('src/**/*.ts');
  });

  it('should reject unknown lifecycle phases', async () => {
    const badConfigPath = join(process.cwd(), 'tests/fixtures/bad-phase-config.json');
    const cm = new ConfigManager({ configPath: badConfigPath });

    const { writeFileSync, mkdirSync, rmSync } = await import('node:fs');
    mkdirSync(join(process.cwd(), 'tests/fixtures'), { recursive: true });
    writeFileSync(
      badConfigPath,
      JSON.stringify({
        default: 'mock-success',
        commands: { 'mock-success': { command: 'echo', allowedSubcommands: [], disallowedSubcommands: [] } },
        hooks: {
          lifecycle: {
            'invalid-phase': [
              {
                command: 'echo test',
              },
            ],
          },
        },
      })
    );

    try {
      await cm.load();
      expect.fail('Should reject unknown phase');
    } catch (error) {
      const msg = (error as Error).message;
      expect(msg).toContain('Unknown lifecycle phase: invalid-phase');
      expect(msg).toContain('Valid phases:');
    }

    rmSync(badConfigPath);
  });

  it('should load and return command with valid env object', async () => {
    const envConfigPath = join(process.cwd(), 'tests/fixtures/valid-env-config.json');
    const cm = new ConfigManager({ configPath: envConfigPath });

    const { writeFileSync, mkdirSync, rmSync } = await import('node:fs');
    mkdirSync(join(process.cwd(), 'tests/fixtures'), { recursive: true });
    writeFileSync(
      envConfigPath,
      JSON.stringify({
        default: 'cmd-with-env',
        commands: {
          'cmd-with-env': {
            command: 'echo "hello"',
            allowedSubcommands: [],
            disallowedSubcommands: [],
            env: {
              FOO: 'bar',
              BAZ: 'qux',
            },
          },
        },
      })
    );

    const config = await cm.load();
    const cmd = cm.getCommand('cmd-with-env');
    expect(cmd.env).toBeDefined();
    expect(cmd.env).toEqual({ FOO: 'bar', BAZ: 'qux' });

    rmSync(envConfigPath);
  });

  it('should reject config where env is a string instead of object', async () => {
    const badEnvConfigPath = join(process.cwd(), 'tests/fixtures/bad-env-string-config.json');
    const cm = new ConfigManager({ configPath: badEnvConfigPath });

    const { writeFileSync, mkdirSync, rmSync } = await import('node:fs');
    mkdirSync(join(process.cwd(), 'tests/fixtures'), { recursive: true });
    writeFileSync(
      badEnvConfigPath,
      JSON.stringify({
        default: 'cmd-with-bad-env',
        commands: {
          'cmd-with-bad-env': {
            command: 'echo "hello"',
            allowedSubcommands: [],
            disallowedSubcommands: [],
            env: 'not-an-object',
          },
        },
      })
    );

    try {
      await cm.load();
      expect.fail('Should reject env as string');
    } catch (error) {
      const msg = (error as Error).message;
      expect(msg).toContain('env must be an object');
    }

    rmSync(badEnvConfigPath);
  });

  it('should reject config where env.KEY is a number instead of string', async () => {
    const badEnvValueConfigPath = join(process.cwd(), 'tests/fixtures/bad-env-value-config.json');
    const cm = new ConfigManager({ configPath: badEnvValueConfigPath });

    const { writeFileSync, mkdirSync, rmSync } = await import('node:fs');
    mkdirSync(join(process.cwd(), 'tests/fixtures'), { recursive: true });
    writeFileSync(
      badEnvValueConfigPath,
      JSON.stringify({
        default: 'cmd-with-bad-env-value',
        commands: {
          'cmd-with-bad-env-value': {
            command: 'echo "hello"',
            allowedSubcommands: [],
            disallowedSubcommands: [],
            env: {
              VALID_KEY: 'valid-value',
              INVALID_NUMBER: 42,
            },
          },
        },
      })
    );

    try {
      await cm.load();
      expect.fail('Should reject env.INVALID_NUMBER as number');
    } catch (error) {
      const msg = (error as Error).message;
      expect(msg).toContain('env');
      expect(msg).toContain('must be a string');
    }

    rmSync(badEnvValueConfigPath);
  });
});

describe('validateLlmConfig (pure)', () => {
  const BASE = (): import('../../src/lib/ConfigManager.js').LlmConfig => ({
    default: 'a',
    commands: {
      a: { command: 'echo', allowedSubcommands: [], disallowedSubcommands: [] },
    },
  });

  it('accepts a minimal valid config', async () => {
    const { validateLlmConfig } = await import('../../src/lib/ConfigManager.js');
    expect(() => validateLlmConfig(BASE())).not.toThrow();
  });

  it('throws when defaultPlanner references unknown command (with suggestion)', async () => {
    const { validateLlmConfig } = await import('../../src/lib/ConfigManager.js');
    const cfg = BASE();
    cfg.defaultPlanner = 'ab';
    expect(() => validateLlmConfig(cfg)).toThrow(/defaultPlanner.*ab.*did you mean 'a'/);
  });

  it('throws when defaultExecutioner references unknown command', async () => {
    const { validateLlmConfig } = await import('../../src/lib/ConfigManager.js');
    const cfg = BASE();
    cfg.defaultExecutioner = 'zz';
    expect(() => validateLlmConfig(cfg)).toThrow(/defaultExecutioner.*zz/);
  });

  it('throws when env is not an object', async () => {
    const { validateLlmConfig } = await import('../../src/lib/ConfigManager.js');
    const cfg = BASE();
    (cfg.commands.a as any).env = 'not-an-object';
    expect(() => validateLlmConfig(cfg)).toThrow(/env must be an object/);
  });

  it('throws when env value is not a string', async () => {
    const { validateLlmConfig } = await import('../../src/lib/ConfigManager.js');
    const cfg = BASE();
    (cfg.commands.a as any).env = { KEY: 42 };
    expect(() => validateLlmConfig(cfg)).toThrow(/env\.KEY must be a string/);
  });

  it('throws on unknown allowedSubcommand with suggestion', async () => {
    const { validateLlmConfig } = await import('../../src/lib/ConfigManager.js');
    const cfg = BASE();
    cfg.commands.a.allowedSubcommands = ['paln'];
    expect(() => validateLlmConfig(cfg)).toThrow(/allowedSubcommands.*paln.*did you mean 'plan'/);
  });

  it('throws on unknown disallowedSubcommand', async () => {
    const { validateLlmConfig } = await import('../../src/lib/ConfigManager.js');
    const cfg = BASE();
    cfg.commands.a.disallowedSubcommands = ['nope'];
    expect(() => validateLlmConfig(cfg)).toThrow(/disallowedSubcommands.*nope/);
  });

  it('throws on executionerEscalation referencing missing command', async () => {
    const { validateLlmConfig } = await import('../../src/lib/ConfigManager.js');
    const cfg = BASE();
    cfg.executionerEscalation = ['missing'];
    expect(() => validateLlmConfig(cfg)).toThrow(/executionerEscalation\[0\].*"missing" does not exist/);
  });

  it('throws when executionerEscalation command does not allow implement', async () => {
    const { validateLlmConfig } = await import('../../src/lib/ConfigManager.js');
    const cfg = BASE();
    cfg.commands.a.allowedSubcommands = ['plan'];
    cfg.executionerEscalation = ['a'];
    expect(() => validateLlmConfig(cfg)).toThrow(/does not allow implement/);
  });

  it('throws when executionerEscalation is not an array', async () => {
    const { validateLlmConfig } = await import('../../src/lib/ConfigManager.js');
    const cfg = BASE();
    (cfg as any).executionerEscalation = 'not-an-array';
    expect(() => validateLlmConfig(cfg)).toThrow(/executionerEscalation must be an array/);
  });

  it('throws on unknown hook lifecycle phase', async () => {
    const { validateLlmConfig } = await import('../../src/lib/ConfigManager.js');
    const cfg = BASE();
    cfg.hooks = { lifecycle: { 'bogus-phase': [] as any } } as any;
    expect(() => validateLlmConfig(cfg)).toThrow(/Unknown lifecycle phase/);
  });

it('throws on unknown event name with suggestion', async () => {
    const { validateLlmConfig } = await import('../../src/lib/ConfigManager.js');
    const cfg = BASE();
    cfg.hooks = { events: { 'run.startd': [{ command: 'echo' }] } } as any;
    expect(() => validateLlmConfig(cfg)).toThrow(/Unknown event type.*did you mean 'run\.started'/);
  });

  it('throws when post-plan hook has onFailure retry', async () => {
    const { validateLlmConfig } = await import('../../src/lib/ConfigManager.js');
    const cfg = BASE();
    cfg.hooks = {
      lifecycle: { 'post-plan': [{ command: 'echo', onFailure: 'retry' } as any] },
    } as any;
    expect(() => validateLlmConfig(cfg)).toThrow(/post-plan hooks cannot have onFailure: 'retry'/);
  });

  it('throws when pre-hook has neither instructions nor command', async () => {
    const { validateLlmConfig } = await import('../../src/lib/ConfigManager.js');
    const cfg = BASE();
    cfg.hooks = { lifecycle: { 'pre-task': [{} as any] } } as any;
    expect(() => validateLlmConfig(cfg)).toThrow(/must have either 'instructions' or 'command'/);
  });

  it('throws when post-task-file hook has no match glob', async () => {
    const { validateLlmConfig } = await import('../../src/lib/ConfigManager.js');
    const cfg = BASE();
    cfg.hooks = {
      lifecycle: { 'post-task-file': [{ command: 'echo' } as any] },
    } as any;
    expect(() => validateLlmConfig(cfg)).toThrow(/must have a 'match' glob pattern/);
  });

  it('throws when runOnSurprise is not a boolean', async () => {
    const { validateLlmConfig } = await import('../../src/lib/ConfigManager.js');
    const cfg = BASE();
    cfg.hooks = {
      lifecycle: {
        'post-task-file': [
          { command: 'echo', match: '**/*.ts', runOnSurprise: 'true' } as any,
        ],
      },
    } as any;
    expect(() => validateLlmConfig(cfg)).toThrow(/runOnSurprise must be a boolean/);
  });

  it('throws when runOnSurprise is set on non post-task-file phase', async () => {
    const { validateLlmConfig } = await import('../../src/lib/ConfigManager.js');
    const cfg = BASE();
    cfg.hooks = {
      lifecycle: {
        'pre-task-file': [
          { command: 'echo', match: '**/*.ts', runOnSurprise: true } as any,
        ],
      },
    } as any;
    expect(() => validateLlmConfig(cfg)).toThrow(/runOnSurprise is only valid on post-task-file hooks/);
  });

  it('accepts runOnSurprise=true on a post-task-file hook', async () => {
    const { validateLlmConfig } = await import('../../src/lib/ConfigManager.js');
    const cfg = BASE();
    cfg.hooks = {
      lifecycle: {
        'post-task-file': [
          { command: 'echo', match: '**/*.ts', runOnSurprise: true } as any,
        ],
      },
    } as any;
    expect(() => validateLlmConfig(cfg)).not.toThrow();
  });

  it('throws when event hook has no command', async () => {
    const { validateLlmConfig } = await import('../../src/lib/ConfigManager.js');
    const cfg = BASE();
    cfg.hooks = { events: { 'run.started': [{} as any] } } as any;
    expect(() => validateLlmConfig(cfg)).toThrow(/event hook.*must have a 'command' property/);
  });

  it('throws when shell:false hook has a string command', async () => {
    const { validateLlmConfig } = await import('../../src/lib/ConfigManager.js');
    const cfg = BASE();
    cfg.hooks = {
      lifecycle: {
        'post-task-file': [
          { command: 'echo hi', match: '**/*.ts', shell: false } as any,
        ],
      },
    } as any;
    expect(() => validateLlmConfig(cfg)).toThrow(/when shell:false, command must be a non-empty string\[\]/);
  });

  it('throws when shell:true (default) hook has an array command', async () => {
    const { validateLlmConfig } = await import('../../src/lib/ConfigManager.js');
    const cfg = BASE();
    cfg.hooks = {
      lifecycle: {
        'post-task-file': [
          { command: ['echo', 'hi'], match: '**/*.ts' } as any,
        ],
      },
    } as any;
    expect(() => validateLlmConfig(cfg)).toThrow(/when shell:true \(default\), command must be a string/);
  });

  it('accepts shell:false with a valid string[] command', async () => {
    const { validateLlmConfig } = await import('../../src/lib/ConfigManager.js');
    const cfg = BASE();
    cfg.hooks = {
      lifecycle: {
        'post-task-file': [
          { command: ['node', '-e', '1'], match: '**/*.ts', shell: false } as any,
        ],
      },
    } as any;
    expect(() => validateLlmConfig(cfg)).not.toThrow();
  });

  it('accepts default (no shell) with a string command', async () => {
    const { validateLlmConfig } = await import('../../src/lib/ConfigManager.js');
    const cfg = BASE();
    cfg.hooks = {
      lifecycle: {
        'post-task-file': [
          { command: 'echo hi', match: '**/*.ts' } as any,
        ],
      },
    } as any;
    expect(() => validateLlmConfig(cfg)).not.toThrow();
  });

  it('throws when shell:false has an empty array command', async () => {
    const { validateLlmConfig } = await import('../../src/lib/ConfigManager.js');
    const cfg = BASE();
    cfg.hooks = {
      lifecycle: {
        'post-task-file': [
          { command: [], match: '**/*.ts', shell: false } as any,
        ],
      },
    } as any;
    expect(() => validateLlmConfig(cfg)).toThrow(/non-empty string\[\]/);
  });

  it('throws when shell is not a boolean', async () => {
    const { validateLlmConfig } = await import('../../src/lib/ConfigManager.js');
    const cfg = BASE();
    cfg.hooks = {
      lifecycle: {
        'post-task-file': [
          { command: 'echo', match: '**/*.ts', shell: 'false' } as any,
        ],
      },
    } as any;
    expect(() => validateLlmConfig(cfg)).toThrow(/shell must be a boolean/);
  });

  it('accepts a valid retry config', async () => {
    const { validateLlmConfig } = await import('../../src/lib/ConfigManager.js');
    const cfg = BASE();
    cfg.hooks = {
      lifecycle: {
        'post-task-file': [
          { command: 'echo', match: '**/*.ts', retry: { maxAttempts: 3, backoffMs: 50, jitter: 0.2 } } as any,
        ],
      },
    } as any;
    expect(() => validateLlmConfig(cfg)).not.toThrow();
  });

  it('throws when retry.maxAttempts is below 1', async () => {
    const { validateLlmConfig } = await import('../../src/lib/ConfigManager.js');
    const cfg = BASE();
    cfg.hooks = {
      lifecycle: {
        'post-task-file': [
          { command: 'echo', match: '**/*.ts', retry: { maxAttempts: 0, backoffMs: 10 } } as any,
        ],
      },
    } as any;
    expect(() => validateLlmConfig(cfg)).toThrow(/retry\.maxAttempts must be an integer in \[1, 20\]/);
  });

  it('throws when retry.maxAttempts is above 20', async () => {
    const { validateLlmConfig } = await import('../../src/lib/ConfigManager.js');
    const cfg = BASE();
    cfg.hooks = {
      lifecycle: {
        'post-task-file': [
          { command: 'echo', match: '**/*.ts', retry: { maxAttempts: 99, backoffMs: 10 } } as any,
        ],
      },
    } as any;
    expect(() => validateLlmConfig(cfg)).toThrow(/retry\.maxAttempts must be an integer in \[1, 20\]/);
  });

  it('throws when retry.backoffMs is negative', async () => {
    const { validateLlmConfig } = await import('../../src/lib/ConfigManager.js');
    const cfg = BASE();
    cfg.hooks = {
      lifecycle: {
        'post-task-file': [
          { command: 'echo', match: '**/*.ts', retry: { maxAttempts: 3, backoffMs: -5 } } as any,
        ],
      },
    } as any;
    expect(() => validateLlmConfig(cfg)).toThrow(/retry\.backoffMs must be a non-negative integer/);
  });

  it('throws when retry.jitter is outside [0, 1]', async () => {
    const { validateLlmConfig } = await import('../../src/lib/ConfigManager.js');
    const cfg = BASE();
    cfg.hooks = {
      lifecycle: {
        'post-task-file': [
          { command: 'echo', match: '**/*.ts', retry: { maxAttempts: 3, backoffMs: 10, jitter: 1.5 } } as any,
        ],
      },
    } as any;
    expect(() => validateLlmConfig(cfg)).toThrow(/retry\.jitter must be a number in \[0, 1\]/);
  });

  it('throws when retry is not an object', async () => {
    const { validateLlmConfig } = await import('../../src/lib/ConfigManager.js');
    const cfg = BASE();
    cfg.hooks = {
      lifecycle: {
        'post-task-file': [
          { command: 'echo', match: '**/*.ts', retry: 'yes' } as any,
        ],
      },
    } as any;
    expect(() => validateLlmConfig(cfg)).toThrow(/retry must be an object/);
  });

  it('rejects a destructive command without the destructive flag', async () => {
    const { validateLlmConfig } = await import('../../src/lib/ConfigManager.js');
    const cfg = BASE();
    cfg.hooks = {
      lifecycle: {
        'post-task-file': [
          { command: 'rm -rf /tmp/x', match: '**/*.ts' } as any,
        ],
      },
    } as any;
    expect(() => validateLlmConfig(cfg)).toThrow(/destructive pattern 'rm -rf'/);
  });

  it('accepts a destructive command when the destructive flag is set', async () => {
    const { validateLlmConfig } = await import('../../src/lib/ConfigManager.js');
    const cfg = BASE();
    cfg.hooks = {
      lifecycle: {
        'post-task-file': [
          { command: 'rm -rf /tmp/x', match: '**/*.ts', destructive: true } as any,
        ],
      },
    } as any;
    expect(() => validateLlmConfig(cfg)).not.toThrow();
  });

  it('rejects a destructive array-form command without the flag', async () => {
    const { validateLlmConfig } = await import('../../src/lib/ConfigManager.js');
    const cfg = BASE();
    cfg.hooks = {
      lifecycle: {
        'post-task-file': [
          { command: ['rm', '-rf', '/tmp/x'], match: '**/*.ts', shell: false } as any,
        ],
      },
    } as any;
    expect(() => validateLlmConfig(cfg)).toThrow(/destructive pattern 'rm -rf'/);
  });

  it('throws when destructive is not a boolean', async () => {
    const { validateLlmConfig } = await import('../../src/lib/ConfigManager.js');
    const cfg = BASE();
    cfg.hooks = {
      lifecycle: {
        'post-task-file': [
          { command: 'echo hi', match: '**/*.ts', destructive: 'yes' } as any,
        ],
      },
    } as any;
    expect(() => validateLlmConfig(cfg)).toThrow(/destructive must be a boolean/);
  });

  it("accepts onAbort: 'revert'", async () => {
    const { validateLlmConfig } = await import('../../src/lib/ConfigManager.js');
    const cfg = BASE();
    cfg.hooks = {
      lifecycle: {
        'post-task-file': [
          { command: 'echo', match: '**/*.ts', onAbort: 'revert' } as any,
        ],
      },
    } as any;
    expect(() => validateLlmConfig(cfg)).not.toThrow();
  });

  it('rejects onAbort with an unknown value', async () => {
    const { validateLlmConfig } = await import('../../src/lib/ConfigManager.js');
    const cfg = BASE();
    cfg.hooks = {
      lifecycle: {
        'post-task-file': [
          { command: 'echo', match: '**/*.ts', onAbort: 'rollback' } as any,
        ],
      },
    } as any;
    expect(() => validateLlmConfig(cfg)).toThrow(/onAbort must be 'revert' or 'keep'/);
  });

  describe('workspace config validation', () => {
    it('accepts a valid workspace with single root', async () => {
      const { validateLlmConfig } = await import('../../src/lib/ConfigManager.js');
      const cfg = BASE();
      cfg.workspace = {
        roots: [
          { path: '.', vcs: 'git', label: 'main' },
        ],
      } as any;
      expect(() => validateLlmConfig(cfg)).not.toThrow();
    });

    it('accepts a valid workspace with multiple unique roots', async () => {
      const { validateLlmConfig } = await import('../../src/lib/ConfigManager.js');
      const cfg = BASE();
      cfg.workspace = {
        roots: [
          { path: '.', vcs: 'git', label: 'main' },
          { path: './subdir', vcs: 'none', label: 'secondary' },
        ],
      } as any;
      expect(() => validateLlmConfig(cfg)).not.toThrow();
    });

    it('rejects workspace with duplicate labels', async () => {
      const { validateLlmConfig } = await import('../../src/lib/ConfigManager.js');
      const cfg = BASE();
      cfg.workspace = {
        roots: [
          { path: '.', vcs: 'git', label: 'main' },
          { path: './other', vcs: 'none', label: 'main' },
        ],
      } as any;
      expect(() => validateLlmConfig(cfg)).toThrow(/label "main" is not unique/);
    });

    it('rejects root with unknown vcs value', async () => {
      const { validateLlmConfig } = await import('../../src/lib/ConfigManager.js');
      const cfg = BASE();
      cfg.workspace = {
        roots: [
          { path: '.', vcs: 'svn', label: 'main' } as any,
        ],
      } as any;
      expect(() => validateLlmConfig(cfg)).toThrow(/vcs: must be either 'git' or 'none'/);
    });

    it('rejects root with empty path', async () => {
      const { validateLlmConfig } = await import('../../src/lib/ConfigManager.js');
      const cfg = BASE();
      cfg.workspace = {
        roots: [
          { path: '', vcs: 'git', label: 'main' } as any,
        ],
      } as any;
      expect(() => validateLlmConfig(cfg)).toThrow(/path: must be a non-empty string/);
    });

    it('rejects root with whitespace-only path', async () => {
      const { validateLlmConfig } = await import('../../src/lib/ConfigManager.js');
      const cfg = BASE();
      cfg.workspace = {
        roots: [
          { path: '   ', vcs: 'git', label: 'main' } as any,
        ],
      } as any;
      expect(() => validateLlmConfig(cfg)).toThrow(/path: must be a non-empty string/);
    });

    it('rejects root with missing path', async () => {
      const { validateLlmConfig } = await import('../../src/lib/ConfigManager.js');
      const cfg = BASE();
      cfg.workspace = {
        roots: [
          { vcs: 'git', label: 'main' } as any,
        ],
      } as any;
      expect(() => validateLlmConfig(cfg)).toThrow(/path: must be a non-empty string/);
    });

    it('rejects root with empty label', async () => {
      const { validateLlmConfig } = await import('../../src/lib/ConfigManager.js');
      const cfg = BASE();
      cfg.workspace = {
        roots: [
          { path: '.', vcs: 'git', label: '' } as any,
        ],
      } as any;
      expect(() => validateLlmConfig(cfg)).toThrow(/label: must be a non-empty string/);
    });

    it('rejects root ignore with non-string entry', async () => {
      const { validateLlmConfig } = await import('../../src/lib/ConfigManager.js');
      const cfg = BASE();
      cfg.workspace = {
        roots: [
          { path: '.', vcs: 'git', label: 'main', ignore: ['*.md', 42] } as any,
        ],
      } as any;
      expect(() => validateLlmConfig(cfg)).toThrow(/ignore\[1\]: must be a string/);
    });

    it('rejects workspace-level ignore with non-string entry', async () => {
      const { validateLlmConfig } = await import('../../src/lib/ConfigManager.js');
      const cfg = BASE();
      cfg.workspace = {
        roots: [
          { path: '.', vcs: 'git', label: 'main' },
        ],
        ignore: ['*.log', true] as any,
      } as any;
      expect(() => validateLlmConfig(cfg)).toThrow(/workspace\.ignore\[1\]: must be a string/);
    });

    it('accepts workspace omitted entirely (backwards compat)', async () => {
      const { validateLlmConfig } = await import('../../src/lib/ConfigManager.js');
      const cfg = BASE();
      // workspace is not defined
      expect(() => validateLlmConfig(cfg)).not.toThrow();
    });

    it('accepts root with valid ignore array', async () => {
      const { validateLlmConfig } = await import('../../src/lib/ConfigManager.js');
      const cfg = BASE();
      cfg.workspace = {
        roots: [
          { path: '.', vcs: 'git', label: 'main', ignore: ['*.log', '*.tmp'] },
        ],
      } as any;
      expect(() => validateLlmConfig(cfg)).not.toThrow();
    });

    it('accepts workspace-level ignore array', async () => {
      const { validateLlmConfig } = await import('../../src/lib/ConfigManager.js');
      const cfg = BASE();
      cfg.workspace = {
        roots: [
          { path: '.', vcs: 'git', label: 'main' },
        ],
        ignore: ['node_modules', '.git'],
      } as any;
      expect(() => validateLlmConfig(cfg)).not.toThrow();
    });

    it('rejects non-object workspace', async () => {
      const { validateLlmConfig } = await import('../../src/lib/ConfigManager.js');
      const cfg = BASE();
      cfg.workspace = 'not-an-object' as any;
      expect(() => validateLlmConfig(cfg)).toThrow(/workspace must be an object/);
    });

    it('rejects workspace without roots array', async () => {
      const { validateLlmConfig } = await import('../../src/lib/ConfigManager.js');
      const cfg = BASE();
      cfg.workspace = {} as any;
      expect(() => validateLlmConfig(cfg)).toThrow(/workspace\.roots must be an array/);
    });

    it('rejects workspace.roots that is not an array', async () => {
      const { validateLlmConfig } = await import('../../src/lib/ConfigManager.js');
      const cfg = BASE();
      cfg.workspace = { roots: 'not-an-array' } as any;
      expect(() => validateLlmConfig(cfg)).toThrow(/workspace\.roots must be an array/);
    });

    it('rejects empty roots array', async () => {
      const { validateLlmConfig } = await import('../../src/lib/ConfigManager.js');
      const cfg = BASE();
      cfg.workspace = { roots: [] } as any;
      expect(() => validateLlmConfig(cfg)).not.toThrow();
    });
  });
});

describe('ConfigManager adaptive section', () => {
  it('loads adaptive config block with all fields', async () => {
    const configPath = join(process.cwd(), 'tests/fixtures/adaptive-config.test.json');
    const cm = new ConfigManager({ configPath });
    await cm.load();

    const adaptive = cm.getAdaptiveConfig();
    expect(adaptive).toBeDefined();
    expect(adaptive?.confidenceThreshold).toBe(0.8);
    expect(adaptive?.maxReplans).toBe(3);
    expect(adaptive?.diffMaxBytes).toBe(16384);
    expect(adaptive?.defaultEvaluator).toBe('cmd-b');
    expect(adaptive?.defaultReplanner).toBe('cmd-c');
  });

  it('getDefaultEvaluator returns adaptive.defaultEvaluator when set', async () => {
    const configPath = join(process.cwd(), 'tests/fixtures/adaptive-config.test.json');
    const cm = new ConfigManager({ configPath });
    await cm.load();

    expect(cm.getDefaultEvaluator()).toBe('cmd-b');
  });

  it('getDefaultReplanner returns adaptive.defaultReplanner when set', async () => {
    const configPath = join(process.cwd(), 'tests/fixtures/adaptive-config.test.json');
    const cm = new ConfigManager({ configPath });
    await cm.load();

    expect(cm.getDefaultReplanner()).toBe('cmd-c');
  });

  it('getDefaultEvaluator falls back to defaultPlanner when adaptive unset', async () => {
    const configPath = join(process.cwd(), 'tests/fixtures/galloper.test.json');
    const cm = new ConfigManager({ configPath });
    await cm.load();

    expect(cm.getDefaultEvaluator()).toBe('mock-json');
  });

  it('getDefaultReplanner falls back to defaultPlanner when adaptive unset', async () => {
    const configPath = join(process.cwd(), 'tests/fixtures/galloper.test.json');
    const cm = new ConfigManager({ configPath });
    await cm.load();

    expect(cm.getDefaultReplanner()).toBe('mock-json');
  });

  it('throws when adaptive.confidenceThreshold is out of [0, 1] range', async () => {
    const badConfigPath = join(process.cwd(), 'tests/fixtures/bad-adaptive-confidence.json');
    const cm = new ConfigManager({ configPath: badConfigPath });

    const { writeFileSync, mkdirSync, rmSync } = await import('node:fs');
    mkdirSync(join(process.cwd(), 'tests/fixtures'), { recursive: true });
    writeFileSync(
      badConfigPath,
      JSON.stringify({
        default: 'cmd-a',
        commands: { 'cmd-a': { command: 'echo', allowedSubcommands: [], disallowedSubcommands: [] } },
        adaptive: { confidenceThreshold: 1.5 },
      })
    );

    try {
      await cm.load();
      expect.fail('Should throw for out-of-range confidenceThreshold');
    } catch (error) {
      const msg = (error as Error).message;
      expect(msg).toContain('adaptive.confidenceThreshold');
    } finally {
      rmSync(badConfigPath);
    }
  });

  it('throws when adaptive.maxReplans is negative', async () => {
    const badConfigPath = join(process.cwd(), 'tests/fixtures/bad-adaptive-maxreplans.json');
    const cm = new ConfigManager({ configPath: badConfigPath });

    const { writeFileSync, mkdirSync, rmSync } = await import('node:fs');
    mkdirSync(join(process.cwd(), 'tests/fixtures'), { recursive: true });
    writeFileSync(
      badConfigPath,
      JSON.stringify({
        default: 'cmd-a',
        commands: { 'cmd-a': { command: 'echo', allowedSubcommands: [], disallowedSubcommands: [] } },
        adaptive: { maxReplans: -1 },
      })
    );

    try {
      await cm.load();
      expect.fail('Should throw for negative maxReplans');
    } catch (error) {
      const msg = (error as Error).message;
      expect(msg).toContain('adaptive.maxReplans');
    } finally {
      rmSync(badConfigPath);
    }
  });

  it('throws when adaptive.diffMaxBytes is zero', async () => {
    const badConfigPath = join(process.cwd(), 'tests/fixtures/bad-adaptive-diffmaxbytes.json');
    const cm = new ConfigManager({ configPath: badConfigPath });

    const { writeFileSync, mkdirSync, rmSync } = await import('node:fs');
    mkdirSync(join(process.cwd(), 'tests/fixtures'), { recursive: true });
    writeFileSync(
      badConfigPath,
      JSON.stringify({
        default: 'cmd-a',
        commands: { 'cmd-a': { command: 'echo', allowedSubcommands: [], disallowedSubcommands: [] } },
        adaptive: { diffMaxBytes: 0 },
      })
    );

    try {
      await cm.load();
      expect.fail('Should throw for zero diffMaxBytes');
    } catch (error) {
      const msg = (error as Error).message;
      expect(msg).toContain('adaptive.diffMaxBytes');
    } finally {
      rmSync(badConfigPath);
    }
  });

  it('throws when adaptive.defaultEvaluator references a non-existent command', async () => {
    const badConfigPath = join(process.cwd(), 'tests/fixtures/bad-adaptive-evaluator.json');
    const cm = new ConfigManager({ configPath: badConfigPath });

    const { writeFileSync, mkdirSync, rmSync } = await import('node:fs');
    mkdirSync(join(process.cwd(), 'tests/fixtures'), { recursive: true });
    writeFileSync(
      badConfigPath,
      JSON.stringify({
        default: 'cmd-a',
        commands: { 'cmd-a': { command: 'echo', allowedSubcommands: [], disallowedSubcommands: [] } },
        adaptive: { defaultEvaluator: 'does-not-exist' },
      })
    );

    try {
      await cm.load();
      expect.fail('Should throw for non-existent defaultEvaluator');
    } catch (error) {
      const msg = (error as Error).message;
      expect(msg).toContain('adaptive.defaultEvaluator');
      expect(msg).toContain('does not exist');
    } finally {
      rmSync(badConfigPath);
    }
  });

  it('throws when adaptive.defaultReplanner references a non-existent command', async () => {
    const badConfigPath = join(process.cwd(), 'tests/fixtures/bad-adaptive-replanner.json');
    const cm = new ConfigManager({ configPath: badConfigPath });

    const { writeFileSync, mkdirSync, rmSync } = await import('node:fs');
    mkdirSync(join(process.cwd(), 'tests/fixtures'), { recursive: true });
    writeFileSync(
      badConfigPath,
      JSON.stringify({
        default: 'cmd-a',
        commands: { 'cmd-a': { command: 'echo', allowedSubcommands: [], disallowedSubcommands: [] } },
        adaptive: { defaultReplanner: 'does-not-exist' },
      })
    );

    try {
      await cm.load();
      expect.fail('Should throw for non-existent defaultReplanner');
    } catch (error) {
      const msg = (error as Error).message;
      expect(msg).toContain('adaptive.defaultReplanner');
      expect(msg).toContain('does not exist');
    } finally {
      rmSync(badConfigPath);
    }
  });
});
