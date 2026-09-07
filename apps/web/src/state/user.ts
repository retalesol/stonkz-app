import {
  ACH,
  CRATES,
  HOUR,
  RANKS,
  type AchievementKey,
  type CrateTier,
  type DropLogEntry,
  type User,
  achOf,
  applyXpMult,
  crateReady,
  dayKey,
  rankOf,
  xpMult as xpMultOf,
} from '@stonkz/shared';
import { $ } from '../lib/dom.js';
import { DOT } from '../lib/fmt.js';
import { emit } from '../lib/bus.js';
import { burst } from '../fx/debris.js';
import { rankUp } from '../fx/rankUp.js';
import { toast } from '../fx/toast.js';

/**
 * The local game ledger, persisted in `stonkz.rewards.v1`.
 *
 * Phase 3 makes every number here server-authoritative (`xp_events`,
 * `balances`, `streaks`, `achievements`, `crate_state`) and this file becomes
 * a read-through cache of `GET /rewards` plus the `user:{addr}` WS channel.
 * Until then it is the source of truth, which is exactly what must not ship.
 * `index.html:2091`
 */

const KEY = 'stonkz.rewards.v1';

/** Legacy field: the pre-SP/Optionz `$STONKZ` balance. */
interface StoredUser extends User {
  stonkz: number;
}

export let USER: StoredUser = defaultUser();

export function defaultUser(): StoredUser {
  const n = Date.now();
  return {
    xp: 1840,
    // Kept for migration only. Nothing renders it any more.
    stonkz: 128400,
    sp: 1840,
    optionz: 128400,
    crates: {
      BRONZE: 0,
      IRON: 0,
      SILVER: 0,
      GOLD: 0,
      PLATINUM: n + 3 * HOUR + 5 * 60000,
      IRIDIUM: n + 18 * HOUR,
      PALLADIUM: n + 52 * HOUR,
      RHODIUM: n + 126 * HOUR,
    },
    log: [
      { t: '09:14', k: 'SILVER', r: '3,120 OPTIONZ', col: '#d7dde3' },
      { t: '08:02', k: 'BRONZE', r: '180 OPTIONZ', col: '#c07434' },
      { t: '22:41', k: 'GOLD', r: 'FEE REBATE 24H', col: '#ffd23f' },
    ],
  };
}

export function loadUser(): void {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? (JSON.parse(raw) as StoredUser) : defaultUser();
    USER = !parsed || typeof parsed.xp !== 'number' ? defaultUser() : parsed;
  } catch {
    USER = defaultUser();
  }
  if (!USER.crates) USER.crates = {};
  if (!USER.log) USER.log = [];
  // Migrate the single `$STONKZ` balance into the two ledgers that replace it.
  // SP tracks XP 1:1 in v1; crate `S` drops pay Optionz.
  if (typeof USER.optionz !== 'number') USER.optionz = USER.stonkz || 0;
  if (typeof USER.sp !== 'number') USER.sp = USER.xp || 0;
}

export function saveUser(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(USER));
  } catch {
    /* private mode / quota — the session still works, it just will not persist */
  }
}

/* -------------------------------------------------------------------------- */
/* XP, rank, streak                                                            */
/* -------------------------------------------------------------------------- */

/** Current streak multiplier, 1.00x on day one and 1.30x from day seven. */
export function xpMult(): number {
  return xpMultOf(USER.streak);
}

/**
 * Award XP and mirror it into SP.
 *
 * Phase 3 deletes this: XP is credited by the server on a confirmed event and
 * arrives over `user:{addr}`; the ceremony below stays. `index.html:2142`
 */
export function addXP(base: number, why?: string): void {
  const n = applyXpMult(base, USER.streak);
  const before = rankOf(USER.xp).i;
  USER.xp += n;
  USER.sp = (USER.sp ?? 0) + n;
  saveUser();
  emit('xp', { amount: n, reason: why, gained: true });
  emit('rank');
  const after = rankOf(USER.xp).i;
  if (after > before) {
    toast('RANK UP ' + DOT + ' LV ' + (after + 1) + ' ' + (RANKS[after] as (typeof RANKS)[number])[0], 'gold');
    rankUp(after);
  } else if (why) {
    const mult = xpMult() > 1 ? ' ' + DOT + ' x' + xpMult().toFixed(2) : '';
    toast('+' + n + ' XP ' + DOT + ' ' + why + mult);
  }
}

/**
 * One increment per local calendar day. Phase 3 moves the day boundary to
 * server UTC so a device clock cannot farm streaks. `index.html:2157`
 */
export function touchStreak(): void {
  const today = dayKey();
  const y = new Date();
  y.setDate(y.getDate() - 1);
  if (USER.lastDay === today) return;
  USER.streak = USER.lastDay === dayKey(y) ? (USER.streak || 0) + 1 : 1;
  USER.lastDay = today;
  saveUser();
  if (USER.streak > 1) toast('STREAK ' + USER.streak + ' DAYS ' + DOT + ' XP x' + xpMult().toFixed(2), 'gold');
  if (USER.streak >= 7) unlock('streak7');
}

/* -------------------------------------------------------------------------- */
/* Achievements                                                                */
/* -------------------------------------------------------------------------- */

export function achCount(): number {
  return USER.ach ? Object.keys(USER.ach).length : 0;
}

export function hasAch(k: AchievementKey): boolean {
  return !!(USER.ach && USER.ach[k]);
}

/**
 * Unlock once, ever. Phase 3 derives these from the ledger instead — a client
 * can claim `whale` today, which is exactly why 3.A exists. `index.html:2180`
 */
export function unlock(k: AchievementKey): void {
  if (!USER.ach) USER.ach = {};
  if (USER.ach[k]) return;
  const a = achOf(k);
  if (!a) return;
  USER.ach[k] = Date.now();
  saveUser();
  toast('ACHIEVEMENT ' + DOT + ' ' + a.n + ' ' + DOT + ' +' + a.xp + ' XP', 'ach');
  const btn = $('#rankBtn');
  if (btn && !(btn.parentNode as HTMLElement | null)?.hidden) {
    const r = btn.getBoundingClientRect();
    burst(r.left, r.top + 2, Math.max(8, r.height - 4), { n: 26, gold: true });
  }
  addXP(a.xp);
  emit('achievement', { key: k });
}

export const ACH_TOTAL = ACH.length;

/* -------------------------------------------------------------------------- */
/* Crates                                                                      */
/* -------------------------------------------------------------------------- */

export function readyAt(k: CrateTier): number {
  return USER.crates?.[k] ?? 0;
}

export function isReady(k: CrateTier): boolean {
  return crateReady(readyAt(k) || undefined);
}

export function readyCount(): number {
  return CRATES.reduce((n, c) => n + (isReady(c.k) ? 1 : 0), 0);
}

/** Fraction of the cooldown elapsed, floored at 2% so the bar is visible. `index.html:2267` */
export function cdPct(c: { k: CrateTier; cd: number }): number {
  const left = readyAt(c.k) - Date.now();
  if (left <= 0) return 100;
  return Math.max(2, Math.min(100, (1 - left / (c.cd * HOUR)) * 100));
}

/** Prepend to the drop log, keeping the newest fourteen. */
export function pushDrop(entry: DropLogEntry): void {
  USER.log.unshift(entry);
  if (USER.log.length > 14) USER.log.pop();
}
