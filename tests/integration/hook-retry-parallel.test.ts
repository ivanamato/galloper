import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createTempRepo, initSeededRepo, runPlan, cleanupMeta, type TempRepo } from '../helpers/runPlanHarness.js';

/**
 * Argv-mode flaky command: increments a counter file; appends a timestamp
 * to a timeline file; exits 0 only when the counter has reached `successOn`.
 */
function flakyCommand(counterFile: string, timelineFile: string, successOn: number): string[] {
  const script = `
    const fs = require('fs');
    const [counter, timeline, successOnStr] = process.argv.slice(1);
    const successOn = Number(successOnStr);
    const n = (fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8').trim()) : 0) + 1;
    fs.writeFileSync(counter, String(n));
    fs.appendFileSync(timeline, Date.now() + '\\n');
    process.exit(n >= successOn ? 0 : 1);
  `;
  return ['node', '-e', script, counterFile, timelineFile, String(successOn)];
}

describe('Hook retry + parallel + path-lock composition', () => {
  let repo: TempRepo;
  let aCounterFile: string;
  let bCounterFile: string;
  let aTimelineFile: string;
  let bTimelineFile: string;

  beforeEach(async () => {
    repo = await createTempRepo();
    await initSeededRepo(repo.dir, { 'a.ts': 'a\n', 'b.ts': 'b\n' });
    aCounterFile = join(repo.dir, '..', `a-count-${Date.now()}`);
    bCounterFile = join(repo.dir, '..', `b-count-${Date.now()}`);
    aTimelineFile = join(repo.dir, '..', `a-timeline-${Date.now()}`);
    bTimelineFile = join(repo.dir, '..', `b-timeline-${Date.now()}`);
  });

  afterEach(async () => {
    await repo.cleanup();
    for (const p of [aCounterFile, bCounterFile, aTimelineFile, bTimelineFile]) {
      try { await fs.rm(p, { force: true }); } catch { /* ignore */ }
    }
  });

  it('flaky hooks retry bounded, succeed, and retries across files overlap', async () => {
    const { metaDir, manifestPath } = await runPlan({
      repo,
      planTasks: [
        {
          id: 't1',
          files: [
            { path: 'a.ts', action: 'edit' },
            { path: 'b.ts', action: 'edit' },
          ],
        },
      ],
      writes: [
        { path: 'a.ts', action: 'edit', content: 'a1\n' },
        { path: 'b.ts', action: 'edit', content: 'b1\n' },
      ],
      hooks: {
        lifecycle: {
          'post-task-file': [
            {
              match: 'a.ts',
              shell: false,
              command: flakyCommand(aCounterFile, aTimelineFile, 2),
              retry: { maxAttempts: 3, backoffMs: 30, jitter: 0 },
            },
            {
              match: 'b.ts',
              shell: false,
              command: flakyCommand(bCounterFile, bTimelineFile, 2),
              retry: { maxAttempts: 3, backoffMs: 30, jitter: 0 },
            },
          ],
        },
      },
      concurrency: 4,
    });

    // Exactly 2 attempts per file.
    expect(Number(readFileSync(aCounterFile, 'utf8').trim())).toBe(2);
    expect(Number(readFileSync(bCounterFile, 'utf8').trim())).toBe(2);

    // Zero final HookFailures — succeeded on retry.
    const persisted = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const attempt = persisted.tasks[0]?.attempts?.[0];
    expect(attempt?.hookFailures ?? []).toHaveLength(0);

    // Cross-file parallelism: first attempt of a.ts and b.ts should be close
    // in time (real parallelism ≈ tens of ms; 500ms is loose for CI noise).
    expect(existsSync(aTimelineFile)).toBe(true);
    expect(existsSync(bTimelineFile)).toBe(true);
    const aTs = readFileSync(aTimelineFile, 'utf8').trim().split('\n').map(Number);
    const bTs = readFileSync(bTimelineFile, 'utf8').trim().split('\n').map(Number);
    expect(aTs).toHaveLength(2);
    expect(bTs).toHaveLength(2);
    expect(Math.abs(aTs[0]! - bTs[0]!)).toBeLessThan(500);

    await cleanupMeta(metaDir);
  }, 15_000);
});
