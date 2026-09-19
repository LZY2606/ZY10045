// Minimal reproduction for ANALYSIS.md. Run from the repo root:
//   node analysis-reproduce.mjs
// Requires a build first (npm ci runs the "prepare" build script automatically).
import { cachified, createCacheEntry } from './dist/index.mjs';

let now = 0;
const RealDate = Date;
globalThis.Date = class extends RealDate {
  static now() {
    return now;
  }
};

const store = new Map();
const ops = [];
const cache = {
  name: 'demo',
  async get(key) {
    ops.push(`get ${key}`);
    return store.get(key);
  },
  async set(key, entry) {
    ops.push(`set ${key}=${entry.value}`);
    store.set(key, entry);
  },
  async delete(key) {
    ops.push(`delete ${key}`);
    store.delete(key);
  },
};

const events = [];
const reporter = () => (event) => events.push(event.name);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let loaderCount = 0;
function makeOptions(waitUntil = () => {}) {
  return {
    cache,
    key: 'k',
    ttl: 10,
    swr: 50,
    waitUntil,
    getFreshValue: ({ background }) => {
      const value = `v${loaderCount++}`;
      console.log(`  -> loader runs (background=${background}), returns ${value}`);
      return value;
    },
  };
}

// 1) expired miss: adapter get, loader, adapter set
events.length = 0;
const first = await cachified(makeOptions(), reporter);
console.log('miss settles with:', first);
console.log('adapter ops:', ops);
console.log('events:', events);

// 2) two concurrent stale hits (10 < now <= 60): both return v0 immediately,
//    one shared background refresh is queued
events.length = 0;
ops.length = 0;
now = 15;
const background = [];
const waitUntil = (p) => background.push(p);
const [a, b] = await Promise.all([
  cachified(makeOptions(waitUntil), reporter),
  cachified(makeOptions(waitUntil), reporter),
]);
console.log('\nstale calls settle with:', a, b);
console.log('events before refresh starts:', events);

// let the 0ms staleRefreshTimeout timer fire, then await the background work
await sleep(20);
await Promise.all(background);
console.log('adapter ops:', ops);
console.log('events after background refresh:', events);
console.log('cache now holds:', store.get('k')?.value);

// 3) refresh failure never reaches the caller: still stale, error is only reported
events.length = 0;
ops.length = 0;
now = 30; // v1 was created at 15 with ttl 10 + swr 50, so 30 is stale
const failedBackground = [];
const value = await cachified(
  {
    ...makeOptions((p) => failedBackground.push(p)),
    getFreshValue: () => {
      throw new Error('boom');
    },
  },
  reporter,
);
await sleep(20);
await Promise.all(failedBackground);
console.log('\nstale call after failed refresh settles with:', value);
console.log('adapter ops:', ops);
console.log('events:', events);
