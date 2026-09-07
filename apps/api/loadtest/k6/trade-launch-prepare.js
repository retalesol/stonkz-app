// Write-path load test: POST /trade/prepare (buy/sell mix) and
// POST /launch/prepare.
//
//   k6 run loadtest/k6/trade-launch-prepare.js
//
// Both routes are behind `requireAuth()` — every VU carries a JWT for a
// distinct synthetic wallet from `loadtest/fixtures/auth.json` (minted by
// `loadtest/mint-tokens.ts`), so `RATE_LIMITS.trade` (60/min) is measured
// per-wallet the way it is in production, not tripped by every VU sharing one
// identity.
//
// `/launch/prepare` is deliberately rate-limited hard by design — 5 launches
// per wallet per hour (`LAUNCH_RATE_LIMIT_PER_WALLET`) and 30 per IP per hour
// (`RATE_LIMITS.launchIp`) — so `launch_prepare`'s target rate below is sized
// to stay under both with the wallet/IP pool this run has, not to find a
// ceiling; see docs/load-test-results.md for what that implies about
// "launch storm" traffic.
import http from 'k6/http';
import { check, sleep } from 'k6';
import { BASE_URL, NET, netManifest, netAuth, jsonHeaders } from './lib/config.js';

const board = netManifest(NET);
const identities = netAuth(NET);
if (identities.length === 0) {
  throw new Error('trade-launch-prepare needs loadtest/fixtures/auth.json; run loadtest/mint-tokens.ts first');
}
const TRADEABLE = board.tradeableSymbols;
if (TRADEABLE.length === 0) {
  throw new Error('no native-paired, non-graduated tokens to trade; run loadtest/seed.ts first');
}

const NATIVE_SYMBOL = NET === 'RH' ? 'ETH' : 'SOL';

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

/** One identity per VU, stable for the life of the VU (spreads the per-wallet rate limit evenly). */
function identityFor(vuId) {
  return identities[(Number(vuId) - 1) % identities.length];
}

export const options = {
  scenarios: {
    trade_prepare: {
      executor: 'ramping-arrival-rate',
      exec: 'tradePrepare',
      startRate: 5,
      timeUnit: '1s',
      preAllocatedVUs: 40,
      maxVUs: Math.min(200, identities.length),
      stages: [
        { duration: '20s', target: Number(__ENV.TRADE_RATE || 20) },
        { duration: __ENV.DURATION || '90s', target: Number(__ENV.TRADE_RATE || 20) },
        { duration: '10s', target: 0 },
      ],
    },
    launch_prepare: {
      executor: 'constant-arrival-rate',
      exec: 'launchPrepare',
      rate: Number(__ENV.LAUNCH_RATE || 2),
      timeUnit: '10s', // 2/10s = 12/min, well under the 30/hr-per-IP and 5/hr-per-wallet ceilings across a >2min run with a rotating identity pool
      duration: __ENV.DURATION || '90s',
      preAllocatedVUs: 10,
      maxVUs: Math.min(50, identities.length),
    },
  },
  thresholds: {
    'http_req_duration{name:POST /trade/prepare}': ['p(95)<600', 'p(99)<1200'],
    'http_req_failed{name:POST /trade/prepare}': ['rate<0.05'],
    'http_req_duration{name:POST /launch/prepare}': ['p(95)<800'],
  },
};

export function tradePrepare() {
  const identity = identityFor(__VU);
  const headers = jsonHeaders(__VU, { Authorization: `Bearer ${identity.token}` });
  const sym = pick(TRADEABLE);
  const side = Math.random() < 0.65 ? 'buy' : 'sell';
  const amount = side === 'buy' ? Number((0.02 + Math.random() * 0.8).toFixed(3)) : Number((50 + Math.random() * 5000).toFixed(0));

  const res = http.post(`${BASE_URL}/trade/prepare`, JSON.stringify({ sym, side, amount }), {
    headers,
    tags: { name: 'POST /trade/prepare' },
  });
  // 429 (rate-limited) and 422 (e.g. slippage/curve-capped on a heavily-sold
  // synthetic token) are expected outcomes under a deliberately bursty mix,
  // not failures of the endpoint — only a 5xx or a hung request is.
  check(res, { 'trade/prepare answered': (r) => r.status < 500 });
  sleep(0.2 + Math.random() * 0.5);
}

let launchSeq = 0;

export function launchPrepare() {
  launchSeq += 1;
  const identity = pick(identities);
  const headers = jsonHeaders(__VU, { Authorization: `Bearer ${identity.token}` });
  const ticker = `LK${Date.now().toString(36)}${launchSeq}${__VU}`.toUpperCase().slice(0, 10);

  const res = http.post(
    `${BASE_URL}/launch/prepare`,
    JSON.stringify({
      ticker,
      name: `Loadtest Launch ${ticker}`,
      descr: 'k6 write-path load test launch',
      supply: pick([1_000_000, 500_000_000, 1_000_000_000, 1_000_000_000_000]),
      feePct: Number((1 + Math.random() * 4).toFixed(1)),
      cashback: false,
      baseSymbol: NATIVE_SYMBOL,
      devBuyNative: 0,
    }),
    { headers, tags: { name: 'POST /launch/prepare' } },
  );
  check(res, { 'launch/prepare answered': (r) => r.status < 500 });
}
