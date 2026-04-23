import { describe, it, expect } from 'vitest';
import { WriteLock } from '../../src/lib/WriteLock.js';

describe('WriteLock', () => {
  it('runs a single critical section and returns its value', async () => {
    const lock = new WriteLock();
    const result = await lock.acquire(async () => 42);
    expect(result).toBe(42);
  });

  it('serializes concurrent acquires in FIFO order', async () => {
    const lock = new WriteLock();
    const events: string[] = [];
    const { promise: p1Promise, resolve: resolveP1 } = Promise.withResolvers<void>();
    const p1 = lock.acquire(async () => {
      events.push('1:start');
      await p1Promise;
      events.push('1:end');
    });
    const p2 = lock.acquire(async () => {
      events.push('2:start');
      events.push('2:end');
    });
    const p3 = lock.acquire(async () => {
      events.push('3:start');
      events.push('3:end');
    });
    resolveP1();
    await Promise.all([p1, p2, p3]);
    expect(events).toEqual(['1:start', '1:end', '2:start', '2:end', '3:start', '3:end']);
  });

  it('releases the lock if the critical section throws', async () => {
    const lock = new WriteLock();
    await expect(lock.acquire(async () => {
      throw new Error('boom');
    })).rejects.toThrow('boom');

    const after = await lock.acquire(async () => 'after-error');
    expect(after).toBe('after-error');
  });

  it('allows interleaved micro-tasks outside critical sections', async () => {
    const lock = new WriteLock();
    const order: number[] = [];
    const defer1 = Promise.withResolvers<void>();
    const defer2 = Promise.withResolvers<void>();
    const defer3 = Promise.withResolvers<void>();

    const p1 = lock.acquire(async () => {
      order.push(1 * 10);
      await defer1.promise;
      order.push(1 * 10 + 1);
    });
    const p2 = lock.acquire(async () => {
      order.push(2 * 10);
      await defer2.promise;
      order.push(2 * 10 + 1);
    });
    const p3 = lock.acquire(async () => {
      order.push(3 * 10);
      await defer3.promise;
      order.push(3 * 10 + 1);
    });

    defer1.resolve();
    defer2.resolve();
    defer3.resolve();

    await Promise.all([p1, p2, p3]);
    expect(order).toEqual([10, 11, 20, 21, 30, 31]);
  });

  it('supports nested independent locks without deadlock', async () => {
    const a = new WriteLock();
    const b = new WriteLock();
    const result = await a.acquire(async () => {
      return b.acquire(async () => 'inner');
    });
    expect(result).toBe('inner');
  });

  it('does not leak state between test invocations (fresh instances serialize independently)', async () => {
    const l1 = new WriteLock();
    const l2 = new WriteLock();
    const seen: string[] = [];
    const { promise: l1Promise, resolve: resolveL1 } = Promise.withResolvers<void>();
    const first = l1.acquire(async () => {
      seen.push('l1-start');
      await l1Promise;
      seen.push('l1-end');
    });
    const second = l2.acquire(async () => {
      seen.push('l2');
    });
    resolveL1();
    await Promise.all([first, second]);
    expect(seen).toContain('l1-start');
    expect(seen).toContain('l1-end');
    expect(seen).toContain('l2');
    // l2 finishes during l1's wait; it must appear between l1-start and l1-end
    expect(seen.indexOf('l2')).toBeGreaterThan(seen.indexOf('l1-start'));
    expect(seen.indexOf('l2')).toBeLessThan(seen.indexOf('l1-end'));
  });
});
