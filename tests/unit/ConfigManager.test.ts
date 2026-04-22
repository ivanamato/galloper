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
