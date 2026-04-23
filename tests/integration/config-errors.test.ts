import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

describe('Config Error Suggestions Integration', () => {
  const projectRoot = process.cwd();
  const cliPath = join(projectRoot, 'dist', 'run-llm-session.js');
  const fixturesDir = join(projectRoot, 'tests', 'fixtures', 'config-errors');

  beforeAll(async () => {
    const buildResult = spawnSync('npm', ['run', 'build'], {
      cwd: projectRoot,
      stdio: 'pipe',
    });
    if (buildResult.status !== 0) {
      throw new Error(`Build failed: ${buildResult.stderr.toString()}`);
    }
  });

  it('should suggest plan for typo subcommand paln in allowedSubcommands', () => {
    const result = spawnSync('node', [cliPath, 'doctor', '--config', join(fixturesDir, 'typo-subcommand.json')], {
      cwd: projectRoot,
      encoding: 'utf8',
    });

    expect(result.status).toBe(1);
    const output = result.stderr || result.stdout;
    expect(output).toContain("did you mean 'plan'");
  });

  it('should suggest run.started for typo event run.startd during config load', () => {
    const result = spawnSync('node', [cliPath, 'doctor', '--config', join(fixturesDir, 'typo-event.json')], {
      cwd: projectRoot,
      encoding: 'utf8',
    });

    expect(result.status).toBe(1);
    const output = result.stderr || result.stdout;
    expect(output).toContain("did you mean 'run.started'");
  });
});
