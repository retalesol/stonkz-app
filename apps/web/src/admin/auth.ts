import type { Net } from '@stonkz/shared';
import { NET_INFO } from '@stonkz/shared';
import { ensureSession, clearSession } from '../app/session.js';
import {
  activeWallet,
  availableWallets,
  connectWalletFor,
  disconnectActive,
  initWalletDiscovery,
  requireWallet,
  type SignPayload,
  type WalletChoice,
} from '../wallet/index.js';
import {
  API_BASE,
  ApiError,
  adminSession,
  call,
  clearAdminSession,
  setAdminSession,
  type AdminSession,
} from './api.js';

/**
 * Admin sign-in = the normal SIWS/SIWE session **plus** a step-up signature
 * over a fresh nonce (`GET /admin/auth/challenge` → wallet signs →
 * `POST /admin/auth/verify`), optionally with a TOTP code. The resulting
 * admin token is the only credential `/admin/*` accepts.
 */
export type StepUpPhase = 'connect' | 'session' | 'challenge' | 'sign' | 'verify' | 'done';

export interface StepUpHooks {
  onPhase?: (phase: StepUpPhase) => void;
  /** Called when the API says TOTP is required; return the code (or undefined to abort). */
  askTotp: () => Promise<string | undefined>;
  /** Wallet picker for a net with more than one candidate. */
  pickWallet?: (choices: WalletChoice[]) => Promise<string | undefined>;
}

export function initAdminWallets(): void {
  initWalletDiscovery();
}

export function walletChoices(net: Net): WalletChoice[] {
  return availableWallets(net).filter((c) => !c.unavailable);
}

export async function stepUp(
  net: Net,
  hooks: StepUpHooks,
  walletId?: string,
): Promise<AdminSession> {
  hooks.onPhase?.('connect');
  const current = activeWallet();
  if (!current || current.net !== net || (walletId && !current.label.includes(walletId))) {
    const choices = walletChoices(net);
    if (choices.length === 0) {
      throw new Error(`No ${NET_INFO[net].name} wallet detected. ${NET_INFO[net].walletHint}`);
    }
    let id = walletId ?? (choices.length === 1 ? choices[0]?.id : undefined);
    if (!id && hooks.pickWallet) id = await hooks.pickWallet(choices);
    if (!id) throw new Error('No wallet selected.');
    await connectWalletFor(net, { id });
  }
  // Admin actions are transactions on this net, so get the wallet onto its
  // chain now rather than at the first prepared tx; wallets without a switch
  // method (mobile) just sign in — the chain is re-checked before sending.
  await activeWallet()
    ?.ensureChain?.()
    .catch(() => undefined);

  hooks.onPhase?.('session');
  const session = await ensureSession(API_BASE, net);

  hooks.onPhase?.('challenge');
  let challenge: { message: string; totpRequired: boolean };
  try {
    challenge = await call<{ message: string; totpRequired: boolean }>('/admin/auth/challenge', {
      accessToken: session.accessToken,
    });
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      throw new Error('This wallet is not an admin.');
    }
    throw err;
  }

  hooks.onPhase?.('sign');
  const wallet = requireWallet(net);
  const signature = await wallet.signInMessage(challenge.message);

  hooks.onPhase?.('verify');
  let totp: string | undefined;
  if (challenge.totpRequired) {
    totp = await hooks.askTotp();
    if (!totp) throw new Error('TOTP code required.');
  }
  const verify = async (code: string | undefined): Promise<AdminSession> => {
    const body = await call<Record<string, unknown>>('/admin/auth/verify', {
      method: 'POST',
      accessToken: session.accessToken,
      body: { message: challenge.message, signature, ...(code ? { totp: code } : {}) },
    });
    return {
      adminToken: String(body['adminToken']),
      expiresAt: Number(body['expiresAt']),
      role: body['role'] as AdminSession['role'],
      mfa: body['mfa'] === true,
      wallet: String(body['wallet']),
      net,
    };
  };
  let result: AdminSession;
  try {
    result = await verify(totp);
  } catch (err) {
    if (err instanceof ApiError && err.code === 'totp_required') {
      // Enrolled between challenge and verify — ask now (the challenge is still unused).
      const code = await hooks.askTotp();
      if (!code) throw new Error('TOTP code required.');
      result = await verify(code);
    } else throw err;
  }
  setAdminSession(result);
  hooks.onPhase?.('done');
  return result;
}

export async function adminLogout(): Promise<void> {
  try {
    if (adminSession()) await call('/admin/auth/logout', { method: 'POST', body: {} });
  } catch {
    /* already dead */
  }
  clearAdminSession();
  clearSession();
  await disconnectActive().catch(() => undefined);
}

/** Signs and broadcasts a prepared admin transaction with the connected wallet. */
export async function signPrepared(
  net: Net,
  payload: SignPayload,
): Promise<{ signature: string; explorerUrl?: string }> {
  const wallet = requireWallet(net);
  if (wallet.ensureChain) await wallet.ensureChain();
  const out = await wallet.signAndSend(payload);
  return out.explorerUrl
    ? { signature: out.signature, explorerUrl: out.explorerUrl }
    : { signature: out.signature };
}

export function connectedAddress(): string | null {
  return activeWallet()?.address ?? null;
}
