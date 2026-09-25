// Board + token read-path load test — the "many concurrent board pollers +
// WS subscribers" scenario from the load-test brief.
//
//   k6 run loadtest/k6/board-read.js
//   BASE_URL=http://127.0.0.1:8787 WS_URL=ws://127.0.0.1:8787/ws \
//     BOARD_VUS=150 WS_VUS=150 DURATION=3m k6 run loadtest/k6/board-read.js
//
// Two independent scenarios run concurrently:
//   - `board_poll`  — REST reads: GET /tokens (board), GET /tokens/:sym,
//     GET /tokens/:sym/candles, GET /tokens/:sym/trades. This is what the web
//     board does on load and on every ~few-second refresh.
//   - `ws_subscribe` — opens a WS connection per VU, subscribes to `board`
//     and one `token:{sym}` channel, and holds it open for the run, the way
//     an idle browser tab does. Run `apps/indexer` (fixtures) alongside this
//     for the channels to actually carry traffic; see loadtest/README.md.
import http from 'k6/http';
import ws from 'k6/ws';
import { check, sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';
import { BASE_URL, WS_URL, NET, netManifest, jsonHeaders } from './lib/config.js';

const board = netManifest(NET);
const SORTS = ['new', 'mc', 'chg', 'rep'];
const LANES = [undefined, 'new', 'soon', 'grad'];
const TIMEFRAMES = ['1m', '5m', '1h'];

const wsMessages = new Counter('ws_messages_received');
const wsConnectTime = new Trend('ws_connect_time_ms');

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

export const options = {
  scenarios: {
    board_poll: {
      executor: 'ramping-vus',
      exec: 'boardPoll',
      startVUs: 0,
      stages: [
        { duration: '30s', target: Number(__ENV.BOARD_VUS || 100) },
        { duration: __ENV.DURATION || '2m', target: Number(__ENV.BOARD_VUS || 100) },
        { duration: '20s', target: 0 },
      ],
    },
    ws_subscribe: {
      executor: 'ramping-vus',
      exec: 'wsSubscribe',
      startVUs: 0,
      stages: [
        { duration: '20s', target: Number(__ENV.WS_VUS || 100) },
        { duration: __ENV.DURATION || '2m', target: Number(__ENV.WS_VUS || 100) },
        { duration: '10s', target: 0 },
      ],
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<400', 'p(99)<800'],
    http_req_failed: ['rate<0.01'],
    ws_connect_time_ms: ['p(95)<500'],
  },
};

export function boardPoll() {
  const headers = jsonHeaders(__VU);

  // GET /tokens — the board itself, the hottest of the hot paths.
  // (k6's goja runtime has no `URLSearchParams`, hence manual query building.)
  const lane = pick(LANES);
  const qs = `net=${NET}&sort=${pick(SORTS)}&limit=60${lane ? `&lane=${lane}` : ''}`;
  const boardRes = http.get(`${BASE_URL}/tokens?${qs}`, { headers, tags: { name: 'GET /tokens' } });
  check(boardRes, { 'GET /tokens 200': (r) => r.status === 200 });

  // A user who opened a token from the board: /tokens/:sym, candles, trades.
  const sym = pick(board.allSymbols);
  const tokenRes = http.get(`${BASE_URL}/tokens/${sym}?net=${NET}`, {
    headers,
    tags: { name: 'GET /tokens/:sym' },
  });
  check(tokenRes, { 'GET /tokens/:sym 200': (r) => r.status === 200 });

  const candlesRes = http.get(
    `${BASE_URL}/tokens/${sym}/candles?net=${NET}&tf=${pick(TIMEFRAMES)}&limit=200`,
    {
      headers,
      tags: { name: 'GET /tokens/:sym/candles' },
    },
  );
  check(candlesRes, { 'GET /tokens/:sym/candles 200': (r) => r.status === 200 });

  const tradesRes = http.get(`${BASE_URL}/tokens/${sym}/trades?net=${NET}&limit=50`, {
    headers,
    tags: { name: 'GET /tokens/:sym/trades' },
  });
  check(tradesRes, { 'GET /tokens/:sym/trades 200': (r) => r.status === 200 });

  // The board refreshes every few seconds in the real client; do not hammer
  // faster than that.
  sleep(1 + Math.random() * 2);
}

export function wsSubscribe() {
  const sym = pick(board.hotSymbols.length > 0 ? board.hotSymbols : board.allSymbols);
  const started = Date.now();
  const res = ws.connect(WS_URL, {}, (socket) => {
    socket.on('open', () => {
      wsConnectTime.add(Date.now() - started);
      socket.send(JSON.stringify({ type: 'subscribe', channel: 'board' }));
      socket.send(JSON.stringify({ type: 'subscribe', channel: `token:${sym}` }));
    });
    socket.on('message', () => wsMessages.add(1));
    // Hold the connection open the way an idle board tab does.
    socket.setTimeout(() => socket.close(), Number(__ENV.WS_HOLD_MS || 30000));
  });
  check(res, { 'ws connected': (r) => r && r.status === 101 });
}
