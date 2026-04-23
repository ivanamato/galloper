import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTempRepo, initSeededRepo, runPlan, cleanupMeta, type TempRepo } from '../helpers/runPlanHarness.js';

interface TimelineEntry {
  event: 'start' | 'end';
  hook: string;
  file: string;
  t: number;
}

function parseTimeline(raw: string): TimelineEntry[] {
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [event, hook, file, t] = line.split('|');
      return { event: event as 'start' | 'end', hook: hook!, file: file!, t: Number(t) };
    });
}

/**
 * Build an argv-mode hook command that writes `start|hook|file|ts` to the
 * timeline, waits `sleepMs`, then writes `end|hook|file|ts`. Argv mode
 * (Step 5) avoids shell-quoting traps.
 */
function mkHook(hookId: string, sleepMs: number, timelinePath: string): string[] {
  const script = `
    const fs = require('fs');
    const [tl, hook, file] = process.argv.slice(1);
    fs.appendFileSync(tl, 'start|' + hook + '|' + file + '|' + Date.now() + '\\n');
    setTimeout(() => {
      fs.appendFileSync(tl, 'end|' + hook + '|' + file + '|' + Date.now() + '\\n');
    }, ${sleepMs});
  `;
  return ['node', '-e', script, timelinePath, hookId, '{file}'];
}

describe('Hook PathLock — same-path serialization + cross-path overlap', () => {
  let repo: TempRepo;
  let timelinePath: string;

  beforeEach(async () => {
    repo = await createTempRepo();
    await initSeededRepo(repo.dir, { 'a.ts': 'a0\n', 'b.ts': 'b0\n' });
    timelinePath = join(repo.dir, '..', `timeline-${Date.now()}.log`);
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it('same-file hooks run strictly nested; different-file hooks overlap', async () => {
    const { metaDir } = await runPlan({
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
            { match: '**/*.ts', shell: false, command: mkHook('H1', 60, timelinePath) },
            { match: '**/*.ts', shell: false, command: mkHook('H2', 60, timelinePath) },
          ],
        },
      },
      concurrency: 4,
    });

    const timeline = parseTimeline(readFileSync(timelinePath, 'utf8'));
    await cleanupMeta(metaDir);

    const byFile: Record<string, TimelineEntry[]> = {};
    for (const e of timeline) {
      (byFile[e.file] ??= []).push(e);
    }
    expect(Object.keys(byFile).sort()).toEqual(['a.ts', 'b.ts']);

    // Same-file serialization: strict nesting [H1 start, H1 end, H2 start, H2 end].
    for (const entries of Object.values(byFile)) {
      entries.sort((a, b) => a.t - b.t);
      expect(entries.map((e) => `${e.hook}:${e.event}`)).toEqual([
        'H1:start', 'H1:end', 'H2:start', 'H2:end',
      ]);
    }

    // Cross-file overlap: a.ts and b.ts activity windows must overlap.
    const aWindow = { start: byFile['a.ts']![0]!.t, end: byFile['a.ts']!.at(-1)!.t };
    const bWindow = { start: byFile['b.ts']![0]!.t, end: byFile['b.ts']!.at(-1)!.t };
    const overlap = aWindow.start < bWindow.end && bWindow.start < aWindow.end;
    expect(overlap).toBe(true);
  });
});
