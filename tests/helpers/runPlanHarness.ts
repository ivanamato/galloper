import { promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { TaskRunner } from '../../src/lib/TaskRunner.js';
import { CoreRunner } from '../../src/lib/CoreRunner.js';
import { Logger } from '../../src/lib/Logger.js';
import type { HooksConfig } from '../../src/lib/HookDispatcher.js';
import { createTempRepo, TempRepo } from './tempRepo.js';
import { FakeExecutioner, asExecutioner, type FakeWrite } from './fakeExecutioner.js';

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd });
}

export async function initSeededRepo(dir: string, seed: Record<string, string>): Promise<void> {
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

export interface RunPlanArgs {
  repo: TempRepo;
  planTasks: Array<{ id: string; files: Array<{ path: string; action: 'create' | 'edit' | 'delete' }>; verify?: string }>;
  writes: FakeWrite[] | FakeWrite[][];
  hooks: HooksConfig;
  concurrency?: number;
  defaultMaxAttempts?: number;
}

export interface RunPlanResult {
  logPath: string;
  manifestPath: string;
  manifest: unknown;
  metaDir: string;
}

export async function runPlan(args: RunPlanArgs): Promise<RunPlanResult> {
  const metaDir = join(tmpdir(), `galloper-meta-${randomUUID()}`);
  const logsDir = join(metaDir, 'logs');
  await fs.mkdir(logsDir, { recursive: true });
  const logPath = join(logsDir, 'runs.jsonl');
  const logger = new Logger({ logsDir, centralLogPath: logPath });
  await logger.ensureDir();

  const planContent = JSON.stringify({
    planId: 'harness',
    tasks: args.planTasks.map((t) => ({
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
    cwd: args.repo.dir,
    executioner: asExecutioner(new FakeExecutioner(args.writes)),
    coreRunner: new CoreRunner(),
    logger,
    hooksConfig: args.hooks,
    sessionId: 'test-session',
    defaultMaxAttempts: args.defaultMaxAttempts ?? 1,
    concurrency: args.concurrency,
  });

  return { logPath, manifestPath, manifest, metaDir };
}

export async function cleanupMeta(metaDir: string): Promise<void> {
  try {
    await fs.rm(metaDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

export { createTempRepo, TempRepo };
