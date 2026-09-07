import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * The whole persistence surface for Phases 1 and 3.
 *
 * Identity is always the pair `(net, wallet)`: the same human holds a
 * different address on Solana and on Robinhood, and the plan's "switching nets
 * does not mix balances" gate falls out of that key. Every SQL migration in
 * `apps/api/drizzle` is the source of truth for DDL; this file is the typed
 * mirror the query layer uses, and `db/schema.test.ts` asserts the two agree.
 */

/* -------------------------------------------------------------------------- */
/* 0000 — identity, sessions, settings                                        */
/* -------------------------------------------------------------------------- */

export const users = pgTable(
  'users',
  {
    net: text('net').notNull(),
    wallet: text('wallet').notNull(),
    username: text('username'),
    bio: text('bio'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.net, t.wallet] })],
);

export const authNonces = pgTable(
  'auth_nonces',
  {
    nonce: text('nonce').primaryKey(),
    net: text('net').notNull(),
    domain: text('domain').notNull(),
    statement: text('statement').notNull(),
    issuedAt: timestamp('issued_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    consumedBy: text('consumed_by'),
  },
  (t) => [index('auth_nonces_expires_idx').on(t.expiresAt)],
);

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    net: text('net').notNull(),
    wallet: text('wallet').notNull(),
    /** SHA-256 of the refresh token. The raw token never touches the database. */
    refreshHash: text('refresh_hash').notNull(),
    issuedAt: timestamp('issued_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    userAgent: text('user_agent'),
    ip: text('ip'),
  },
  (t) => [
    uniqueIndex('sessions_refresh_hash_uq').on(t.refreshHash),
    index('sessions_wallet_idx').on(t.net, t.wallet),
  ],
);

export const settings = pgTable(
  'settings',
  {
    net: text('net').notNull(),
    wallet: text('wallet').notNull(),
    slip: doublePrecision('slip').notNull().default(1.5),
    prio: doublePrecision('prio').notNull().default(0.0005),
    mev: text('mev').notNull().default('SHIELD'),
    mevTip: doublePrecision('mev_tip').notNull().default(0.001),
    cap: doublePrecision('cap').notNull().default(5),
    defBuy: doublePrecision('def_buy').notNull().default(0.5),
    confirm: boolean('confirm').notNull().default(true),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.net, t.wallet] })],
);

/* -------------------------------------------------------------------------- */
/* 0001 — indexer read path                                                   */
/* -------------------------------------------------------------------------- */

export const tokens = pgTable(
  'tokens',
  {
    net: text('net').notNull(),
    sym: text('sym').notNull(),
    name: text('name').notNull(),
    descr: text('descr').notNull().default(''),
    creator: text('creator').notNull(),
    baseSymbol: text('base_symbol').notNull(),
    baseMint: text('base_mint').notNull(),
    supply: doublePrecision('supply').notNull(),
    /** Creator-set curve fee in basis points, 100–500. */
    feeBps: integer('fee_bps').notNull(),
    cashback: boolean('cashback').notNull().default(false),
    /** Epoch ms the cashback window opened; `effFee()` decays from it. */
    cbStartMs: bigint('cb_start_ms', { mode: 'number' }),
    mc: doublePrecision('mc').notNull().default(0),
    lastMc: doublePrecision('last_mc').notNull().default(0),
    chg: doublePrecision('chg').notNull().default(0),
    holders: integer('holders').notNull().default(0),
    replies: integer('replies').notNull().default(0),
    lane: text('lane').notNull().default('new'),
    graduatedAt: timestamp('graduated_at', { withTimezone: true }),
    /** Deterministic seed for the pixel avatar, mirrored from the sim. */
    seed: bigint('seed', { mode: 'number' }).notNull(),
    xHandle: text('x_handle'),
    website: text('website'),
    telegram: text('telegram'),
    launchedAt: timestamp('launched_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.net, t.sym] }),
    index('tokens_lane_idx').on(t.net, t.lane),
    index('tokens_mc_idx').on(t.net, t.mc),
    index('tokens_creator_idx').on(t.net, t.creator),
  ],
);

export const trades = pgTable(
  'trades',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    net: text('net').notNull(),
    sym: text('sym').notNull(),
    txSig: text('tx_sig').notNull(),
    logIndex: integer('log_index').notNull().default(0),
    side: text('side').notNull(),
    trader: text('trader').notNull(),
    /** Native notional — SOL on Solana, ETH on Robinhood. Awards weight on this. */
    nativeAmount: doublePrecision('native_amount').notNull(),
    baseAmount: doublePrecision('base_amount').notNull(),
    tokenAmount: doublePrecision('token_amount').notNull(),
    usdValue: doublePrecision('usd_value').notNull(),
    mc: doublePrecision('mc').notNull(),
    price: doublePrecision('price').notNull(),
    cashback: boolean('cashback').notNull().default(false),
    blockTime: timestamp('block_time', { withTimezone: true }).notNull(),
    chainPosition: bigint('chain_position', { mode: 'number' }).notNull(),
  },
  (t) => [
    uniqueIndex('trades_sig_uq').on(t.net, t.txSig, t.logIndex),
    index('trades_token_time_idx').on(t.net, t.sym, t.blockTime),
    index('trades_time_idx').on(t.blockTime),
    index('trades_trader_idx').on(t.net, t.trader, t.blockTime),
  ],
);

export const candles = pgTable(
  'candles',
  {
    net: text('net').notNull(),
    sym: text('sym').notNull(),
    /** 1m | 5m | 15m | 1h | 4h | 1d */
    tf: text('tf').notNull(),
    bucketStart: timestamp('bucket_start', { withTimezone: true }).notNull(),
    o: doublePrecision('o').notNull(),
    h: doublePrecision('h').notNull(),
    l: doublePrecision('l').notNull(),
    c: doublePrecision('c').notNull(),
    /** USD volume. */
    v: doublePrecision('v').notNull().default(0),
    nativeVolume: doublePrecision('native_volume').notNull().default(0),
    trades: integer('trades').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.net, t.sym, t.tf, t.bucketStart] })],
);

export const holdersSnapshot = pgTable(
  'holders_snapshot',
  {
    net: text('net').notNull(),
    sym: text('sym').notNull(),
    wallet: text('wallet').notNull(),
    tokenAmount: doublePrecision('token_amount').notNull().default(0),
    /** Cost basis recorded in the native unit, per the plan's step 98. */
    costNative: doublePrecision('cost_native').notNull().default(0),
    realizedNative: doublePrecision('realized_native').notNull().default(0),
    firstSeen: timestamp('first_seen', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.net, t.sym, t.wallet] }),
    index('holders_by_token_idx').on(t.net, t.sym, t.tokenAmount),
    index('holders_by_wallet_idx').on(t.net, t.wallet),
  ],
);

export const koth = pgTable('koth', {
  net: text('net').primaryKey(),
  sym: text('sym').notNull(),
  mc: doublePrecision('mc').notNull(),
  crownedAt: timestamp('crowned_at', { withTimezone: true }).notNull().defaultNow(),
});

export const tape = pgTable(
  'tape',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    net: text('net').notNull(),
    sym: text('sym').notNull(),
    side: text('side').notNull(),
    trader: text('trader').notNull(),
    nativeAmount: doublePrecision('native_amount').notNull(),
    tokenAmount: doublePrecision('token_amount').notNull(),
    usdValue: doublePrecision('usd_value').notNull(),
    mc: doublePrecision('mc').notNull(),
    cashback: boolean('cashback').notNull().default(false),
    txSig: text('tx_sig').notNull(),
    logIndex: integer('log_index').notNull().default(0),
    blockTime: timestamp('block_time', { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex('tape_sig_uq').on(t.net, t.txSig, t.logIndex),
    index('tape_time_idx').on(t.blockTime),
  ],
);

export const treasuries = pgTable(
  'treasuries',
  {
    net: text('net').notNull(),
    /** `protocol` (the 20%) or `stonkz_ops` (the 10%). Never claimable by users. */
    kind: text('kind').notNull(),
    nativeBalance: doublePrecision('native_balance').notNull().default(0),
    lifetimeCredited: doublePrecision('lifetime_credited').notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.net, t.kind] })],
);

export const treasuryCredits = pgTable(
  'treasury_credits',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    net: text('net').notNull(),
    kind: text('kind').notNull(),
    sym: text('sym'),
    amount: doublePrecision('amount').notNull(),
    txSig: text('tx_sig').notNull(),
    logIndex: integer('log_index').notNull().default(0),
    blockTime: timestamp('block_time', { withTimezone: true }).notNull(),
  },
  (t) => [uniqueIndex('treasury_credits_sig_uq').on(t.net, t.kind, t.txSig, t.logIndex)],
);

export const creatorVaults = pgTable(
  'creator_vaults',
  {
    net: text('net').notNull(),
    sym: text('sym').notNull(),
    creator: text('creator').notNull(),
    /** The 70% bucket, minus whatever the memecoin stakers have peeled off. */
    unclaimedNative: doublePrecision('unclaimed_native').notNull().default(0),
    unclaimedTokens: doublePrecision('unclaimed_tokens').notNull().default(0),
    stakerPoolNative: doublePrecision('staker_pool_native').notNull().default(0),
    lifetimeNative: doublePrecision('lifetime_native').notNull().default(0),
    claimedNative: doublePrecision('claimed_native').notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.net, t.sym] }), index('creator_vaults_creator_idx').on(t.net, t.creator)],
);

export const stakePositions = pgTable(
  'stake_positions',
  {
    net: text('net').notNull(),
    sym: text('sym').notNull(),
    wallet: text('wallet').notNull(),
    amount: doublePrecision('amount').notNull().default(0),
    lockDays: integer('lock_days').notNull().default(0),
    mult: doublePrecision('mult').notNull().default(1),
    untilMs: bigint('until_ms', { mode: 'number' }).notNull().default(0),
    rewardNative: doublePrecision('reward_native').notNull().default(0),
    rewardTokens: doublePrecision('reward_tokens').notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.net, t.sym, t.wallet] }), index('stake_by_wallet_idx').on(t.net, t.wallet)],
);

/**
 * Append-only log of everything the indexer accepted from a chain. The ledger
 * refuses to award XP for a chain reason unless the matching row exists here,
 * which is what makes "no XP without a verified event" enforceable.
 */
export const chainEvents = pgTable(
  'chain_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    net: text('net').notNull(),
    kind: text('kind').notNull(),
    sym: text('sym'),
    wallet: text('wallet'),
    txSig: text('tx_sig').notNull(),
    logIndex: integer('log_index').notNull().default(0),
    chainPosition: bigint('chain_position', { mode: 'number' }).notNull(),
    blockTime: timestamp('block_time', { withTimezone: true }).notNull(),
    payload: jsonb('payload').notNull(),
    ingestedAt: timestamp('ingested_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('chain_events_sig_uq').on(t.net, t.txSig, t.logIndex, t.kind),
    index('chain_events_cursor_idx').on(t.net, t.chainPosition),
  ],
);

export const indexerCursors = pgTable('indexer_cursors', {
  /** One row per chain: the Solana slot cursor and the EVM block cursor. */
  net: text('net').primaryKey(),
  position: bigint('position', { mode: 'number' }).notNull().default(0),
  chainHead: bigint('chain_head', { mode: 'number' }).notNull().default(0),
  lastEventAt: timestamp('last_event_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/* -------------------------------------------------------------------------- */
/* 0002 — the game ledger                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Append-only. Nothing ever updates or deletes a row here; `balances` is a
 * materialised fold of this table plus `crate_opens`.
 */
export const xpEvents = pgTable(
  'xp_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    wallet: text('wallet').notNull(),
    net: text('net').notNull(),
    /** Post-streak-multiplier, post-cap. This is what landed in `balances.xp`. */
    amount: integer('amount').notNull(),
    /** Pre-multiplier award, kept so the cap and the multiplier stay auditable. */
    baseAmount: integer('base_amount').notNull(),
    reason: text('reason').notNull(),
    txSig: text('tx_sig'),
    sym: text('sym'),
    dayUtc: date('day_utc').notNull(),
    meta: jsonb('meta').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // The plan's step-101 constraint: replayed chain events cannot double-pay.
    uniqueIndex('xp_events_sig_reason_uq')
      .on(t.wallet, t.txSig, t.reason)
      .where(sql`${t.txSig} is not null`),
    index('xp_events_day_idx').on(t.wallet, t.net, t.dayUtc),
    index('xp_events_recent_idx').on(t.wallet, t.net, t.id),
  ],
);

export const balances = pgTable(
  'balances',
  {
    wallet: text('wallet').notNull(),
    net: text('net').notNull(),
    xp: bigint('xp', { mode: 'number' }).notNull().default(0),
    /** Stonk Pointz. */
    sp: bigint('sp', { mode: 'number' }).notNull().default(0),
    /** Stonk Optionz — what crate `S` drops pay instead of `$STONKZ`. */
    optionz: bigint('optionz', { mode: 'number' }).notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.wallet, t.net] })],
);

export const balanceLedger = pgTable(
  'balance_ledger',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    wallet: text('wallet').notNull(),
    net: text('net').notNull(),
    /** XP | SP | OPTIONZ */
    asset: text('asset').notNull(),
    delta: bigint('delta', { mode: 'number' }).notNull(),
    balanceAfter: bigint('balance_after', { mode: 'number' }).notNull(),
    reason: text('reason').notNull(),
    refType: text('ref_type'),
    refId: text('ref_id'),
    dayUtc: date('day_utc').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('balance_ledger_wallet_idx').on(t.wallet, t.net, t.id)],
);

export const streaks = pgTable(
  'streaks',
  {
    wallet: text('wallet').notNull(),
    net: text('net').notNull(),
    count: integer('count').notNull().default(0),
    /** Server UTC day only — never the client's calendar. */
    lastDayUtc: date('last_day_utc'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.wallet, t.net] })],
);

export const achievements = pgTable(
  'achievements',
  {
    wallet: text('wallet').notNull(),
    net: text('net').notNull(),
    key: text('key').notNull(),
    unlockedAt: timestamp('unlocked_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.wallet, t.net, t.key] })],
);

export const crateState = pgTable(
  'crate_state',
  {
    wallet: text('wallet').notNull(),
    net: text('net').notNull(),
    tier: text('tier').notNull(),
    /** Cooldown gate. Server clock only; the client cannot move this. */
    readyAt: timestamp('ready_at', { withTimezone: true }).notNull().defaultNow(),
    opens: integer('opens').notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.wallet, t.net, t.tier] })],
);

export const crateOpens = pgTable(
  'crate_opens',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    wallet: text('wallet').notNull(),
    net: text('net').notNull(),
    tier: text('tier').notNull(),
    /** HMAC(serverSecret, wallet|net|tier|nonce) — the auditable roll commitment. */
    rollCommit: text('roll_commit').notNull(),
    serverSeedHash: text('server_seed_hash').notNull(),
    clientNonce: text('client_nonce').notNull(),
    rollValue: doublePrecision('roll_value').notNull(),
    amountRoll: doublePrecision('amount_roll').notNull(),
    dropIndex: integer('drop_index').notNull(),
    rarity: text('rarity').notNull(),
    payloadJson: jsonb('payload_json').notNull(),
    optionzAwarded: bigint('optionz_awarded', { mode: 'number' }).notNull().default(0),
    itemKey: text('item_key'),
    xpAwarded: integer('xp_awarded').notNull().default(0),
    openedAt: timestamp('opened_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('crate_opens_commit_uq').on(t.wallet, t.net, t.rollCommit),
    index('crate_opens_recent_idx').on(t.wallet, t.net, t.id),
  ],
);

/** Crate `I` drops land here as flags rather than as a balance. */
export const itemFlags = pgTable(
  'item_flags',
  {
    wallet: text('wallet').notNull(),
    net: text('net').notNull(),
    item: text('item').notNull(),
    count: integer('count').notNull().default(1),
    grantedAt: timestamp('granted_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
  },
  (t) => [primaryKey({ columns: [t.wallet, t.net, t.item] })],
);
