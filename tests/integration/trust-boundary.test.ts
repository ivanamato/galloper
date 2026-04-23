import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs, existsSync, readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { TaskRunner } from '../../src/lib/TaskRunner.js';
import { CoreRunner } from '../../src/lib/CoreRunner.js';
import { Logger } from '../../src/lib/Logger.js';
import { HooksConfig } from '../../src/lib/HookDispatcher.js';
import { createTempRepo, TempRepo } from '../helpers/tempRepo.js';
import { FakeExecutioner, asExecutioner, type FakeWrite } from '../helpers/fakeExecutioner.js';
import { readJsonlEvents } from '../helpers/readJsonl.js';

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd });
}

async function initSeededRepo(dir: string, seed: Record<string, string>): Promise<void> {
  await git(dir, ['init', '-q', '--initial-branch=main']);
  await git(dir, ['config', 'user.email', 'test@example.com']);
  await git(dir, ['config', 'user.name', 'test']);
  await git(dir, ['config', 'commit.gpgsign', 'false']);
  for (const [rel, content] of Object.entries(seed)) {
    const full = join(dir, rel);
    await fs.mkdir(join(full, '..'), { recursive: true });
    await fs.writeFile(full, content);
  }
  await git(dir, ['add', '.']);
  await git(dir, ['commit', '-q', '-m', 'seed']);
}

interface RunArgs {
  repo: TempRepo;
  planTasks: Array<{ id: string; files: Array<{ path: string; action: 'create' | 'edit' | 'delete' }>; verify?: string }>;
  writes: FakeWrite[] | FakeWrite[][];
  hooks: HooksConfig;
}

async function runPlan({ repo, planTasks, writes, hooks }: RunArgs): Promise<{
  logPath: string;
  manifestPath: string;
  manifest: unknown;
  metaDir: string;
}> {
  // Keep plan/manifest/logs OUTSIDE the repo under test — anything inside the
  // repo cwd would show up in reconciliation as an extra surprise write.
  const metaDir = join(tmpdir(), `galloper-meta-${randomUUID()}`);
  const logsDir = join(metaDir, 'logs');
  await fs.mkdir(logsDir, { recursive: true });
  const logPath = join(logsDir, 'runs.jsonl');
  const logger = new Logger({ logsDir, centralLogPath: logPath });
  await logger.ensureDir();

  const planContent = JSON.stringify({
    planId: 'trust-boundary',
    tasks: planTasks.map((t) => ({
      id: t.id,
      title: `Task ${t.id}`,
      files: t.files,
      instructions: 'fake',
      verify: t.verify ?? 'true',
      dependsOn: [],
    })),
  });
  const planFilePath = join(metaDir, 'plan.json');
  await fs.writeFile(planFilePath, JSON.stringify({ content: planContent }), 'utf8');
  const manifestPath = join(metaDir, 'manifest.json');

  const runner = new TaskRunner();
  const manifest = await runner.run({
    planFilePath,
    runManifestPath: manifestPath,
    cwd: repo.dir,
    executioner: asExecutioner(new FakeExecutioner(writes)),
    coreRunner: new CoreRunner(),
    logger,
    hooksConfig: hooks,
    sessionId: 'test-session',
    defaultMaxAttempts: 1,
  });

  return { logPath, manifestPath, manifest, metaDir };
}

async function cleanupMeta(metaDir: string): Promise<void> {
  try {
    await fs.rm(metaDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

describe('Trust boundary — scenario 01 (escape: undeclared .sh write)', () => {
  let repo: TempRepo;

  beforeEach(async () => {
    repo = await createTempRepo();
    await initSeededRepo(repo.dir, { 'src/a.ts': 'original\n' });
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it('classifies undeclared writes as surprise and routes hooks correctly', async () => {
    const declaredSentinel = join(repo.dir, 'declared.log');
    const surpriseSentinel = join(repo.dir, 'surprise.log');

    const { logPath, manifestPath } = await runPlan({
      repo,
      planTasks: [
        {
          id: 't1',
          files: [{ path: 'src/a.ts', action: 'edit' }],
        },
      ],
      writes: [
        { path: 'src/a.ts', action: 'edit', content: 'modified by task\n' },
        { path: 'scripts/release.sh', action: 'create', content: '#!/bin/sh\necho hi\n' },
      ],
      hooks: {
        lifecycle: {
          'post-task-file': [
            // Hook 1: .ts files, no runOnSurprise — only fires for declared.
            {
              match: '**/*.ts',
              command: `echo "{file}" >> "${declaredSentinel}"`,
            },
            // Hook 2: .sh files, runOnSurprise: true — catches surprises.
            {
              match: '**/*.sh',
              command: `echo "{file}" >> "${surpriseSentinel}"`,
              runOnSurprise: true,
            },
          ],
        },
      },
    });

    const events = readJsonlEvents(logPath);
    const surpriseEvents = events.filter((e) => e.type === 'task.file.surprise');
    const declaredEvents = events.filter((e) => e.type === 'task.file.declared');

    expect(surpriseEvents.map((e) => e.path)).toContain('scripts/release.sh');
    expect(declaredEvents.map((e) => e.path)).toContain('src/a.ts');

    // .ts hook fired for the declared path only (no .sh matches it anyway).
    expect(existsSync(declaredSentinel)).toBe(true);
    expect(readFileSync(declaredSentinel, 'utf8').trim()).toBe('src/a.ts');
    // .sh hook fired on the surprise path.
    expect(existsSync(surpriseSentinel)).toBe(true);
    expect(readFileSync(surpriseSentinel, 'utf8').trim()).toBe('scripts/release.sh');

    // Acceptance criterion 6: SessionRecord contains the classified manifest.
    const persisted = JSON.parse(readFileSync(manifestPath, 'utf8'));
    expect(persisted.taskManifests.t1.surprise.map((p: { path: string }) => p.path)).toContain('scripts/release.sh');
    expect(persisted.taskManifests.t1.declared.map((p: { path: string }) => p.path)).toContain('src/a.ts');
  });

  it('hooks without runOnSurprise do NOT fire on surprise paths', async () => {
    const sentinel = join(repo.dir, 'fired.log');

    const { logPath } = await runPlan({
      repo,
      planTasks: [
        {
          id: 't1',
          files: [{ path: 'src/a.ts', action: 'edit' }],
        },
      ],
      writes: [
        { path: 'src/a.ts', action: 'edit', content: 'modified\n' },
        { path: 'scripts/release.sh', action: 'create', content: 'noise\n' },
      ],
      hooks: {
        lifecycle: {
          'post-task-file': [
            {
              match: '**/*.sh',
              command: `echo fired >> "${sentinel}"`,
              // no runOnSurprise — must skip the surprise .sh path
            },
          ],
        },
      },
    });

    const events = readJsonlEvents(logPath);
    expect(events.some((e) => e.type === 'task.file.surprise' && e.path === 'scripts/release.sh')).toBe(true);
    expect(existsSync(sentinel)).toBe(false);
  });
});

describe('Trust boundary — Step 5: argv mode + path injection', () => {
  let repo: TempRepo;

  beforeEach(async () => {
    repo = await createTempRepo();
    await initSeededRepo(repo.dir, { 'src/a.ts': 'original\n' });
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it('argv mode (shell:false) substitutes {file} into array arguments without a shell', async () => {
    const sentinel = join(repo.dir, '..', `argv-sentinel-${Date.now()}.log`);

    const { logPath } = await runPlan({
      repo,
      planTasks: [{ id: 't1', files: [{ path: 'src/a.ts', action: 'edit' }] }],
      writes: [{ path: 'src/a.ts', action: 'edit', content: 'modified\n' }],
      hooks: {
        lifecycle: {
          'post-task-file': [
            {
              match: '**/*.ts',
              shell: false,
              command: [
                'node',
                '-e',
                'require("fs").appendFileSync(process.argv[1], process.argv[2] + "\\n")',
                sentinel,
                '{file}',
              ],
            },
          ],
        },
      },
    });

    expect(existsSync(sentinel)).toBe(true);
    expect(readFileSync(sentinel, 'utf8').trim()).toBe('src/a.ts');
    // argv mode should not flag path-injection even for "exotic" paths since
    // no shell is involved. (Here the path is plain, just asserting the happy flow.)
    const events = readJsonlEvents(logPath);
    expect(events.find((e) => e.type === 'task.file.declared' && e.path === 'src/a.ts')).toBeDefined();
  });

  it('shell-mode hooks are skipped when {file} would interpolate a metachar-laden path', async () => {
    const safeSentinel = join(repo.dir, '..', `safe-sentinel-${Date.now()}.log`);
    const unsafeSentinel = join(repo.dir, '..', `unsafe-sentinel-${Date.now()}.log`);

    // Seed a filename that is legal on POSIX but contains a shell metachar.
    const unsafeName = "weird'file.ts";
    const { logPath, manifestPath } = await runPlan({
      repo,
      planTasks: [{ id: 't1', files: [{ path: 'src/a.ts', action: 'edit' }] }],
      writes: [
        { path: 'src/a.ts', action: 'edit', content: 'modified\n' },
        { path: unsafeName, action: 'create', content: 'oops\n' },
      ],
      hooks: {
        lifecycle: {
          'post-task-file': [
            // Shell-mode hook that would be vulnerable — must be SKIPPED for the unsafe path.
            {
              match: '**/*.ts',
              command: `echo "{file}" >> "${unsafeSentinel}"`,
              runOnSurprise: true,
            },
            // Argv-mode hook — bypasses path-safety check, should still run.
            {
              match: '**/*.ts',
              shell: false,
              runOnSurprise: true,
              command: [
                'node',
                '-e',
                'require("fs").appendFileSync(process.argv[1], process.argv[2] + "\\n")',
                safeSentinel,
                '{file}',
              ],
            },
          ],
        },
      },
    });

    // Shell hook must NOT have written the unsafe path into its sentinel —
    // the only line written is the safe declared one (src/a.ts).
    if (existsSync(unsafeSentinel)) {
      const contents = readFileSync(unsafeSentinel, 'utf8');
      expect(contents).not.toContain(unsafeName);
    }

    // Argv hook wrote BOTH paths because it bypasses the path-safety check.
    expect(existsSync(safeSentinel)).toBe(true);
    const argvContents = readFileSync(safeSentinel, 'utf8');
    expect(argvContents).toContain('src/a.ts');
    expect(argvContents).toContain(unsafeName);

    // The unsafe path was classified (surprise) — the skip happens at dispatch, not classification.
    const events = readJsonlEvents(logPath);
    expect(events.some((e) => e.type === 'task.file.surprise' && e.path === unsafeName)).toBe(true);

    // The HookFailure for path-injection-risk is persisted on the attempt record.
    const persisted = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const attempts = persisted.tasks[0]?.attempts ?? [];
    const allFailures = attempts.flatMap((a: { hookFailures: unknown[] }) => a.hookFailures);
    const riskFailure = allFailures.find((f: { stderr: string }) => f.stderr.includes('path-injection-risk'));
    expect(riskFailure).toBeDefined();
  });
});

describe('Trust boundary — scenario 05 (churn: write-then-revert)', () => {
  // Full churn detection needs the live watcher (Step 4). What Step 1
  // guarantees is the byproduct: if the LLM writes a file and then restores
  // the original content, `git status` sees no net change, reconcile returns
  // empty, and no post-task-file hook runs for that path.
  let repo: TempRepo;

  beforeEach(async () => {
    repo = await createTempRepo();
    await initSeededRepo(repo.dir, { 'foo.ts': 'baseline\n' });
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it('write-then-revert produces no reconciled change and fires no file-scoped hooks', async () => {
    const sentinel = join(repo.dir, 'hook-fired.log');

    // FakeExecutioner runs once, but we can write multiple files in the one
    // "attempt" — the second write restores the original content, so git sees
    // no net change by the time reconcile runs post-task.
    const { logPath } = await runPlan({
      repo,
      planTasks: [{ id: 't1', files: [{ path: 'foo.ts', action: 'edit' }] }],
      writes: [
        { path: 'foo.ts', action: 'edit', content: 'transient modification\n' },
        { path: 'foo.ts', action: 'edit', content: 'baseline\n' },
      ],
      hooks: {
        lifecycle: {
          'post-task-file': [
            { match: '**/*.ts', command: `echo fired >> "${sentinel}"` },
          ],
        },
      },
    });

    const events = readJsonlEvents(logPath);
    expect(events.some((e) => e.type === 'task.file.declared' && e.path === 'foo.ts')).toBe(false);
    expect(events.some((e) => e.type === 'task.file.surprise' && e.path === 'foo.ts')).toBe(false);
    expect(existsSync(sentinel)).toBe(false);

    const summary = events.find((e) => e.type === 'workspace.reconciled' && e.taskId === 't1');
    expect(summary?.declared).toBe(0);
    expect(summary?.surprise).toBe(0);
  });
});

describe('Trust boundary — scenario 07 (wrong declared manifest: independence)', () => {
  let repo: TempRepo;

  beforeEach(async () => {
    repo = await createTempRepo();
    await initSeededRepo(repo.dir, { 'src/a.ts': 'original\n' });
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it('reconciled set is identical regardless of declared-manifest accuracy', async () => {
    const commonWrites: FakeWrite[] = [
      { path: 'src/a.ts', action: 'edit', content: 'modified\n' },
      { path: 'scripts/release.sh', action: 'create', content: '#!/bin/sh\n' },
    ];

    // Run A: accurate plan declares src/a.ts.
    const runA = await runPlan({
      repo,
      planTasks: [{ id: 't1', files: [{ path: 'src/a.ts', action: 'edit' }] }],
      writes: commonWrites,
      hooks: {},
    });
    const eventsA = readJsonlEvents(runA.logPath);
    const reconciledA = new Set(
      eventsA
        .filter((e) => e.type === 'task.file.declared' || e.type === 'task.file.surprise')
        .map((e) => String(e.path)),
    );

    // Reset repo state for run B (new temp repo).
    await repo.cleanup();
    repo = await createTempRepo();
    await initSeededRepo(repo.dir, { 'src/a.ts': 'original\n' });

    // Run B: wrong plan — declares a file never written, omits src/a.ts.
    const runB = await runPlan({
      repo,
      planTasks: [{ id: 't1', files: [{ path: 'src/never-written.ts', action: 'create' }] }],
      writes: commonWrites,
      hooks: {},
    });
    const eventsB = readJsonlEvents(runB.logPath);
    const reconciledB = new Set(
      eventsB
        .filter((e) => e.type === 'task.file.declared' || e.type === 'task.file.surprise')
        .map((e) => String(e.path)),
    );

    // Acceptance criterion 4: reconciled set is identical; only partition differs.
    expect(reconciledB).toEqual(reconciledA);

    // In run B, src/a.ts must now be surprise (it was not declared).
    const aTsClassificationB = eventsB.find((e) => e.path === 'src/a.ts' && (e.type === 'task.file.declared' || e.type === 'task.file.surprise'));
    expect(aTsClassificationB?.type).toBe('task.file.surprise');

    // src/never-written.ts must appear in neither declared nor surprise — nothing was written.
    expect(reconciledB.has('src/never-written.ts')).toBe(false);
  });
});

describe('Trust boundary — workspace.reconciled summary', () => {
  let repo: TempRepo;

  beforeEach(async () => {
    repo = await createTempRepo();
    await initSeededRepo(repo.dir, { 'src/a.ts': 'original\n' });
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it('emits a workspace.reconciled event with correct counts per task', async () => {
    const { logPath } = await runPlan({
      repo,
      planTasks: [{ id: 't1', files: [{ path: 'src/a.ts', action: 'edit' }] }],
      writes: [
        { path: 'src/a.ts', action: 'edit', content: 'modified\n' },
        { path: 'scripts/release.sh', action: 'create', content: '#!/bin/sh\n' },
        { path: 'scripts/deploy.sh', action: 'create', content: '#!/bin/sh\n' },
      ],
      hooks: {},
    });

    const events = readJsonlEvents(logPath);
    const summary = events.find((e) => e.type === 'workspace.reconciled' && e.taskId === 't1');
    expect(summary).toBeDefined();
    expect(summary?.declared).toBe(1);
    expect(summary?.surprise).toBe(2);
    expect(summary?.churn).toBe(0);
  });

  it('emits workspace.baseline.captured event before task execution', async () => {
    const { logPath } = await runPlan({
      repo,
      planTasks: [{ id: 't1', files: [] }],
      writes: [],
      hooks: {},
    });

    const events = readJsonlEvents(logPath);
    const baseline = events.find((e) => e.type === 'workspace.baseline.captured' && e.taskId === 't1');
    expect(baseline).toBeDefined();
    expect(baseline?.vcs).toBe('git');
    expect(String(baseline?.ref)).toMatch(/^[0-9a-f]{40}$/);
  });
});
