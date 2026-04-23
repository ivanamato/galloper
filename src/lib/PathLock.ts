import nodePath from 'node:path';

/**
 * Per-path serialization primitive. `acquire(p, fn)` runs `fn` only after any
 * in-flight operation on the same normalized path resolves. Concurrent calls
 * on DIFFERENT paths run freely — the lock is per-key, not global.
 *
 * Used to guarantee "sequential within a file" semantics for hooks that
 * mutate shared paths while allowing "parallel across files" dispatch.
 */
export class PathLock {
  private tails = new Map<string, Promise<unknown>>();

  async acquire<T>(path: string, fn: () => Promise<T>): Promise<T> {
    const key = nodePath.resolve(path);
    const prev = this.tails.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.tails.set(key, next);
    try {
      return await next;
    } finally {
      // Only delete the entry if we're still the tail — otherwise a later
      // acquire has already chained on and we'd orphan its pending work.
      if (this.tails.get(key) === next) {
        this.tails.delete(key);
      }
    }
  }
}
