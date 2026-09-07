import type { Net } from '@stonkz/shared';
import { WalletError, activeWallet, mapWalletError } from '../wallet/index.js';

/**
 * The live adapter's auth session.
 *
 * `POST /trade/prepare`, `/launch/prepare`, `/launch/confirm`, `GET /fees`
 * and `POST /fees/claim/prepare` all sit behind `requireAuth()` — a real JWT
 * minted by `POST /auth/siws` / `/auth/siwe` (`auth/service.ts`), not a
 * fixture bypass. This module runs that handshake and holds the access token
 * in memory for `live.ts` to attach as `Authorization: Bearer …`.
 *
 * The handshake itself was always real cryptography; what changed in Phase B
 * is the key holder. It is now whichever wallet `wallet/manager.ts` has
 * connected — a Wallet Standard `solana:signMessage` for SIWS, an EIP-1193
 * `personal_sign` for SIWE — rather than a keypair this app minted in
 * `localStorage`. The address is the wallet's, so the session is bound to an
 * account the user actually controls.
 *
 * Two deliberate non-behaviours, both from `docs/robinhood-chain.md` §6.2:
 * signing in never asks the wallet to switch chains (`personal_sign` is
 * chain-agnostic and mobile wallets may have no switch method), and the
 * nonce/session model does not depend on the signing method, so an EIP-712
 * sign-in fallback can be added without touching the server.
 *
 * Session lifetime is one page load — a reload logs back in rather than
 * refreshing.
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
  const wallet = activeWallet();
  if (!wallet || wallet.net !== net) {
    throw new WalletError('not_connected', 'Connect a wallet before signing in.');
  }
  const address = wallet.address;
  const nonceRes = await fetch(`${base}/auth/nonce?net=${net}&address=${encodeURIComponent(address)}`);
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
  const data = (await loginRes.json()) as LoginResponse;
  return { net: data.net, wallet: data.wallet, accessToken: data.accessToken };
}

/** Logs in (once) for `net`, reusing an already-live session for the same net. */
export async function ensureSession(base: string, net: Net): Promise<Session> {
  const wallet = activeWallet();
  // A session for an address the connected wallet no longer holds is worse
  // than none: every write would authorise as the previous account.
  if (session && (session.net !== net || (wallet && session.wallet.toLowerCase() !== wallet.address.toLowerCase()))) {
    session = null;
  }
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

/** The connected wallet's address for `net`, whether or not a session is live yet. */
export function sessionWallet(net: Net): string {
  if (session?.net === net) return session.wallet;
  const wallet = activeWallet();
  return wallet?.net === net ? wallet.address : '';
}

export function authHeader(net: Net): Record<string, string> {
  return session?.net === net ? { Authorization: `Bearer ${session.accessToken}` } : {};
}

export function clearSession(): void {
  session = null;
  pending = null;
}
