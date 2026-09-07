import { FEE_SPLIT, splitFee, type Net } from '@stonkz/shared';

/**
 * The chain event schema (plan step 55).
 *
 * This is the contract between the on-chain programs and everything
 * server-side. It is defined here *before* the programs exist so the API, the
 * read tables and their tests can be driven by the fixture producer in
 * `fixtures/producer.ts`; when the Anchor and Solidity events land, only the
 * decoders change, not this shape or anything downstream of it.
 *
 * Every event carries the four fields that make it replayable and
 * deduplicable: the chain it came from, its transaction signature, its log
 * index within that transaction, and its position in the chain (a Solana slot
 * or an EVM block number).
 */
export interface EventBase {
  net: Net;
  /** Transaction signature (Solana) or hash (EVM). */
  txSig: string;
  /** Index within the transaction — a single tx can emit several events. */
  logIndex: number;
  /** Solana slot or EVM block number. Drives the replay cursor. */
  chainPosition: number;
  blockTimeMs: number;
}

/**
 * The curve state a chain-sourced launch carries, in the exact string form
 * `tokens`' curve columns store (atoms past `bigint`'s range — see the schema
 * comment on `tokens.curveK`).
 *
 * Optional on the event because the fixture producer has no curve to describe;
 * a fixture-sourced `tokens` row keeps its `'0'` defaults and `/quote` falls
 * back to the indicative approximation, exactly as before this phase.
 */
export interface CurveSnapshot {
  tokenDecimals: number;
  baseDecimals: number;
  basePriceUsd1e6: string;
  tokensForSale: string;
  virtualBase0: string;
  virtualToken0: string;
  k: string;
  realBase: string;
  realToken: string;
  gradMcapBase: string;
}

/** A fair launch. */
export interface TokenCreatedEvent extends EventBase {
  kind: 'TokenCreated';
  /** The launched token's own address (SPL mint / ERC-20). Chain sources only. */
  mint?: string;
  /** Real curve parameters, when the source decoded them from the program. */
  curve?: CurveSnapshot;
  sym: string;
  name: string;
  descr: string;
  creator: string;
  /** The curve's pair — SOL, ETH, USDC, AAPLx … */
  baseSymbol: string;
  baseMint: string;
  supply: number;
  /** Creator-set curve fee in basis points, 100–500. */
  feeBps: number;
  cashback: boolean;
  seed: number;
  /** Market cap right after the (optional) dev buy. */
  mc: number;
  xHandle?: string;
  website?: string;
  telegram?: string;
}

/** A curve fill. `nativeAmount` is the ticket the user actually paid. */
export interface TradeEvent extends EventBase {
  kind: 'Trade';
  sym: string;
  trader: string;
  side: 'buy' | 'sell';
  /** SOL on Solana, ETH on Robinhood. All game weighting uses this. */
  nativeAmount: number;
  /** The base-mint leg of the curve hop. */
  baseAmount: number;
  tokenAmount: number;
  usdValue: number;
  /** Market cap after the fill. */
  mc: number;
  /** Filled inside a cashback window. */
  cashback: boolean;
  /**
   * Post-fill real reserves, in atoms, when the source decoded them. Keeps
   * `tokens`' curve columns live instead of frozen at the last
   * `/trade/prepare` — the staleness caveat in `router/curve-state.ts`.
   */
  realBase?: string;
  realToken?: string;
}

/** $69K market cap reached; reserves migrated and LP burned. */
export interface GraduatedEvent extends EventBase {
  kind: 'Graduated';
  sym: string;
  mc: number;
  poolAddress?: string;
}

/**
 * The fee split, as the program settled it. Carries all three legs
 * (20% protocol / 70% creator bucket / 10% `$STONKZ` ops) so the indexer can
 * check the on-chain arithmetic rather than recomputing and trusting itself.
 */
export interface FeeAccruedEvent extends EventBase {
  kind: 'FeeAccrued';
  sym: string;
  creator: string;
  /** Total curve fee taken on this fill, in the native unit. */
  feeAmount: number;
  protocol: number;
  creatorBucket: number;
  stonkzOps: number;
  /** Portion of the creator bucket peeled to that coin's stakers (Phase 4). */
  stakerShare: number;
  /** During a cashback window the creator's 70% arrives as tokens. */
  creatorTokens: number;
}

export interface StakedEvent extends EventBase {
  kind: 'Staked';
  sym: string;
  wallet: string;
  amount: number;
  lockDays: number;
  mult: number;
  untilMs: number;
  /** Circulating supply at stake time — `xpForStake` weights against it. */
  circulating: number;
}

export interface UnstakedEvent extends EventBase {
  kind: 'Unstaked';
  sym: string;
  wallet: string;
  amount: number;
}

export interface StakeClaimedEvent extends EventBase {
  kind: 'StakeClaimed';
  sym: string;
  wallet: string;
  rewardNative: number;
  rewardTokens: number;
}

/** Opens or closes the 5-minute launch window. */
export interface CashbackWindowEvent extends EventBase {
  kind: 'CashbackWindow';
  sym: string;
  open: boolean;
  startedAtMs: number;
  baseFeeBps: number;
  startFeeBps: number;
}

/**
 * A credit into a protocol or ops vault that did not come from a curve fill
 * (or a periodic reconciliation of one that did).
 */
export interface TreasuryCreditEvent extends EventBase {
  kind: 'TreasuryCredit';
  vault: 'protocol' | 'stonkz_ops';
  sym: string | null;
  amount: number;
}

/**
 * `claim_creator_fees()`. Not named in step 55, which lists the accrual side —
 * but the ledger's rule 111 (`XP max(10, round(native*30))`) needs a verified
 * event to hang off, so the claim is part of the schema too.
 */
export interface CreatorFeesClaimedEvent extends EventBase {
  kind: 'CreatorFeesClaimed';
  sym: string;
  creator: string;
  nativeAmount: number;
  tokenAmount: number;
}

export type ChainEvent =
  | TokenCreatedEvent
  | TradeEvent
  | GraduatedEvent
  | FeeAccruedEvent
  | StakedEvent
  | UnstakedEvent
  | StakeClaimedEvent
  | CashbackWindowEvent
  | TreasuryCreditEvent
  | CreatorFeesClaimedEvent;

export type ChainEventKind = ChainEvent['kind'];

export const EVENT_KINDS: readonly ChainEventKind[] = [
  'TokenCreated',
  'Trade',
  'Graduated',
  'FeeAccrued',
  'Staked',
  'Unstaked',
  'StakeClaimed',
  'CashbackWindow',
  'TreasuryCredit',
  'CreatorFeesClaimed',
];

/** Chain order within a batch: position, then transaction, then log index. */
export function compareEvents(a: ChainEvent, b: ChainEvent): number {
  if (a.chainPosition !== b.chainPosition) return a.chainPosition - b.chainPosition;
  if (a.txSig !== b.txSig) return a.txSig < b.txSig ? -1 : 1;
  return a.logIndex - b.logIndex;
}

export class EventIntegrityError extends Error {
  constructor(
    readonly event: ChainEvent,
    message: string,
  ) {
    super(`${event.kind} ${event.net}/${event.txSig}#${event.logIndex}: ${message}`);
    this.name = 'EventIntegrityError';
  }
}

/** Rounding tolerance for the split check, in native units. */
const SPLIT_EPSILON = 1e-9;

/**
 * Rejects a `FeeAccrued` whose legs do not add up to the 20/70/10 split.
 *
 * The programs settle the split on-chain and the client never computes it, so
 * a mismatch here means either a program bug or a decoder bug — both of which
 * must stop ingest rather than quietly skew the treasuries.
 */
export function assertFeeSplit(event: FeeAccruedEvent): void {
  const expected = splitFee(event.feeAmount);
  const legs: [keyof typeof expected, number][] = [
    ['protocol', event.protocol],
    ['creatorBucket', event.creatorBucket],
    ['stonkzOps', event.stonkzOps],
  ];
  for (const [leg, actual] of legs) {
    if (Math.abs(actual - expected[leg]) > SPLIT_EPSILON) {
      throw new EventIntegrityError(
        event,
        `${leg} is ${actual}, expected ${expected[leg]} (${FEE_SPLIT[leg] * 100}% of ${event.feeAmount})`,
      );
    }
  }
  const sum = event.protocol + event.creatorBucket + event.stonkzOps;
  if (Math.abs(sum - event.feeAmount) > SPLIT_EPSILON) {
    throw new EventIntegrityError(event, `legs sum to ${sum}, not ${event.feeAmount}`);
  }
  // Stakers take at most half the creator bucket — 35% of the whole fee.
  if (event.stakerShare < 0 || event.stakerShare > event.creatorBucket / 2 + SPLIT_EPSILON) {
    throw new EventIntegrityError(
      event,
      `stakerShare ${event.stakerShare} exceeds half of the creator bucket (${event.creatorBucket / 2})`,
    );
  }
}

/** Validates whatever invariants the event kind carries. */
export function assertEventIntegrity(event: ChainEvent): void {
  if (!event.txSig) throw new EventIntegrityError(event, 'missing txSig');
  if (event.chainPosition < 0) throw new EventIntegrityError(event, 'negative chainPosition');
  if (event.kind === 'FeeAccrued') assertFeeSplit(event);
  if (event.kind === 'Trade' && event.nativeAmount < 0) {
    throw new EventIntegrityError(event, 'negative nativeAmount');
  }
  if (event.kind === 'TokenCreated' && (event.feeBps < 100 || event.feeBps > 500)) {
    throw new EventIntegrityError(event, `feeBps ${event.feeBps} outside the 1.0%-5.0% slider range`);
  }
}
