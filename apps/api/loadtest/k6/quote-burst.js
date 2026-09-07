// Quote burst — simulates a "pump": a small set of hot tokens suddenly
// getting hammered with quote requests as a crowd piles in, some refreshing
// the 8s quote bar repeatedly (cache hits), others sizing up different
// amounts (cache misses against `@stonkz/curve-sim`).
//
//   k6 run loadtest/k6/quote-burst.js
//   PUMP_RATE=80 k6 run loadtest/k6/quote-burst.js   # requests/sec at peak
//
// `GET /tokens/:sym/quote` is rate-limited per identity at 120/min
// (`RATE_LIMITS.quote`, `src/redis/ratelimit.ts`) — each VU gets its own
// synthetic `X-Forwarded-For` (see lib/config.js) so this measures the API's
// actual quote-serving capacity, not the anti-spam ceiling a single browser
// tab would hit.
import http from 'k6/http';
import { check, sleep } from 'k6';
import { BASE_URL, NET, netManifest, jsonHeaders } from './lib/config.js';

const board = netManifest(NET);
const HOT = board.hotSymbols.length > 0 ? board.hotSymbols : board.tradeableSymbols.slice(0, 5);
if (HOT.length === 0) throw new Error('quote-burst needs at least one native-paired token; run loadtest/seed.ts first');

const AMOUNTS = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5];

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

export const options = {
  scenarios: {
    steady: {
      executor: 'constant-arrival-rate',
      exec: 'quote',
      rate: Number(__ENV.STEADY_RATE || 15),
      timeUnit: '1s',
      duration: '30s',
      preAllocatedVUs: 30,
      maxVUs: 200,
      startTime: '0s',
    },
    pump: {
      executor: 'ramping-arrival-rate',
      exec: 'quote',
      startRate: Number(__ENV.STEADY_RATE || 15),
      timeUnit: '1s',
      preAllocatedVUs: 50,
      maxVUs: 400,
      stages: [
        { duration: '10s', target: Number(__ENV.STEADY_RATE || 15) },
        // The pump: everyone piles into the same handful of hot tokens at once.
        { duration: '20s', target: Number(__ENV.PUMP_RATE || 120) },
        { duration: '30s', target: Number(__ENV.PUMP_RATE || 120) },
        { duration: '15s', target: Number(__ENV.STEADY_RATE || 15) },
      ],
      startTime: '30s',
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<300', 'p(99)<700'],
    'http_req_duration{cache:hit-likely}': ['p(95)<150'],
    http_req_failed: ['rate<0.02'],
  },
};

export function quote() {
  const sym = pick(HOT);
  const side = Math.random() < 0.75 ? 'buy' : 'sell';
  const amount = pick(AMOUNTS);
  const headers = jsonHeaders(__VU);
  // Repeating the same (sym, side, amount) key inside the 8s TTL is a cache
  // hit (`redis/quote-cache.ts`); varying it is a cache miss that recomputes
  // the curve. Tag both so the results can be split.
  const cacheLikely = Math.random() < 0.4;
  const res = http.get(`${BASE_URL}/tokens/${sym}/quote?net=${NET}&side=${side}&amount=${cacheLikely ? AMOUNTS[0] : amount}`, {
    headers,
    tags: { name: 'GET /tokens/:sym/quote', cache: cacheLikely ? 'hit-likely' : 'miss-likely' },
  });
  check(res, { 'quote 200': (r) => r.status === 200, 'quote has hops': (r) => !!r.json('hops') || r.status !== 200 });
  sleep(Math.random() * 0.3);
}
