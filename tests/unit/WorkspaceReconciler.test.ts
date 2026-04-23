import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { captureBaseline, reconcile, classify, captureBaselines, reconcileAll, classifyAcrossRoots, WorkspaceRoot, MultiBaseline } from '../../src/lib/WorkspaceReconciler.js';
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

describe('WorkspaceReconciler.captureBaselines', () => {
  let repo1: TempRepo;
  let repo2: TempRepo;

  beforeEach(async () => {
    repo1 = await createTempRepo();
    repo2 = await createTempRepo();
  });

  afterEach(async () => {
    await repo1.cleanup();
    await repo2.cleanup();
  });

  it('single-root happy path preserves label', async () => {
    await initRepo(repo1.dir);
    await fs.writeFile(join(repo1.dir, 'seed.txt'), 'seed');
    await git(repo1.dir, ['add', '.']);
    await git(repo1.dir, ['commit', '-q', '-m', 'init']);

    const roots: WorkspaceRoot[] = [
      {
        label: 'root-a',
        path: repo1.dir,
        vcs: 'git',
      },
    ];

    const multi = await captureBaselines(roots);
    expect(multi).toHaveLength(1);
    expect(multi[0]?.label).toBe('root-a');
    expect(multi[0]?.path).toBe(repo1.dir);
    expect(multi[0]?.vcs).toBe('git');
    expect(multi[0]?.baseline).not.toBeNull();
    expect(multi[0]?.baseline?.head).toMatch(/^[0-9a-f]{40}$/);
  });

  it('non-git root returns baseline=null', async () => {
    const roots: WorkspaceRoot[] = [
      {
        label: 'non-git-root',
        path: repo1.dir,
        vcs: 'none',
      },
    ];

    const multi = await captureBaselines(roots);
    expect(multi).toHaveLength(1);
    expect(multi[0]?.label).toBe('non-git-root');
    expect(multi[0]?.vcs).toBe('none');
    expect(multi[0]?.baseline).toBeNull();
  });
});

describe('WorkspaceReconciler.reconcileAll', () => {
  let repo1: TempRepo;
  let repo2: TempRepo;

  beforeEach(async () => {
    repo1 = await createTempRepo();
    repo2 = await createTempRepo();
  });

  afterEach(async () => {
    await repo1.cleanup();
    await repo2.cleanup();
  });

  it('single-root reconciliation returns empty array for clean state', async () => {
    await initRepo(repo1.dir);
    await fs.writeFile(join(repo1.dir, 'a.ts'), 'initial\n');
    await git(repo1.dir, ['add', '.']);
    await git(repo1.dir, ['commit', '-q', '-m', 'init']);

    const baseline = await captureBaseline(repo1.dir);
    const multi: MultiBaseline = [
      {
        label: 'root-a',
        path: repo1.dir,
        vcs: 'git',
        baseline,
      },
    ];

    const result = await reconcileAll(multi);
    expect(result['root-a']).toEqual([]);
  });

  it('non-git root in reconcileAll returns empty array', async () => {
    const multi: MultiBaseline = [
      {
        label: 'non-git',
        path: repo1.dir,
        vcs: 'none',
        baseline: null,
      },
    ];

    const result = await reconcileAll(multi);
    expect(result['non-git']).toEqual([]);
  });

  it('two git roots reconcile independently', async () => {
    // Set up repo1
    await initRepo(repo1.dir);
    await fs.writeFile(join(repo1.dir, 'file1.ts'), 'content1\n');
    await git(repo1.dir, ['add', '.']);
    await git(repo1.dir, ['commit', '-q', '-m', 'init']);

    // Set up repo2
    await initRepo(repo2.dir);
    await fs.writeFile(join(repo2.dir, 'file2.ts'), 'content2\n');
    await git(repo2.dir, ['add', '.']);
    await git(repo2.dir, ['commit', '-q', '-m', 'init']);

    // Capture baselines for both
    const baseline1 = await captureBaseline(repo1.dir);
    const baseline2 = await captureBaseline(repo2.dir);

    // Modify only repo1
    await fs.writeFile(join(repo1.dir, 'file1.ts'), 'modified1\n');

    // Modify only repo2
    await fs.writeFile(join(repo2.dir, 'new2.ts'), 'new content\n');

    const multi: MultiBaseline = [
      {
        label: 'root-a',
        path: repo1.dir,
        vcs: 'git',
        baseline: baseline1,
      },
      {
        label: 'root-b',
        path: repo2.dir,
        vcs: 'git',
        baseline: baseline2,
      },
    ];

    const result = await reconcileAll(multi);

    expect(result['root-a']).toContainEqual({ path: 'file1.ts', action: 'edit' });
    expect(result['root-a']?.some((p) => p.path === 'new2.ts')).toBe(false);

    expect(result['root-b']).toContainEqual({ path: 'new2.ts', action: 'create' });
    expect(result['root-b']?.some((p) => p.path === 'file1.ts')).toBe(false);
  });

  it('imports MultiBaseline type correctly', async () => {
    const multi: MultiBaseline = [
      {
        label: 'test',
        path: '/tmp',
        vcs: 'none',
        baseline: null,
      },
    ];
    expect(multi).toHaveLength(1);
  });
});

describe('WorkspaceReconciler.classifyAcrossRoots', () => {
  it('path under one root is in-workspace', () => {
    const perRootReconciled = {
      'root-a': [{ path: 'src/a.ts', action: 'edit' as const }],
    };
    const declared = [{ path: 'src/**/*.ts', action: 'edit' as const }];
    const rootPaths: WorkspaceRoot[] = [
      { label: 'root-a', path: '/tmp/root-a', vcs: 'git' },
    ];
    const churn = [];

    const result = classifyAcrossRoots(perRootReconciled, declared, rootPaths, churn);

    expect(result.declared).toContainEqual({ path: 'src/a.ts', action: 'edit' });
    expect(result.outOfWorkspace).toEqual([]);
  });

  it('path under no root is outOfWorkspace', () => {
    const perRootReconciled = {
      'root-a': [{ path: '../outside.txt', action: 'create' as const }],
    };
    const declared = [{ path: 'src/**/*.ts', action: 'edit' as const }];
    const rootPaths: WorkspaceRoot[] = [
      { label: 'root-a', path: '/tmp/root-a', vcs: 'git' },
    ];
    const churn = [];

    const result = classifyAcrossRoots(perRootReconciled, declared, rootPaths, churn);

    expect(result.outOfWorkspace).toContainEqual({ path: '../outside.txt', action: 'create' });
    expect(result.declared).toEqual([]);
    expect(result.surprise).toEqual([]);
  });

  it('two-root setup correctly assigns each path to its owning root', () => {
    const perRootReconciled = {
      'root-a': [{ path: 'src/a.ts', action: 'edit' as const }],
      'root-b': [{ path: 'src/b.tsx', action: 'edit' as const }],
    };
    const declared = [
      { path: 'src/**/*.ts', action: 'edit' as const },
      { path: 'src/**/*.tsx', action: 'edit' as const },
    ];
    const rootPaths: WorkspaceRoot[] = [
      { label: 'root-a', path: '/tmp/root-a', vcs: 'git' },
      { label: 'root-b', path: '/tmp/root-b', vcs: 'git' },
    ];
    const churn = [];

    const result = classifyAcrossRoots(perRootReconciled, declared, rootPaths, churn);

    expect(result.declared).toHaveLength(2);
    expect(result.declared).toContainEqual({ path: 'src/a.ts', action: 'edit' });
    expect(result.declared).toContainEqual({ path: 'src/b.tsx', action: 'edit' });
    expect(result.outOfWorkspace).toEqual([]);
  });

  it('handles surprise paths within roots correctly', () => {
    const perRootReconciled = {
      'root-a': [
        { path: 'src/expected.ts', action: 'edit' as const },
        { path: 'scripts/release.sh', action: 'create' as const },
      ],
    };
    const declared = [{ path: 'src/**/*.ts', action: 'edit' as const }];
    const rootPaths: WorkspaceRoot[] = [
      { label: 'root-a', path: '/tmp/root-a', vcs: 'git' },
    ];
    const churn = [];

    const result = classifyAcrossRoots(perRootReconciled, declared, rootPaths, churn);

    expect(result.declared).toContainEqual({ path: 'src/expected.ts', action: 'edit' });
    expect(result.surprise).toContainEqual({ path: 'scripts/release.sh', action: 'create' });
    expect(result.outOfWorkspace).toEqual([]);
  });

  it('respects churn classification across roots', () => {
    const perRootReconciled = {
      'root-a': [{ path: 'src/churn.ts', action: 'edit' as const }],
    };
    const declared = [{ path: 'src/**/*.ts', action: 'edit' as const }];
    const rootPaths: WorkspaceRoot[] = [
      { label: 'root-a', path: '/tmp/root-a', vcs: 'git' },
    ];
    const churn = [{ path: 'src/churn.ts', action: 'edit' as const }];

    const result = classifyAcrossRoots(perRootReconciled, declared, rootPaths, churn);

    expect(result.declared).toEqual([]);
    expect(result.surprise).toEqual([]);
    expect(result.churn).toContainEqual({ path: 'src/churn.ts', action: 'edit' });
  });

  it('handles escaping paths in two-root setup', () => {
    const perRootReconciled = {
      'root-a': [{ path: '../shared/config.yaml', action: 'edit' as const }],
      'root-b': [{ path: 'src/b.ts', action: 'edit' as const }],
    };
    const declared = [{ path: 'src/**/*.{ts,tsx}', action: 'edit' as const }];
    const rootPaths: WorkspaceRoot[] = [
      { label: 'root-a', path: '/projects/backend', vcs: 'git' },
      { label: 'root-b', path: '/projects/frontend', vcs: 'git' },
    ];
    const churn = [];

    const result = classifyAcrossRoots(perRootReconciled, declared, rootPaths, churn);

    expect(result.outOfWorkspace).toContainEqual({ path: '../shared/config.yaml', action: 'edit' });
    expect(result.declared).toContainEqual({ path: 'src/b.ts', action: 'edit' });
  });

  it('handles empty per-root reconciled gracefully', () => {
    const perRootReconciled: Record<string, any[]> = {};
    const declared = [{ path: 'src/**/*.ts', action: 'edit' as const }];
    const rootPaths: WorkspaceRoot[] = [
      { label: 'root-a', path: '/tmp/root-a', vcs: 'git' },
    ];
    const churn = [];

    const result = classifyAcrossRoots(perRootReconciled, declared, rootPaths, churn);

    expect(result.declared).toEqual([]);
    expect(result.surprise).toEqual([]);
    expect(result.churn).toEqual([]);
    expect(result.outOfWorkspace).toEqual([]);
  });
});
