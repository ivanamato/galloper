import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import picomatch from 'picomatch';

const execFileAsync = promisify(execFile);

/**
 * A baseline snapshot of a git working tree.
 * `head` is the current HEAD SHA (or a sentinel for unborn branches).
 * `entries` maps path → porcelain-status-tag so reconcile() can diff
 * post-task state against pre-task state and return only net-changed paths.
 */
export interface Baseline {
  head: string;
  entries: Record<string, string>;
  /**
   * SHA of a `git stash create` commit capturing the dirty TRACKED state at
   * baseline time. Used by `revertToBaseline` to replay pre-task dirty edits
   * after a reset. Untracked files at baseline are NOT captured in v1 —
   * revert restores the committed state + stashed tracked dirty, but
   * untracked files present at baseline are wiped by the revert's
   * `git clean -fd`. `git stash create` is read-only; it does not mutate
   * the working tree or the stash stack.
   */
  stashSha?: string;
}

export interface ReconciledPath {
  path: string;
  action: 'create' | 'edit' | 'delete';
}

export interface ClassifyInput {
  path: string;
  action: 'create' | 'edit' | 'delete';
}

export interface Classified {
  declared: ReconciledPath[];
  surprise: ReconciledPath[];
  churn: ReconciledPath[];
}

async function runGit(cwd: string, args: string[]): Promise<{ stdout: string }> {
  const { stdout } = await execFileAsync('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 });
  return { stdout };
}

async function runGitBuffer(cwd: string, args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, maxBuffer: 64 * 1024 * 1024, encoding: 'buffer' }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout as Buffer);
    });
  });
}

async function assertGitRepo(cwd: string): Promise<void> {
  try {
    const { stdout } = await runGit(cwd, ['rev-parse', '--is-inside-work-tree']);
    if (stdout.trim() !== 'true') {
      throw new Error(`cwd is not a git repository: ${cwd}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.startsWith('cwd is not a git repository')) throw err;
    throw new Error(`cwd is not a git repository: ${cwd}`);
  }
}

interface ParsedEntry {
  path: string;
  tag: string;       // stable per-state tag (e.g. "1:.M", "?", "!")
  action: 'create' | 'edit' | 'delete';
}

/**
 * Parse `git status --porcelain=v2 -z` output into structured entries.
 *
 * Porcelain v2 NUL-separated record types:
 *   "1 XY ... path"             ordinary changed entry
 *   "2 XY ... path\tori_path"   rename/copy (uses two NUL-terminated fields)
 *   "u XY ... path"             unmerged
 *   "? path"                    untracked
 *   "! path"                    ignored (skipped)
 */
function parsePorcelainV2Z(buf: Buffer): ParsedEntry[] {
  const out: ParsedEntry[] = [];
  const parts = buf.toString('utf8').split('\0');
  for (let i = 0; i < parts.length; i++) {
    const record = parts[i];
    if (!record) continue;
    const type = record[0];
    if (type === '!') continue;
    if (type === '?') {
      const path = record.slice(2);
      if (path) out.push({ path, tag: '?', action: 'create' });
      continue;
    }
    if (type === '1' || type === 'u') {
      const fields = record.split(' ');
      const xy = fields[1] ?? '..';
      const path = fields.slice(8).join(' ');
      if (!path) continue;
      out.push({ path, tag: `${type}:${xy}`, action: xyToAction(xy) });
      continue;
    }
    if (type === '2') {
      const fields = record.split(' ');
      const xy = fields[1] ?? '..';
      const path = fields.slice(9).join(' ');
      // skip the original-path field that follows
      i++;
      if (path) out.push({ path, tag: `2:${xy}`, action: xyToAction(xy) });
      continue;
    }
  }
  return out;
}

function xyToAction(xy: string): 'create' | 'edit' | 'delete' {
  if (xy.includes('D')) return 'delete';
  if (xy.includes('A')) return 'create';
  return 'edit';
}

async function snapshotEntries(cwd: string): Promise<ParsedEntry[]> {
  const porcelain = await runGitBuffer(cwd, ['status', '--porcelain=v2', '-z', '--untracked-files=all']);
  return parsePorcelainV2Z(porcelain);
}

export async function captureBaseline(cwd: string): Promise<Baseline> {
  await assertGitRepo(cwd);

  let head: string;
  try {
    const { stdout } = await runGit(cwd, ['rev-parse', 'HEAD']);
    head = stdout.trim();
  } catch {
    head = '0000000000000000000000000000000000000000';
  }

  const entries = await snapshotEntries(cwd);
  const record: Record<string, string> = {};
  for (const e of entries) record[e.path] = e.tag;

  // Capture a READ-ONLY snapshot of the dirty tracked state via `git stash
  // create`, which builds a commit object representing the current index +
  // worktree but does NOT touch the working tree or the stash stack.
  // Returning empty stdout on a clean tree is normal — we leave stashSha
  // undefined in that case.
  //
  // Intentional non-goal for v1: `--include-untracked` is NOT passed (it
  // isn't accepted by `stash create` anyway), so untracked files at
  // baseline are not captured. The only safe alternative (`stash push
  // --include-untracked` + `stash pop`) mutates the working tree — if any
  // step of the chain fails, uncommitted files are lost. That cost is not
  // worth the benefit for v1; document the limitation and revisit later.
  let stashSha: string | undefined;
  try {
    const { stdout } = await runGit(cwd, ['stash', 'create']);
    const trimmed = stdout.trim();
    if (trimmed) stashSha = trimmed;
  } catch {
    // `git stash create` can fail on unborn branches or odd states; absence
    // of stashSha just disables dirty-state replay in revert.
  }

  return { head, entries: record, ...(stashSha ? { stashSha } : {}) };
}

/**
 * Restore the working tree to the state captured by `baseline`. Safe to call
 * from an abort path — never throws; returns `{ reverted:false, reason }` on
 * any failure so the caller can log and continue propagating the original
 * error.
 *
 * **Destructive** — runs `git reset --hard` and `git clean -fd` on `cwd`.
 * Only invoke when the caller has explicitly opted in (e.g. via
 * `onAbort:'revert'` on a hook). Any uncommitted untracked files inside
 * `cwd` at revert time are removed by `git clean -fd`; untracked files
 * present at baseline are NOT restored in v1.
 */
export async function revertToBaseline(
  cwd: string,
  baseline: Baseline,
): Promise<{ reverted: boolean; reason?: string }> {
  try {
    await assertGitRepo(cwd);
  } catch {
    return { reverted: false, reason: 'non-git' };
  }
  if (baseline.head === '0000000000000000000000000000000000000000') {
    return { reverted: false, reason: 'unborn-branch' };
  }
  try {
    await runGit(cwd, ['reset', '--hard', baseline.head]);
  } catch (err) {
    return { reverted: false, reason: `reset failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  try {
    await runGit(cwd, ['clean', '-fd']);
  } catch (err) {
    return { reverted: false, reason: `clean failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (baseline.stashSha) {
    try {
      await runGit(cwd, ['stash', 'apply', baseline.stashSha]);
    } catch (err) {
      return { reverted: false, reason: `stash apply failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
  return { reverted: true };
}

/**
 * Return the net set of paths whose state differs from `baseline`.
 *
 * A path is returned when:
 *   - it appears now but did not in baseline (new write), OR
 *   - its porcelain tag differs from the baseline tag (state transition).
 *
 * A path that was dirty at baseline and has the SAME tag now is excluded —
 * it represents pre-existing dirty state the task did not touch. A path
 * that was dirty at baseline and is clean now (reverted) is also excluded
 * from the reconciled set in Step 1; churn detection is routed separately.
 */
export async function reconcile(cwd: string, baseline: Baseline): Promise<ReconciledPath[]> {
  await assertGitRepo(cwd);
  const now = await snapshotEntries(cwd);
  const out: ReconciledPath[] = [];
  for (const entry of now) {
    const prev = baseline.entries[entry.path];
    if (prev === entry.tag) continue; // unchanged since baseline
    out.push({ path: entry.path, action: entry.action });
  }
  return out;
}

export function classify(
  reconciled: ReconciledPath[],
  declared: ClassifyInput[],
  churn: ReconciledPath[],
): Classified {
  const churnSet = new Set(churn.map((c) => c.path));
  const literal = new Set<string>();
  const globs: string[] = [];
  for (const d of declared) {
    if (d.path.includes('*') || d.path.includes('?') || d.path.includes('[') || d.path.includes('{')) {
      globs.push(d.path);
    } else {
      literal.add(d.path);
    }
  }

  const declaredOut: ReconciledPath[] = [];
  const surpriseOut: ReconciledPath[] = [];

  for (const r of reconciled) {
    if (churnSet.has(r.path)) continue;
    if (literal.has(r.path)) {
      declaredOut.push(r);
      continue;
    }
    let matched = false;
    for (const g of globs) {
      try {
        if (picomatch.isMatch(r.path, g)) {
          matched = true;
          break;
        }
      } catch {
        // ignore invalid glob here; validator surfaces it elsewhere
      }
    }
    if (matched) declaredOut.push(r);
    else surpriseOut.push(r);
  }

  return { declared: declaredOut, surprise: surpriseOut, churn };
}
