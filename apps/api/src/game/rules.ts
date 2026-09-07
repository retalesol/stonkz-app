import type { AchievementKey, Net } from '@stonkz/shared';

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
  /** `addXP(max(5, round(sol*40)), "TRADE")` — index.html:1974 */
  trade: 'trade',
  /** `addXP(150, "COIN LAUNCH")` — index.html:3967 */
  launch: 'launch',
  /** `addXP(max(10, round(tot*30)), "FEE CLAIM")` — index.html:3047 */
  feeClaim: 'fee_claim',
  /** `addXP(max(5, round(amt/circ*400)), "STAKE")` — index.html:3177 */
  stake: 'stake',
  /** `addXP(12, "STAKE CLAIM")` — index.html:3203 */
  stakeClaim: 'stake_claim',
  /** `addXP(6, "FOLLOW")` — index.html:3270 */
  follow: 'follow',
  /** `addXP(8, "WALL POST")` — index.html:3332 */
  wallPost: 'wall_post',
  /** `addXP(20 + tierIndex*15, k + " CRATE")` — index.html:2383 */
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
 * The `whale` cut, in native units.
 *
 * `index.html:1973` is `if (buy && sol >= 5) unlock("whale")` — five SOL. The
 * plan (step 109) asks for the ETH equivalent to be documented in
 * `packages/shared`; that package is owned by another track this cycle, so the
 * value lives here and is env-overridable via `WHALE_SOL` / `WHALE_ETH`.
 * 2 ETH is the chosen cut: at the frozen oracle prices in the test fixtures
 * (SOL $214.08, ETH $4200) five SOL is ~$1070 and two ETH is ~$8400, so this
 * is deliberately *not* USD-parity — it keeps the achievement rare on a chain
 * whose gas token is ~20x the price, rather than making it 20x easier.
 *
 * See the final report: this constant wants to move to `packages/shared`.
 */
export const DEFAULT_WHALE_CUT: Record<Net, number> = { SOL: 5, RH: 2 };

/**
 * Dust floor, in native units. Below this a fill awards nothing at all — no
 * XP, no SP, and no achievement unlock either, since a 0.000001 SOL trade
 * earning FIRST BLOOD is exactly the farm the cap is meant to stop.
 *
 * The event is still recorded (with `amount = 0`) so a replay cannot later
 * decide the same fill is worth paying for.
 */
export const DEFAULT_DUST: Record<Net, number> = { SOL: 0.01, RH: 0.0005 };

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
