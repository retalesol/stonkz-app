// Shared config + fixture loading for every k6 script in this directory.
//
// k6 runs scripts in its own JS runtime (goja), not Node — `open()` is a k6
// builtin for reading a file at *init* time (once per VU, before any
// iteration), which is why the fixtures are read this way instead of
// `fs.readFileSync`.
export const BASE_URL = __ENV.BASE_URL || 'http://127.0.0.1:8787';
export const WS_URL = __ENV.WS_URL || 'ws://127.0.0.1:8787/ws';
export const NET = __ENV.LOADTEST_NET || 'SOL';

// `open()` resolves relative to *this* file, not the entry script.
export const manifest = JSON.parse(open('../../fixtures/manifest.json'));
export const auth = JSON.parse(open('../../fixtures/auth.json'));

export function netManifest(net) {
  return manifest.nets[net];
}

export function netAuth(net) {
  return auth[net];
}

/**
 * A synthetic per-VU source IP. `apps/api`'s rate limiter
 * (`src/redis/ratelimit.ts`) keys unauthenticated requests on
 * `X-Forwarded-For` (`app/middleware.ts:clientIdentity`) — real board
 * pollers each have their own IP, so a realistic many-user simulation gives
 * each VU one too, rather than every VU sharing k6's one loopback address
 * and tripping the read/quote limits after a few seconds.
 */
export function syntheticIp(vuId) {
  const n = Number(vuId) % 65000;
  return `10.${Math.floor(n / 250) % 250}.${n % 250}.${(n * 7) % 250}`;
}

export function jsonHeaders(vuId, extra) {
  return Object.assign(
    { 'Content-Type': 'application/json', 'X-Forwarded-For': syntheticIp(vuId) },
    extra || {},
  );
}
