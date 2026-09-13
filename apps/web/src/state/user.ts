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
  crateBy,
  crateReady,
  dayKey,
  rankOf,
  xpMult as xpMultOf,
} from '@stonkz/shared';
import { $ } from '../lib/dom.js';
import { DOT, clock } from '../lib/fmt.js';
import { emit } from '../lib/bus.js';
import { burst } from '../fx/debris.js';
import { rankUp } from '../fx/rankUp.js';
import { toast } from '../fx/toast.js';

/**
 * The local game ledger.
 *
 * In `sim` mode this is the source of truth, seeded so the sandbox looks
 * lived-in, and persisted under `stonkz.rewards.v1`.
 *
 * In `live` mode the server ledger (`GET /rewards`, `GET /me`) is
 * authoritative. The client starts empty — never the sim seed — and only
 * caches a read-through snapshot under `stonkz.rewards.live.v1` so a reload
 * does not flash LV 4 before the session hydrates. Client-side `addXP` is a
 * no-op in live; XP arrives from the API after verified events.
 */

const SIM_KEY = 'stonkz.rewards.v1';
const LIVE_KEY = 'stonkz.rewards.live.v1';

function isLiveMode(): boolean {
  return (import.meta.env['VITE_API_MODE'] as string) === 'live';
}

function storageKey(): string {
  return isLiveMode() ? LIVE_KEY : SIM_KEY;
}

/** Legacy field: the pre-SP/Optionz `$STONKZ` balance. */
interface StoredUser extends User {
  stonkz: number;
  /** Pinata (or other) HTTPS avatar override. */
  avatarUrl?: string;
}

export let USER: StoredUser = emptyUser();

/** Empty guest / live-mode baseline — never looks like a ranked account. */
export function emptyUser(): StoredUser {
  return {
    xp: 0,
    stonkz: 0,
    sp: 0,
    optionz: 0,
    crates: {},
    log: [],
  };
}

/** Sim-only seeded ledger so the sandbox has crates and a drop log. */
export function defaultUser(): StoredUser {
  const n = Date.now();
  return {
    xp: 1840,
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
  if (isLiveMode()) {
    // Never hydrate from the sim seed key — leftover LV-4 demos must not
    // survive a live deploy. Prefer an empty guest until `hydrateRewards`.
    try {
      const raw = localStorage.getItem(LIVE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as StoredUser;
        USER = parsed && typeof parsed.xp === 'number' ? parsed : emptyUser();
      } else {
        USER = emptyUser();
      }
    } catch {
      USER = emptyUser();
    }
    // Drop the legacy sim blob so a future mode flip cannot resurrect it.
    try {
      localStorage.removeItem(SIM_KEY);
    } catch {
      /* private mode */
    }
  } else {
    try {
      const raw = localStorage.getItem(SIM_KEY);
      const parsed = raw ? (JSON.parse(raw) as StoredUser) : defaultUser();
      USER = !parsed || typeof parsed.xp !== 'number' ? defaultUser() : parsed;
    } catch {
      USER = defaultUser();
    }
  }
  if (!USER.crates) USER.crates = {};
  if (!USER.log) USER.log = [];
  if (typeof USER.optionz !== 'number') USER.optionz = USER.stonkz || 0;
  if (typeof USER.sp !== 'number') USER.sp = USER.xp || 0;
}

export function saveUser(): void {
  try {
    localStorage.setItem(storageKey(), JSON.stringify(USER));
  } catch {
    /* private mode / quota — the session still works, it just will not persist */
  }
}

/** Server snapshot shape from `GET /rewards` / the rewards half of `GET /me`. */
export interface RewardsHydration {
  xp: number;
  sp: number;
  optionz: number;
  streak?: number;
  achievements?: { key: AchievementKey; unlockedAt: number }[];
  crates?: { tier: CrateTier; readyAt: number }[];
  dropLog?: { at: number; tier: string; label: string }[];
}

/** Replace the local ledger with the server's numbers (live mode only). */
export function hydrateRewards(snap: RewardsHydration): void {
  const before = rankOf(USER.xp).i;
  USER.xp = snap.xp;
  USER.sp = snap.sp;
  USER.optionz = snap.optionz;
  if (typeof snap.streak === 'number') USER.streak = snap.streak;

  if (snap.achievements) {
    USER.ach = {};
    for (const a of snap.achievements) USER.ach[a.key] = a.unlockedAt;
  }

  if (snap.crates) {
    USER.crates = {};
    for (const c of snap.crates) USER.crates[c.tier] = c.readyAt;
  }

  if (snap.dropLog) {
    USER.log = snap.dropLog.map((d) => {
      const crate = crateBy(d.tier as CrateTier);
      const at = new Date(d.at);
      return {
        t: clock(at),
        k: d.tier as CrateTier,
        r: d.label,
        col: crate?.col ?? '#d7dde3',
      };
    });
  }

  saveUser();
  emit('xp', { amount: 0, reason: 'hydrate', gained: false });
  emit('rank');
  const after = rankOf(USER.xp).i;
  if (after > before) {
    toast('RANK UP to LV ' + (after + 1) + ' ' + (RANKS[after] as (typeof RANKS)[number])[0], 'gold');
    rankUp(after);
  }
}

/** Reset to guest empty (disconnect / live session drop). */
export function resetLiveRewards(): void {
  if (!isLiveMode()) return;
  USER = emptyUser();
  saveUser();
  emit('rank');
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
 * Live mode: no-op. The server credits XP on confirmed events; calling this
 * locally would invent rank progress. Sim mode keeps the local ledger.
 */
export function addXP(base: number, why?: string): void {
  if (isLiveMode()) return;
  const n = applyXpMult(base, USER.streak);
  const before = rankOf(USER.xp).i;
  USER.xp += n;
  USER.sp = (USER.sp ?? 0) + n;
  saveUser();
  emit('xp', { amount: n, reason: why, gained: true });
  emit('rank');
  const after = rankOf(USER.xp).i;
  if (after > before) {
    toast('RANK UP to LV ' + (after + 1) + ' ' + (RANKS[after] as (typeof RANKS)[number])[0], 'gold');
    rankUp(after);
  } else if (why) {
    const mult = xpMult() > 1 ? ' (x' + xpMult().toFixed(2) + ')' : '';
    toast('+' + n + ' XP for ' + why + mult);
  }
}

/**
 * One increment per local calendar day. Live mode: no-op — `GET /me` touches
 * the server-UTC streak instead.
 */
export function touchStreak(): void {
  if (isLiveMode()) return;
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
 * Unlock once, ever. Live mode: no-op — the server unlocks and hydrates.
 */
export function unlock(k: AchievementKey): void {
  if (isLiveMode()) return;
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

/** Fraction of the cooldown elapsed, floored at 2% so the bar is visible. */
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
