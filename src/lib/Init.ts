import { LlmConfig, validateLlmConfig } from './ConfigManager.js';
import { Prompter } from './Prompter.js';
import { nearest } from './Suggest.js';

export interface SupportedCli {
  readonly name: string;
  readonly command: string;
}

export const SUPPORTED_CLIS: readonly SupportedCli[] = [
  { name: 'claude', command: 'claude --dangerously-skip-permissions' },
  { name: 'codex', command: 'codex exec --json --skip-git-repo-check -' },
  { name: 'gemini', command: 'gemini' },
];

export type InitFailureCode =
  | 'CONFIG_EXISTS'
  | 'NONE_DETECTED'
  | 'UNKNOWN_DEFAULT'
  | 'NO_SELECTION'
  | 'VALIDATION_FAILED'
  | 'WRITE_FAILED';

export type InitResult =
  | { ok: true; writtenPath: string; selected: string[]; defaultName: string }
  | { ok: false; code: InitFailureCode; message: string };

export interface InitOptions {
  force: boolean;
  nonInteractive: boolean;
  defaultName?: string;
  configPath: string;
}

export interface InitDeps {
  pathLookup(bin: string): Promise<boolean>;
  prompter: Prompter | null;
  writeFile(path: string, contents: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
  fileExists(path: string): Promise<boolean>;
  randomSuffix(): string;
}

export async function runInit(opts: InitOptions, deps: InitDeps): Promise<InitResult> {
  if (await deps.fileExists(opts.configPath) && !opts.force) {
    return {
      ok: false,
      code: 'CONFIG_EXISTS',
      message: `galloper.json already exists at ${opts.configPath}. Use --force to overwrite.`,
    };
  }

  const detected: SupportedCli[] = [];
  for (const cli of SUPPORTED_CLIS) {
    if (await deps.pathLookup(cli.name)) {
      detected.push(cli);
    }
  }

  if (detected.length === 0) {
    const names = SUPPORTED_CLIS.map((c) => c.name).join(', ');
    return {
      ok: false,
      code: 'NONE_DETECTED',
      message: `No supported LLM CLI found on $PATH. Expected one of: ${names}.`,
    };
  }

  const interactive = !opts.nonInteractive && deps.prompter !== null;
  let selected: SupportedCli[];
  let chosenDefault: string | undefined = opts.defaultName;

  if (interactive) {
    const prompter = deps.prompter as Prompter;
    const detectedNames = detected.map((c) => c.name);
    const pickAnswer = (await prompter.ask(
      `Detected: ${detectedNames.join(', ')}. Which to include? [all, or comma-separated names]: `,
    )).trim();

    if (pickAnswer === '' || pickAnswer.toLowerCase() === 'all') {
      selected = detected;
    } else {
      const requested = pickAnswer.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
      selected = [];
      for (const name of requested) {
        const match = detected.find((c) => c.name === name);
        if (!match) {
          const suggestion = nearest(name, detectedNames)[0];
          const suggestionText = suggestion ? ` (did you mean '${suggestion}'?)` : '';
          return {
            ok: false,
            code: 'UNKNOWN_DEFAULT',
            message: `'${name}' is not among detected CLIs${suggestionText}.`,
          };
        }
        if (!selected.some((c) => c.name === match.name)) {
          selected.push(match);
        }
      }
      if (selected.length === 0) {
        return { ok: false, code: 'NO_SELECTION', message: 'No CLIs selected.' };
      }
    }

    if (!chosenDefault) {
      const selectedNames = selected.map((c) => c.name);
      const defaultAnswer = (await prompter.ask(
        `Which is default? [${selectedNames[0]}, or one of: ${selectedNames.join(', ')}]: `,
      )).trim();
      chosenDefault = defaultAnswer === '' ? selectedNames[0] : defaultAnswer;
    }
  } else {
    selected = [...detected];
  }

  if (!chosenDefault) {
    chosenDefault = selected[0].name;
  }

  if (!selected.some((c) => c.name === chosenDefault)) {
    const selectedNames = selected.map((c) => c.name);
    const suggestion = nearest(chosenDefault, selectedNames)[0];
    const suggestionText = suggestion ? ` (did you mean '${suggestion}'?)` : '';
    return {
      ok: false,
      code: 'UNKNOWN_DEFAULT',
      message: `--default '${chosenDefault}' is not among selected CLIs (${selectedNames.join(', ')})${suggestionText}.`,
    };
  }

  const config: LlmConfig = {
    default: chosenDefault,
    commands: Object.fromEntries(
      selected.map((cli) => [
        cli.name,
        { command: cli.command, allowedSubcommands: [], disallowedSubcommands: [] },
      ]),
    ),
  };

  try {
    validateLlmConfig(config);
  } catch (error) {
    return {
      ok: false,
      code: 'VALIDATION_FAILED',
      message: `Generated config failed validation: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const contents = `${JSON.stringify(config, null, 2)}\n`;
  try {
    await atomicWrite(deps, opts.configPath, contents);
  } catch (error) {
    return {
      ok: false,
      code: 'WRITE_FAILED',
      message: `Failed to write galloper.json: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  return {
    ok: true,
    writtenPath: opts.configPath,
    selected: selected.map((c) => c.name),
    defaultName: chosenDefault,
  };
}

async function atomicWrite(deps: InitDeps, targetPath: string, contents: string): Promise<void> {
  const tmpPath = `${targetPath}.tmp-${deps.randomSuffix()}`;
  try {
    await deps.writeFile(tmpPath, contents);
    await deps.rename(tmpPath, targetPath);
  } catch (error) {
    try {
      await deps.unlink(tmpPath);
    } catch {
      // ignore
    }
    throw error;
  }
}
