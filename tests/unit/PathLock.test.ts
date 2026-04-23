import { describe, it, expect } from 'vitest';
import { PathLock } from '../../src/lib/PathLock.js';

describe('PathLock', () => {
  it('serializes acquire() calls on the same path', async () => {
    const lock = new PathLock();
    const events: string[] = [];

    const a = lock.acquire('/a', async () => {
      events.push('a-start');
      const { promise: barrier, resolve } = Promise.withResolvers<void>();
      resolve();
      await barrier;
      events.push('a-end');
    });
    const b = lock.acquire('/a', async () => {
      events.push('b-start');
      const { promise: barrier, resolve } = Promise.withResolvers<void>();
      resolve();
      await barrier;
      events.push('b-end');
    });

    await Promise.all([a, b]);
    expect(events).toEqual(['a-start', 'a-end', 'b-start', 'b-end']);
  });

  it('permits concurrent acquire() on different paths', async () => {
    const lock = new PathLock();
    const timeline: Array<{ op: string; t: number }> = [];
    const start = Date.now();

    const { promise: barrier, resolve: resolveBarrier } = Promise.withResolvers<void>();
    let startCount = 0;

    const a = lock.acquire('/a', async () => {
      timeline.push({ op: 'a-start', t: Date.now() - start });
      startCount++;
      if (startCount === 2) {
        // Defer resolution to allow time to pass between start and end events
        setTimeout(() => resolveBarrier(), 1);
      }
      await barrier;
      timeline.push({ op: 'a-end', t: Date.now() - start });
    });
    const b = lock.acquire('/b', async () => {
      timeline.push({ op: 'b-start', t: Date.now() - start });
      startCount++;
      if (startCount === 2) {
        // Defer resolution to allow time to pass between start and end events
        setTimeout(() => resolveBarrier(), 1);
      }
      await barrier;
      timeline.push({ op: 'b-end', t: Date.now() - start });
    });

    await Promise.all([a, b]);

    const aStart = timeline.find((e) => e.op === 'a-start')!.t;
    const aEnd = timeline.find((e) => e.op === 'a-end')!.t;
    const bStart = timeline.find((e) => e.op === 'b-start')!.t;
    const bEnd = timeline.find((e) => e.op === 'b-end')!.t;
    // Overlapping means at least one start is before the other's end.
    expect(bStart < aEnd || aStart < bEnd).toBe(true);
    // And they're close enough together that they actually ran in parallel.
    expect(Math.abs(aStart - bStart)).toBeLessThan(10);
  });

  it('releases lock on rejection and lets next acquire run', async () => {
    const lock = new PathLock();
    await expect(lock.acquire('/a', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    // Subsequent acquire must still run.
    const result = await lock.acquire('/a', async () => 'ok');
    expect(result).toBe('ok');
  });

  it('normalizes path so relative and absolute forms share the same lock', async () => {
    const lock = new PathLock();
    const events: string[] = [];

    const a = lock.acquire('./src/a.ts', async () => {
      events.push('rel-start');
      const { promise: barrier, resolve } = Promise.withResolvers<void>();
      resolve();
      await barrier;
      events.push('rel-end');
    });
    // Build the absolute path the same way PathLock does via node:path.resolve.
    const abs = (await import('node:path')).default.resolve('./src/a.ts');
    const b = lock.acquire(abs, async () => {
      events.push('abs-start');
      events.push('abs-end');
    });

    await Promise.all([a, b]);
    expect(events).toEqual(['rel-start', 'rel-end', 'abs-start', 'abs-end']);
  });
});
