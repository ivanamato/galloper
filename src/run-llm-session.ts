#!/usr/bin/env node

import { promises as fs } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { Logger } from './lib/Logger.js';
import { SessionManager } from './lib/SessionManager.js';
import { ConfigManager } from './lib/ConfigManager.js';
import { CoreRunner } from './lib/CoreRunner.js';
import { Planner } from './lib/Planner.js';
import { Executioner } from './lib/Executioner.js';
import { DryRunHooks } from './lib/DryRunHooks.js';
import { Orchestrator, OrchestratorInput, isSubcommand, SubcommandName } from './lib/Orchestrator.js';
import { clampVerbosity } from './lib/Verbosity.js';
import { ConsoleHumanReporter, NullHumanReporter } from './lib/HumanReporter.js';
import { runDoctor, defaultDoctorDeps, KNOWN_SUBCOMMANDS } from './lib/Doctor.js';
import { nearest } from './lib/Suggest.js';
import { runInit, InitDeps } from './lib/Init.js';
import { createReadlinePrompter } from './lib/Prompter.js';

const CWD = process.cwd();
const ROOT_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const DATA_DIR = path.join(CWD, 'galloper-data');
const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');
const LOGS_DIR = path.join(DATA_DIR, 'logs');
const PLANS_DIR = path.join(DATA_DIR, 'plans');
const EXECUTIONS_DIR = path.join(DATA_DIR, 'executions');
const CONFIG_PATH = path.join(CWD, 'galloper.json');
const CENTRAL_LOG_PATH = path.join(LOGS_DIR, 'runs.jsonl');

interface CliArgs {
  subcommand: SubcommandName | 'doctor' | 'init';
  prompt?: string;
  promptFile?: string;
  planFile?: string;
  configPath?: string;
  verbosity: number;
  humanFriendly: boolean;
  concurrency?: number;
  force?: boolean;
  nonInteractive?: boolean;
  defaultName?: string;
  dryRunHooks?: boolean;
}

function printUsage(): void {
  process.stderr.write(`Usage: galloper <subcommand> [options]

Subcommands:
  single-prompt     Send a prompt and get a response (default command)
  plan              Generate a plan for a task
  implement         Execute implementation based on a plan
  pipeline          Generate a plan and execute all tasks (plan + implement)
  doctor            Validate the galloper.json configuration
  init              Scaffold a new galloper.json by detecting installed LLM CLIs

Options:
  --prompt <text>        The prompt text (required for single-prompt/plan if --prompt-file not provided)
  --prompt-file <path>   Path to a file containing the prompt (for single-prompt/plan)
  --plan-file <path>     Path to a plan JSON file (required for implement/--dry-run-hooks)
  --config <path>        Path to galloper.json (optional for doctor, default: ./galloper.json)
  --concurrency <n>      Number of concurrent tasks (default: 1, sequential)
  --dry-run-hooks        Analyze which hooks would match without executing (requires --plan-file)
  --force                (init) Overwrite an existing galloper.json
  --non-interactive      (init) Skip prompts; select all detected CLIs, first as default
  --default <name>       (init) Use the named CLI as the default command
  -v                     Verbose level 1 (show start/end events)
  -vv                    Verbose level 2 (show command resolution)
  -vvv                   Verbose level 3 (show all subprocess I/O)
  --human-friendly, -H   Human-friendly progress output (independent from -v flags)

Examples:
  galloper single-prompt --prompt "Hello, Claude!"
  galloper plan --prompt-file ./task.txt -v
  galloper implement --plan-file ./galloper-data/plans/plan.json -vv
  galloper pipeline --prompt "Build and execute a complete plan" -vvv
  galloper doctor --config ./galloper.json
  galloper init --non-interactive
`);
}

const EXTRA_SUBCOMMANDS = ['doctor', 'init'] as const;

function isExtraSubcommand(arg: string): arg is typeof EXTRA_SUBCOMMANDS[number] {
  return (EXTRA_SUBCOMMANDS as readonly string[]).includes(arg);
}

function parseArgs(argv: string[]): CliArgs {
  const subcommandArg = argv[0];
  if (!subcommandArg || (!isExtraSubcommand(subcommandArg) && !isSubcommand(subcommandArg))) {
    printUsage();
    process.exitCode = 2;
    const candidates = [...KNOWN_SUBCOMMANDS, ...EXTRA_SUBCOMMANDS];
    const suggestion = nearest(subcommandArg, candidates)[0];
    const suggestionText = suggestion ? ` (did you mean '${suggestion}'?)` : '';
    throw new Error(`Invalid or missing subcommand. Expected one of: single-prompt, plan, implement, pipeline, doctor, init${suggestionText}`);
  }

  const parsed: CliArgs = { subcommand: subcommandArg as any, verbosity: 0, humanFriendly: false };

  for (let i = 1; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--prompt') {
      parsed.prompt = argv[i + 1];
      i += 1;
    } else if (token === '--prompt-file') {
      parsed.promptFile = argv[i + 1];
      i += 1;
    } else if (token === '--plan-file') {
      parsed.planFile = argv[i + 1];
      i += 1;
    } else if (token === '--config') {
      parsed.configPath = argv[i + 1];
      i += 1;
    } else if (token === '--concurrency') {
      const num = parseInt(argv[i + 1], 10);
      if (!isNaN(num) && num >= 1) {
        parsed.concurrency = num;
      }
      i += 1;
    } else if (token === '--force') {
      parsed.force = true;
    } else if (token === '--non-interactive') {
      parsed.nonInteractive = true;
    } else if (token === '--default') {
      parsed.defaultName = argv[i + 1];
      i += 1;
    } else if (token === '--dry-run-hooks') {
      parsed.dryRunHooks = true;
    } else if (/^-v+$/.test(token)) {
      parsed.verbosity = token.length - 1;
    } else if (token === '--human-friendly' || token === '-H') {
      parsed.humanFriendly = true;
    }
  }

  // Validate implement subcommand requires --plan-file, not --prompt
  if (parsed.subcommand === 'implement') {
    if (parsed.prompt || parsed.promptFile) {
      throw new Error('implement subcommand does not accept --prompt or --prompt-file. Use --plan-file instead.');
    }
    if (!parsed.planFile) {
      throw new Error('implement subcommand requires --plan-file <path>');
    }
  }

  return parsed;
}

async function resolvePrompt(args: CliArgs): Promise<string> {
  if (args.promptFile) {
    const filePath = path.resolve(CWD, args.promptFile);
    return (await fs.readFile(filePath, 'utf8')).trim();
  }
  return args.prompt?.trim() ?? '';
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // Handle doctor subcommand separately
  if (args.subcommand === 'doctor') {
    const configPath = args.configPath ? path.resolve(CWD, args.configPath) : CONFIG_PATH;
    const configManager = new ConfigManager({ configPath });

    try {
      const config = await configManager.load();
      const report = await runDoctor(config, defaultDoctorDeps);

      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

      if (report.errors.length > 0) {
        process.exitCode = 1;
      } else {
        process.exitCode = 0;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`${message}\n`);
      process.exitCode = 1;
    }
    return;
  }

  // Handle init subcommand separately
  if (args.subcommand === 'init') {
    const configPath = args.configPath ? path.resolve(CWD, args.configPath) : CONFIG_PATH;
    const tty = Boolean(process.stdin.isTTY && process.stderr.isTTY);
    const nonInteractive = Boolean(args.nonInteractive) || !tty;
    const prompter = nonInteractive ? null : createReadlinePrompter();

    const deps: InitDeps = {
      pathLookup: defaultDoctorDeps.lookupOnPath,
      prompter,
      writeFile: (p, c) => fs.writeFile(p, c, 'utf8'),
      rename: (from, to) => fs.rename(from, to),
      unlink: (p) => fs.unlink(p),
      fileExists: async (p) => {
        try {
          await fs.access(p);
          return true;
        } catch {
          return false;
        }
      },
      randomSuffix: () => randomBytes(6).toString('hex'),
    };

    try {
      const result = await runInit(
        {
          force: Boolean(args.force),
          nonInteractive,
          defaultName: args.defaultName,
          configPath,
        },
        deps,
      );

      if (result.ok) {
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        process.exitCode = 0;
      } else {
        process.stderr.write(`${result.message}\n`);
        process.exitCode = 1;
      }
    } finally {
      prompter?.close();
    }
    return;
  }

  // Handle --dry-run-hooks flag
  if (args.dryRunHooks) {
    if (args.subcommand !== 'plan') {
      throw new Error('--dry-run-hooks is only valid with the "plan" subcommand');
    }
    if (!args.planFile) {
      throw new Error('--dry-run-hooks requires --plan-file <path>');
    }

    const configPath = args.configPath ? path.resolve(CWD, args.configPath) : CONFIG_PATH;
    const configManager = new ConfigManager({ configPath });

    try {
      const dryRunHooks = new DryRunHooks(configManager);
      const planFilePath = path.resolve(CWD, args.planFile);
      const result = await dryRunHooks.run(planFilePath);

      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      process.exitCode = 0;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`${message}\n`);
      process.exitCode = 1;
    }
    return;
  }

  // For implement subcommand, we don't need a prompt, just a plan file
  let prompt = '';
  if (args.subcommand !== 'implement') {
    prompt = await resolvePrompt(args);
    if (!prompt) {
      throw new Error('Missing prompt. Use: galloper <subcommand> --prompt "..." or --prompt-file ./path');
    }
  }

  const verbosity = clampVerbosity(args.verbosity);
  const humanReporter = args.humanFriendly ? new ConsoleHumanReporter({ enabled: true }) : new NullHumanReporter();
  const logger = new Logger({ logsDir: LOGS_DIR, centralLogPath: CENTRAL_LOG_PATH, verbosity });
  const sessionManager = new SessionManager({ sessionsDir: SESSIONS_DIR });
  const configManager = new ConfigManager({ configPath: CONFIG_PATH });
  const coreRunner = new CoreRunner();

  await logger.ensureDir();
  await sessionManager.ensureDir();
  await configManager.load();

  const planner = new Planner({
    configManager,
    coreRunner,
    logger,
    humanReporter,
    plansDir: PLANS_DIR,
  });

  const executioner = new Executioner({
    configManager,
    coreRunner,
    logger,
    humanReporter,
    executionsDir: EXECUTIONS_DIR,
  });

  const orchestrator = new Orchestrator({
    configManager,
    coreRunner,
    sessionManager,
    logger,
    humanReporter,
    planner,
    executioner,
    rootDir: ROOT_DIR,
    dataDir: DATA_DIR,
  });

  const input: OrchestratorInput = {
    subcommand: args.subcommand as SubcommandName,
    prompt: prompt || undefined,
    planFile: args.planFile,
    cwd: CWD,
    verbosity,
    concurrency: args.concurrency,
    env: {
      ...process.env,
      CODEX_DISABLE_PROJECT_HOOKS: '1',
    },
  };

  const result = await orchestrator.execute(input);

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

  if ((result.exitCode ?? 0) !== 0) {
    process.exitCode = result.exitCode ?? 1;
  }
}

main().catch(async (error: unknown) => {
  try {
    const logger = new Logger({ logsDir: LOGS_DIR, centralLogPath: CENTRAL_LOG_PATH });
    await logger.ensureDir();
    await logger.append({
      sessionId: 'bootstrap-error',
      type: 'run.crashed',
      timestamp: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
    });
  } catch {
    // Silently fail if logging fails
  }
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
