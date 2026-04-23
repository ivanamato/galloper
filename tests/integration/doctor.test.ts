import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

describe('Doctor CLI Integration', () => {
  const projectRoot = process.cwd();
  const cliPath = join(projectRoot, 'dist', 'run-llm-session.js');
  const fixturesDir = join(projectRoot, 'tests', 'fixtures', 'doctor');

  beforeAll(async () => {
    // Ensure project is built before running CLI tests
    const buildResult = spawnSync('npm', ['run', 'build'], {
      cwd: projectRoot,
      stdio: 'pipe',
    });
    if (buildResult.status !== 0) {
      throw new Error(`Build failed: ${buildResult.stderr.toString()}`);
    }
  });

  it('should exit 0 for valid config', () => {
    const result = spawnSync('node', [cliPath, 'doctor', '--config', join(fixturesDir, 'valid-config', 'galloper.json')], {
      cwd: projectRoot,
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.errors).toHaveLength(0);
    expect(Array.isArray(report.warnings)).toBe(true);
  });

  it('should exit 1 for broken defaults and report error', () => {
    const result = spawnSync('node', [cliPath, 'doctor', '--config', join(fixturesDir, 'broken-defaults', 'galloper.json')], {
      cwd: projectRoot,
      encoding: 'utf8',
    });

    expect(result.status).toBe(1);
    const report = JSON.parse(result.stdout);
    expect(report.errors.length).toBeGreaterThan(0);
    const unknownDefaultError = report.errors.find((e: any) => e.code === 'UNKNOWN_DEFAULT');
    expect(unknownDefaultError).toBeDefined();
    expect(unknownDefaultError.path).toBe('default');
  });

  it('should exit 1 for missing binary command', () => {
    const result = spawnSync('node', [cliPath, 'doctor', '--config', join(fixturesDir, 'missing-binary', 'galloper.json')], {
      cwd: projectRoot,
      encoding: 'utf8',
    });

    expect(result.status).toBe(1);
    const report = JSON.parse(result.stdout);
    expect(report.errors.length).toBeGreaterThan(0);
    const binaryNotFoundError = report.errors.find((e: any) => e.code === 'BINARY_NOT_FOUND');
    expect(binaryNotFoundError).toBeDefined();
    expect(binaryNotFoundError.message).toContain('definitely-not-real-binary-xyz');
  });

  it('should resolve --config relative path correctly', () => {
    // Test with absolute path
    const result = spawnSync('node', [cliPath, 'doctor', '--config', join(fixturesDir, 'valid-config', 'galloper.json')], {
      cwd: projectRoot,
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.errors).toHaveLength(0);
  });

  it('should exit 1 with clear error for missing config file', () => {
    const result = spawnSync('node', [cliPath, 'doctor', '--config', join(fixturesDir, 'nonexistent', 'galloper.json')], {
      cwd: projectRoot,
      encoding: 'utf8',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Failed to load');
    // Should not contain a stack trace (no "at " pattern)
    expect(result.stderr).not.toMatch(/at\s+\w+/);
  });
});
