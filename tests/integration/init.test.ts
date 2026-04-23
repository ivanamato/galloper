import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { createTempRepo, TempRepo } from '../helpers/tempRepo.js';

describe('Init CLI Integration', () => {
  const projectRoot = process.cwd();
  const cliPath = join(projectRoot, 'dist', 'run-llm-session.js');
  const repos: TempRepo[] = [];

  beforeAll(() => {
    const buildResult = spawnSync('npm', ['run', 'build'], { cwd: projectRoot, stdio: 'pipe' });
    if (buildResult.status !== 0) {
      throw new Error(`Build failed: ${buildResult.stderr.toString()}`);
    }
  });

  afterEach(async () => {
    while (repos.length > 0) {
      const repo = repos.pop();
      if (repo) await repo.cleanup();
    }
  });

  async function makeStubBin(dir: string, name: string): Promise<void> {
    const binPath = join(dir, name);
    await fs.writeFile(binPath, '#!/bin/sh\nexit 0\n', 'utf8');
    await fs.chmod(binPath, 0o755);
  }

  async function newRepo(): Promise<TempRepo> {
    const repo = await createTempRepo();
    repos.push(repo);
    return repo;
  }

  it('non-interactive in empty dir with stubbed PATH produces a config doctor accepts', async () => {
    const repo = await newRepo();
    const binDir = join(repo.dir, 'bin');
    await fs.mkdir(binDir, { recursive: true });
    await makeStubBin(binDir, 'claude');
    await makeStubBin(binDir, 'codex');

    const initResult = spawnSync(process.execPath, [cliPath, 'init', '--non-interactive'], {
      cwd: repo.dir,
      encoding: 'utf8',
      env: { ...process.env, PATH: binDir },
    });

    expect(initResult.status).toBe(0);
    const payload = JSON.parse(initResult.stdout);
    expect(payload.ok).toBe(true);
    expect(payload.selected).toEqual(['claude', 'codex']);
    expect(payload.defaultName).toBe('claude');

    const written = JSON.parse(await fs.readFile(join(repo.dir, 'galloper.json'), 'utf8'));
    expect(written.default).toBe('claude');

    const doctorResult = spawnSync(process.execPath, [cliPath, 'doctor'], {
      cwd: repo.dir,
      encoding: 'utf8',
      env: { ...process.env, PATH: binDir },
    });
    expect(doctorResult.status).toBe(0);
    const report = JSON.parse(doctorResult.stdout);
    expect(report.errors).toHaveLength(0);
  });

  it('non-interactive with empty PATH exits non-zero with useful message and no file written', async () => {
    const repo = await newRepo();
    const result = spawnSync(process.execPath, [cliPath, 'init', '--non-interactive'], {
      cwd: repo.dir,
      encoding: 'utf8',
      env: { ...process.env, PATH: '' },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('No supported LLM CLI');
    await expect(fs.access(join(repo.dir, 'galloper.json'))).rejects.toThrow();
  });

  it('pre-existing galloper.json + no --force leaves file untouched', async () => {
    const repo = await newRepo();
    const binDir = join(repo.dir, 'bin');
    await fs.mkdir(binDir, { recursive: true });
    await makeStubBin(binDir, 'claude');

    const configPath = join(repo.dir, 'galloper.json');
    const original = '{"default":"existing","commands":{"existing":{"command":"echo","allowedSubcommands":[],"disallowedSubcommands":[]}}}\n';
    await fs.writeFile(configPath, original, 'utf8');

    const result = spawnSync(process.execPath, [cliPath, 'init', '--non-interactive'], {
      cwd: repo.dir,
      encoding: 'utf8',
      env: { ...process.env, PATH: binDir },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('already exists');
    const onDisk = await fs.readFile(configPath, 'utf8');
    expect(onDisk).toBe(original);
  });

  it('pre-existing galloper.json + --force overwrites', async () => {
    const repo = await newRepo();
    const binDir = join(repo.dir, 'bin');
    await fs.mkdir(binDir, { recursive: true });
    await makeStubBin(binDir, 'claude');

    const configPath = join(repo.dir, 'galloper.json');
    await fs.writeFile(configPath, '{"default":"existing","commands":{"existing":{"command":"echo","allowedSubcommands":[],"disallowedSubcommands":[]}}}\n', 'utf8');

    const result = spawnSync(process.execPath, [cliPath, 'init', '--non-interactive', '--force'], {
      cwd: repo.dir,
      encoding: 'utf8',
      env: { ...process.env, PATH: binDir },
    });

    expect(result.status).toBe(0);
    const written = JSON.parse(await fs.readFile(configPath, 'utf8'));
    expect(written.default).toBe('claude');
    expect(Object.keys(written.commands)).toEqual(['claude']);
  });

  it('--default naming a non-detected CLI exits non-zero with useful message and no file', async () => {
    const repo = await newRepo();
    const binDir = join(repo.dir, 'bin');
    await fs.mkdir(binDir, { recursive: true });
    await makeStubBin(binDir, 'claude');

    const result = spawnSync(
      process.execPath,
      [cliPath, 'init', '--non-interactive', '--default', 'codex'],
      { cwd: repo.dir, encoding: 'utf8', env: { ...process.env, PATH: binDir } },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/codex/);
    expect(result.stderr).toMatch(/not among/);
    await expect(fs.access(join(repo.dir, 'galloper.json'))).rejects.toThrow();
  });

  it('non-TTY invocation without --non-interactive still degrades to non-interactive', async () => {
    const repo = await newRepo();
    const binDir = join(repo.dir, 'bin');
    await fs.mkdir(binDir, { recursive: true });
    await makeStubBin(binDir, 'claude');

    // spawnSync with default stdio='pipe' gives child non-TTY stdin/stderr, so CLI should auto-degrade.
    const result = spawnSync(process.execPath, [cliPath, 'init'], {
      cwd: repo.dir,
      encoding: 'utf8',
      env: { ...process.env, PATH: binDir },
    });

    expect(result.status).toBe(0);
    const written = JSON.parse(await fs.readFile(join(repo.dir, 'galloper.json'), 'utf8'));
    expect(written.default).toBe('claude');
  });

  it('round-trip: init then doctor accept the output', async () => {
    const repo = await newRepo();
    const binDir = join(repo.dir, 'bin');
    await fs.mkdir(binDir, { recursive: true });
    await makeStubBin(binDir, 'claude');
    await makeStubBin(binDir, 'gemini');

    const initResult = spawnSync(process.execPath, [cliPath, 'init', '--non-interactive', '--default', 'gemini'], {
      cwd: repo.dir,
      encoding: 'utf8',
      env: { ...process.env, PATH: binDir },
    });
    expect(initResult.status).toBe(0);

    const doctorResult = spawnSync(process.execPath, [cliPath, 'doctor'], {
      cwd: repo.dir,
      encoding: 'utf8',
      env: { ...process.env, PATH: binDir },
    });
    expect(doctorResult.status).toBe(0);
    const report = JSON.parse(doctorResult.stdout);
    expect(report.errors).toHaveLength(0);

    const written = JSON.parse(await fs.readFile(join(repo.dir, 'galloper.json'), 'utf8'));
    expect(written.default).toBe('gemini');
  });
});
