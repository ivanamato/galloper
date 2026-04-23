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
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [event, hook, file, t] = l.split('|');
      return { event: event as 'start' | 'end', hook: hook!, file: file!, t: Number(t) };
    });
}

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

describe('concurrency=1 equivalence', () => {
  let repo: TempRepo;
  let timelinePath: string;

  beforeEach(async () => {
    repo = await createTempRepo();
    await initSeededRepo(repo.dir, { 'a.ts': 'a\n', 'b.ts': 'b\n', 'c.ts': 'c\n' });
    timelinePath = join(repo.dir, '..', `seq-timeline-${Date.now()}.log`);
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it('has zero overlap across all hook invocations when concurrency=1', async () => {
    const { metaDir } = await runPlan({
      repo,
      planTasks: [
        {
          id: 't1',
          files: [
            { path: 'a.ts', action: 'edit' },
            { path: 'b.ts', action: 'edit' },
            { path: 'c.ts', action: 'edit' },
          ],
        },
      ],
      writes: [
        { path: 'a.ts', action: 'edit', content: 'a1\n' },
        { path: 'b.ts', action: 'edit', content: 'b1\n' },
        { path: 'c.ts', action: 'edit', content: 'c1\n' },
      ],
      hooks: {
        lifecycle: {
          'post-task-file': [
            { match: '**/*.ts', shell: false, command: mkHook('H1', 30, timelinePath) },
            { match: '**/*.ts', shell: false, command: mkHook('H2', 30, timelinePath) },
          ],
        },
      },
      concurrency: 1,
    });

    const timeline = parseTimeline(readFileSync(timelinePath, 'utf8'));
    await cleanupMeta(metaDir);

    timeline.sort((a, b) => a.t - b.t);
    const invocations: Array<{ hook: string; file: string; start: number; end: number }> = [];
    const openByKey: Record<string, number> = {};
    for (const e of timeline) {
      const key = `${e.hook}|${e.file}`;
      if (e.event === 'start') openByKey[key] = e.t;
      else {
        const start = openByKey[key];
        if (start !== undefined) invocations.push({ hook: e.hook, file: e.file, start, end: e.t });
        delete openByKey[key];
      }
    }

    invocations.sort((a, b) => a.start - b.start);
    for (let i = 1; i < invocations.length; i++) {
      expect(invocations[i]!.start).toBeGreaterThanOrEqual(invocations[i - 1]!.end);
    }

    expect(invocations).toHaveLength(6);
  });
});
