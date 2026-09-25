import { AnchorEventCoder, type EventLayout } from './anchor.js';
import type { BorshReader } from './borsh.js';

/**
 * Every `#[event]` in `programs/solana/programs/launchpad/src/events.rs`,
 * transcribed field-for-field and in declaration order.
 *
 * Field order *is* the wire format — Borsh has no field names — so these
 * layouts must stay in lockstep with that file. `solana-events.test.ts`
 * re-encodes each struct from the Rust declaration and round-trips it through
 * this coder, so a reordered or retyped field in `events.rs` fails a test
 * rather than silently shifting every subsequent field.
 *
 * Amounts stay `bigint` here. Converting to the read tables' `double` happens
 * once, later, in `market.ts` — decoding must not lose precision it cannot get
 * back.
 */

export interface SolTokenCreated {
  kind: 'TokenCreated';
  mint: string;
  baseMint: string;
  creator: string;
  ticker: string;
  supply: bigint;
  feeBps: number;
  cashback: boolean;
  cbStart: bigint;
  virtualBase: bigint;
  virtualToken: bigint;
  tokensForSale: bigint;
  lpReserve: bigint;
  gradMcapBase: bigint;
  basePrice1e6: bigint;
  ts: bigint;
}

export interface SolTrade {
  kind: 'Trade';
  mint: string;
  trader: string;
  isBuy: boolean;
  baseAmount: bigint;
  tokenAmount: bigint;
  effFeeBps: number;
  inCashback: boolean;
  feeTotal: bigint;
  feeProtocol: bigint;
  feeOps: bigint;
  feeCreatorBucket: bigint;
  feeStakers: bigint;
  feeCreator: bigint;
  cashbackTokens: bigint;
  virtualBase: bigint;
  virtualToken: bigint;
  realBase: bigint;
  realToken: bigint;
  circulating: bigint;
  ts: bigint;
}

export interface SolFeeAccrued {
  kind: 'FeeAccrued';
  mint: string;
  baseMint: string;
  feeTotal: bigint;
  protocol: bigint;
  ops: bigint;
  creatorBucket: bigint;
  ts: bigint;
}

export interface SolTreasuryCredit {
  kind: 'TreasuryCredit';
  baseMint: string;
  protocolDelta: bigint;
  opsDelta: bigint;
  ts: bigint;
}

export interface SolGraduated {
  kind: 'Graduated';
  mint: string;
  baseMint: string;
  reason: number;
  baseMigrated: bigint;
  tokensMigrated: bigint;
  tokensBurned: bigint;
  mcapBase: bigint;
  mcapUsd1e6: bigint;
  ts: bigint;
}

export interface SolLiquidityMigrated {
  kind: 'LiquidityMigrated';
  mint: string;
  baseMint: string;
  pool: string;
  /** DLMM PositionV2 account (formerly Raydium LP mint). */
  position: string;
  baseDeposited: bigint;
  tokenDeposited: bigint;
  lockReleasePoint: bigint;
  positionLocked: bigint;
  ts: bigint;
}

export interface SolCreatorFeesClaimed {
  kind: 'CreatorFeesClaimed';
  mint: string;
  creator: string;
  baseAmount: bigint;
  tokenAmount: bigint;
  ts: bigint;
}

export interface SolStaked {
  kind: 'Staked';
  mint: string;
  owner: string;
  amount: bigint;
  lockDays: number;
  weight: bigint;
  lockUntil: bigint;
  eligibleStaked: bigint;
  totalWeight: bigint;
  ts: bigint;
}

export interface SolUnstaked {
  kind: 'Unstaked';
  mint: string;
  owner: string;
  amount: bigint;
  eligibleStaked: bigint;
  totalWeight: bigint;
  ts: bigint;
}

export interface SolStakeClaimed {
  kind: 'StakeClaimed';
  mint: string;
  owner: string;
  baseAmount: bigint;
  tokenAmount: bigint;
  ts: bigint;
}

export interface SolTreasuryWithdrawn {
  kind: 'TreasuryWithdrawn';
  baseMint: string;
  which: number;
  amount: bigint;
  destination: string;
  ts: bigint;
}

export type SolanaLaunchpadEvent =
  | SolTokenCreated
  | SolTrade
  | SolFeeAccrued
  | SolTreasuryCredit
  | SolGraduated
  | SolLiquidityMigrated
  | SolCreatorFeesClaimed
  | SolStaked
  | SolUnstaked
  | SolStakeClaimed
  | SolTreasuryWithdrawn;

const layouts: readonly EventLayout<SolanaLaunchpadEvent>[] = [
  {
    name: 'TokenCreated',
    read: (r: BorshReader): SolTokenCreated => ({
      kind: 'TokenCreated',
      mint: r.pubkey(),
      baseMint: r.pubkey(),
      creator: r.pubkey(),
      ticker: r.string(),
      supply: r.u64(),
      feeBps: r.u16(),
      cashback: r.bool(),
      cbStart: r.i64(),
      virtualBase: r.u128(),
      virtualToken: r.u128(),
      tokensForSale: r.u64(),
      lpReserve: r.u64(),
      gradMcapBase: r.u128(),
      basePrice1e6: r.u64(),
      ts: r.i64(),
    }),
  },
  {
    name: 'Trade',
    read: (r: BorshReader): SolTrade => ({
      kind: 'Trade',
      mint: r.pubkey(),
      trader: r.pubkey(),
      isBuy: r.bool(),
      baseAmount: r.u64(),
      tokenAmount: r.u64(),
      effFeeBps: r.u16(),
      inCashback: r.bool(),
      feeTotal: r.u64(),
      feeProtocol: r.u64(),
      feeOps: r.u64(),
      feeCreatorBucket: r.u64(),
      feeStakers: r.u64(),
      feeCreator: r.u64(),
      cashbackTokens: r.u64(),
      virtualBase: r.u128(),
      virtualToken: r.u128(),
      realBase: r.u64(),
      realToken: r.u64(),
      circulating: r.u64(),
      ts: r.i64(),
    }),
  },
  {
    name: 'FeeAccrued',
    read: (r: BorshReader): SolFeeAccrued => ({
      kind: 'FeeAccrued',
      mint: r.pubkey(),
      baseMint: r.pubkey(),
      feeTotal: r.u64(),
      protocol: r.u64(),
      ops: r.u64(),
      creatorBucket: r.u64(),
      ts: r.i64(),
    }),
  },
  {
    name: 'TreasuryCredit',
    read: (r: BorshReader): SolTreasuryCredit => ({
      kind: 'TreasuryCredit',
      baseMint: r.pubkey(),
      protocolDelta: r.u64(),
      opsDelta: r.u64(),
      ts: r.i64(),
    }),
  },
  {
    name: 'Graduated',
    read: (r: BorshReader): SolGraduated => ({
      kind: 'Graduated',
      mint: r.pubkey(),
      baseMint: r.pubkey(),
      reason: r.u8(),
      baseMigrated: r.u64(),
      tokensMigrated: r.u64(),
      tokensBurned: r.u64(),
      mcapBase: r.u128(),
      mcapUsd1e6: r.u128(),
      ts: r.i64(),
    }),
  },
  {
    name: 'LiquidityMigrated',
    read: (r: BorshReader): SolLiquidityMigrated => ({
      kind: 'LiquidityMigrated',
      mint: r.pubkey(),
      baseMint: r.pubkey(),
      pool: r.pubkey(),
      position: r.pubkey(),
      baseDeposited: r.u64(),
      tokenDeposited: r.u64(),
      lockReleasePoint: r.u64(),
      positionLocked: r.u64(),
      ts: r.i64(),
    }),
  },
  {
    name: 'CreatorFeesClaimed',
    read: (r: BorshReader): SolCreatorFeesClaimed => ({
      kind: 'CreatorFeesClaimed',
      mint: r.pubkey(),
      creator: r.pubkey(),
      baseAmount: r.u64(),
      tokenAmount: r.u64(),
      ts: r.i64(),
    }),
  },
  {
    name: 'Staked',
    read: (r: BorshReader): SolStaked => ({
      kind: 'Staked',
      mint: r.pubkey(),
      owner: r.pubkey(),
      amount: r.u64(),
      lockDays: r.u16(),
      weight: r.u128(),
      lockUntil: r.i64(),
      eligibleStaked: r.u64(),
      totalWeight: r.u128(),
      ts: r.i64(),
    }),
  },
  {
    name: 'Unstaked',
    read: (r: BorshReader): SolUnstaked => ({
      kind: 'Unstaked',
      mint: r.pubkey(),
      owner: r.pubkey(),
      amount: r.u64(),
      eligibleStaked: r.u64(),
      totalWeight: r.u128(),
      ts: r.i64(),
    }),
  },
  {
    name: 'StakeClaimed',
    read: (r: BorshReader): SolStakeClaimed => ({
      kind: 'StakeClaimed',
      mint: r.pubkey(),
      owner: r.pubkey(),
      baseAmount: r.u64(),
      tokenAmount: r.u64(),
      ts: r.i64(),
    }),
  },
  {
    name: 'TreasuryWithdrawn',
    read: (r: BorshReader): SolTreasuryWithdrawn => ({
      kind: 'TreasuryWithdrawn',
      baseMint: r.pubkey(),
      which: r.u8(),
      amount: r.u64(),
      destination: r.pubkey(),
      ts: r.i64(),
    }),
  },
];

export const LAUNCHPAD_EVENT_LAYOUTS = layouts;

/** The launchpad's event coder. Stateless and safe to share. */
export const launchpadEventCoder = new AnchorEventCoder<SolanaLaunchpadEvent>(layouts);
