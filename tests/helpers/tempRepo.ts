import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface TempRepo {
  dir: string;
  cleanup(): Promise<void>;
}

export async function createTempRepo(): Promise<TempRepo> {
  const dir = await fs.mkdtemp(join(tmpdir(), 'galloper-repo-'));
  return {
    dir,
    async cleanup(): Promise<void> {
      try {
        await fs.rm(dir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    },
  };
}
