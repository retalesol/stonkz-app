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
  numeric,
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
    /**
     * 0023 — private profile: portfolio, PnL, recent actions, wall and follow
     * lists are owner-only. Identity (username, avatar, bio, links) and the
     * tokens this wallet created stay public.
     */
    private: boolean('private').notNull().default(false),
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
    /**
     * USD cap at the launch-time oracle snapshot (`basePriceUsd1e6`). Kept as
     * the base-proportional figure lanes, KOTH selection and graduation read,
     * and as the USD figure for rows without a curve. Live USD is
     * `mcBase × the current base price` (0027, `routes/live-base-usd.ts`).
     */
    mc: doublePrecision('mc').notNull().default(0),
    lastMc: doublePrecision('last_mc').notNull().default(0),
    /** Cap in whole base units (ETH / SOL / USDC …) after the last fill — the source of truth (0027). */
    mcBase: doublePrecision('mc_base'),
    lastMcBase: doublePrecision('last_mc_base'),
    /** 24h change, percent, measured on the coin's own curve (base terms). */
    chg: doublePrecision('chg').notNull().default(0),
    holders: integer('holders').notNull().default(0),
    replies: integer('replies').notNull().default(0),
    lane: text('lane').notNull().default('new'),
    graduatedAt: timestamp('graduated_at', { withTimezone: true }),
    /**
     * Where the graduated reserves went: the Uniswap v2 pair (EVM) or the
     * Meteora DLMM `LbPair` (Solana). `null` until `LiquidityMigrated` lands —
     * on EVM that is a second, authority-gated transaction after `Graduated`,
     * so a token can be graduated with no pool yet.
     */
    poolAddress: text('pool_address'),
    /** Meteora DLMM `PositionV2` holding the permanently locked liquidity (Solana only). */
    positionAddress: text('position_address'),
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
    /** Off-chain socials, validated at prepare and copied onto `tokens` at confirm (0019). */
    xHandle: text('x_handle'),
    website: text('website'),
    telegram: text('telegram'),
    /**
     * Solana: the pinned Metaplex metadata JSON URL written on-chain as the
     * token `uri` (0019). `uri` above stays the display image. Null on EVM,
     * or when metadata storage was unavailable and the image went on-chain.
     */
    metadataUri: text('metadata_uri'),
  },
  (t) => [
    index('launch_intents_lookup_idx').on(t.net, t.ticker, t.consumedAt),
    index('launch_intents_creator_idx').on(t.net, t.creator),
    index('launch_intents_expires_idx').on(t.expiresAt),
    // `/launch/confirm` refuses a signature another intent already consumed.
    index('launch_intents_consumed_sig_idx')
      .on(t.net, t.consumedTxSig)
      .where(sql`${t.consumedTxSig} is not null`),
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
    /** USD notional at the launch-time snapshot price — historical, never re-marked. */
    usdValue: doublePrecision('usd_value').notNull(),
    /** Cap after the fill, USD at the snapshot price (base-proportional). */
    mc: doublePrecision('mc').notNull(),
    price: doublePrecision('price').notNull(),
    /** Cap after the fill in whole base units, and base per token (0027). */
    mcBase: doublePrecision('mc_base'),
    priceBase: doublePrecision('price_base'),
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
    /** OHLC in base per token (0027); `o`–`c` are USD at the launch snapshot. */
    oBase: doublePrecision('o_base'),
    hBase: doublePrecision('h_base'),
    lBase: doublePrecision('l_base'),
    cBase: doublePrecision('c_base'),
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
  mcBase: doublePrecision('mc_base'),
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
    mcBase: doublePrecision('mc_base'),
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
    /**
     * `protocol` (15%), `buyback` (10%, the on-chain `stonkz_ops` vault) or `rwa`
     * (6%, the on-chain `burn` vault). Never claimable by users.
     */
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
    /** The 69% bucket, minus whatever the memecoin stakers have peeled off. */
    unclaimedNative: doublePrecision('unclaimed_native').notNull().default(0),
    unclaimedTokens: doublePrecision('unclaimed_tokens').notNull().default(0),
    stakerPoolNative: doublePrecision('staker_pool_native').notNull().default(0),
    /**
     * The staker peel of cashback-window fills, in the launched token: on
     * chain the whole bucket of such a fill is converted before it is split,
     * so neither the creator's nor the stakers' share of it is native. 0022.
     */
    stakerPoolTokens: doublePrecision('staker_pool_tokens').notNull().default(0),
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
    // Scoped by `net` since 0025: an EVM address is the same string on RH,
    // Base and Arc, and synthetic keys (`checkin:<day>`, `follow:<addr>`)
    // must dedupe per net, the way the balance they credit is kept.
    uniqueIndex('xp_events_sig_reason_uq')
      .on(t.wallet, t.net, t.txSig, t.reason)
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
    /** `$STONKZ` reward credits — what crate `S` drops pay, claimable once the token is live on the net. */
    stonkz: bigint('stonkz', { mode: 'number' }).notNull().default(0),
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
    /** XP | SP | STONKZ */
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
    /**
     * Hex HMAC-SHA256(serverSeed, net|wallet|tier|clientSeed) — the roll
     * itself. Rows before 0025 hold HMAC(CRATE_HMAC_SECRET, …|nonce) instead
     * and have no `server_seed`, so they cannot be re-derived by a user.
     */
    rollCommit: text('roll_commit').notNull(),
    /** sha256(serverSeed), shown to the wallet BEFORE the open (`crate_commitments`). */
    serverSeedHash: text('server_seed_hash').notNull(),
    /** The client's seed (or a server-drawn one when the client sent none). Legacy: the server nonce. */
    clientNonce: text('client_nonce').notNull(),
    /** Revealed per-open server seed. Null on legacy rows. */
    serverSeed: text('server_seed'),
    /** True when the client supplied the seed — the only case the server provably could not grind. */
    clientSeeded: boolean('client_seeded').notNull().default(false),
    rollValue: doublePrecision('roll_value').notNull(),
    amountRoll: doublePrecision('amount_roll').notNull(),
    dropIndex: integer('drop_index').notNull(),
    rarity: text('rarity').notNull(),
    payloadJson: jsonb('payload_json').notNull(),
    stonkzAwarded: bigint('stonkz_awarded', { mode: 'number' }).notNull().default(0),
    itemKey: text('item_key'),
    xpAwarded: integer('xp_awarded').notNull().default(0),
    openedAt: timestamp('opened_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('crate_opens_commit_uq').on(t.wallet, t.net, t.rollCommit),
    index('crate_opens_recent_idx').on(t.wallet, t.net, t.id),
  ],
);

/**
 * The pending commit–reveal seed for a wallet's NEXT crate open. Its sha256 is
 * published on `GET /rewards` before the wallet decides to open; the open
 * consumes the row, HMACs with the seed, reveals it, and commits a fresh one.
 */
export const crateCommitments = pgTable(
  'crate_commitments',
  {
    wallet: text('wallet').notNull(),
    net: text('net').notNull(),
    /** 32 random bytes, hex. Never sent to a client until the open it backed is done. */
    seed: text('seed').notNull(),
    seedHash: text('seed_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.wallet, t.net] })],
);

/** RWA positions won from crate `R` drops, per asset. Off-chain identity: a net reset keeps them. */
export const rwaRewards = pgTable(
  'rwa_rewards',
  {
    net: text('net').notNull(),
    wallet: text('wallet').notNull(),
    /** Catalog key from `RWA_ASSETS`, e.g. `PAXG`, `TSLA`. */
    asset: text('asset').notNull(),
    units: doublePrecision('units').notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.net, t.wallet, t.asset] })],
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
    // 0023 — newest-first follow lists.
    index('follows_follower_time_idx').on(t.net, t.follower, t.createdAt),
    index('follows_followee_time_idx').on(t.net, t.followee, t.createdAt),
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
    /** 0023 — blocklist hit: kept (the tip was real) but never replayed to readers. */
    flagged: boolean('flagged').notNull().default(false),
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

/**
 * `referral_fee_balances` broken down by tier (0022). Credited alongside the
 * wallet balance on every fill and drained with it on every claim, so
 * `sum(pending_native)` over a wallet's three rows equals its balance.
 */
export const referralFeeTierBalances = pgTable(
  'referral_fee_tier_balances',
  {
    net: text('net').notNull(),
    wallet: text('wallet').notNull(),
    tier: integer('tier').notNull(),
    pendingNative: doublePrecision('pending_native').notNull().default(0),
    lifetimeNative: doublePrecision('lifetime_native').notNull().default(0),
    fills: integer('fills').notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.net, t.wallet, t.tier] })],
);

/**
 * One row per referral claim (0022). `stonkz` claims are settled at once as
 * reward credits. `native` claims are requests: the commission sits in the
 * on-chain protocol vault and leaves it through `withdrawTreasury(0, …)`,
 * signed by the protocol withdraw authority in an operator batch
 * (`scripts/referral-payouts.ts`), which then marks the row `paid`.
 */
/** What `referral_payouts.voucher` holds for an on-chain claim. */
export interface ReferralVoucherRecord {
  deadline: number;
  signature: string;
  vault: string;
  /** EVM only. */
  chainId?: number;
  /** Solana only: the cluster tag word (`mainnet`, `devnet`, …) without its NUL padding. */
  clusterTag?: string;
  issuedAt: number;
}

export const referralPayouts = pgTable(
  'referral_payouts',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    net: text('net').notNull(),
    wallet: text('wallet').notNull(),
    amountNative: doublePrecision('amount_native').notNull(),
    /** `stonkz` | `native`. */
    mode: text('mode').notNull(),
    /** `requested` | `paid` | `void`. */
    status: text('status').notNull().default('requested'),
    /** Per-tier breakdown of `amountNative` at claim time: `{ "1": 0.1, "2": 0.02 }`. */
    tiers: jsonb('tiers').$type<Record<string, number>>().notNull().default({}),
    /** Reward credits granted, `stonkz` mode only. */
    stonkz: doublePrecision('stonkz'),
    txSig: text('tx_sig'),
    note: text('note'),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
    settledAt: timestamp('settled_at', { withTimezone: true }),
    /**
     * How a `native` row is settled (0028): `batch` — the protocol withdraw
     * authority pays it from the protocol vault; `onchain` — the referrer
     * redeems an API-signed voucher against the chain's referral vault.
     */
    method: text('method').notNull().default('batch'),
    /** On-chain rows: the asset paid (WETH address / wSOL mint). */
    asset: text('asset'),
    /** On-chain rows: `amountNative` in the asset's atoms, as a decimal string. */
    amountAtoms: numeric('amount_atoms', { precision: 78, scale: 0 }),
    /**
     * On-chain rows: the lifetime atoms the voucher certifies. The running
     * maximum over a wallet's rows is what the API signs next; the vault pays
     * the difference over what it already paid.
     */
    cumulativeAtoms: numeric('cumulative_atoms', { precision: 78, scale: 0 }),
    /** On-chain rows: the last voucher issued for this cumulative (deadline, signature). */
    voucher: jsonb('voucher').$type<ReferralVoucherRecord>(),
  },
  (t) => [
    index('referral_payouts_wallet_idx').on(t.net, t.wallet, t.requestedAt),
    index('referral_payouts_status_idx').on(t.net, t.status),
    index('referral_payouts_onchain_idx').on(t.net, t.wallet, t.method, t.asset),
  ],
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

/* -------------------------------------------------------------------------- */
/* 0024 — admin panel: roles, step-up, audit, platform settings, moderation   */
/* -------------------------------------------------------------------------- */

/**
 * Admin identity is the bare wallet address, deliberately *not* `(net, wallet)`:
 * an operator is the same human whichever chain they signed in from, and
 * `ADMIN_WALLETS` bootstraps `owner` the same way. Compared case-insensitively
 * for EVM addresses (`admin/roles.ts`).
 */
export const adminRoles = pgTable('admin_roles', {
  wallet: text('wallet').primaryKey(),
  /** owner | admin | moderator | viewer */
  role: text('role').notNull(),
  grantedBy: text('granted_by').notNull(),
  note: text('note'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** RFC 6238 secret, AES-256-GCM sealed under the admin secret. `enabledAt` null = enrolled but unconfirmed. */
export const adminTotp = pgTable('admin_totp', {
  wallet: text('wallet').primaryKey(),
  secretEnc: text('secret_enc').notNull(),
  enabledAt: timestamp('enabled_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** One step-up challenge per admin token mint; 5-minute TTL, single use. */
export const adminChallenges = pgTable(
  'admin_challenges',
  {
    nonce: text('nonce').primaryKey(),
    net: text('net').notNull(),
    wallet: text('wallet').notNull(),
    message: text('message').notNull(),
    issuedAt: timestamp('issued_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
  },
  (t) => [index('admin_challenges_expires_idx').on(t.expiresAt)],
);

/** Append-only (a trigger refuses UPDATE/DELETE). Every mutating `/admin/*` call writes one row. */
export const adminAuditLog = pgTable(
  'admin_audit_log',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
    actor: text('actor').notNull(),
    actorNet: text('actor_net').notNull(),
    role: text('role').notNull(),
    action: text('action').notNull(),
    target: text('target'),
    before: jsonb('before'),
    after: jsonb('after'),
    ip: text('ip'),
    requestId: text('request_id'),
    ok: boolean('ok').notNull().default(true),
  },
  (t) => [
    index('admin_audit_log_at_idx').on(t.at),
    index('admin_audit_log_actor_idx').on(t.actor, t.id),
    index('admin_audit_log_action_idx').on(t.action, t.id),
  ],
);

/** DB-backed platform knobs; `admin/settings.ts` reads them with env as the fallback. */
export const platformSettings = pgTable('platform_settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedBy: text('updated_by').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const userModeration = pgTable(
  'user_moderation',
  {
    net: text('net').notNull(),
    wallet: text('wallet').notNull(),
    chatBanned: boolean('chat_banned').notNull().default(false),
    commentsBanned: boolean('comments_banned').notNull().default(false),
    launchBanned: boolean('launch_banned').notNull().default(false),
    tradeBanned: boolean('trade_banned').notNull().default(false),
    /** Messages persist flagged (invisible to everyone else) while the sender sees success. */
    shadowMuted: boolean('shadow_muted').notNull().default(false),
    reason: text('reason'),
    until: timestamp('until', { withTimezone: true }),
    updatedBy: text('updated_by').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.net, t.wallet] })],
);

export const tokenModeration = pgTable(
  'token_moderation',
  {
    net: text('net').notNull(),
    mint: text('mint').notNull(),
    featured: boolean('featured').notNull().default(false),
    /** Overrides the indexer's KOTH crown for this net while set. */
    kothOverride: boolean('koth_override').notNull().default(false),
    /** Off the board and search; never off the chain. */
    hidden: boolean('hidden').notNull().default(false),
    scamWarning: text('scam_warning'),
    reason: text('reason'),
    updatedBy: text('updated_by').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.net, t.mint] })],
);

/** Comms: global banner, per-net notices and scheduled maintenance windows. */
export const adminNotices = pgTable(
  'admin_notices',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    /** banner | notice | maintenance */
    kind: text('kind').notNull(),
    /** `null` = every net. */
    net: text('net'),
    text: text('text').notNull(),
    severity: text('severity').notNull().default('info'),
    startsAt: timestamp('starts_at', { withTimezone: true }),
    endsAt: timestamp('ends_at', { withTimezone: true }),
    active: boolean('active').notNull().default(true),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('admin_notices_active_idx').on(t.active, t.kind)],
);

/** Operator jobs handed to other processes (reindex requests to the indexer over Redis). */
export const adminJobs = pgTable(
  'admin_jobs',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    kind: text('kind').notNull(),
    net: text('net').notNull(),
    payload: jsonb('payload').notNull().default({}),
    status: text('status').notNull().default('queued'),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('admin_jobs_status_idx').on(t.status, t.id)],
);
