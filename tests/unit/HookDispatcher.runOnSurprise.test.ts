import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HookDispatcher, type HooksConfig } from '../../src/lib/HookDispatcher.js';

describe('HookDispatcher.runOnSurprise gating', () => {
  let tempDir: string;
  let declaredSentinel: string;
  let surpriseSentinel: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'hook-surprise-'));
    declaredSentinel = join(tempDir, 'declared.log');
    surpriseSentinel = join(tempDir, 'surprise.log');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function buildConfig(): HooksConfig {
    return {
      lifecycle: {
        'post-task-file': [
          {
            match: '**/*.ts',
            command: `echo declared >> "${declaredSentinel}"`,
            // no runOnSurprise — defaults to false
          },
          {
            match: '**/*.sh',
            command: `echo surprise >> "${surpriseSentinel}"`,
            runOnSurprise: true,
          },
        ],
      },
    };
  }

  it('fires on declared paths regardless of runOnSurprise flag', async () => {
    const dispatcher = new HookDispatcher(buildConfig());
    await dispatcher.runPost('post-task-file', {
      file: { path: 'src/a.ts', action: 'edit' },
      sessionId: 'test',
      cwd: tempDir,
      classification: 'declared',
    });
    expect(existsSync(declaredSentinel)).toBe(true);
    expect(readFileSync(declaredSentinel, 'utf8').trim()).toBe('declared');
  });

  it('skips hooks without runOnSurprise when classification is surprise', async () => {
    const dispatcher = new HookDispatcher(buildConfig());
    await dispatcher.runPost('post-task-file', {
      file: { path: 'src/a.ts', action: 'edit' },
      sessionId: 'test',
      cwd: tempDir,
      classification: 'surprise',
    });
    expect(existsSync(declaredSentinel)).toBe(false);
  });

  it('fires hook with runOnSurprise=true on surprise path', async () => {
    const dispatcher = new HookDispatcher(buildConfig());
    await dispatcher.runPost('post-task-file', {
      file: { path: 'scripts/release.sh', action: 'create' },
      sessionId: 'test',
      cwd: tempDir,
      classification: 'surprise',
    });
    expect(existsSync(surpriseSentinel)).toBe(true);
  });

  it('runOnSurprise hook still only fires for matching glob', async () => {
    const dispatcher = new HookDispatcher(buildConfig());
    // surprise path does NOT match **/*.sh (it's a .md)
    await dispatcher.runPost('post-task-file', {
      file: { path: 'NOTES.md', action: 'create' },
      sessionId: 'test',
      cwd: tempDir,
      classification: 'surprise',
    });
    expect(existsSync(declaredSentinel)).toBe(false);
    expect(existsSync(surpriseSentinel)).toBe(false);
  });

  it('defaults to declared semantics when classification is omitted', async () => {
    const dispatcher = new HookDispatcher(buildConfig());
    await dispatcher.runPost('post-task-file', {
      file: { path: 'src/a.ts', action: 'edit' },
      sessionId: 'test',
      cwd: tempDir,
      // no classification — backwards compatible, acts as declared
    });
    expect(existsSync(declaredSentinel)).toBe(true);
  });
});
