import { describe, expect, it } from 'vitest';
import { BusyError, ResultCache, Semaphore } from './cache.js';

function clock(start = 0): { now: () => number; advance: (ms: number) => void } {
  let value = start;
  return {
    now: () => value,
    advance: (ms) => {
      value += ms;
    },
  };
}

describe('ResultCache', () => {
  it('computes once and serves the cached value', async () => {
    const cache = new ResultCache<number>({ ttlSec: 60, maxEntries: 10 });
    let calls = 0;
    const compute = async () => {
      calls += 1;
      return 42;
    };

    expect(await cache.resolve('a', compute)).toEqual({ value: 42, cached: false });
    expect(await cache.resolve('a', compute)).toEqual({ value: 42, cached: true });
    expect(calls).toBe(1);
  });

  it('recomputes after the ttl expires', async () => {
    const time = clock();
    const cache = new ResultCache<number>({ ttlSec: 60, maxEntries: 10, now: time.now });
    let calls = 0;
    const compute = async () => {
      calls += 1;
      return calls;
    };

    await cache.resolve('a', compute);
    time.advance(60_001);
    expect(await cache.resolve('a', compute)).toEqual({ value: 2, cached: false });
  });

  it('collapses concurrent work on the same key', async () => {
    const cache = new ResultCache<number>({ ttlSec: 60, maxEntries: 10 });
    let calls = 0;
    let release: (value: number) => void = () => undefined;
    const compute = async () => {
      calls += 1;
      return new Promise<number>((resolve) => {
        release = resolve;
      });
    };

    const first = cache.resolve('a', compute);
    const second = cache.resolve('a', compute);
    release(7);

    // Ten visitors to one shared trace link must be one crawl, not ten.
    expect((await first).value).toBe(7);
    expect((await second).value).toBe(7);
    expect(calls).toBe(1);
  });

  it('does not cache a failure, or serve it to the next caller', async () => {
    const cache = new ResultCache<number>({ ttlSec: 60, maxEntries: 10 });
    await expect(cache.resolve('a', () => Promise.reject(new Error('rpc down')))).rejects.toThrow(
      'rpc down',
    );

    expect((await cache.resolve('a', async () => 5)).value).toBe(5);
  });

  it('evicts the least recently used entry', async () => {
    const cache = new ResultCache<string>({ ttlSec: 600, maxEntries: 2 });
    await cache.resolve('a', async () => 'a');
    await cache.resolve('b', async () => 'b');
    // Touching 'a' makes 'b' the oldest.
    expect(cache.peek('a')).toBe('a');
    await cache.resolve('c', async () => 'c');

    expect(cache.peek('b')).toBeNull();
    expect(cache.peek('a')).toBe('a');
    expect(cache.size).toBe(2);
  });
});

describe('Semaphore', () => {
  it('runs no more than the limit at once', async () => {
    const semaphore = new Semaphore({ limit: 2 });
    let peak = 0;
    let running = 0;

    const task = async (): Promise<void> => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running -= 1;
    };

    await Promise.all(Array.from({ length: 6 }, () => semaphore.run(task)));
    expect(peak).toBe(2);
  });

  it('refuses once the queue is full rather than accepting work it cannot start', async () => {
    const semaphore = new Semaphore({ limit: 1, maxQueued: 1 });
    const held: (() => void)[] = [];
    const block = () => new Promise<void>((resolve) => held.push(resolve));

    const running = semaphore.run(block);
    const queued = semaphore.run(block);
    await expect(semaphore.run(block)).rejects.toBeInstanceOf(BusyError);

    for (const release of held.splice(0)) release();
    await running;
    // The queued task starts once the first releases; drain it so the test does
    // not leave a promise pending.
    setTimeout(() => {
      for (const release of held.splice(0)) release();
    }, 0);
    await queued;
  });

  it('releases its slot when the work throws', async () => {
    const semaphore = new Semaphore({ limit: 1 });
    await expect(semaphore.run(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(semaphore.active).toBe(0);
    expect(await semaphore.run(async () => 'ok')).toBe('ok');
  });
});
