import {
  cachified,
  createBatch,
  softPurge,
  createCacheEntry,
  CacheEntry,
  Cache,
} from './index';
import { Deferred } from './createBatch';

jest.mock('./index', () => {
  if (process.version.startsWith('v20')) {
    return jest.requireActual('./index');
  } else {
    return require('../dist/index.cjs');
  }
});

let currentTime = 0;
beforeEach(() => {
  currentTime = 0;
  jest.spyOn(Date, 'now').mockImplementation(() => currentTime);
});

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Minimal instrumented in-memory adapter (same shape as the adapter shown
 * in ANALYSIS.md). Every adapter interaction is appended to `ops` so tests
 * can assert the get/set/delete ordering without touching private maps.
 */
function createAdapter(
  store: Map<string, CacheEntry>,
  opts: { failSet?: boolean; failDelete?: boolean } = {},
) {
  const ops: string[] = [];
  const cache: Cache = {
    name: 'analysis-adapter',
    async get(key: string) {
      ops.push('get');
      return store.get(key);
    },
    async set(key: string, entry: CacheEntry) {
      ops.push(`set:${String(entry.value)}`);
      if (opts.failSet) throw new Error('set boom');
      store.set(key, entry);
    },
    async delete(key: string) {
      ops.push('delete');
      if (opts.failDelete) throw new Error('delete boom');
      store.delete(key);
    },
  };
  return { cache, ops };
}

type RecEvent = { name: string; error?: unknown };

/** Reporter factory that also exposes the recorded events. */
function createEventRecorder() {
  const events: RecEvent[] = [];
  const creator = () => (event: RecEvent) => {
    events.push(event);
  };
  creator.events = events;
  return creator;
}

const eventNames = (events: RecEvent[]) =>
  events.map((event) =>
    event.error
      ? `${event.name}(${
          event.error instanceof Error ? event.error.message : String(event.error)
        })`
      : event.name,
  );

describe('ANALYSIS.md timelines', () => {
  it('fresh hit: reads cache, validates, returns without loader or set', async () => {
    const store = new Map<string, CacheEntry>([
      ['k', createCacheEntry('A')],
    ]);
    const { cache, ops } = createAdapter(store);
    const reporter = createEventRecorder();
    const getFreshValue = jest.fn();

    const value = await cachified(
      { cache, key: 'k', getFreshValue },
      reporter,
    );

    expect(value).toBe('A');
    expect(getFreshValue).not.toHaveBeenCalled();
    expect(ops).toEqual(['get']);
    expect(eventNames(reporter.events)).toEqual([
      'getCachedValueStart',
      'getCachedValueRead',
      'getCachedValueSuccess',
      'done',
    ]);
  });

  it('expired miss: loader rejection propagates, expired entry is not deleted', async () => {
    const store = new Map<string, CacheEntry>([
      ['k', createCacheEntry('OLD', { ttl: 5, swr: 5 })],
    ]);
    const { cache, ops } = createAdapter(store);
    const reporter = createEventRecorder();

    currentTime = 100;
    const call = cachified(
      {
        cache,
        key: 'k',
        ttl: 5,
        swr: 5,
        getFreshValue: () => {
          throw new Error('loader boom');
        },
      },
      reporter,
    );

    await expect(call).rejects.toThrow('loader boom');
    expect(ops).toEqual(['get']);
    expect(store.get('k')?.value).toBe('OLD');
    expect(eventNames(reporter.events)).toEqual([
      'getCachedValueStart',
      'getCachedValueRead',
      'getCachedValueOutdated',
      'getFreshValueStart',
      'getFreshValueError(loader boom)',
    ]);
  });

  it('invalid cached schema: deletes entry and loads fresh value', async () => {
    const store = new Map<string, CacheEntry>([
      ['k', createCacheEntry('BAD')],
    ]);
    const { cache, ops } = createAdapter(store);
    const reporter = createEventRecorder();
    const badSchema = {
      '~standard': {
        version: 1 as const,
        vendor: 'test',
        validate: (value: unknown) =>
          value === 'GOOD'
            ? { value }
            : { issues: [{ message: 'nope' }] },
      },
    };

    const value = await cachified(
      {
        cache,
        key: 'k',
        checkValue: badSchema as any,
        getFreshValue: () => 'GOOD',
      },
      reporter,
    );

    expect(value).toBe('GOOD');
    expect(ops).toEqual(['get', 'delete', 'set:GOOD']);
    expect(eventNames(reporter.events)).toEqual([
      'getCachedValueStart',
      'getCachedValueRead',
      'checkCachedValueErrorObj',
      'checkCachedValueError',
      'getFreshValueStart',
      'getFreshValueSuccess',
      'writeFreshValueSuccess',
      'done',
    ]);
  });

  it('loader reject on empty cache propagates the loader error', async () => {
    const store = new Map<string, CacheEntry>();
    const { cache, ops } = createAdapter(store);
    const reporter = createEventRecorder();

    const call = cachified(
      {
        cache,
        key: 'k',
        getFreshValue: () => {
          throw new Error('down');
        },
      },
      reporter,
    );

    await expect(call).rejects.toThrow('down');
    expect(ops).toEqual(['get']);
    expect(eventNames(reporter.events)).toEqual([
      'getCachedValueStart',
      'getCachedValueRead',
      'getCachedValueEmpty',
      'getFreshValueStart',
      'getFreshValueError(down)',
    ]);
  });

  it('softPurge: rewrites a live entry with ttl 0 and remaining lifetime as swr', async () => {
    const store = new Map<string, CacheEntry>([
      ['k', createCacheEntry('V', { createdTime: 0, ttl: 1000, swr: 50 })],
    ]);
    const { cache, ops } = createAdapter(store);

    currentTime = 20;
    await softPurge({ cache, key: 'k' });

    expect(ops).toEqual(['get', 'set:V']);
    expect(store.get('k')).toEqual(
      createCacheEntry('V', { createdTime: 0, ttl: 0, swr: 1050 }),
    );

    // The purged entry is now stale: next read returns it and triggers a
    // single background refresh whose failure stays with the reporter.
    const reporter = createEventRecorder();
    const background: Promise<unknown>[] = [];
    const call = cachified(
      {
        cache,
        key: 'k',
        ttl: 1000,
        swr: 1050,
        waitUntil: (p) => background.push(p),
        getFreshValue: () => {
          throw new Error('refresh down');
        },
      },
      reporter,
    );

    expect(await call).toBe('V');
    await Promise.all(background);
    expect(eventNames(reporter.events)).toEqual([
      'getCachedValueStart',
      'getCachedValueRead',
      'getCachedValueSuccess',
      'done',
      'refreshValueStart',
      'refreshValueError(refresh down)',
    ]);
  });

  it('batch partial failure: cached keys resolve while uncached keys all reject', async () => {
    const store = new Map<string, CacheEntry>([
      ['a', createCacheEntry('cached-a')],
    ]);
    const { cache, ops } = createAdapter(store);

    const batch = createBatch<string, string>((keys: string[]) => {
      if (keys.includes('boom')) throw new Error('batch boom');
      return keys;
    });

    const recA = createEventRecorder();
    const recB = createEventRecorder();
    const recC = createEventRecorder();
    const calls = [
      cachified({ cache, key: 'a', getFreshValue: batch.add('a') }, recA),
      cachified({ cache, key: 'b', getFreshValue: batch.add('b') }, recB),
      cachified(
        { cache, key: 'boom', getFreshValue: batch.add('boom') },
        recC,
      ),
    ];

    const results = await Promise.allSettled(calls);
    expect(results.map((r) => (r.status === 'fulfilled' ? r.value : r.reason.message))).toEqual([
      'cached-a',
      'batch boom',
      'batch boom',
    ]);
    expect(ops).toEqual(['get', 'get', 'get']);
    expect(eventNames(recA.events)).toEqual([
      'getCachedValueStart',
      'getCachedValueRead',
      'getCachedValueSuccess',
      'done',
    ]);
    for (const rec of [recB, recC]) {
      expect(eventNames(rec.events)).toEqual([
        'getCachedValueStart',
        'getCachedValueRead',
        'getCachedValueEmpty',
        'getFreshValueStart',
        'getFreshValueError(batch boom)',
      ]);
    }
  });
});

describe('ANALYSIS.md risk points', () => {
  it('R1: stale value is returned while background refresh errors only reach the reporter', async () => {
    // Fake clock: ttl 10, swr 50, entry created at 0, read at 15.
    const store = new Map<string, CacheEntry>([
      ['k', createCacheEntry('S', { createdTime: 0, ttl: 10, swr: 50 })],
    ]);
    const { cache, ops } = createAdapter(store);
    const reporter = createEventRecorder();
    const background: Promise<unknown>[] = [];

    currentTime = 15;
    const call = cachified(
      {
        cache,
        key: 'k',
        ttl: 10,
        swr: 50,
        waitUntil: (p) => background.push(p),
        getFreshValue: () => {
          throw new Error('refresh boom');
        },
      },
      reporter,
    );

    // The promise settles with the stale value before the refresh is attempted.
    expect(await call).toBe('S');
    // Only after the caller settled does the background task report the error.
    await Promise.all(background);
    expect(store.get('k')?.value).toBe('S');
    expect(ops).toEqual(['get']);
    expect(eventNames(reporter.events)).toEqual([
      'getCachedValueStart',
      'getCachedValueRead',
      'getCachedValueSuccess',
      'done',
      'refreshValueStart',
      'refreshValueError(refresh boom)',
    ]);
  });

  it('R2: expired entry stays in the adapter when the loader rejects', async () => {
    // Fake clock: ttl 5, swr 5, entry created at 0, read at 100.
    const store = new Map<string, CacheEntry>([
      ['k', createCacheEntry('OLD', { createdTime: 0, ttl: 5, swr: 5 })],
    ]);
    const { cache, ops } = createAdapter(store);
    const reporter = createEventRecorder();

    currentTime = 100;
    const call = cachified(
      {
        cache,
        key: 'k',
        ttl: 5,
        swr: 5,
        getFreshValue: () => {
          throw new Error('loader boom');
        },
      },
      reporter,
    );

    await expect(call).rejects.toThrow('loader boom');
    // A fully expired entry is never deleted, so the stale value survives.
    expect(store.get('k')?.value).toBe('OLD');
    expect(ops).toEqual(['get']);
    expect(eventNames(reporter.events)).toEqual([
      'getCachedValueStart',
      'getCachedValueRead',
      'getCachedValueOutdated',
      'getFreshValueStart',
      'getFreshValueError(loader boom)',
    ]);
  });

  it('R3: a fresh value failing checkValue rejects with a wrapping error and is not cached', async () => {
    const store = new Map<string, CacheEntry>();
    const { cache, ops } = createAdapter(store);
    const reporter = createEventRecorder();

    const call = cachified(
      {
        cache,
        key: 'k',
        checkValue: () => 'not what we want',
        getFreshValue: () => 'X',
      },
      reporter,
    );

    await expect(call).rejects.toThrow('check failed for fresh value of k');
    expect(store.size).toBe(0);
    expect(ops).toEqual(['get']);
    expect(eventNames(reporter.events)).toEqual([
      'getCachedValueStart',
      'getCachedValueRead',
      'getCachedValueEmpty',
      'getFreshValueStart',
      'getFreshValueSuccess',
      'checkFreshValueErrorObj',
      'checkFreshValueError',
    ]);
  });

  it('R4: cache.set errors are swallowed and only emitted as writeFreshValueError', async () => {
    const store = new Map<string, CacheEntry>();
    const { cache, ops } = createAdapter(store, { failSet: true });
    const reporter = createEventRecorder();

    const value = await cachified(
      { cache, key: 'k', ttl: 5, getFreshValue: () => 'V' },
      reporter,
    );

    expect(value).toBe('V');
    expect(store.size).toBe(0);
    expect(ops).toEqual(['get', 'set:V']);
    expect(eventNames(reporter.events)).toEqual([
      'getCachedValueStart',
      'getCachedValueRead',
      'getCachedValueEmpty',
      'getFreshValueStart',
      'getFreshValueSuccess',
      'writeFreshValueError(set boom)',
      'done',
    ]);
  });

  it('R5: a failing delete after invalid cached value turns into getCachedValueError and skips the loader', async () => {
    const store = new Map<string, CacheEntry>([
      ['k', createCacheEntry('BAD')],
    ]);
    const { cache, ops } = createAdapter(store, { failDelete: true });
    const reporter = createEventRecorder();
    const getFreshValue = jest.fn(() => 'V');

    const call = cachified(
      { cache, key: 'k', checkValue: () => false, getFreshValue },
      reporter,
    );

    await expect(call).rejects.toThrow('delete boom');
    expect(getFreshValue).not.toHaveBeenCalled();
    expect(store.get('k')?.value).toBe('BAD');
    expect(ops).toEqual(['get', 'delete', 'delete']);
    expect(eventNames(reporter.events)).toEqual([
      'getCachedValueStart',
      'getCachedValueRead',
      'checkCachedValueErrorObj',
      'checkCachedValueError',
      'getCachedValueError(delete boom)',
    ]);
  });
});

describe('ANALYSIS.md deterministic refresh de-duplication', () => {
  it('returns the stale value first and starts the background refresh exactly once', async () => {
    // Fake clock, fully controlled. No sleep() anywhere in this test and the
    // pending-values WeakMap is never read.
    jest.useFakeTimers({ doNotFake: ['Date'] });

    const store = new Map<string, CacheEntry>([
      ['k', createCacheEntry('S', { createdTime: 0, ttl: 10, swr: 50 })],
    ]);
    const { cache, ops } = createAdapter(store);
    const reporter = createEventRecorder();
    const background: Promise<unknown>[] = [];

    // The loader is a manually controlled promise: the test decides when the
    // refresh settles, instead of waiting for real time to pass.
    const refresh = new Deferred<string>();
    const getFreshValue = jest.fn(() => refresh.promise);

    const callCachified = () =>
      cachified(
        {
          cache,
          key: 'k',
          ttl: 10,
          swr: 50,
          getFreshValue,
          waitUntil: (p) => background.push(p),
        },
        reporter,
      );

    currentTime = 15; // 10 < now <= 60: the entry is in the stale window
    const first = callCachified();
    const second = callCachified();

    // Flush microtasks (the adapter get is async) without advancing any timer.
    await Promise.resolve();
    await Promise.resolve();

    // Both callers have already settled with the stale value, and because the
    // refresh sleeps for staleRefreshTimeout (0ms timer) the loader itself has
    // not been invoked yet.
    await expect(Promise.all([first, second])).resolves.toEqual(['S', 'S']);
    expect(getFreshValue).not.toHaveBeenCalled();

    // Advance exactly the 0ms staleRefreshTimeout timer. The background
    // refresh is de-duplicated: the loader is started once for both callers.
    await jest.advanceTimersByTimeAsync(0);
    expect(getFreshValue).toHaveBeenCalledTimes(1);
    expect(getFreshValue).toHaveBeenCalledWith(
      expect.objectContaining({ background: true }),
    );
    expect(background).toHaveLength(2);

    // Reporter ordering proves the stale responses were delivered before the
    // single background refresh even started.
    expect(eventNames(reporter.events)).toEqual([
      'getCachedValueStart',
      'getCachedValueStart',
      'getCachedValueRead',
      'getCachedValueRead',
      'getCachedValueSuccess',
      'getCachedValueSuccess',
      'done',
      'done',
      'refreshValueStart',
    ]);

    // Manually settle the shared refresh promise; both waitUntil tasks finish.
    refresh.resolve('N');
    await Promise.all(background);

    expect(store.get('k')?.value).toBe('N');
    expect(ops).toEqual(['get', 'get', 'set:N']);
    expect(getFreshValue).toHaveBeenCalledTimes(1);
    expect(eventNames(reporter.events)).toEqual([
      'getCachedValueStart',
      'getCachedValueStart',
      'getCachedValueRead',
      'getCachedValueRead',
      'getCachedValueSuccess',
      'getCachedValueSuccess',
      'done',
      'done',
      'refreshValueStart',
      'refreshValueSuccess',
      'refreshValueSuccess',
    ]);

    jest.useRealTimers();
  });
});
