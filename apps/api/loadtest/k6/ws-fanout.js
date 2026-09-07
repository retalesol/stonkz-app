// WS broadcast fan-out — the scenario `docs/load-test-results.md` explicitly
// did NOT cover, and the reason its PASS is not a capacity sign-off.
//
//   k6 run loadtest/k6/ws-fanout.js
//   BASE_URL=https://staging-api WS_URL=wss://staging-api/ws \
//     WS_VUS=500 DURATION=5m k6 run loadtest/k6/ws-fanout.js
//
// The existing board-read.js opens WS connections and counts whatever arrives.
// That measures connection capacity, not fan-out: with no publisher running,
// idle sockets are close to free. This script measures the thing that actually
// breaks under launch-day load — how long a published event takes to reach a
// subscriber, as the subscriber count climbs.
//
// It works because `apps/api/src/ws/publisher.ts` stamps every event with
// `at` (server epoch ms) before publishing to Redis. Delivery lag is therefore
// measurable end to end from the client: `Date.now() - msg.at`, covering
// Redis pub/sub, the hub's fan-out loop, and the socket write.
//
// REQUIRED: something must be publishing, or this measures an empty channel
// and passes vacuously. Either:
//   - `apps/indexer` in chain mode against a funded testnet with real
//     activity (the honest configuration — see docs/phase-f-e2e.md), or
//   - `apps/indexer` on fixtures, which produces synthetic but continuous
//     board/token traffic.
// The `ws_connection_received_traffic` threshold below fails the run if
// nothing arrives, so a misconfigured stack cannot be mistaken for a pass.
import ws from 'k6/ws';
import http from 'k6/http';
import { check } from 'k6';
import { Counter, Trend, Rate } from 'k6/metrics';
import { BASE_URL, WS_URL, NET, netManifest, jsonHeaders } from './lib/config.js';

const board = netManifest(NET);

/** `Date.now() - msg.at` — Redis publish to client receipt. The headline number. */
const deliveryLag = new Trend('ws_delivery_lag_ms');
const wsConnectTime = new Trend('ws_connect_time_ms');
const messages = new Counter('ws_messages_received');
const boardMessages = new Counter('ws_board_messages');
const tokenMessages = new Counter('ws_token_messages');
/** Messages whose `at` is missing — a payload shape regression, not a latency problem. */
const unstamped = new Counter('ws_messages_unstamped');
/** Connections that received at least one message. A low rate means the channel is dead. */
const receivedAnything = new Rate('ws_connection_received_traffic');

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

const VUS = Number(__ENV.WS_VUS || 500);
const HOLD_MS = Number(__ENV.WS_HOLD_MS || 60000);

export const options = {
  scenarios: {
    // Ramp subscribers steadily rather than all at once: a step function
    // measures the reconnect thundering herd, which is a different test.
    fanout: {
      executor: 'ramping-vus',
      exec: 'subscribe',
      startVUs: 0,
      stages: [
        { duration: '1m', target: Math.floor(VUS / 2) },
        { duration: '1m', target: VUS },
        { duration: __ENV.DURATION || '3m', target: VUS },
        { duration: '30s', target: 0 },
      ],
      gracefulRampDown: '30s',
    },
    // A trickle of REST reads alongside, because in production the same
    // process serves both and the fan-out loop competes with request handling.
    concurrent_reads: {
      executor: 'constant-vus',
      exec: 'read',
      vus: Number(__ENV.READ_VUS || 20),
      duration: __ENV.DURATION || '3m',
      startTime: '2m',
    },
  },
  thresholds: {
    // The real target: a board update should feel immediate. Anything past a
    // second and the tape visibly lags the chain.
    ws_delivery_lag_ms: ['p(95)<1000', 'p(99)<2500'],
    ws_connect_time_ms: ['p(95)<1000'],
    // Guards against a vacuous pass: if most connections see no traffic, the
    // publisher is not running and this run proves nothing.
    ws_connection_received_traffic: ['rate>0.9'],
    // Payload shape regression: `at` must be present to measure anything.
    ws_messages_unstamped: ['count<1'],
    // The REST path must not collapse while the hub is fanning out.
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<800'],
  },
};

export function subscribe() {
  const sym = pick(board.hotSymbols.length > 0 ? board.hotSymbols : board.allSymbols);
  const started = Date.now();
  let got = 0;

  const res = ws.connect(WS_URL, {}, (socket) => {
    socket.on('open', () => {
      wsConnectTime.add(Date.now() - started);
      socket.send(JSON.stringify({ type: 'subscribe', channel: 'board' }));
      socket.send(JSON.stringify({ type: 'subscribe', channel: `token:${sym}` }));
    });

    socket.on('message', (raw) => {
      messages.add(1);
      got += 1;

      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        unstamped.add(1);
        return;
      }

      // Subscription acks and pings carry no `at` and are not fan-out events.
      if (msg.type === 'subscribed' || msg.type === 'pong' || msg.type === 'ping') return;

      if (typeof msg.at === 'number') {
        // Clock skew between the load generator and the API shows up here as
        // a constant offset (and can go negative). Run k6 on a host whose
        // clock is NTP-synced with the API, and treat a negative p50 as a
        // skew problem rather than an impossibly fast delivery.
        deliveryLag.add(Date.now() - msg.at);
      } else {
        unstamped.add(1);
      }

      if (msg.channel === 'board' || msg.scope === 'board') boardMessages.add(1);
      else tokenMessages.add(1);
    });

    socket.on('error', (e) => {
      // A closed socket during ramp-down is expected; anything else is signal.
      if (e && e.error && String(e.error).indexOf('close') === -1) {
        console.error(`ws error: ${e.error}`);
      }
    });

    socket.setTimeout(() => socket.close(), HOLD_MS);
  });

  check(res, { 'ws connected': (r) => r && r.status === 101 });
  receivedAnything.add(got > 0);
}

export function read() {
  const headers = jsonHeaders(__VU);
  const res = http.get(`${BASE_URL}/tokens?net=${NET}&sort=new&limit=60`, {
    headers,
    tags: { name: 'GET /tokens (during fanout)' },
  });
  check(res, { 'GET /tokens 200 during fanout': (r) => r.status === 200 });
}
