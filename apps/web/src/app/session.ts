import type { Net } from '@stonkz/shared';
import { WalletError, activeWallet, mapWalletError } from '../wallet/index.js';

/**
 * The live adapter's auth session.
 *
 * Access + refresh JWTs are persisted so a reload does not force another
 * SIWS/SIWE signature for at least 24 hours (server refresh TTL is longer —
 * default 30 days). `ensureSession` prefers a still-valid access token, then
 * `/auth/refresh` (no wallet prompt), and only falls back to a fresh sign-in
 * when both fail.
 */

const STORAGE_KEY = 'stonkz.auth.v1';
const ACCESS_SKEW_MS = 60_000;

interface Session {
  net: Net;
  wallet: string;
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: number;
  refreshExpiresAt: number;
  /** When this login (or restore) was established — for the 24h UX floor. */
  establishedAt: number;
}

interface StoredAuth {
  net: Net;
  wallet: string;
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: number;
  refreshExpiresAt: number;
  establishedAt: number;
}

let session: Session | null = null;
let pending: Promise<Session> | null = null;
let refreshPending: Promise<Session> | null = null;

interface NonceChallenge {
  message: string;
}

interface TokenResponse {
  net: Net;
  wallet: string;
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: number;
  refreshExpiresAt: number;
}

function readStore(): StoredAuth | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredAuth>;
    if (
      (parsed.net !== 'SOL' && parsed.net !== 'RH' && parsed.net !== 'BASE') ||
      typeof parsed.wallet !== 'string' ||
      typeof parsed.accessToken !== 'string' ||
      typeof parsed.refreshToken !== 'string' ||
      typeof parsed.accessExpiresAt !== 'number' ||
      typeof parsed.refreshExpiresAt !== 'number' ||
      typeof parsed.establishedAt !== 'number'
    ) {
      return null;
    }
    return parsed as StoredAuth;
  } catch {
    return null;
  }
}

function writeStore(s: Session): void {
  try {
    const payload: StoredAuth = {
      net: s.net,
      wallet: s.wallet,
      accessToken: s.accessToken,
      refreshToken: s.refreshToken,
      accessExpiresAt: s.accessExpiresAt,
      refreshExpiresAt: s.refreshExpiresAt,
      establishedAt: s.establishedAt,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // Private mode / quota — in-memory session still works for this tab.
  }
}

function clearStore(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

function hydrateFromStore(): Session | null {
  const stored = readStore();
  if (!stored) return null;
  if (stored.refreshExpiresAt <= Date.now()) {
    clearStore();
    return null;
  }
  return { ...stored };
}

function adopt(tokens: TokenResponse, establishedAt?: number): Session {
  const next: Session = {
    net: tokens.net,
    wallet: tokens.wallet,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    accessExpiresAt: tokens.accessExpiresAt,
    refreshExpiresAt: tokens.refreshExpiresAt,
    establishedAt: establishedAt ?? Date.now(),
  };
  session = next;
  writeStore(next);
  return next;
}

async function readError(res: Response): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { error?: string; detail?: string };
  return body.detail ?? body.error ?? `HTTP ${res.status}`;
}

async function login(base: string, net: Net): Promise<Session> {
  const wallet = activeWallet();
  if (!wallet || wallet.net !== net) {
    throw new WalletError('not_connected', 'Connect a wallet before signing in.');
  }
  const address = wallet.address;
  const nonceRes = await fetch(
    `${base}/auth/nonce?net=${net}&address=${encodeURIComponent(address)}`,
  );
  if (!nonceRes.ok) throw new Error('auth/nonce: ' + (await readError(nonceRes)));
  const challenge = (await nonceRes.json()) as NonceChallenge;

  let signature: string;
  try {
    signature = await wallet.signInMessage(challenge.message);
  } catch (err) {
    throw mapWalletError(err, 'The wallet would not sign the sign-in message.');
  }

  const loginPath = net === 'SOL' ? '/auth/siws' : '/auth/siwe';
  const loginRes = await fetch(base + loginPath, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address, message: challenge.message, signature }),
  });
  if (!loginRes.ok) throw new Error(loginPath + ': ' + (await readError(loginRes)));
  const data = (await loginRes.json()) as TokenResponse;
  return adopt(data);
}

async function refresh(base: string, current: Session): Promise<Session> {
  const res = await fetch(base + '/auth/refresh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken: current.refreshToken }),
  });
  if (!res.ok) {
    throw new Error('auth/refresh: ' + (await readError(res)));
  }
  const data = (await res.json()) as TokenResponse;
  return adopt(data, current.establishedAt);
}

function accessFresh(s: Session): boolean {
  return s.accessExpiresAt - ACCESS_SKEW_MS > Date.now();
}

function refreshUsable(s: Session): boolean {
  return s.refreshExpiresAt > Date.now();
}

/** EVM addresses are case-insensitive; Solana base58 is not. */
function sameAddress(net: Net, a: string, b: string): boolean {
  return net === 'RH' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/**
 * Logs in (once) for `net`. Reuses a live / persisted session when the access
 * token is still good, refreshes when it is not, and only prompts the wallet
 * to sign when refresh is impossible.
 */
export async function ensureSession(base: string, net: Net): Promise<Session> {
  const wallet = activeWallet();

  if (!session) session = hydrateFromStore();

  // Drop a session that belongs to a different net or a different address than
  // the currently connected wallet.
  if (
    session &&
    (session.net !== net || (wallet && !sameAddress(net, session.wallet, wallet.address)))
  ) {
    session = null;
  }

  if (session && session.net === net && accessFresh(session)) return session;

  if (session && session.net === net && refreshUsable(session)) {
    if (!refreshPending) {
      const current = session;
      refreshPending = refresh(base, current).then(
        (s) => {
          refreshPending = null;
          return s;
        },
        (err) => {
          refreshPending = null;
          // Stale refresh — fall through to a fresh SIWS/SIWE below.
          if (session?.refreshToken === current.refreshToken) {
            session = null;
            clearStore();
          }
          throw err;
        },
      );
    }
    try {
      return await refreshPending;
    } catch {
      // Continue to sign-in when the wallet is available.
    }
  }

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

/**
 * Restore tokens from storage without a wallet prompt. Used on boot after the
 * extension reconnects: refresh if needed, otherwise return null so the UI
 * stays logged out until the user connects.
 */
export async function restoreSession(base: string): Promise<Session | null> {
  if (!session) session = hydrateFromStore();
  if (!session) return null;
  if (accessFresh(session)) return session;
  if (!refreshUsable(session)) {
    clearSession();
    return null;
  }
  try {
    return await refresh(base, session);
  } catch {
    clearSession();
    return null;
  }
}

/** The connected wallet's address for `net`, whether or not a session is live yet. */
export function sessionWallet(net: Net): string {
  if (session?.net === net) return session.wallet;
  const wallet = activeWallet();
  return wallet?.net === net ? wallet.address : '';
}

export function authHeader(net: Net): Record<string, string> {
  return session?.net === net ? { Authorization: `Bearer ${session.accessToken}` } : {};
}

/** True when a SIWS/SIWE JWT is already held for `net`. */
export function hasSession(net: Net): boolean {
  return !!session && session.net === net && accessFresh(session);
}

/** Peek at the persisted session without hydrating refresh logic. */
export function peekStoredSession(): { net: Net; wallet: string } | null {
  const s = session ?? hydrateFromStore();
  if (!s || !refreshUsable(s)) return null;
  return { net: s.net, wallet: s.wallet };
}

export function clearSession(): void {
  session = null;
  pending = null;
  refreshPending = null;
  clearStore();
}

/** Best-effort server logout so the refresh token cannot be reused. */
export async function logoutSession(base: string): Promise<void> {
  const s = session ?? hydrateFromStore();
  if (s?.accessToken) {
    await fetch(base + '/auth/logout', {
      method: 'POST',
      headers: { Authorization: `Bearer ${s.accessToken}` },
    }).catch(() => undefined);
  }
  clearSession();
}

/** Mark the access token stale so the next `ensureSession` hits `/auth/refresh`. */
export function invalidateAccessToken(): void {
  if (!session) session = hydrateFromStore();
  if (session) session = { ...session, accessExpiresAt: 0 };
}
