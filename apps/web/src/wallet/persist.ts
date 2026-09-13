import type { Net } from '@stonkz/shared';

/**
 * Last successful wallet connect — used to silent-reconnect after a reload.
 *
 * Cleared only on explicit disconnect or when the wallet itself revokes the
 * site. Auth tokens live separately in `app/session.ts`.
 */

const STORAGE_KEY = 'stonkz.wallet.v1';

export interface LastWallet {
  net: Net;
  /** Picker / manager id (`Phantom`, `injected:io.metamask`, `walletconnect`, …). */
  walletId: string;
  address: string;
  savedAt: number;
}

export function loadLastWallet(): LastWallet | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<LastWallet>;
    if (
      (parsed.net !== 'SOL' && parsed.net !== 'RH') ||
      typeof parsed.walletId !== 'string' ||
      typeof parsed.address !== 'string' ||
      typeof parsed.savedAt !== 'number'
    ) {
      return null;
    }
    return parsed as LastWallet;
  } catch {
    return null;
  }
}

export function rememberLastWallet(pref: Omit<LastWallet, 'savedAt'>): void {
  try {
    const payload: LastWallet = { ...pref, savedAt: Date.now() };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    /* private mode / quota */
  }
}

export function clearLastWallet(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}
