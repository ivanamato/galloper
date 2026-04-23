import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Executioner, ExecutionerInput, ExecutionResult } from '../../src/lib/Executioner.js';

export interface FakeWrite {
  path: string;
  action: 'create' | 'edit' | 'delete';
  content?: string;
}

/**
 * A deterministic Executioner stub for trust-boundary tests.
 *
 * Replays a recorded set of file writes against `cwd` instead of invoking
 * a real LLM subprocess. The writes are what the fixture claims the model
 * "really did" — which may disagree with the plan's declared manifest;
 * that disagreement is what the tests exercise.
 */
export class FakeExecutioner {
  private writesByAttempt: FakeWrite[][];
  private invocations = 0;

  constructor(writes: FakeWrite[] | FakeWrite[][]) {
    this.writesByAttempt = Array.isArray(writes[0]) ? (writes as FakeWrite[][]) : [writes as FakeWrite[]];
  }

  async implement(input: ExecutionerInput): Promise<ExecutionResult> {
    const cwd = input.cwd ?? process.cwd();
    const idx = Math.min(this.invocations, this.writesByAttempt.length - 1);
    const writes = this.writesByAttempt[idx] ?? [];
    this.invocations++;

    for (const w of writes) {
      const full = path.join(cwd, w.path);
      if (w.action === 'delete') {
        await fs.rm(full, { force: true });
      } else {
        await fs.mkdir(path.dirname(full), { recursive: true });
        await fs.writeFile(full, w.content ?? '', 'utf8');
      }
    }

    const sessionId = `fake-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    return {
      executionId: sessionId,
      executionFilePath: '',
      sessionId,
      exitCode: 0,
      executionContent: '',
    };
  }
}

export function asExecutioner(fake: FakeExecutioner): Executioner {
  return fake as unknown as Executioner;
}
