import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Orchestrator } from '../../src/lib/Orchestrator.js';
import { ConfigManager } from '../../src/lib/ConfigManager.js';
import { CoreRunner } from '../../src/lib/CoreRunner.js';
import { SessionManager, SessionRecord } from '../../src/lib/SessionManager.js';
import { Logger } from '../../src/lib/Logger.js';
import { Planner } from '../../src/lib/Planner.js';
import { Executioner } from '../../src/lib/Executioner.js';
import { createTempWorkspace, cleanup } from '../helpers/tempDir.js';

describe('Orchestrator - Environment Propagation', () => {
  let tempDir: string;
  let orchestrator: Orchestrator;
  let configPath: string;
  let logsDir: string;
  let logPath: string;
  let sessionsDir: string;
  let plansDir: string;
  let executionsDir: string;

  beforeEach(async () => {
    tempDir = createTempWorkspace();
    const dataDir = join(tempDir, 'devflowv3-data');
    logsDir = join(dataDir, 'logs');
    logPath = join(logsDir, 'runs.jsonl');
    sessionsDir = join(dataDir, 'sessions');
    plansDir = join(dataDir, 'plans');
    executionsDir = join(dataDir, 'executions');
    configPath = join(tempDir, 'llm-config.env.test.json');

    // Create a default config file for beforeEach
    const defaultConfig = {
      default: 'test-default',
      defaultPlanner: 'test-default',
      defaultExecutioner: 'test-default',
      commands: {
        'test-default': {
          command: "sh -c 'cat > /dev/null && echo test'",
          allowedSubcommands: [],
          disallowedSubcommands: [],
        },
      },
    };
    writeFileSync(configPath, JSON.stringify(defaultConfig), 'utf-8');

    const configManager = new ConfigManager({ configPath });
    await configManager.load();

    const logger = new Logger({ logsDir, centralLogPath: logPath });
    await logger.ensureDir();

    const coreRunner = new CoreRunner();
    const sessionManager = new SessionManager({ sessionsDir });
    await sessionManager.ensureDir();

    const planner = new Planner({
      configManager,
      coreRunner,
      logger,
      plansDir,
    });

    const executioner = new Executioner({
      configManager,
      coreRunner,
      logger,
      executionsDir,
    });

    orchestrator = new Orchestrator({
      configManager,
      coreRunner,
      sessionManager,
      logger,
      planner,
      executioner,
      rootDir: process.cwd(),
      dataDir,
    });
  });

  afterEach(() => {
    cleanup(tempDir);
  });

  it('should propagate env from config to subprocess', async () => {
    // Create a config with env field that echoes DEVFLOW_TEST_VAR
    const configWithEnv = {
      default: 'test-env-cmd',
      defaultPlanner: 'test-env-cmd',
      defaultExecutioner: 'test-env-cmd',
      commands: {
        'test-env-cmd': {
          command: "sh -c 'cat > /dev/null && echo DEVFLOW_TEST_VAR=$DEVFLOW_TEST_VAR'",
          allowedSubcommands: [],
          disallowedSubcommands: [],
          env: {
            DEVFLOW_TEST_VAR: 'hello-from-config',
          },
        },
      },
    };

    writeFileSync(configPath, JSON.stringify(configWithEnv), 'utf-8');

    // Reload config
    const configManager = new ConfigManager({ configPath });
    await configManager.load();

    orchestrator = new Orchestrator({
      configManager,
      coreRunner: new CoreRunner(),
      sessionManager: new SessionManager({ sessionsDir }),
      logger: new Logger({ logsDir, centralLogPath: logPath }),
      planner: new Planner({
        configManager,
        coreRunner: new CoreRunner(),
        logger: new Logger({ logsDir, centralLogPath: logPath }),
        plansDir,
      }),
      executioner: new Executioner({
        configManager,
        coreRunner: new CoreRunner(),
        logger: new Logger({ logsDir, centralLogPath: logPath }),
        executionsDir,
      }),
      rootDir: process.cwd(),
      dataDir: join(tempDir, 'devflowv3-data'),
    });

    const result = await orchestrator.execute({
      subcommand: 'single-prompt',
      prompt: 'test env propagation',
      env: process.env,
    });

    expect(result.exitCode).toBe(0);
    expect(existsSync(result.sessionFilePath)).toBe(true);

    const content = readFileSync(result.sessionFilePath, 'utf-8');
    const sessionRecord = JSON.parse(content) as SessionRecord;

    // Verify that env var from config was propagated
    expect(sessionRecord.stdout).toContain('hello-from-config');
    expect(result.finalOutput).toContain('hello-from-config');
  });

  it('should forward process.env when config does not define env', async () => {
    // Create a config without env field
    const configWithoutEnv = {
      default: 'test-no-env-cmd',
      defaultPlanner: 'test-no-env-cmd',
      defaultExecutioner: 'test-no-env-cmd',
      commands: {
        'test-no-env-cmd': {
          command:
            "sh -c 'cat > /dev/null && echo PATH_EXISTS=$([[ -n \"$PATH\" ]] && echo yes || echo no)'",
          allowedSubcommands: [],
          disallowedSubcommands: [],
        },
      },
    };

    writeFileSync(configPath, JSON.stringify(configWithoutEnv), 'utf-8');

    // Reload config
    const configManager = new ConfigManager({ configPath });
    await configManager.load();

    orchestrator = new Orchestrator({
      configManager,
      coreRunner: new CoreRunner(),
      sessionManager: new SessionManager({ sessionsDir }),
      logger: new Logger({ logsDir, centralLogPath: logPath }),
      planner: new Planner({
        configManager,
        coreRunner: new CoreRunner(),
        logger: new Logger({ logsDir, centralLogPath: logPath }),
        plansDir,
      }),
      executioner: new Executioner({
        configManager,
        coreRunner: new CoreRunner(),
        logger: new Logger({ logsDir, centralLogPath: logPath }),
        executionsDir,
      }),
      rootDir: process.cwd(),
      dataDir: join(tempDir, 'devflowv3-data'),
    });

    const result = await orchestrator.execute({
      subcommand: 'single-prompt',
      prompt: 'test process.env forwarding',
      env: process.env,
    });

    expect(result.exitCode).toBe(0);
    expect(existsSync(result.sessionFilePath)).toBe(true);

    const content = readFileSync(result.sessionFilePath, 'utf-8');
    const sessionRecord = JSON.parse(content) as SessionRecord;

    // Verify that process.env was forwarded (PATH should exist in process.env)
    expect(sessionRecord.stdout).toContain('PATH_EXISTS=yes');
    expect(result.finalOutput).toContain('PATH_EXISTS=yes');
  });

  it('should merge config env with process.env (config takes precedence)', async () => {
    // Set a test variable in process.env to be overridden
    const testEnvValue = `from-process-${Date.now()}`;
    const oldEnv = process.env.DEVFLOW_MERGE_TEST;
    process.env.DEVFLOW_MERGE_TEST = testEnvValue;

    try {
      // Create a config that overrides the env var
      const configWithOverride = {
        default: 'test-merge-cmd',
        defaultPlanner: 'test-merge-cmd',
        defaultExecutioner: 'test-merge-cmd',
        commands: {
          'test-merge-cmd': {
            command:
              "sh -c 'cat > /dev/null && echo DEVFLOW_MERGE_TEST=$DEVFLOW_MERGE_TEST'",
            allowedSubcommands: [],
            disallowedSubcommands: [],
            env: {
              DEVFLOW_MERGE_TEST: 'from-config-override',
            },
          },
        },
      };

      writeFileSync(configPath, JSON.stringify(configWithOverride), 'utf-8');

      // Reload config
      const configManager = new ConfigManager({ configPath });
      await configManager.load();

      orchestrator = new Orchestrator({
        configManager,
        coreRunner: new CoreRunner(),
        sessionManager: new SessionManager({ sessionsDir }),
        logger: new Logger({ logsDir, centralLogPath: logPath }),
        planner: new Planner({
          configManager,
          coreRunner: new CoreRunner(),
          logger: new Logger({ logsDir, centralLogPath: logPath }),
          plansDir,
        }),
        executioner: new Executioner({
          configManager,
          coreRunner: new CoreRunner(),
          logger: new Logger({ logsDir, centralLogPath: logPath }),
          executionsDir,
        }),
        rootDir: process.cwd(),
        dataDir: join(tempDir, 'devflowv3-data'),
      });

      const result = await orchestrator.execute({
        subcommand: 'single-prompt',
        prompt: 'test env override',
        env: process.env,
      });

      expect(result.exitCode).toBe(0);

      const content = readFileSync(result.sessionFilePath, 'utf-8');
      const sessionRecord = JSON.parse(content) as SessionRecord;

      // Verify that config env takes precedence
      expect(sessionRecord.stdout).toContain('from-config-override');
      expect(sessionRecord.stdout).not.toContain(testEnvValue);
    } finally {
      // Restore old env
      if (oldEnv !== undefined) {
        process.env.DEVFLOW_MERGE_TEST = oldEnv;
      } else {
        delete process.env.DEVFLOW_MERGE_TEST;
      }
    }
  });
});
