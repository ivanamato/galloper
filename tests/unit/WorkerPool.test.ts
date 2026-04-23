import { describe, it, expect } from 'vitest';
import { WorkerPool } from '../../src/lib/WorkerPool.js';

describe('WorkerPool', () => {
  it('throws when constructed with concurrency < 1', () => {
    expect(() => new WorkerPool<number>(0)).toThrow(/at least 1/);
    expect(() => new WorkerPool<number>(-1)).toThrow(/at least 1/);
  });

  it('runs a single task and returns its value', async () => {
    const pool = new WorkerPool<number>(1);
    const result = await pool.enqueue(async () => 42);
    expect(result).toBe(42);
  });

  it('runs tasks sequentially when concurrency is 1', async () => {
    const pool = new WorkerPool<number>(1);
    const running: number[] = [];
    const snapshots: number[] = [];
    const make = (n: number) =>
      pool.enqueue(async () => {
        running.push(n);
        snapshots.push(running.length);
        const { promise: barrier, resolve } = Promise.withResolvers<void>();
        resolve();
        await barrier;
        running.splice(running.indexOf(n), 1);
        return n;
      });

    const results = await Promise.all([make(1), make(2), make(3)]);
    expect(results).toEqual([1, 2, 3]);
    expect(Math.max(...snapshots)).toBe(1);
  });

  it('respects the concurrency bound (never more than N running at once)', async () => {
    const pool = new WorkerPool<number>(3);
    let running = 0;
    let maxRunning = 0;
    const { promise: barrier, resolve: resolveBarrier } = Promise.withResolvers<void>();

    const tasks = Array.from({ length: 10 }, (_, i) =>
      pool.enqueue(async () => {
        running += 1;
        maxRunning = Math.max(maxRunning, running);
        if (running === 3) resolveBarrier();
        await barrier;
        running -= 1;
        return i;
      }),
    );

    const results = await Promise.all(tasks);
    expect(results).toHaveLength(10);
    expect(maxRunning).toBeLessThanOrEqual(3);
    expect(maxRunning).toBeGreaterThan(1);
  });

  it('propagates task rejections without stalling the pool', async () => {
    const pool = new WorkerPool<string>(2);
    const t1 = pool.enqueue(async () => {
      throw new Error('boom');
    });
    const t2 = pool.enqueue(async () => 'ok');

    await expect(t1).rejects.toThrow('boom');
    expect(await t2).toBe('ok');

    const t3 = await pool.enqueue(async () => 'after');
    expect(t3).toBe('after');
  });

  it('processes tasks enqueued after the pool has drained', async () => {
    const pool = new WorkerPool<number>(2);
    const batch1 = await Promise.all([
      pool.enqueue(async () => 1),
      pool.enqueue(async () => 2),
    ]);
    expect(batch1).toEqual([1, 2]);

    const batch2 = await Promise.all([
      pool.enqueue(async () => 3),
      pool.enqueue(async () => 4),
    ]);
    expect(batch2).toEqual([3, 4]);
  });

  it('accepts new tasks enqueued while others are still running', async () => {
    const pool = new WorkerPool<string>(2);
    const slow = pool.enqueue(async () => {
      const { promise: barrier, resolve } = Promise.withResolvers<void>();
      resolve();
      await barrier;
      return 'slow';
    });
    // enqueue mid-flight
    const fast = pool.enqueue(async () => 'fast');
    const results = await Promise.all([slow, fast]);
    expect(results.sort()).toEqual(['fast', 'slow']);
  });
});
