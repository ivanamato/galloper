import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { captureBaseline, revertToBaseline } from '../../src/lib/WorkspaceReconciler.js';
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

describe('revertToBaseline', () => {
  let repo: TempRepo;

  beforeEach(async () => {
    repo = await createTempRepo();
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it('restores tracked files and removes new untracked files (clean baseline)', async () => {
    await initRepo(repo.dir);
    await fs.writeFile(join(repo.dir, 'a.txt'), 'v1');
    await git(repo.dir, ['add', '.']);
    await git(repo.dir, ['commit', '-q', '-m', 'init']);

    const baseline = await captureBaseline(repo.dir);
    await fs.writeFile(join(repo.dir, 'a.txt'), 'v2');
    await fs.writeFile(join(repo.dir, 'b.txt'), 'new');

    const res = await revertToBaseline(repo.dir, baseline);
    expect(res.reverted).toBe(true);

    expect(await fs.readFile(join(repo.dir, 'a.txt'), 'utf8')).toBe('v1');
    let exists = true;
    try { await fs.access(join(repo.dir, 'b.txt')); } catch { exists = false; }
    expect(exists).toBe(false);
  });

  it('restores dirty tracked state at baseline via stashSha replay', async () => {
    await initRepo(repo.dir);
    await fs.writeFile(join(repo.dir, 'a.txt'), 'committed');
    await git(repo.dir, ['add', '.']);
    await git(repo.dir, ['commit', '-q', '-m', 'init']);

    // Dirty tracked change BEFORE capturing baseline.
    await fs.writeFile(join(repo.dir, 'a.txt'), 'dirty-at-baseline');

    const baseline = await captureBaseline(repo.dir);
    expect(baseline.stashSha).toBeDefined();

    // Task further modifies a.txt and writes a new file.
    await fs.writeFile(join(repo.dir, 'a.txt'), 'task-modified');
    await fs.writeFile(join(repo.dir, 'new-file.ts'), 'task-wrote-this');

    const res = await revertToBaseline(repo.dir, baseline);
    expect(res.reverted).toBe(true);

    // a.txt restored to the DIRTY baseline state, not the committed state.
    expect(await fs.readFile(join(repo.dir, 'a.txt'), 'utf8')).toBe('dirty-at-baseline');
    // The file written only during the task is gone.
    let newFileExists = true;
    try { await fs.access(join(repo.dir, 'new-file.ts')); } catch { newFileExists = false; }
    expect(newFileExists).toBe(false);
  });

  it('returns non-git reason on a non-git cwd without throwing', async () => {
    const fakeBaseline = { head: 'a'.repeat(40), entries: {} };
    const res = await revertToBaseline(repo.dir, fakeBaseline);
    expect(res).toEqual({ reverted: false, reason: 'non-git' });
  });

  it('returns unborn-branch reason when baseline has the sentinel head', async () => {
    await initRepo(repo.dir);
    const baseline = { head: '0000000000000000000000000000000000000000', entries: {} };
    const res = await revertToBaseline(repo.dir, baseline);
    expect(res).toEqual({ reverted: false, reason: 'unborn-branch' });
  });

  it('captureBaseline is non-mutating: working tree content unchanged before/after', async () => {
    await initRepo(repo.dir);
    await fs.writeFile(join(repo.dir, 'a.txt'), 'committed');
    await git(repo.dir, ['add', '.']);
    await git(repo.dir, ['commit', '-q', '-m', 'init']);
    await fs.writeFile(join(repo.dir, 'a.txt'), 'dirty');
    await fs.writeFile(join(repo.dir, 'untracked.txt'), 'also dirty');

    const before = await fs.readFile(join(repo.dir, 'a.txt'), 'utf8');
    const beforeUntracked = await fs.readFile(join(repo.dir, 'untracked.txt'), 'utf8');

    await captureBaseline(repo.dir);

    expect(await fs.readFile(join(repo.dir, 'a.txt'), 'utf8')).toBe(before);
    expect(await fs.readFile(join(repo.dir, 'untracked.txt'), 'utf8')).toBe(beforeUntracked);
  });
});
