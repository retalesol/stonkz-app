import type { Net } from '@stonkz/shared';
import { practiceAddress, signSignInMessage } from './keys.js';

/**
 * The live adapter's auth session.
 *
 * `POST /trade/prepare`, `/launch/prepare`, `/launch/confirm`, `GET /fees`
 * and `POST /fees/claim/prepare` all sit behind `requireAuth()` — a real JWT
 * minted by `POST /auth/siws` / `/auth/siwe` (`auth/service.ts`), not a
 * fixture bypass. This module runs that real handshake with `app/keys.ts`'s
 * practice key so every one of those endpoints is reachable for real, then
 * holds the access token in memory for `live.ts` to attach as `Authorization:
 * Bearer …`.
 *
 * Session lifetime is one page load — a reload logs back in rather than
 * refreshing, which is simpler and fine for a practice key that never expires
 * on its own.
 */

interface Session {
  net: Net;
  wallet: string;
  accessToken: string;
}

let session: Session | null = null;
let pending: Promise<Session> | null = null;

interface NonceChallenge {
  message: string;
}

interface LoginResponse {
  net: Net;
  wallet: string;
  accessToken: string;
}

async function readError(res: Response): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { error?: string; detail?: string };
  return body.detail ?? body.error ?? `HTTP ${res.status}`;
}

async function login(base: string, net: Net): Promise<Session> {
  const address = practiceAddress(net);
  const nonceRes = await fetch(`${base}/auth/nonce?net=${net}&address=${encodeURIComponent(address)}`);
  if (!nonceRes.ok) throw new Error('auth/nonce: ' + (await readError(nonceRes)));
  const challenge = (await nonceRes.json()) as NonceChallenge;
  const signature = signSignInMessage(net, challenge.message);

  const loginPath = net === 'SOL' ? '/auth/siws' : '/auth/siwe';
  const loginRes = await fetch(base + loginPath, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address, message: challenge.message, signature }),
  });
  if (!loginRes.ok) throw new Error(loginPath + ': ' + (await readError(loginRes)));
  const data = (await loginRes.json()) as LoginResponse;
  return { net: data.net, wallet: data.wallet, accessToken: data.accessToken };
}

/** Logs in (once) for `net`, reusing an already-live session for the same net. */
export async function ensureSession(base: string, net: Net): Promise<Session> {
  if (session && session.net === net) return session;
  if (!pending) {
    pending = login(base, net).then(
      (s) => {
        session = s;
        pending = null;
        return s;
      },
      (err) => {
        pending = null;
        throw err;
      },
    );
  }
  return pending;
}

/** `net`'s real derived wallet address, whether or not a session is live yet. */
export function sessionWallet(net: Net): string {
  return session?.net === net ? session.wallet : practiceAddress(net);
}

export function authHeader(net: Net): Record<string, string> {
  return session?.net === net ? { Authorization: `Bearer ${session.accessToken}` } : {};
}

export function clearSession(): void {
  session = null;
  pending = null;
}
