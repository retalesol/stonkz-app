import { HOUR } from '@stonkz/shared';

/**
 * What each crate `I` row actually does.
 *
 * Item labels are the ledger keys (`item_flags.item`), so this catalogue is
 * keyed on the exact strings in `CRATES`. `implemented` is honest: a perk
 * with no integration point yet is shown to the wallet as "NOT LIVE YET"
 * rather than silently doing nothing.
 */
export type ItemEffect =
  | 'xp_boost'
  | 'instant_crate'
  | 'fee_rebate'
  | 'fee_free'
  | 'priority_lane'
  | 'sniper_alert'
  | 'early_mint'
  | 'ticker_badge';

export interface ItemDef {
  effect: ItemEffect;
  /** Multiplier applied to base XP while the item is active (`xp_boost`). */
  xpMult?: number;
  /** True when a server system reads the flag. */
  implemented: boolean;
  blurb: string;
}

export const ITEM_XP_BOOST = 'XP BOOST 2X 1H';
export const ITEM_RHODIUM_KEY = 'RHODIUM KEY · INSTANT CRATE';

export const ITEMS: Readonly<Record<string, ItemDef>> = {
  'FEE REBATE 24H': {
    effect: 'fee_rebate',
    implemented: false,
    blurb: 'Curve fees rebated as $STONKZ credits for 24h — needs the fee-split hook.',
  },
  [ITEM_XP_BOOST]: {
    effect: 'xp_boost',
    xpMult: 2,
    implemented: true,
    blurb: 'Every award pays double XP and SP for one hour (before the daily cap).',
  },
  'PRIORITY LANE PASS': {
    effect: 'priority_lane',
    implemented: false,
    blurb: 'Priority relay lane for your next trades — needs the relay hook.',
  },
  'SNIPER ALERT PASS 7D': {
    effect: 'sniper_alert',
    implemented: false,
    blurb: 'Launch alerts for seven days — needs the notification hook.',
  },
  'EARLY MINT ACCESS': {
    effect: 'early_mint',
    implemented: false,
    blurb: 'Early access to gated mints — needs the launch gate hook.',
  },
  'IRIDIUM TICKER BADGE': {
    effect: 'ticker_badge',
    implemented: false,
    blurb: 'Cosmetic ticker badge on your profile — needs the profile hook.',
  },
  'FEE FREE WEEK': {
    effect: 'fee_free',
    implemented: false,
    blurb: 'Platform-leg fees waived for a week — needs the fee-split hook.',
  },
  [ITEM_RHODIUM_KEY]: {
    effect: 'instant_crate',
    implemented: true,
    blurb: 'Skip the global cooldown once: open any crate you hold immediately.',
  },
};

export function itemDef(item: string): ItemDef | null {
  return ITEMS[item] ?? null;
}

/** Timed item drops carry their window in the label; the rest never expire. */
export function itemExpiry(item: string, nowMs: number): Date | null {
  const match = /(\d+)\s*(H|D)\b/.exec(item);
  if (!match) return null;
  const value = Number.parseInt(match[1] as string, 10);
  const unit = match[2] === 'D' ? 24 * HOUR : HOUR;
  return new Date(nowMs + value * unit);
}

/** Held, unexpired and with count left. */
export function itemActive(
  row: { count: number; expiresAt: Date | number | null },
  nowMs: number,
): boolean {
  if (row.count <= 0) return false;
  if (row.expiresAt === null) return true;
  const exp = row.expiresAt instanceof Date ? row.expiresAt.getTime() : row.expiresAt;
  return exp > nowMs;
}
