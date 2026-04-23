import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createTempRepo, initSeededRepo, runPlan, type TempRepo } from '../helpers/runPlanHarness.js';
import { readJsonlEvents } from '../helpers/readJsonl.js';

/**
 * Step 9 scenarios — a `post-task-file` hook with `onFailure:'abort'` fails
 * the task attempt (not the whole run). `onAbort:'revert'` rolls the
 * workspace back to the pre-task baseline; `onAbort:'keep'` (default) leaves
 * partial writes in place.
 */
describe('Step 9: onAbort rollback', () => {
  let repo: TempRepo;

  beforeEach(async () => {
    repo = await createTempRepo();
    await initSeededRepo(repo.dir, { 'a.txt': 'v1\n' });
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it('onAbort:revert restores workspace to baseline after a hook abort', async () => {
    const { logPath } = await runPlan({
      repo,
      planTasks: [{ id: 't1', files: [{ path: 'a.txt', action: 'edit' }] }],
      writes: [
        { path: 'a.txt', action: 'edit', content: 'v2-from-task\n' },
        { path: 'b.txt', action: 'create', content: 'task-wrote-b\n' },
      ],
      hooks: {
        lifecycle: {
          'post-task-file': [
            {
              match: '**/*',
              shell: false,
              command: ['sh', '-c', 'exit 1'],
              onFailure: 'abort',
              onAbort: 'revert',
            },
          ],
        },
      },
    });

    expect(await fs.readFile(join(repo.dir, 'a.txt'), 'utf8')).toBe('v1\n');
    expect(existsSync(join(repo.dir, 'b.txt'))).toBe(false);

    const events = readJsonlEvents(logPath);
    const revert = events.find((e) => e.type === 'workspace.reverted');
    expect(revert).toBeDefined();
    expect(revert?.reverted).toBe(true);
    expect(revert?.taskId).toBe('t1');
  });

  it('onAbort omitted keeps partial task writes on abort', async () => {
    const { logPath } = await runPlan({
      repo,
      planTasks: [{ id: 't1', files: [{ path: 'a.txt', action: 'edit' }] }],
      writes: [
        { path: 'a.txt', action: 'edit', content: 'v2-from-task\n' },
        { path: 'b.txt', action: 'create', content: 'task-wrote-b\n' },
      ],
      hooks: {
        lifecycle: {
          'post-task-file': [
            {
              match: '**/*',
              shell: false,
              command: ['sh', '-c', 'exit 1'],
              onFailure: 'abort',
            },
          ],
        },
      },
    });

    expect(await fs.readFile(join(repo.dir, 'a.txt'), 'utf8')).toBe('v2-from-task\n');
    expect(existsSync(join(repo.dir, 'b.txt'))).toBe(true);

    const events = readJsonlEvents(logPath);
    expect(events.find((e) => e.type === 'workspace.reverted')).toBeUndefined();
  });

  it("onAbort:'keep' (explicit) behaves the same as omitted", async () => {
    const { logPath } = await runPlan({
      repo,
      planTasks: [{ id: 't1', files: [{ path: 'a.txt', action: 'edit' }] }],
      writes: [{ path: 'a.txt', action: 'edit', content: 'v2\n' }],
      hooks: {
        lifecycle: {
          'post-task-file': [
            {
              match: '**/*',
              shell: false,
              command: ['sh', '-c', 'exit 1'],
              onFailure: 'abort',
              onAbort: 'keep',
            },
          ],
        },
      },
    });

    expect(await fs.readFile(join(repo.dir, 'a.txt'), 'utf8')).toBe('v2\n');
    const events = readJsonlEvents(logPath);
    expect(events.find((e) => e.type === 'workspace.reverted')).toBeUndefined();
  });
});
