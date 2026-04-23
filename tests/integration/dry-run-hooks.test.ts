import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

describe('Dry-Run-Hooks CLI Integration', () => {
  const projectRoot = process.cwd();
  const cliPath = join(projectRoot, 'dist', 'run-llm-session.js');
  const fixturesDir = join(projectRoot, 'tests', 'fixtures', 'dry-run-hooks');

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

  it('should analyze hooks matching for plan files', () => {
    const result = spawnSync('node', [
      cliPath,
      'plan',
      '--dry-run-hooks',
      '--plan-file',
      join(fixturesDir, 'plan.json'),
      '--config',
      join(fixturesDir, 'galloper.json'),
    ], {
      cwd: projectRoot,
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');

    const output = JSON.parse(result.stdout);

    // Validate output structure
    expect(output).toHaveProperty('planId');
    expect(output).toHaveProperty('matches');
    expect(Array.isArray(output.matches)).toBe(true);
    expect(output.planId).toBe('test-plan-dry-run-hooks');

    // Validate we have the expected matches
    expect(output.matches.length).toBeGreaterThan(0);

    // Check structure of each match
    for (const match of output.matches) {
      expect(match).toHaveProperty('taskId');
      expect(match).toHaveProperty('file');
      expect(match).toHaveProperty('hook');
      expect(match.hook).toHaveProperty('phase');
      expect(match.hook).toHaveProperty('index');
      expect(match.hook).toHaveProperty('match');
      expect(match.hook).toHaveProperty('command');
    }

    // Verify specific matches for t1 (create src files)
    const t1Creates = output.matches.filter(
      (m: any) => m.taskId === 't1' && m.file.startsWith('src/') && m.hook.phase === 'pre-task-file'
    );
    expect(t1Creates.length).toBe(2); // Two pre-task-file hooks match

    // Verify t2 README edit post-task-file hook
    const t2ReadmePost = output.matches.filter(
      (m: any) => m.taskId === 't2' && m.file === 'README.md' && m.hook.phase === 'post-task-file'
    );
    expect(t2ReadmePost.length).toBe(1); // One post-task-file hook matches *.md

    // Verify t3 test file and config edit hooks
    const t3TestPre = output.matches.filter(
      (m: any) => m.taskId === 't3' && m.file === 'tests/unit/main.test.ts' && m.hook.phase === 'pre-task-file'
    );
    expect(t3TestPre.length).toBe(1); // tests/**/*.test.ts matches

    const t3ConfigEditPre = output.matches.filter(
      (m: any) => m.taskId === 't3' && m.file === 'src/config.ts' && m.hook.phase === 'pre-task-file'
    );
    expect(t3ConfigEditPre.length).toBe(1); // edit src/**/*.ts matches
  });

  it('should require --plan-file flag', () => {
    const result = spawnSync('node', [
      cliPath,
      'plan',
      '--dry-run-hooks',
      '--config',
      join(fixturesDir, 'galloper.json'),
    ], {
      cwd: projectRoot,
      encoding: 'utf8',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--dry-run-hooks requires --plan-file');
  });

  it('should only work with "plan" subcommand', () => {
    const result = spawnSync('node', [
      cliPath,
      'implement',
      '--dry-run-hooks',
      '--plan-file',
      join(fixturesDir, 'plan.json'),
      '--config',
      join(fixturesDir, 'galloper.json'),
    ], {
      cwd: projectRoot,
      encoding: 'utf8',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('only valid with the "plan" subcommand');
  });

  it('should fail on missing plan file', () => {
    const result = spawnSync('node', [
      cliPath,
      'plan',
      '--dry-run-hooks',
      '--plan-file',
      join(fixturesDir, 'nonexistent.json'),
      '--config',
      join(fixturesDir, 'galloper.json'),
    ], {
      cwd: projectRoot,
      encoding: 'utf8',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('ENOENT');
  });

  it('should match file actions correctly', () => {
    const result = spawnSync('node', [
      cliPath,
      'plan',
      '--dry-run-hooks',
      '--plan-file',
      join(fixturesDir, 'plan.json'),
      '--config',
      join(fixturesDir, 'galloper.json'),
    ], {
      cwd: projectRoot,
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout);

    // Task 1: src/index.ts should be a create action
    const t1Index = output.matches.find(
      (m: any) => m.taskId === 't1' && m.file === 'src/index.ts'
    );
    expect(t1Index).toBeDefined();

    // Should match create action hooks
    const t1CreateHooks = output.matches.filter(
      (m: any) => m.taskId === 't1' && m.file === 'src/index.ts' && m.hook.action === 'create'
    );
    expect(t1CreateHooks.length).toBeGreaterThan(0);

    // Task 3: src/config.ts should be edit action
    const t3Config = output.matches.find(
      (m: any) => m.taskId === 't3' && m.file === 'src/config.ts' && m.hook.action === 'edit'
    );
    expect(t3Config).toBeDefined();
  });

  it('should handle runOnSurprise flag in post-task-file hooks', () => {
    const result = spawnSync('node', [
      cliPath,
      'plan',
      '--dry-run-hooks',
      '--plan-file',
      join(fixturesDir, 'plan.json'),
      '--config',
      join(fixturesDir, 'galloper.json'),
    ], {
      cwd: projectRoot,
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout);

    // Find the post-task-file hook with runOnSurprise
    const surpriseHooks = output.matches.filter(
      (m: any) => m.hook.phase === 'post-task-file' && m.hook.runOnSurprise === true
    );

    expect(surpriseHooks.length).toBeGreaterThan(0);
    expect(surpriseHooks[0].hook.match).toBe('tests/**/*.test.ts');
  });
});
