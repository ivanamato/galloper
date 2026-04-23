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
    const p1 = lock.acquire(async () => {
      events.push('1:start');
      await new Promise((r) => setTimeout(r, 15));
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
    const run = (n: number, delayMs: number) =>
      lock.acquire(async () => {
        order.push(n * 10);
        await new Promise((r) => setTimeout(r, delayMs));
        order.push(n * 10 + 1);
      });

    await Promise.all([run(1, 10), run(2, 0), run(3, 5)]);
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
    const first = l1.acquire(async () => {
      seen.push('l1-start');
      await new Promise((r) => setTimeout(r, 10));
      seen.push('l1-end');
    });
    const second = l2.acquire(async () => {
      seen.push('l2');
    });
    await Promise.all([first, second]);
    expect(seen).toContain('l1-start');
    expect(seen).toContain('l1-end');
    expect(seen).toContain('l2');
    // l2 finishes during l1's wait; it must appear between l1-start and l1-end
    expect(seen.indexOf('l2')).toBeGreaterThan(seen.indexOf('l1-start'));
    expect(seen.indexOf('l2')).toBeLessThan(seen.indexOf('l1-end'));
  });
});
