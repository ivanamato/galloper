import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

describe('CLI Error Suggestions Integration', () => {
  const projectRoot = process.cwd();
  const cliPath = join(projectRoot, 'dist', 'run-llm-session.js');

  beforeAll(async () => {
    const buildResult = spawnSync('npm', ['run', 'build'], {
      cwd: projectRoot,
      stdio: 'pipe',
    });
    if (buildResult.status !== 0) {
      throw new Error(`Build failed: ${buildResult.stderr.toString()}`);
    }
  });

  it('should suggest nearest subcommand for single-char typo', () => {
    const result = spawnSync('node', [cliPath, 'plna'], {
      cwd: projectRoot,
      encoding: 'utf8',
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("did you mean 'plan'");
  });

  it('should suggest plan for paln typo', () => {
    const result = spawnSync('node', [cliPath, 'paln'], {
      cwd: projectRoot,
      encoding: 'utf8',
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("did you mean 'plan'");
  });

  it('should not suggest for completely unrelated input', () => {
    const result = spawnSync('node', [cliPath, 'xyzzy'], {
      cwd: projectRoot,
      encoding: 'utf8',
    });

    expect(result.status).not.toBe(0);
    const output = result.stderr;
    expect(output).toContain('Invalid or missing subcommand');
    expect(output).not.toContain("did you mean");
  });

  it('should suggest implement for implemen typo', () => {
    const result = spawnSync('node', [cliPath, 'implemen'], {
      cwd: projectRoot,
      encoding: 'utf8',
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("did you mean 'implement'");
  });
});
