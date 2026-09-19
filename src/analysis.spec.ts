/*
 * Deterministic tests backing ANALYSIS.md.
 * All timing is manual: fake clock + manually controlled deferreds.
 * No sleeps, no reads of the internal pending-values map.
 */
import {
  cachified,
  createBatch,
  Cache,
  CacheEntry,
  CreateReporter,
} from './index';

jest.mock('./index', () => {
  if (process.version.startsWith('v20')) {
    return jest.requireActual('./index');
  } else {
    return require('../dist/index.cjs');
  }
});

type EventName = string;

function eventCollector(): {
  events: EventName[];
  payloads: Record<string, unknown>[];
  reporter: CreateReporter<unknown>;
} {
  const events: EventName[] = [];
  const payloads: Record<string, unknown>[] = [];
  const reporter: CreateReporter<unknown> = () => (event: any) => {
    events.push(event.name);
    const { name, ...payload } = event;
    payloads.push(payload);
  };
  return { events, payloads, reporter };
}

function createAdapter(): {
  cache: Cache;
  ops: string[];
  seed: (key: string, entry: CacheEntry) => void;
  peek: (key: string) => CacheEntry | undefined;
  deleteShouldFail: (error: unknown) => void;
} {
  const store = new Map<string, CacheEntry>();
  const ops: string[] = [];
  let deleteFailure: unknown = undefined;
  const cache: Cache = {
    name: 'memory',
    get(key) {
      ops.push(`get:${key}`);
      return Promise.resolve(store.get(key));
    },
    set(key, entry) {
      ops.push(`set:${key}`);
      store.set(key, entry);
    },
    delete(key) {
      ops.push(`delete:${key}`);
      if (deleteFailure !== undefined) {
        const error = deleteFailure;
        deleteFailure = undefined;
        return Promise.reject(error);
      }
      store.delete(key);
    },
  };
  return {
    cache,
    ops,
    seed(key, entry) {
      store.set(key, entry);
    },
    peek(key) {
      return store.get(key);
    },
    deleteShouldFail(error: unknown) {
      deleteFailure = error;
    },
  };
}

class Deferred<T> {
  resolve!: (value: T) => void;
  reject!: (reason: unknown) => void;
  promise: Promise<T> = new Promise<T>((res, rej) => {
    this.resolve = res;
    this.reject = rej;
  });
}

async function flushMicrotasks(times = 8) {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
  }
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(0);
});

describe('ANALYSIS: stale-while-revalidate determinism', () => {
  it('returns the stale value first and starts the background refresh exactly once', async () => {
    const adapter = createAdapter();
    const { cache } = adapter;
    const a = eventCollector();
    const b = eventCollector();
    const backgrounds: Promise<unknown>[] = [];
    const contexts: { background: boolean }[] = [];

    // Warm up the cache at t=0: ttl 10, stale window 50
    await cachified(
      {
        cache,
        key: 'k',
        ttl: 10,
        swr: 50,
        waitUntil: (p) => backgrounds.push(p),
        getFreshValue: (ctx) => {
          contexts.push({ background: ctx.background });
          return 'v1';
        },
      },
      a.reporter,
    );

    // Two concurrent calls inside the stale window.
    jest.setSystemTime(15);
    const p1 = cachified(
      {
        cache,
        key: 'k',
        ttl: 10,
        swr: 50,
        waitUntil: (p) => backgrounds.push(p),
        getFreshValue: (ctx) => {
          contexts.push({ background: ctx.background });
          return 'v2';
        },
      },
      a.reporter,
    );
    const p2 = cachified(
      {
        cache,
        key: 'k',
        ttl: 10,
        swr: 50,
        waitUntil: (p) => backgrounds.push(p),
        getFreshValue: (ctx) => {
          contexts.push({ background: ctx.background });
          return 'v2';
        },
      },
      b.reporter,
    );

    // Stale values settle WITHOUT flushing any timer: the refresh loader
    // has not run yet (it is parked behind a zero-length timer).
    const results = await Promise.all([p1, p2]);
    expect(results).toEqual(['v1', 'v1']);
    expect(contexts).toEqual([{ background: false }]);
    expect(a.events.slice(-4)).toEqual([
      'getCachedValueStart',
      'getCachedValueRead',
      'getCachedValueSuccess',
      'done',
    ]);
    expect(b.events).toEqual([
      'getCachedValueStart',
      'getCachedValueRead',
      'getCachedValueSuccess',
      'done',
    ]);

    // Release the parked refresh: exactly one loader start (one background
    // refresh is shared through the internal force-fresh pending entry).
    await jest.advanceTimersByTimeAsync(0);
    expect(contexts).toEqual([
      { background: false },
      { background: true },
    ]);

    // Both background chains settle with the one shared refresh result.
    await Promise.all(backgrounds);
    expect(adapter.peek('k')?.value).toBe('v2');
    expect(
      a.events.filter((name) => name === 'refreshValueStart'),
    ).toHaveLength(1);
    expect(
      b.events.filter((name) => name === 'refreshValueStart'),
    ).toHaveLength(0);
    expect(
      [
        ...a.events,
        ...b.events,
      ].filter((name) => name === 'refreshValueSuccess'),
    ).toHaveLength(2);
    expect(a.events).toContain('refreshValueSuccess');
    expect(b.events).toContain('refreshValueSuccess');
    // Only one background loader invocation ever happened.
    expect(
      contexts.filter((ctx) => ctx.background),
    ).toHaveLength(1);
  });
});

describe('ANALYSIS: concurrent miss determinism', () => {
  it('shares one pending foreground load and reports getFreshValueHookPending once', async () => {
    const adapter = createAdapter();
    const { cache } = adapter;
    const a = eventCollector();
    const b = eventCollector();
    const d = new Deferred<string>();
    let loaderCalls = 0;
    const loader = () => {
      loaderCalls++;
      return d.promise;
    };

    const p1 = cachified(
      { cache, key: 'k', getFreshValue: loader },
      a.reporter,
    );
    await flushMicrotasks();
    expect(loaderCalls).toBe(1);

    const p2 = cachified(
      { cache, key: 'k', getFreshValue: loader },
      b.reporter,
    );
    await flushMicrotasks();
    expect(loaderCalls).toBe(1);

    d.resolve('V');
    await expect(Promise.all([p1, p2])).resolves.toEqual(['V', 'V']);

    expect(a.events).toEqual([
      'getCachedValueStart',
      'getCachedValueRead',
      'getCachedValueEmpty',
      'getFreshValueStart',
      'getFreshValueSuccess',
      'writeFreshValueSuccess',
      'done',
    ]);
    expect(b.events).toEqual([
      'getCachedValueStart',
      'getCachedValueRead',
      'getCachedValueEmpty',
      'getFreshValueHookPending',
      'done',
    ]);
    expect(loaderCalls).toBe(1);
    expect(adapter.peek('k')?.value).toBe('V');
  });
});

describe('ANALYSIS: risk points', () => {
  it('R1 stale refresh failure is reporter-only; stale entry survives', async () => {
    const adapter = createAdapter();
    const { cache } = adapter;
    const c = eventCollector();
    const backgrounds: Promise<unknown>[] = [];
    const failure = new Error('boom-refresh');
    const refresh = new Deferred<string>();
    let loaderCalls = 0;

    adapter.seed('k', {
      metadata: { createdTime: 0, ttl: 10, swr: 50 },
      value: 'v1',
    });
    jest.setSystemTime(15);

    const call = cachified(
      {
        cache,
        key: 'k',
        ttl: 10,
        swr: 50,
        waitUntil: (p) => backgrounds.push(p),
        getFreshValue: () => {
          loaderCalls++;
          return refresh.promise;
        },
      },
      c.reporter,
    );

    await expect(call).resolves.toBe('v1');
    expect(loaderCalls).toBe(0);

    await jest.advanceTimersByTimeAsync(0);
    expect(loaderCalls).toBe(1);
    expect(c.events).not.toContain('refreshValueError');

    refresh.reject(failure);
    await Promise.all(backgrounds);

    expect(c.events).toEqual([
      'getCachedValueStart',
      'getCachedValueRead',
      'getCachedValueSuccess',
      'done',
      'refreshValueStart',
      'refreshValueError',
    ]);
    // The stale entry is never deleted; the caller already has its value.
    expect(adapter.peek('k')?.value).toBe('v1');
  });

  it('R2 expired miss with rejecting loader propagates and leaves the expired entry', async () => {
    const adapter = createAdapter();
    const { cache, ops } = adapter;
    const c = eventCollector();
    const failure = new Error('boom-loader');

    adapter.seed('k', {
      metadata: { createdTime: 0, ttl: 10, swr: 5 },
      value: 'old',
    });
    jest.setSystemTime(100);

    await expect(
      cachified(
        {
          cache,
          key: 'k',
          ttl: 10,
          swr: 5,
          getFreshValue: () => Promise.reject(failure),
        },
        c.reporter,
      ),
    ).rejects.toBe(failure);

    expect(c.events).toEqual([
      'getCachedValueStart',
      'getCachedValueRead',
      'getCachedValueOutdated',
      'getFreshValueStart',
      'getFreshValueError',
    ]);
    // No delete: a fully expired-but-present entry is not removed on loader failure.
    expect(ops).toEqual(['get:k']);
    expect(adapter.peek('k')?.value).toBe('old');
  });

  it('R3 invalid cached entry aborts when cache.delete rejects, shadowing the loader path', async () => {
    const adapter = createAdapter();
    const { cache } = adapter;
    const c = eventCollector();
    const deleteError = new Error('boom-delete');
    let loaderCalls = 0;

    adapter.seed('k', 'not-an-entry' as unknown as CacheEntry);
    adapter.deleteShouldFail(deleteError);

    await expect(
      cachified(
        {
          cache,
          key: 'k',
          getFreshValue: () => {
            loaderCalls++;
            return 'v';
          },
        },
        c.reporter,
      ),
    ).rejects.toBe(deleteError);

    expect(loaderCalls).toBe(0);
    expect(c.events).toEqual([
      'getCachedValueStart',
      'getCachedValueRead',
      'getCachedValueError',
    ]);
  });

  it('R4 expired pending loads are not shared and the late call resolves the earlier one', async () => {
    const adapter = createAdapter();
    const { cache } = adapter;
    const c1 = eventCollector();
    const c2 = eventCollector();
    const d1 = new Deferred<string>();
    const d2 = new Deferred<string>();
    const loaderLog: string[] = [];

    // First call starts at t=0 with ttl 100 and stalls.
    const p1 = cachified(
      {
        cache,
        key: 'k',
        ttl: 100,
        getFreshValue: () => {
          loaderLog.push('loader-1');
          return d1.promise;
        },
      },
      c1.reporter,
    );
    await flushMicrotasks();
    expect(loaderLog).toEqual(['loader-1']);

    // Time advances beyond ttl while loader-1 is still in flight.
    jest.setSystemTime(200);

    const p2 = cachified(
      {
        cache,
        key: 'k',
        ttl: 100,
        getFreshValue: () => {
          loaderLog.push('loader-2');
          return d2.promise;
        },
      },
      c2.reporter,
    );
    await flushMicrotasks();
    expect(loaderLog).toEqual(['loader-1', 'loader-2']);

    d2.resolve('B');
    await expect(p2).resolves.toBe('B');

    d1.resolve('A');
    await expect(p1).resolves.toBe('B');

    // Both loaders ran; the cache holds B; A was never written.
    expect(loaderLog).toEqual(['loader-1', 'loader-2']);
    expect(adapter.peek('k')?.value).toBe('B');
    expect(c2.events).toEqual([
      'getCachedValueStart',
      'getCachedValueRead',
      'getCachedValueEmpty',
      'getFreshValueStart',
      'getFreshValueSuccess',
      'writeFreshValueSuccess',
      'done',
    ]);
    const c2Written = c2.payloads[c2.events.indexOf('writeFreshValueSuccess')];
    expect(c2Written).toMatchObject({ written: true });
    // Caller 1 returned before loader-1's side effects finished.
    const c1Write = c1.payloads[c1.events.indexOf('writeFreshValueSuccess')];
    expect(c1Write).toMatchObject({ written: false });
    expect(c1.events).toContain('done');
    // But its reporter saw its own loader produce 'A' while the caller got 'B'.
    const c1Success = c1.payloads[c1.events.indexOf('getFreshValueSuccess')];
    expect(c1Success).toMatchObject({ value: 'A' });
  });

  it('R5 batch partial failure isolates a rejected item; a loader reject rejects all', async () => {
    const cache = new Map<string, CacheEntry>();
    const batch = createBatch<string, number>((ids) =>
      ids.map((id) => (id === 2 ? ('bad' as string) : `v${id}`)),
    );
    const reporters = new Map<string, ReturnType<typeof eventCollector>>();
    const call = (id: number) => {
      const c = eventCollector();
      reporters.set(`k${id}`, c);
      return cachified(
        {
          cache,
          key: `k${id}`,
          getFreshValue: batch.add(id),
          checkValue: (value) =>
            value === 'bad' ? 'bad-value-reason' : true,
        },
        c.reporter,
      );
    };

    const results = await Promise.allSettled([call(1), call(2), call(3)]);
    expect(results.map((r) => r.status)).toEqual([
      'fulfilled',
      'rejected',
      'fulfilled',
    ]);
    expect((results[0] as PromiseFulfilledResult<string>).value).toBe('v1');
    expect((results[2] as PromiseFulfilledResult<string>).value).toBe('v3');
    expect(
      ((results[1] as PromiseRejectedResult).reason as Error).message,
    ).toBe('check failed for fresh value of k2');

    expect(cache.get('k1')?.value).toBe('v1');
    expect(cache.get('k2')).toBeUndefined();
    expect(cache.get('k3')?.value).toBe('v3');

    const k2 = reporters.get('k2')!;
    expect(k2.events).toEqual([
      'getCachedValueStart',
      'getCachedValueRead',
      'getCachedValueEmpty',
      'getFreshValueStart',
      'getFreshValueSuccess',
      'checkFreshValueErrorObj',
      'checkFreshValueError',
    ]);
    const k1 = reporters.get('k1')!;
    expect(k1.events).toEqual([
      'getCachedValueStart',
      'getCachedValueRead',
      'getCachedValueEmpty',
      'getFreshValueStart',
      'getFreshValueSuccess',
      'writeFreshValueSuccess',
      'done',
    ]);

    // A batch loader that rejects rejects every request with the same error.
    const cache2 = new Map<string, CacheEntry>();
    const failure = new Error('batch-down');
    const badBatch = createBatch<string, number>(() => {
      throw failure;
    });
    const all = [1, 2, 3].map((id) =>
      cachified({
        cache: cache2,
        key: `b${id}`,
        getFreshValue: badBatch.add(id),
      }),
    );
    const settled = await Promise.allSettled(all);
    expect(settled.every((r) => r.status === 'rejected')).toBe(true);
    expect(
      settled.every(
        (r) => (r as PromiseRejectedResult).reason === failure,
      ),
    ).toBe(true);
  });
});
