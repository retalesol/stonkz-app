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
    /**
     * Phase 5.A profile fields. `avatarUrl` is optional — the default art
     * stays the address-seeded pixel avatar (`pix()`) both client-side and
     * here; a set `avatarUrl` is a user override, never required.
     */
    avatarUrl: text('avatar_url'),
    xHandle: text('x_handle'),
    website: text('website'),
    telegram: text('telegram'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.net, t.wallet] })],
  // Note: `0000_infra_core.sql` already declares a case-insensitive, global
  // `users_username_uq` unique index (`lower(username)`, not scoped to
  // `net`) plus length CHECK constraints for `username`/`bio` — plan step
  // 144's "409 on username clash". Neither is mirrored into this typed
  // layer (drizzle-orm's `pg-core` builder has no `lower()` functional-index
  // helper this repo uses elsewhere), so `routes/social.ts`'s `PATCH /me`
  // relies on `isUniqueViolation()` from the raw SQL constraint rather than
  // a duplicate declaration here.
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
    /** The launched token's own on-chain address (SPL mint / ERC-20 contract). Canonical id with `net`. */
    mint: text('mint').notNull(),
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
    /** IPFS gateway URL for the launch image (Pinata). */
    imageUrl: text('image_url'),
    launchedAt: timestamp('launched_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    /**
     * CPMM state in atoms, mirroring `@stonkz/curve-sim`'s `CurveParams` /
     * `CurveState`. `text`, not `bigint`/`numeric`: a fully-staked `k` can
     * reach ~1e31, past Postgres `bigint`'s 2^63-1 ceiling, and every
     * consumer already speaks `bigint` in TypeScript, never SQL arithmetic on
     * these columns. Defaults are `0` for rows the read-path fixtures seed
     * without curve state; `/quote` and `/trade/prepare` treat that as "no
     * curve data" and refuse to quote rather than divide by zero.
     */
    tokenDecimals: integer('token_decimals').notNull().default(6),
    baseDecimals: integer('base_decimals').notNull().default(6),
    /** Oracle snapshot at `create_token`, USD per whole base token, 1e6-scaled. */
    basePriceUsd1e6: text('base_price_usd_1e6').notNull().default('0'),
    curveTokensForSale: text('curve_tokens_for_sale').notNull().default('0'),
    curveVirtualBase0: text('curve_virtual_base0').notNull().default('0'),
    curveVirtualToken0: text('curve_virtual_token0').notNull().default('0'),
    curveK: text('curve_k').notNull().default('0'),
    /** Mutable: the pool's actual reserves, updated as fills land. */
    curveRealBase: text('curve_real_base').notNull().default('0'),
    curveRealToken: text('curve_real_token').notNull().default('0'),
    curveGradMcapBase: text('curve_grad_mcap_base').notNull().default('0'),
  },
  (t) => [
    primaryKey({ columns: [t.net, t.mint] }),
    index('tokens_lane_idx').on(t.net, t.lane),
    index('tokens_mc_idx').on(t.net, t.mc),
    index('tokens_creator_idx').on(t.net, t.creator),
    index('tokens_sym_idx').on(t.net, t.sym),
    index('tokens_launched_at_idx').on(t.net, t.launchedAt),
  ],
);

/**
 * One row per `POST /launch/prepare` call, per plan step 90–91.
 *
 * `/launch/confirm` reads this back to verify the signed transaction it is
 * handed matches — byte for byte on Solana, `to`+`data` on Robinhood — what
 * this server actually built, rather than trusting client-reported params
 * post-signature. Ticker uniqueness is an app-layer 5-minute cooldown; the
 * tokens PK is `(net, mint)`.
 */
export const launchIntents = pgTable(
  'launch_intents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    net: text('net').notNull(),
    ticker: text('ticker').notNull(),
    creator: text('creator').notNull(),
    name: text('name').notNull(),
    descr: text('descr').notNull().default(''),
    uri: text('uri').notNull().default(''),
    supply: doublePrecision('supply').notNull(),
    feeBps: integer('fee_bps').notNull(),
    cashback: boolean('cashback').notNull().default(false),
    baseSymbol: text('base_symbol').notNull(),
    baseMint: text('base_mint').notNull(),
    devBuyNative: doublePrecision('dev_buy_native').notNull().default(0),
    /** Solana: PDA of creator+salt, known pre-sign. Robinhood: null — `confirm` reads it from the `TokenCreated` log. */
    predictedMint: text('predicted_mint'),
    /** Solana `create_token` salt for mint PDA seeds `[mint, creator, salt]`. */
    mintSalt: bigint('mint_salt', { mode: 'bigint' }),
    /** Solana: the compiled message (no signatures), base64. Robinhood: the exact calldata. */
    unsignedPayload: text('unsigned_payload').notNull(),
    issuedAt: timestamp('issued_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    consumedTxSig: text('consumed_tx_sig'),
  },
  (t) => [
    index('launch_intents_lookup_idx').on(t.net, t.ticker, t.consumedAt),
    index('launch_intents_creator_idx').on(t.net, t.creator),
    index('launch_intents_expires_idx').on(t.expiresAt),
  ],
);

export const trades = pgTable(
  'trades',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    net: text('net').notNull(),
    sym: text('sym').notNull(),
    /** Canonical token id when known (post-0009). */
    mint: text('mint'),
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
    index('trades_mint_time_idx').on(t.net, t.mint, t.blockTime),
    index('trades_time_idx').on(t.blockTime),
    index('trades_trader_idx').on(t.net, t.trader, t.blockTime),
  ],
);

export const candles = pgTable(
  'candles',
  {
    net: text('net').notNull(),
    sym: text('sym').notNull(),
    mint: text('mint').notNull(),
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
  (t) => [primaryKey({ columns: [t.net, t.mint, t.tf, t.bucketStart] })],
);

export const holdersSnapshot = pgTable(
  'holders_snapshot',
  {
    net: text('net').notNull(),
    sym: text('sym').notNull(),
    mint: text('mint').notNull(),
    wallet: text('wallet').notNull(),
    tokenAmount: doublePrecision('token_amount').notNull().default(0),
    /** Cost basis recorded in the native unit, per the plan's step 98. */
    costNative: doublePrecision('cost_native').notNull().default(0),
    realizedNative: doublePrecision('realized_native').notNull().default(0),
    firstSeen: timestamp('first_seen', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.net, t.mint, t.wallet] }),
    index('holders_by_token_idx').on(t.net, t.mint, t.tokenAmount),
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
    /** Slot/block this row was materialised from — what a reorg rollback deletes by. */
    chainPosition: bigint('chain_position', { mode: 'number' }).notNull().default(0),
  },
  (t) => [
    uniqueIndex('tape_sig_uq').on(t.net, t.txSig, t.logIndex),
    index('tape_time_idx').on(t.blockTime),
    index('tape_position_idx').on(t.net, t.chainPosition),
  ],
);

export const treasuries = pgTable(
  'treasuries',
  {
    net: text('net').notNull(),
    /** `protocol` (20%), `stonkz_ops` (the Stonkz Game buyback 10%) or `burn` (10%). Never claimable by users. */
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
    chainPosition: bigint('chain_position', { mode: 'number' }).notNull().default(0),
  },
  (t) => [
    uniqueIndex('treasury_credits_sig_uq').on(t.net, t.kind, t.txSig, t.logIndex),
    index('treasury_credits_position_idx').on(t.net, t.chainPosition),
  ],
);

export const creatorVaults = pgTable(
  'creator_vaults',
  {
    net: text('net').notNull(),
    sym: text('sym').notNull(),
    mint: text('mint').notNull(),
    creator: text('creator').notNull(),
    /** The 60% bucket, minus whatever the memecoin stakers have peeled off. */
    unclaimedNative: doublePrecision('unclaimed_native').notNull().default(0),
    unclaimedTokens: doublePrecision('unclaimed_tokens').notNull().default(0),
    stakerPoolNative: doublePrecision('staker_pool_native').notNull().default(0),
    lifetimeNative: doublePrecision('lifetime_native').notNull().default(0),
    claimedNative: doublePrecision('claimed_native').notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.net, t.mint] }),
    index('creator_vaults_creator_idx').on(t.net, t.creator),
  ],
);

export const stakePositions = pgTable(
  'stake_positions',
  {
    net: text('net').notNull(),
    sym: text('sym').notNull(),
    mint: text('mint').notNull(),
    wallet: text('wallet').notNull(),
    amount: doublePrecision('amount').notNull().default(0),
    lockDays: integer('lock_days').notNull().default(0),
    mult: doublePrecision('mult').notNull().default(1),
    untilMs: bigint('until_ms', { mode: 'number' }).notNull().default(0),
    rewardNative: doublePrecision('reward_native').notNull().default(0),
    rewardTokens: doublePrecision('reward_tokens').notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.net, t.mint, t.wallet] }),
    index('stake_by_wallet_idx').on(t.net, t.wallet),
  ],
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
    // Created in 0003 for the replay window; the reorg rollback reuses it.
    index('chain_events_replay_idx').on(t.net, t.chainPosition, t.id),
  ],
);

export const indexerCursors = pgTable('indexer_cursors', {
  /** One row per chain: the Solana slot cursor and the EVM block cursor. */
  net: text('net').primaryKey(),
  position: bigint('position', { mode: 'number' }).notNull().default(0),
  chainHead: bigint('chain_head', { mode: 'number' }).notNull().default(0),
  /**
   * Block hash (EVM) / blockhash (Solana) observed at `position`. `null` means
   * never observed — a fresh cursor, or fixture mode, which has no hashes.
   * Reorg detection compares the chain's current hash at `position` against
   * this; a mismatch is the only signal that history moved under us.
   */
  positionHash: text('position_hash'),
  /** Last committed Solana signature at `position`; the `until` cursor for `getSignaturesForAddress`. */
  positionSignature: text('position_signature'),
  /** Highest position ingest is allowed to reach, i.e. head minus the confirmation depth. */
  confirmedHead: bigint('confirmed_head', { mode: 'number' }).notNull().default(0),
  reorgs: integer('reorgs').notNull().default(0),
  lastReorgAt: timestamp('last_reorg_at', { withTimezone: true }),
  lastError: text('last_error'),
  lastErrorAt: timestamp('last_error_at', { withTimezone: true }),
  /** Consecutive failed passes at `position`; drives the dead-letter skip. */
  failedAttempts: integer('failed_attempts').notNull().default(0),
  lastEventAt: timestamp('last_event_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Where an event or a batch goes when ingest cannot make progress on it.
 *
 * Without this table an integrity-rejected event left only a log line, and an
 * uncaught exception in `apply()` re-looped the same batch forever
 * (`docs/indexer-runbooks.md` §5). Both now land here, with the payload and
 * the error, and the cursor is allowed past them.
 */
export const indexerDeadLetters = pgTable(
  'indexer_dead_letters',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    net: text('net').notNull(),
    /** `event` for a single rejected event, `batch` for a whole poison range. */
    scope: text('scope').notNull().default('event'),
    kind: text('kind').notNull(),
    txSig: text('tx_sig').notNull(),
    logIndex: integer('log_index').notNull().default(0),
    chainPosition: bigint('chain_position', { mode: 'number' }).notNull(),
    fromPosition: bigint('from_position', { mode: 'number' }).notNull().default(0),
    toPosition: bigint('to_position', { mode: 'number' }).notNull().default(0),
    payload: jsonb('payload').notNull().default({}),
    error: text('error').notNull(),
    attempts: integer('attempts').notNull().default(1),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('indexer_dead_letters_uq').on(t.net, t.txSig, t.logIndex, t.kind),
    index('indexer_dead_letters_open_idx').on(t.net, t.resolvedAt, t.id),
    index('indexer_dead_letters_position_idx').on(t.net, t.chainPosition),
  ],
);

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
    /**
     * Legacy per-tier ready gate — kept for open counts / history.
     * Live cooldown is `crate_cooldown.ready_at` (global across tiers).
     */
    readyAt: timestamp('ready_at', { withTimezone: true }).notNull().defaultNow(),
    opens: integer('opens').notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.wallet, t.net, t.tier] })],
);

/** Lifetime SP level → crate grants already applied for this wallet/net. */
export const spLevelClaims = pgTable(
  'sp_level_claims',
  {
    wallet: text('wallet').notNull(),
    net: text('net').notNull(),
    level: integer('level').notNull(),
    claimedAt: timestamp('claimed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.wallet, t.net, t.level] })],
);

/** Unopened crate inventory earned from SP levels. */
export const crateInventory = pgTable(
  'crate_inventory',
  {
    wallet: text('wallet').notNull(),
    net: text('net').notNull(),
    tier: text('tier').notNull(),
    count: integer('count').notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.wallet, t.net, t.tier] })],
);

/**
 * Global open cooldown: opening any crate locks every tier until `readyAt`.
 * Duration = that tier's `CRATES[].cd` hours.
 */
export const crateCooldown = pgTable(
  'crate_cooldown',
  {
    wallet: text('wallet').notNull(),
    net: text('net').notNull(),
    readyAt: timestamp('ready_at', { withTimezone: true }).notNull().defaultNow(),
    lastTier: text('last_tier'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.wallet, t.net] })],
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

/* -------------------------------------------------------------------------- */
/* 0006 — social layer: follows, walls, chat, X cache                         */
/* -------------------------------------------------------------------------- */

/**
 * Plan step 144. `(net, follower)` is followed by `(net, followee)` — same
 * human, different address per net, so a follow on Solana and a follow on
 * Robinhood are unrelated edges even for the same person, matching every
 * other identity key in this schema.
 */
export const follows = pgTable(
  'follows',
  {
    net: text('net').notNull(),
    follower: text('follower').notNull(),
    followee: text('followee').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.net, t.follower, t.followee] }),
    index('follows_followee_idx').on(t.net, t.followee),
  ],
);

/**
 * Plan step 147-148: one post per verified tip signature. `tipTxSig` is
 * `null` only for the profile owner's own pinned "this is your wall" state —
 * in practice every row here has one, since `POST /wall` refuses to insert
 * without a verified transfer at or above the net's minimum tip.
 */
export const wallPosts = pgTable(
  'wall_posts',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    net: text('net').notNull(),
    toWallet: text('to_wallet').notNull(),
    fromWallet: text('from_wallet').notNull(),
    text: text('text').notNull(),
    /** Native units — SOL or ETH — actually verified on-chain, never client-asserted. */
    tipNative: doublePrecision('tip_native').notNull(),
    tipTxSig: text('tip_tx_sig').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // "One post per signature" — plan step 147 — makes replaying the same
    // transfer to spam a wall a unique-constraint violation, not a policy.
    uniqueIndex('wall_posts_sig_uq').on(t.net, t.tipTxSig),
    index('wall_posts_to_idx').on(t.net, t.toWallet, t.id),
  ],
);

/**
 * Plan step 151. One room per token (`sym` upper-cased, matching the
 * frontend's `$SYM` room label minus the `$`) plus the literal room `GLOBAL`.
 * `flagged` is the moderation hook (plan step 156's "banned-word filtering or
 * a moderation flag field") — a flagged message is persisted (so a human can
 * audit it) but never replayed to new subscribers by `GET /chat/:room`.
 */
export const chatMessages = pgTable(
  'chat_messages',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    net: text('net').notNull(),
    room: text('room').notNull(),
    wallet: text('wallet').notNull(),
    text: text('text').notNull(),
    flagged: boolean('flagged').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('chat_messages_room_idx').on(t.net, t.room, t.id)],
);

/**
 * Plan step 153: a server-side cache in front of the X API v2 (or, absent
 * credentials in this environment, `social/x-provider.ts`'s placeholder),
 * keyed by lower-cased handle. `expiresAt` is the TTL gate `GET /x/:handle`
 * checks before making a fresh call.
 */
export const xProfileCache = pgTable('x_profile_cache', {
  handle: text('handle').primaryKey(),
  displayName: text('display_name'),
  avatarUrl: text('avatar_url'),
  verified: boolean('verified').notNull().default(false),
  found: boolean('found').notNull().default(true),
  fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
});

/* -------------------------------------------------------------------------- */
/* 0011 — referrals, social daily caps, wall likes                            */
/* -------------------------------------------------------------------------- */

export const referralCodes = pgTable(
  'referral_codes',
  {
    net: text('net').notNull(),
    wallet: text('wallet').notNull(),
    code: text('code').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.net, t.wallet] }),
    uniqueIndex('referral_codes_code_uq').on(t.net, t.code),
  ],
);

/** One referrer per referee. Immutable after insert. */
export const referrals = pgTable(
  'referrals',
  {
    net: text('net').notNull(),
    referee: text('referee').notNull(),
    referrer: text('referrer').notNull(),
    code: text('code').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.net, t.referee] }),
    index('referrals_referrer_idx').on(t.net, t.referrer),
  ],
);

export const referralFeeBalances = pgTable(
  'referral_fee_balances',
  {
    net: text('net').notNull(),
    wallet: text('wallet').notNull(),
    pendingNative: doublePrecision('pending_native').notNull().default(0),
    lifetimeNative: doublePrecision('lifetime_native').notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.net, t.wallet] })],
);

export const referralFeeEvents = pgTable(
  'referral_fee_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    net: text('net').notNull(),
    earner: text('earner').notNull(),
    sourceTrader: text('source_trader').notNull(),
    tier: integer('tier').notNull(),
    txSig: text('tx_sig').notNull(),
    feeAmount: doublePrecision('fee_amount').notNull(),
    payoutNative: doublePrecision('payout_native').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('referral_fee_events_uq').on(t.net, t.earner, t.txSig, t.tier)],
);

export const socialDaily = pgTable(
  'social_daily',
  {
    net: text('net').notNull(),
    wallet: text('wallet').notNull(),
    dayUtc: date('day_utc').notNull(),
    comments: integer('comments').notNull().default(0),
    likes: integer('likes').notNull().default(0),
    checkinClaimed: boolean('checkin_claimed').notNull().default(false),
  },
  (t) => [primaryKey({ columns: [t.net, t.wallet, t.dayUtc] })],
);

export const wallLikes = pgTable(
  'wall_likes',
  {
    net: text('net').notNull(),
    postId: bigint('post_id', { mode: 'number' }).notNull(),
    wallet: text('wallet').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.net, t.postId, t.wallet] }),
    index('wall_likes_wallet_idx').on(t.net, t.wallet),
  ],
);
