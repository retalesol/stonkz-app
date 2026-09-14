import type { AchievementKey } from '@stonkz/shared';

/**
 * Every award rule, ported from `legacy/index.html`.
 *
 * The arithmetic itself lives in `@stonkz/shared` (`xpForTrade`,
 * `xpForFeeClaim`, `xpForStake`, `applyXpMult`, `crateXp`, `achOf`) and is not
 * duplicated here. What this file owns is the *policy* the server applies on
 * top of the sim: which reason strings exist, which of them need a verified
 * chain event behind them, the dust floor and the whale cut.
 *
 * Line references are into `legacy/index.html`.
 */

/** Reason strings written to `xp_events.reason`. Stable — they are ledger keys. */
export const REASONS = {
  /** `addXP(max(8, round(sol*50)), "TRADE")` */
  trade: 'trade',
  /** Launch a coin — 50 XP/SP. */
  launch: 'launch',
  /** Creator bonus when their token bonds — 250 XP/SP. */
  launchBond: 'launch_bond',
  /** `addXP(max(10, round(tot*30)), "FEE CLAIM")` */
  feeClaim: 'fee_claim',
  /** `addXP(max(5, round(amt/circ*400)), "STAKE")` */
  stake: 'stake',
  /** `addXP(12, "STAKE CLAIM")` */
  stakeClaim: 'stake_claim',
  /** Follow — 0 XP (anti-farm). */
  follow: 'follow',
  /** Wall comment — 1 XP, max 5/day. */
  wallPost: 'wall_post',
  /** Wall like — 1 XP, max 5/day. */
  like: 'like',
  /** Daily check-in — 10 SP once per UTC day. */
  dailyCheckin: 'daily_checkin',
  /** Direct-referrer SP kickback (5% of referee SP). */
  referralSp: 'referral_sp',
  /** Crate open XP. */
  crate: 'crate',
} as const;

export type Reason = (typeof REASONS)[keyof typeof REASONS] | `ach:${AchievementKey}`;

export function achievementReason(key: AchievementKey): `ach:${AchievementKey}` {
  return `ach:${key}`;
}

/**
 * Reasons that may only be awarded when a matching row exists in
 * `chain_events`. This is the enforcement point for "never start Phase 3
 * awards on unverified client events" — the ledger looks the signature up and
 * refuses rather than trusting the caller.
 *
 * `follow` and `wall_post` are absent because they are API actions, not chain
 * events; from Phase 5 a wall post additionally requires a verified tip
 * signature, which is a separate check on that route. `crate` is absent
 * because the server itself authors the roll.
 */
export const CHAIN_VERIFIED_REASONS: ReadonlySet<string> = new Set<string>([
  REASONS.trade,
  REASONS.launch,
  REASONS.launchBond,
  REASONS.feeClaim,
  REASONS.stake,
  REASONS.stakeClaim,
  achievementReason('first'),
  achievementReason('whale'),
  achievementReason('deploy'),
  achievementReason('cashback'),
  achievementReason('stake'),
  achievementReason('grad'),
  achievementReason('diamond'),
]);

export function requiresVerifiedEvent(reason: string): boolean {
  return CHAIN_VERIFIED_REASONS.has(reason);
}

/**
 * The whale cut and the dust floor now live in `@stonkz/shared`
 * (security review L3) so the sim and the server cannot drift on the exact
 * boundary at which a fill earns anything. Re-exported here because this
 * module is the policy surface the rest of `apps/api` imports from, and
 * `WHALE_SOL`/`WHALE_ETH` env overrides still resolve against these defaults.
 */
export { DEFAULT_DUST, DEFAULT_WHALE_CUT } from '@stonkz/shared';

/** Achievements the ledger can unlock, with the XP each pays (from `ACH`). */
export const UNLOCKABLE: readonly AchievementKey[] = [
  'first',
  'whale',
  'deploy',
  'cashback',
  'stake',
  'crate',
  'diamond',
  'grad',
  'social',
  'streak7',
];

/** Streak length at which `streak7` unlocks. `index.html:2164` */
export const STREAK7_AT = 7;
