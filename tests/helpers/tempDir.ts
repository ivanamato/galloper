import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export function createTempWorkspace(): string {
  const dir = join(tmpdir(), `galloper-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(dir, 'sessions'), { recursive: true });
  mkdirSync(join(dir, 'logs'), { recursive: true });
  return dir;
}

export function cleanup(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
}
