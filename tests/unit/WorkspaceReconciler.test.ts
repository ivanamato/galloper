import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { captureBaseline, reconcile, classify } from '../../src/lib/WorkspaceReconciler.js';
import { createTempRepo, TempRepo } from '../helpers/tempRepo.js';

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd });
}

async function initRepo(dir: string): Promise<void> {
  await git(dir, ['init', '-q', '--initial-branch=main']);
  await git(dir, ['config', 'user.email', 'test@example.com']);
  await git(dir, ['config', 'user.name', 'test']);
  await git(dir, ['config', 'commit.gpgsign', 'false']);
}

describe('WorkspaceReconciler.captureBaseline', () => {
  let repo: TempRepo;

  beforeEach(async () => {
    repo = await createTempRepo();
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it('returns 40-char head and empty entries on a clean repo', async () => {
    await initRepo(repo.dir);
    await fs.writeFile(join(repo.dir, 'seed.txt'), 'seed');
    await git(repo.dir, ['add', '.']);
    await git(repo.dir, ['commit', '-q', '-m', 'init']);

    const baseline = await captureBaseline(repo.dir);
    expect(baseline.head).toMatch(/^[0-9a-f]{40}$/);
    expect(baseline.entries).toEqual({});
  });

  it('handles unborn branch (no commits) with sentinel head', async () => {
    await initRepo(repo.dir);
    const baseline = await captureBaseline(repo.dir);
    expect(baseline.head).toBe('0000000000000000000000000000000000000000');
    expect(baseline.entries).toEqual({});
  });

  it('records pre-existing dirty state in baseline entries', async () => {
    await initRepo(repo.dir);
    await fs.writeFile(join(repo.dir, 'seed.txt'), 'seed');
    await git(repo.dir, ['add', '.']);
    await git(repo.dir, ['commit', '-q', '-m', 'init']);
    await fs.writeFile(join(repo.dir, 'seed.txt'), 'modified');
    await fs.writeFile(join(repo.dir, 'stray.log'), 'noise');

    const baseline = await captureBaseline(repo.dir);
    expect(Object.keys(baseline.entries).sort()).toEqual(['seed.txt', 'stray.log']);
  });

  it('throws on non-git cwd', async () => {
    await expect(captureBaseline(repo.dir)).rejects.toThrow(/not a git repository/);
  });
});

describe('WorkspaceReconciler.reconcile', () => {
  let repo: TempRepo;

  beforeEach(async () => {
    repo = await createTempRepo();
    await initRepo(repo.dir);
    await fs.writeFile(join(repo.dir, 'a.ts'), 'initial\n');
    await git(repo.dir, ['add', '.']);
    await git(repo.dir, ['commit', '-q', '-m', 'init']);
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it('detects modified tracked file as edit', async () => {
    const baseline = await captureBaseline(repo.dir);
    await fs.writeFile(join(repo.dir, 'a.ts'), 'modified\n');
    const paths = await reconcile(repo.dir, baseline);
    expect(paths).toContainEqual({ path: 'a.ts', action: 'edit' });
  });

  it('detects new untracked file as create', async () => {
    const baseline = await captureBaseline(repo.dir);
    await fs.writeFile(join(repo.dir, 'b.ts'), 'new\n');
    const paths = await reconcile(repo.dir, baseline);
    expect(paths).toContainEqual({ path: 'b.ts', action: 'create' });
  });

  it('detects deleted tracked file as delete', async () => {
    const baseline = await captureBaseline(repo.dir);
    await fs.rm(join(repo.dir, 'a.ts'));
    const paths = await reconcile(repo.dir, baseline);
    expect(paths).toContainEqual({ path: 'a.ts', action: 'delete' });
  });

  it('returns empty set when nothing changed', async () => {
    const baseline = await captureBaseline(repo.dir);
    const paths = await reconcile(repo.dir, baseline);
    expect(paths).toEqual([]);
  });

  it('ignores pre-existing dirty state that did not change during the task', async () => {
    // Dirty the tree BEFORE baseline.
    await fs.writeFile(join(repo.dir, 'a.ts'), 'dirty at baseline\n');
    await fs.writeFile(join(repo.dir, 'pre-existing-untracked.log'), 'noise');

    const baseline = await captureBaseline(repo.dir);
    // No changes during the "task" — reconcile must return [].
    const paths = await reconcile(repo.dir, baseline);
    expect(paths).toEqual([]);
  });

  it('detects only paths that changed since baseline, not pre-existing dirt', async () => {
    await fs.writeFile(join(repo.dir, 'a.ts'), 'dirty at baseline\n');
    const baseline = await captureBaseline(repo.dir);

    // Task writes a NEW file; a.ts stays untouched.
    await fs.writeFile(join(repo.dir, 'b.ts'), 'new from task\n');

    const paths = await reconcile(repo.dir, baseline);
    expect(paths).toContainEqual({ path: 'b.ts', action: 'create' });
    expect(paths.find((p) => p.path === 'a.ts')).toBeUndefined();
  });

  it('skips .gitignored files', async () => {
    await fs.writeFile(join(repo.dir, '.gitignore'), 'ignored.log\n');
    await git(repo.dir, ['add', '.gitignore']);
    await git(repo.dir, ['commit', '-q', '-m', 'gitignore']);
    const baseline = await captureBaseline(repo.dir);
    await fs.writeFile(join(repo.dir, 'ignored.log'), 'noise');
    const paths = await reconcile(repo.dir, baseline);
    expect(paths.find((p) => p.path === 'ignored.log')).toBeUndefined();
  });
});

describe('WorkspaceReconciler.classify', () => {
  it('partitions literal-matched paths as declared', () => {
    const r = classify(
      [{ path: 'src/a.ts', action: 'edit' }],
      [{ path: 'src/a.ts', action: 'edit' }],
      [],
    );
    expect(r.declared).toHaveLength(1);
    expect(r.surprise).toHaveLength(0);
  });

  it('partitions glob-matched paths as declared', () => {
    const r = classify(
      [{ path: 'src/deep/a.ts', action: 'edit' }],
      [{ path: 'src/**/*.ts', action: 'edit' }],
      [],
    );
    expect(r.declared).toHaveLength(1);
    expect(r.surprise).toHaveLength(0);
  });

  it('partitions unmatched writes as surprise', () => {
    const r = classify(
      [{ path: 'scripts/release.sh', action: 'create' }],
      [{ path: 'src/**/*.ts', action: 'edit' }],
      [],
    );
    expect(r.declared).toHaveLength(0);
    expect(r.surprise).toEqual([{ path: 'scripts/release.sh', action: 'create' }]);
  });

  it('silently drops overstated declared entries with no reconciled counterpart', () => {
    const r = classify(
      [{ path: 'src/a.ts', action: 'edit' }],
      [
        { path: 'src/a.ts', action: 'edit' },
        { path: 'src/never-written.ts', action: 'create' },
      ],
      [],
    );
    expect(r.declared).toHaveLength(1);
    expect(r.declared[0]?.path).toBe('src/a.ts');
    expect(r.surprise).toHaveLength(0);
  });

  it('passes churn through untouched', () => {
    const churn = [{ path: 'foo.ts', action: 'edit' as const }];
    const r = classify([], [], churn);
    expect(r.churn).toEqual(churn);
  });

  it('excludes churn paths from declared/surprise partitioning', () => {
    const churn = [{ path: 'foo.ts', action: 'edit' as const }];
    const r = classify(
      [{ path: 'foo.ts', action: 'edit' }],
      [{ path: 'foo.ts', action: 'edit' }],
      churn,
    );
    expect(r.declared).toHaveLength(0);
    expect(r.surprise).toHaveLength(0);
    expect(r.churn).toEqual(churn);
  });
});
