import { describe, it, expect } from 'vitest';
import { runInit, InitDeps, InitOptions, SUPPORTED_CLIS } from '../../src/lib/Init.js';
import { createFakePrompter } from '../helpers/fakePrompt.js';

interface FakeFsState {
  files: Map<string, string>;
  writeFailOn?: string;
  unlinkCalls: string[];
}

function createFakeDeps(
  opts: {
    presentBinaries?: string[];
    existingFiles?: Record<string, string>;
    prompterAnswers?: string[];
    writeFailOn?: string;
  } = {},
): { deps: InitDeps; state: FakeFsState } {
  const present = new Set(opts.presentBinaries ?? []);
  const state: FakeFsState = {
    files: new Map(Object.entries(opts.existingFiles ?? {})),
    writeFailOn: opts.writeFailOn,
    unlinkCalls: [],
  };
  const prompter = opts.prompterAnswers ? createFakePrompter(opts.prompterAnswers) : null;
  const deps: InitDeps = {
    pathLookup: async (bin) => present.has(bin),
    prompter,
    writeFile: async (p, c) => {
      if (state.writeFailOn && p.startsWith(state.writeFailOn)) {
        throw new Error('simulated write failure');
      }
      state.files.set(p, c);
    },
    rename: async (from, to) => {
      const content = state.files.get(from);
      if (content === undefined) {
        throw new Error(`rename: source ${from} does not exist`);
      }
      state.files.delete(from);
      state.files.set(to, content);
    },
    unlink: async (p) => {
      state.unlinkCalls.push(p);
      state.files.delete(p);
    },
    fileExists: async (p) => state.files.has(p),
    randomSuffix: () => 'testsuffix',
  };
  return { deps, state };
}

const TARGET = '/fake/repo/galloper.json';

function baseOpts(overrides: Partial<InitOptions> = {}): InitOptions {
  return {
    force: false,
    nonInteractive: true,
    configPath: TARGET,
    ...overrides,
  };
}

describe('runInit', () => {
  it('no CLIs detected returns NONE_DETECTED and writes nothing', async () => {
    const { deps, state } = createFakeDeps({ presentBinaries: [] });
    const result = await runInit(baseOpts(), deps);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('NONE_DETECTED');
    }
    expect(state.files.size).toBe(0);
  });

  it('one CLI detected, non-interactive uses that as default', async () => {
    const { deps, state } = createFakeDeps({ presentBinaries: ['codex'] });
    const result = await runInit(baseOpts(), deps);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.selected).toEqual(['codex']);
      expect(result.defaultName).toBe('codex');
    }
    const written = JSON.parse(state.files.get(TARGET) ?? '{}');
    expect(written.default).toBe('codex');
    expect(Object.keys(written.commands)).toEqual(['codex']);
  });

  it('multiple CLIs detected, non-interactive adds all and first is default', async () => {
    const { deps, state } = createFakeDeps({ presentBinaries: ['claude', 'codex', 'gemini'] });
    const result = await runInit(baseOpts(), deps);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.selected).toEqual(['claude', 'codex', 'gemini']);
      expect(result.defaultName).toBe('claude');
    }
    const written = JSON.parse(state.files.get(TARGET) ?? '{}');
    expect(written.default).toBe('claude');
    expect(Object.keys(written.commands).sort()).toEqual(['claude', 'codex', 'gemini']);
  });

  it('--default <name> overrides auto-pick', async () => {
    const { deps, state } = createFakeDeps({ presentBinaries: ['claude', 'codex'] });
    const result = await runInit(baseOpts({ defaultName: 'codex' }), deps);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.defaultName).toBe('codex');
    }
    const written = JSON.parse(state.files.get(TARGET) ?? '{}');
    expect(written.default).toBe('codex');
  });

  it('--default naming a non-detected CLI errors before writing', async () => {
    const { deps, state } = createFakeDeps({ presentBinaries: ['claude'] });
    const result = await runInit(baseOpts({ defaultName: 'codex' }), deps);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('UNKNOWN_DEFAULT');
    }
    expect(state.files.size).toBe(0);
  });

  it('interactive: user picks a subset', async () => {
    const { deps, state } = createFakeDeps({
      presentBinaries: ['claude', 'codex', 'gemini'],
      prompterAnswers: ['codex, gemini', ''],
    });
    const result = await runInit(baseOpts({ nonInteractive: false }), deps);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.selected).toEqual(['codex', 'gemini']);
      expect(result.defaultName).toBe('codex');
    }
    const written = JSON.parse(state.files.get(TARGET) ?? '{}');
    expect(Object.keys(written.commands).sort()).toEqual(['codex', 'gemini']);
    expect(written.default).toBe('codex');
  });

  it('interactive: user picks non-first as default', async () => {
    const { deps, state } = createFakeDeps({
      presentBinaries: ['claude', 'codex'],
      prompterAnswers: ['all', 'codex'],
    });
    const result = await runInit(baseOpts({ nonInteractive: false }), deps);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.defaultName).toBe('codex');
    }
    const written = JSON.parse(state.files.get(TARGET) ?? '{}');
    expect(written.default).toBe('codex');
  });

  it('galloper.json exists without --force refuses and leaves file untouched', async () => {
    const { deps, state } = createFakeDeps({
      presentBinaries: ['claude'],
      existingFiles: { [TARGET]: 'preexisting content' },
    });
    const result = await runInit(baseOpts(), deps);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('CONFIG_EXISTS');
    }
    expect(state.files.get(TARGET)).toBe('preexisting content');
  });

  it('galloper.json exists with --force overwrites', async () => {
    const { deps, state } = createFakeDeps({
      presentBinaries: ['claude'],
      existingFiles: { [TARGET]: 'preexisting content' },
    });
    const result = await runInit(baseOpts({ force: true }), deps);
    expect(result.ok).toBe(true);
    expect(state.files.get(TARGET)).not.toBe('preexisting content');
    const written = JSON.parse(state.files.get(TARGET) ?? '{}');
    expect(written.default).toBe('claude');
  });

  it('write failure mid-flight leaves no partial file and attempts unlink', async () => {
    const { deps, state } = createFakeDeps({
      presentBinaries: ['claude'],
      writeFailOn: `${TARGET}.tmp-`,
    });
    const result = await runInit(baseOpts(), deps);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('WRITE_FAILED');
    }
    expect(state.files.has(TARGET)).toBe(false);
    expect(state.files.has(`${TARGET}.tmp-testsuffix`)).toBe(false);
    expect(state.unlinkCalls).toContain(`${TARGET}.tmp-testsuffix`);
  });

  it('atomic write uses a tmp file then renames', async () => {
    const renames: Array<[string, string]> = [];
    const { deps, state } = createFakeDeps({ presentBinaries: ['claude'] });
    const originalRename = deps.rename;
    deps.rename = async (from, to) => {
      renames.push([from, to]);
      await originalRename(from, to);
    };
    const result = await runInit(baseOpts(), deps);
    expect(result.ok).toBe(true);
    expect(renames).toHaveLength(1);
    expect(renames[0][0]).toBe(`${TARGET}.tmp-testsuffix`);
    expect(renames[0][1]).toBe(TARGET);
    expect(state.files.has(TARGET)).toBe(true);
  });

  it('SUPPORTED_CLIS includes claude, codex, and gemini', () => {
    const names = SUPPORTED_CLIS.map((c) => c.name);
    expect(names).toEqual(['claude', 'codex', 'gemini']);
  });
});
