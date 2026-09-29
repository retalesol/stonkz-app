import {
  ACH,
  CRATES,
  HOUR,
  RANKS,
  type AchievementKey,
  type CrateProof,
  type CrateTier,
  type DropLogEntry,
  type RwaReward,
  type User,
  type UserItem,
  achOf,
  applyXpMult,
  crateBy,
  crateReady,
  dayKey,
  rankOf,
  spLevelOf,
  spLevelsReached,
  xpMult as xpMultOf,
} from '@stonkz/shared';
import { $ } from '../lib/dom.js';
import { DOT, MID, clock, fmtUnits } from '../lib/fmt.js';
import { emit } from '../lib/bus.js';
import { burst } from '../fx/debris.js';
import { rankUp } from '../fx/rankUp.js';
import { toast } from '../fx/toast.js';
import { setLevelCount, showLevelUp } from '../modals/level.js';

/**
 * The local rewards ledger.
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

/** The persisted ledger: `User` plus a few client-only fields. */
interface StoredUser extends User {
  /** Pinata (or other) HTTPS avatar override. */
  avatarUrl?: string;
  /** Profile links, as `GET /me` / `PATCH /me` hold them (canonical URLs / bare handle). */
  website?: string;
  xHandle?: string;
  telegram?: string;
  /** Private profile: portfolio, PnL, actions, wall and friends are owner-only. */
  private?: boolean;
  /** Sim-only: which SP levels have already granted crates. */
  spLevelClaims?: Record<number, boolean>;
}

export let USER: StoredUser = emptyUser();

/** Empty guest / live-mode baseline — never looks like a ranked account. */
export function emptyUser(): StoredUser {
  return {
    xp: 0,
    stonkz: 0,
    sp: 0,
    rwa: [],
    crates: {},
    log: [],
  };
}

/** Sim-only seeded ledger so the sandbox has crates and a drop log. */
export function defaultUser(): StoredUser {
  return {
    xp: 1840,
    stonkz: 128400,
    sp: 1840,
    rwa: [{ asset: 'PAXG', units: 0.0042 }],
    // Global cooldown clear — inventory gates which tiers can open.
    crates: {
      BRONZE: 0,
      IRON: 0,
      SILVER: 0,
      GOLD: 0,
      PLATINUM: 0,
      IRIDIUM: 0,
      PALLADIUM: 0,
      RHODIUM: 0,
    },
    crateInventory: {
      BRONZE: 3,
      IRON: 2,
      SILVER: 2,
      GOLD: 1,
      PLATINUM: 1,
      IRIDIUM: 0,
      PALLADIUM: 0,
      RHODIUM: 0,
    },
    spLevel: { level: 4, next: 3500, pct: 28, toNext: 1660 },
    // Seed inventory already reflects early levels; don't re-grant on first addXP.
    spLevelClaims: { 1: true, 2: true, 3: true, 4: true },
    log: [
      { t: '09:14', k: 'SILVER', r: '0.0042 PAXG', col: '#d7dde3' },
      { t: '08:02', k: 'BRONZE', r: '180 $STONKZ', col: '#c07434' },
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
  migrateLegacyBalances(USER);
  if (typeof USER.sp !== 'number') USER.sp = USER.xp || 0;
  // Legacy sim blobs predate inventory — grant any SP levels not yet claimed.
  if (!isLiveMode()) {
    if (!USER.crateInventory) USER.crateInventory = {};
    syncSpLevelGrants();
    saveUser();
  }
}

/**
 * Pre-crate-rework blobs carried `optionz` (Stonk Optionz, the reward credits
 * crates paid) next to a stale `stonkz`. Optionz are retired and `stonkz` is
 * the reward-credit balance again, so fold the up-to-date credits into it and
 * drop the old field.
 */
function migrateLegacyBalances(u: StoredUser & { optionz?: unknown }): void {
  if (typeof u.optionz === 'number') u.stonkz = u.optionz;
  delete u.optionz;
  if (typeof u.stonkz !== 'number') u.stonkz = 0;
  if (!Array.isArray(u.rwa)) u.rwa = [];
}

/** `0.0042 PAXG · 0.03 TSLA`, or a dash when no RWA has dropped yet. */
export function rwaSummary(): string {
  const held = (USER.rwa ?? []).filter((r) => r.units > 0);
  return held.length
    ? held.map((r) => fmtUnits(r.units) + ' ' + r.asset).join(' ' + DOT + ' ')
    : MID;
}

/** Units of `asset` held, 0 when none. */
export function rwaUnits(asset: string): number {
  return USER.rwa?.find((r) => r.asset === asset)?.units ?? 0;
}

/** Set one asset's holding to an absolute total (WS `rwa` event). */
export function setRwaUnits(asset: string, total: number): void {
  const list = (USER.rwa ??= []);
  const row = list.find((r) => r.asset === asset);
  if (row) row.units = total;
  else list.push({ asset, units: total });
}

/** Add units to one asset's holding (sim crate open). */
export function creditRwa(asset: string, units: number): void {
  setRwaUnits(asset, Math.round((rwaUnits(asset) + units) * 10_000) / 10_000);
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
  /** `$STONKZ` reward credits. */
  stonkz: number;
  /** RWA positions won from crates. Absent leaves the cached list alone. */
  rwa?: RwaReward[];
  streak?: number;
  achievements?: { key: AchievementKey; unlockedAt: number }[];
  crates?: { tier: CrateTier; readyAt: number; inventory?: number }[];
  spLevel?: {
    level: number;
    next: number | null;
    pct: number;
    toNext: number;
    cur?: number;
    claimed?: number[];
    /** Levels whose grants landed on this very read (server `newlyClaimed`). */
    newlyClaimed?: number[];
    granted?: Partial<Record<CrateTier, number>>;
    levelCount?: number;
  };
  dropLog?: {
    at: number;
    tier: string;
    label: string;
    rarity?: string;
    proof?: CrateProof;
  }[];
  /** USD value of the RWA holdings; `null` while unpriced, absent leaves the cache alone. */
  rwaUsd?: number | null;
  items?: UserItem[];
  nextCrateCommit?: string | null;
}

/** Replace the local ledger with the server's numbers (live mode only). */
export function hydrateRewards(snap: RewardsHydration): void {
  hydrated = true;
  const before = rankOf(USER.xp).i;
  const levelBefore = USER.spLevel?.level ?? 0;
  const hadLevel = USER.spLevel !== undefined;
  USER.xp = snap.xp;
  USER.sp = snap.sp;
  USER.stonkz = snap.stonkz;
  if (snap.rwa) USER.rwa = snap.rwa.map((r) => ({ asset: r.asset, units: r.units }));
  if (snap.rwaUsd !== undefined) USER.rwaUsd = snap.rwaUsd;
  if (snap.items) USER.items = snap.items;
  if (snap.nextCrateCommit !== undefined) USER.nextCrateCommit = snap.nextCrateCommit;
  if (typeof snap.streak === 'number') USER.streak = snap.streak;
  if (snap.spLevel) {
    const { newlyClaimed, granted, levelCount, ...rest } = snap.spLevel;
    USER.spLevel = rest;
    if (levelCount) setLevelCount(levelCount);
    // A level that landed on this read (SP earned while the page was away, or
    // the server catching up an old balance) still deserves its ceremony —
    // but only past level 1, which every wallet starts on, and only when we
    // already knew a lower level, so a first hydrate does not replay history.
    const landed = (newlyClaimed ?? []).filter((l) => l > 1);
    if (hadLevel && (landed.length > 0 || rest.level > levelBefore)) {
      showLevelUp({
        level: rest.level,
        grants: granted ?? spLevelOf(snap.sp).grants,
        totalSp: snap.sp,
        next: rest.next,
      });
    }
  }

  if (snap.achievements) {
    USER.ach = {};
    for (const a of snap.achievements) USER.ach[a.key] = a.unlockedAt;
  }

  if (snap.crates) {
    USER.crates = {};
    USER.crateInventory = {};
    for (const c of snap.crates) {
      USER.crates[c.tier] = c.readyAt;
      USER.crateInventory[c.tier] = c.inventory ?? 0;
    }
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
        at: d.at,
        ...(d.rarity ? { rarity: d.rarity } : {}),
        ...(d.proof ? { proof: d.proof } : {}),
      };
    });
  }

  saveUser();
  emit('xp', { amount: 0, reason: 'hydrate', gained: false });
  emit('rank');
  const after = rankOf(USER.xp).i;
  if (after > before) {
    toast(
      'RANK UP to LV ' + (after + 1) + ' ' + (RANKS[after] as (typeof RANKS)[number])[0],
      'gold',
    );
    rankUp(after);
  }
}

/** Reset to guest empty (disconnect / live session drop). */
export function resetLiveRewards(): void {
  if (!isLiveMode()) return;
  USER = emptyUser();
  hydrated = false;
  saveUser();
  emit('rank');
}

let hydrated = false;
/** True once `GET /rewards` has been applied for the live session (drives the loading state). */
export function rewardsHydrated(): boolean {
  return !isLiveMode() || hydrated;
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
  syncSpLevelGrants();
  saveUser();
  emit('xp', { amount: n, reason: why, gained: true });
  emit('rank');
  const after = rankOf(USER.xp).i;
  if (after > before) {
    toast(
      'RANK UP to LV ' + (after + 1) + ' ' + (RANKS[after] as (typeof RANKS)[number])[0],
      'gold',
    );
    rankUp(after);
  } else if (why) {
    const mult = xpMult() > 1 ? ' (x' + xpMult().toFixed(2) + ')' : '';
    toast('+' + n + ' XP for ' + why + mult);
  }
}

/**
 * Claim SP-level crate grants for the current SP balance (sim only).
 * Tracks claimed levels on `USER.spLevelClaims` so grants are idempotent.
 */
export function syncSpLevelGrants(): void {
  if (isLiveMode()) return;
  const sp = USER.sp ?? 0;
  if (!USER.spLevelClaims) USER.spLevelClaims = {};
  if (!USER.crateInventory) USER.crateInventory = {};
  const claimed = USER.spLevelClaims;
  let grantedAny = false;
  for (const def of spLevelsReached(sp)) {
    if (claimed[def.level]) continue;
    claimed[def.level] = true;
    for (const [tier, n] of Object.entries(def.grants) as [CrateTier, number][]) {
      if (!n || n <= 0) continue;
      USER.crateInventory[tier] = (USER.crateInventory[tier] ?? 0) + n;
      grantedAny = true;
    }
  }
  const info = spLevelOf(sp);
  USER.spLevel = {
    level: info.level,
    next: info.next,
    pct: info.pct,
    toNext: info.toNext,
    cur: info.cur,
    claimed: Object.keys(claimed)
      .map(Number)
      .sort((a, b) => a - b),
  };
  if (grantedAny && info.level > 1) {
    showLevelUp({ level: info.level, grants: info.grants, totalSp: sp, next: info.next });
  } else if (grantedAny) {
    toast('SP LEVEL ' + info.level + ' ' + DOT + ' CRATES GRANTED', 'gold');
  }
}

/* -------------------------------------------------------------------------- */
/* Live WS user-channel setters                                                */
/* -------------------------------------------------------------------------- */

/**
 * Apply an `xp` frame: the server's running total wins. Returns true on a
 * rank-up so the caller can play the ceremony (the server also sends
 * `rank_up`, but a dropped frame must not lose the moment).
 */
export function applyXpTotal(total: number, amount: number, reason?: string): boolean {
  const before = rankOf(USER.xp).i;
  USER.xp = total;
  saveUser();
  emit('xp', { amount, reason, gained: amount > 0 });
  emit('rank');
  return rankOf(total).i > before;
}

/** Apply an `sp` frame: move the total and the level bar; grants arrive on `level_up` / re-hydrate. */
export function applySpTotal(total: number): void {
  USER.sp = total;
  const info = spLevelOf(total);
  USER.spLevel = {
    ...(USER.spLevel ?? {}),
    level: info.level,
    next: info.next,
    pct: info.pct,
    toNext: info.toNext,
    cur: info.cur,
  };
  saveUser();
  emit('rank');
}

/** Apply a `level_up` frame: credit the grants locally so the crate grid moves before the re-hydrate lands. */
export function applyLevelUp(
  level: number,
  grants: Partial<Record<CrateTier, number>>,
  totalSp: number,
): void {
  const inv = (USER.crateInventory ??= {});
  const claimed = new Set(USER.spLevel?.claimed ?? []);
  if (claimed.has(level)) return; // Already applied via hydrate — never double-count.
  claimed.add(level);
  for (const [tier, n] of Object.entries(grants) as [CrateTier, number][]) {
    if (n > 0) inv[tier] = (inv[tier] ?? 0) + n;
  }
  applySpTotal(Math.max(totalSp, USER.sp ?? 0));
  USER.spLevel = {
    ...(USER.spLevel as NonNullable<typeof USER.spLevel>),
    claimed: [...claimed].sort((a, b) => a - b),
  };
  saveUser();
  if (level > 1) showLevelUp({ level, grants, totalSp, next: USER.spLevel.next });
  emit('rank');
}

/** Apply an `achievement` frame. Returns false when it was already known. */
export function applyAchievement(key: AchievementKey, at: number = Date.now()): boolean {
  USER.ach ??= {};
  if (USER.ach[key]) return false;
  USER.ach[key] = at;
  saveUser();
  emit('achievement', { key });
  emit('rank');
  return true;
}

/** Apply a `streak` frame. */
export function applyStreak(count: number): void {
  USER.streak = count;
  saveUser();
  emit('rank');
}

/* -------------------------------------------------------------------------- */
/* Items                                                                       */
/* -------------------------------------------------------------------------- */

/** Held items whose perk is live right now. */
export function activeItems(now: number = Date.now()): UserItem[] {
  return (USER.items ?? []).filter(
    (i) => i.count > 0 && (i.expiresAt === null || i.expiresAt > now),
  );
}

export function hasActiveItem(item: string, now: number = Date.now()): boolean {
  return activeItems(now).some((i) => i.item === item);
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
  if (USER.streak > 1)
    toast('STREAK ' + USER.streak + ' DAYS ' + DOT + ' XP x' + xpMult().toFixed(2), 'gold');
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

export function readyAt(_k: CrateTier): number {
  // Global cooldown — any tier's stamp (or the max if somehow desynced).
  const vals = Object.values(USER.crates ?? {}).filter((t): t is number => typeof t === 'number');
  if (vals.length === 0) return 0;
  return Math.max(...vals);
}

export function inventoryOf(k: CrateTier): number {
  return USER.crateInventory?.[k] ?? 0;
}

export function isReady(k: CrateTier): boolean {
  return crateReady(readyAt(k) || undefined) && inventoryOf(k) > 0;
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
