import { shortAddr } from './fmt.js';
import { USER } from '../state/user.js';
import { WALLET } from '../state/wallet.js';

/**
 * Display names and avatar URLs keyed by full wallet address.
 *
 * Hydrated from `GET /me`, `GET /users/...`, and chat frames that carry
 * profile fields. Falls back to a shortened address — never the literal
 * string "YOU" — so chat, the wallet chip and trades all read the same.
 */

export interface Identity {
  username: string | null;
  avatarUrl: string | null;
}

const CACHE = new Map<string, Identity>();

function keyOf(wallet: string): string {
  return wallet;
}

export function rememberIdentity(wallet: string, id: Partial<Identity>): void {
  if (!wallet) return;
  const prev = CACHE.get(keyOf(wallet)) ?? { username: null, avatarUrl: null };
  CACHE.set(keyOf(wallet), {
    username: id.username !== undefined ? id.username : prev.username,
    avatarUrl: id.avatarUrl !== undefined ? id.avatarUrl : prev.avatarUrl,
  });
}

export function identityOf(wallet: string): Identity {
  return CACHE.get(keyOf(wallet)) ?? { username: null, avatarUrl: null };
}

/** True when `wallet` is the connected session (full or short form). */
export function isOwnWallet(wallet: string): boolean {
  if (!WALLET.on || !wallet) return false;
  if (wallet === WALLET.full || wallet === WALLET.addr) return true;
  return !!WALLET.full && wallet.toLowerCase() === WALLET.full.toLowerCase();
}

/**
 * Human label for a wallet. Own messages use the set username when present,
 * otherwise a short address — never "YOU".
 */
export function displayName(wallet: string): string {
  if (isOwnWallet(wallet)) {
    if (USER.name?.trim()) return USER.name.trim();
    return WALLET.addr || shortAddr(wallet);
  }
  const id = identityOf(wallet);
  if (id.username?.trim()) return id.username.trim();
  return shortAddr(wallet);
}

export function avatarUrlOf(wallet: string): string | null {
  if (isOwnWallet(wallet) && USER.avatarUrl) return USER.avatarUrl;
  return identityOf(wallet).avatarUrl;
}

/** Chip / menu label for the connected wallet. */
export function myDisplayName(): string {
  if (USER.name?.trim()) return USER.name.trim();
  return WALLET.addr || 'WALLET';
}
