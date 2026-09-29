/**
 * Data model, mirrored from FULL_BUILDOUT_GUIDE.md §5 and the shapes the
 * simulated app in `index.html` already builds. Anything the API must be able
 * to hydrate lives here.
 */

/** Chain a coin, wallet or session belongs to. */
export type Net = 'SOL' | 'RH' | 'BASE' | 'ARC';

/** EVM product nets — Robinhood Chain, Coinbase Base and Circle's Arc. */
export type EvmNet = 'RH' | 'BASE' | 'ARC';

/**
 * Every product net, in picker order. Everything else about a net (gas unit,
 * decimals, colours, DEX, caps) lives in `nets.ts`; add a net there and here
 * and the exhaustive `Record<Net, …>` maps across the workspace tell you the
 * rest.
 */
export const ALL_NETS: readonly Net[] = ['SOL', 'BASE', 'ARC', 'RH'] as const;

/**
 * The gas token the user always pays and receives. Arc's gas is USDC: the EVM
 * native value carries 18 decimals there, the ERC-20 face carries 6.
 */
export type NativeUnit = 'SOL' | 'ETH' | 'USDC';

/** Board lane, derived from market cap against `GRAD`. */
export type Lane = 'new' | 'soon' | 'grad';

/** Fixed supplies offered by the launch stepper. */
export type SupplyOption = 1e6 | 5e8 | 1e9 | 1e12;

/** MEV strategy in the settings modal. */
export type MevMode = 'SHIELD' | 'RELAY' | 'OFF';

/**
 * EVM gas preset in the settings modal. `NORMAL` leaves EIP-1559 fields to
 * the wallet; `FAST` / `TURBO` set `maxPriorityFeePerGas` / `maxFeePerGas`
 * explicitly from the chain's current estimate, scaled up.
 */
export type EvmGasPreset = 'NORMAL' | 'FAST' | 'TURBO';

/** Crate tier keys, in ascending value. */
export type CrateTier =
  'BRONZE' | 'IRON' | 'SILVER' | 'GOLD' | 'PLATINUM' | 'IRIDIUM' | 'PALLADIUM' | 'RHODIUM';

/** Achievement keys awarded by the ledger. */
export type AchievementKey =
  | 'first'
  | 'whale'
  | 'deploy'
  | 'cashback'
  | 'stake'
  | 'crate'
  | 'diamond'
  | 'grad'
  | 'social'
  | 'streak7';

/** §5.1 — a launched coin. */
export interface Coin {
  id: number;
  sym: string;
  name: string;
  desc: string;
  /** Market cap in USD. `price = mc / supply`. */
  mc: number;
  /** 24h change, percent. */
  chg: number;
  /** Reply count. */
  reps: number;
  /** Holder count. */
  hold: number;
  /** Minutes since launch. */
  age: number;
  /** Deterministic seed for avatar art and simulated series. */
  seed: number;
  /** Creator address. */
  dev: string;
  /** Token mint / contract address when known. */
  mint?: string;
  /** Server says prepare may succeed (mint + curve k, not graduated). */
  tradeable?: boolean;
  /**
   * Graduation as the chain has it (`lane === 'grad'` only says the cap
   * crossed $69K). `graduatedAt` is set once `graduate` landed; `poolAddress`
   * / `positionAddress` once the liquidity was migrated (a later transaction
   * on EVM); `curveComplete` when the allocation sold out and the curve is
   * closed pending `graduate`; `graduationReady` when the permissionless
   * `graduate` call should succeed now.
   */
  graduatedAt?: number | null;
  poolAddress?: string | null;
  positionAddress?: string | null;
  curveComplete?: boolean;
  graduationReady?: boolean;
  lane: Lane | null;
  /** Previous tick's market cap, for flash direction. */
  lastMc: number;
  /** X handle. */
  x?: string;
  web?: string;
  tg?: string;
  /** Launch image (IPFS gateway URL). */
  image?: string;
  /** Launched by the connected wallet. */
  mine?: boolean;
  /** Unclaimed creator fees, in the chain's native unit. */
  fee?: number;
  /** Creator token allocation accrued during a cashback window. */
  feeTokens?: number;
  /** Fixed supply. Defaults to `SUPPLY` (1e9) when absent. */
  supply?: number;
  /** Pair base symbol — SOL, ETH, USDC, AAPLx … */
  base?: string;
  /** Creator-set curve fee, percent, 1.0–5.0. */
  tfee?: number;
  net?: Net;
  cashback?: boolean;
  /** Epoch ms the cashback window opened. */
  cbStart?: number;
}

/** A real-world-asset position won from a crate. */
export interface RwaReward {
  /** Catalog key, e.g. `PAXG`, `TSLA` (see `RWA_ASSETS`). */
  asset: string;
  /** Units held, fractional. */
  units: number;
}

/** §5.2 — the local/ledger user record. */
export interface User {
  xp: number;
  /** `$STONKZ` reward credits: what crate `S` drops pay, claimable on chain once the token is live on the net. */
  stonkz: number;
  /** Stonk Pointz (server ledger). Levels and crates key off this. */
  sp?: number;
  /** RWA positions won from crates, per asset, claimable once the fund keeper ships. */
  rwa?: RwaReward[];
  /** Tier -> epoch ms the global crate cooldown ends (same value on every tier). */
  crates: Partial<Record<CrateTier, number>>;
  /** Unopened crates earned from SP levels. */
  crateInventory?: Partial<Record<CrateTier, number>>;
  /** SP level progress from the server. */
  spLevel?: {
    level: number;
    next: number | null;
    pct: number;
    toNext: number;
    /** SP at which the current level started. */
    cur?: number;
    /** Levels already granted (server `sp_level_claims`). */
    claimed?: number[];
  };
  /** USD value of the RWA holdings (DefiLlama); `null` while unpriced. */
  rwaUsd?: number | null;
  /** Utility items won from `I` crate rows. */
  items?: UserItem[];
  /** sha256 of the server seed committed for the NEXT crate open. */
  nextCrateCommit?: string | null;
  log: DropLogEntry[];
  /** Lifetime creator fees claimed, in native units. */
  feesClaimed?: number;
  seenWiz?: boolean;
  seenHello?: boolean;
  /** Phase 5: has this device already dismissed the risk/legal disclosure? */
  seenLegal?: boolean;
  /** Ticker -> stake position. */
  stake?: Record<string, Stake>;
  /** Address -> 1. */
  follow?: Record<string, 1>;
  name?: string;
  bio?: string;
  streak?: number;
  /** `dayKey()` of the last visit. */
  lastDay?: string;
  /** Achievement key -> unlocked-at epoch ms. */
  ach?: Partial<Record<AchievementKey, number>>;
}

/** A utility item held from a crate `I` row. */
export interface UserItem {
  item: string;
  count: number;
  expiresAt: number | null;
  /** Server says the perk is live (count > 0 and not expired). */
  active?: boolean;
  /** Which system honours it, if any is wired up yet; `null` for a label no table lists any more. */
  effect?: string | null;
  implemented?: boolean;
  blurb?: string | null;
}

/** The commit–reveal proof behind one crate open. */
export interface CrateProof {
  serverSeedHash: string;
  /** Revealed after the open; `null` on legacy rows opened before commit–reveal. */
  serverSeed: string | null;
  clientSeed: string | null;
  /** Hex HMAC digest — the roll itself. */
  rollCommit: string;
  rollValue: number;
  amountRoll: number;
  dropIndex: number;
}

/** A row in the crate drop log. */
export interface DropLogEntry {
  /** HH:MM local clock. */
  t: string;
  k: CrateTier;
  /** Rendered reward label. */
  r: string;
  /** Tier colour. */
  col: string;
  /** Epoch ms of the open (server rows). */
  at?: number;
  rarity?: string;
  proof?: CrateProof;
}

/**
 * Lifetime fee ledger for one coin, as `GET /tokens/:sym/fees` returns it and
 * the Fees tab renders it. Every amount is in the net's native unit.
 */
export interface TokenFees {
  sym: string;
  net: Net;
  unit: NativeUnit;
  /** Creator-set tax, bps. */
  feeBps: number;
  /** Effective tax right now (cashback decay), bps. */
  effFeeBps: number;
  /** The nominal split the programs assert on every fill. */
  split: { protocol: number; creatorBucket: number; buyback: number; rwa: number };
  totals: {
    /** Everything taken in fees since launch. */
    gross: number;
    /** Platform revenue (on-chain "protocol" vault). */
    protocol: number;
    /** `$STONKZ` buyback vault (`stonkz_ops` on the wire): half to crates, half burned. */
    buyback: number;
    /** RWA crate fund (the former `burn` vault on the wire). */
    rwa: number;
    /** The 69% bucket before the staker peel. */
    creatorBucket: number;
    /** What the creator kept (claimed + unclaimed). */
    creator: number;
    /** What this coin's stakers were paid out of the bucket. */
    stakers: number;
    /** Referral commissions paid out of the protocol leg for this coin's fills. */
    referrals: number;
    /** Staker peel of cashback-window fills, paid in the token. Absent in sim. */
    stakersTokens?: number;
  };
  source: 'chain' | 'sim';
  /** This coin's staking pool. Absent from older API builds and in sim. */
  staking?: StakePoolSummary;
  /**
   * The creator's claimable ledger — what `claimCreatorFees` /
   * `claim_creator_fees` pays right now. Read on chain when the RPC answers
   * (`source: 'chain'`), else the indexer's `creator_vaults` row. Absent in
   * sim and on older API builds.
   */
  creator?: {
    wallet: string;
    /** Base asset (whole units) — the chain's native unit for a native-paired curve. */
    claimableBase: number;
    baseSym: string;
    /** Launched-token slice from cashback-window fills (whole tokens). */
    claimableTokens: number;
    /** Lifetime claimed, native (indexer). */
    claimedNative: number;
    source: 'chain' | 'indexer';
  };
}

/** §5.3 — connected wallet. */
export interface Wallet {
  on: boolean;
  net: Net;
  /** Shortened address, e.g. `7xKQ..9fRt`. */
  addr: string;
  full: string;
  /** Native balance, SOL on Solana / ETH on Robinhood. */
  sol: number;
  seed: number;
  provider: string;
}

/** §5.3 — a selectable network in the picker. */
export interface NetworkOption {
  k: Net;
  name: string;
  sub: string;
  col: string;
  provider: string;
  seed: number;
  addr: string;
  full: string;
}

/** §5.4 — persisted transaction defaults (`stonkz.settings.v1`). */
export interface Settings {
  /** Slippage tolerance, percent. */
  slip: number;
  /** Priority fee, native units. */
  prio: number;
  mev: MevMode;
  /** MEV tip, native units. */
  mevTip: number;
  /** Abort above this total, native units of `capUnit` (or the connected net). */
  cap: number;
  /**
   * The unit `cap` was set in. When the connected net's unit differs, the
   * per-unit default (`DEFAULT_TRADE_CAP`) applies instead of a number that
   * meant something else (5 ETH is not 5 USDC).
   */
  capUnit?: NativeUnit;
  /** Prefilled buy amount, native units. */
  defBuy: number;
  confirm: boolean;
  /**
   * EVM-only gas preset (`wallet/evm.ts`). Device-local: applied by the
   * wallet layer at send time, so it is neither sent to nor stored by the
   * API. Absent means `NORMAL`.
   */
  evmGas?: EvmGasPreset;
}

/** §5.2 — a per-token stake position. */
export interface Stake {
  amt: number;
  /** Lock multiplier from `LOCKS`. */
  mult: number;
  /** Lock length in days. */
  days: number;
  /** Epoch ms the lock expires. 0 = flex. */
  until: number;
  /** Rewards accrued in the token (cashback window). */
  rewTok: number;
  /** Rewards accrued in the native unit. */
  rewSol: number;
  /**
   * On-chain pool weight in whole tokens (`amount * lock bps / 1e4`). FLEX is
   * **zero** on both programs — a parked position earns nothing. Absent in sim
   * and on rows read before the API reported it.
   */
  weight?: number;
  /** Pending rewards in the curve's base asset (whole units), when read from chain. */
  rewBase?: number;
  /** The base asset `rewBase` is denominated in (e.g. `WETH`, `USDC`). */
  baseSym?: string;
  /** Where the numbers came from: a fresh on-chain read, or the indexer's table. */
  source?: 'chain' | 'indexer';
  /** Epoch ms of the last on-chain read, so a lagging indexer row cannot overwrite it. */
  chainAt?: number;
}

/**
 * One coin's staking pool, as the Fees tab and the stake dialog show it.
 * Token amounts are whole tokens; `lifetimeNative` is the chain's native unit.
 */
export interface StakePoolSummary {
  /** Everything staked: lock-eligible plus FLEX. */
  totalStaked: number;
  /** Staked with a lock of at least one day — the only stake that earns. */
  eligibleStaked: number;
  /** FLEX: parked, zero weight, excluded from the pool fraction. */
  flexStaked: number;
  /** Sum of every position's weight (whole-token units). */
  totalWeight: number;
  /** Wallets with a non-zero position. */
  stakers: number;
  /** Circulating supply the programs weigh against (`tokensForSale - realToken`). */
  circulating: number;
  /** `totalStaked / circulating`, 0..1. */
  stakedFrac: number;
  /** The stakers' current share of the 69% creator bucket, 0..0.5 (eligible stake only). */
  bucketShare: number;
  /** The same share expressed against the whole curve fee (`bucketShare * 0.69`). */
  feeShare: number;
  /** Lifetime stakers' earnings in the native unit (indexer). */
  lifetimeNative: number;
  /** Lifetime stakers' earnings in the base asset, when read from chain. */
  lifetimeBase?: number;
  /** Lifetime stakers' earnings paid in the token (cashback window), when read from chain. */
  lifetimeTokens?: number;
  /** The curve's base asset, which `lifetimeBase` is denominated in. */
  baseSym?: string;
  source: 'indexer' | 'chain';
}

/** §5.5 — another user, resolved from an address. */
export interface Member {
  addr: string;
  seed: number;
  name: string;
  bio: string;
  followers: number;
  following: number;
  /** Join date label. */
  joined: string;
  xp: number;
}

/** §5.5 — one post on a member's wall. Tips are verified by signature. */
export interface Wall {
  from: string;
  text: string;
  /** Tip in the native unit. Min 0.001 SOL / 0.0001 ETH. */
  tip: number;
  /** Relative time label. */
  t: string;
  mine?: boolean;
  /** Tip transaction signature. Required server-side from Phase 5. */
  sig?: string;
}

/** Where a hop executes. Stonkz only ever charges a fee on `CURVE`. */
export type Venue = 'JUPITER' | 'UNISWAP' | 'CURVE' | 'DEX';

/**
 * One leg of a trade. Buys are native -> base -> token; sells reverse.
 * Hop 1 (aggregator) always carries `feeBps: 0`.
 */
export interface QuoteHop {
  venue: Venue;
  inSymbol: string;
  outSymbol: string;
  inAmount: number;
  outAmount: number;
  /** Price impact, percent. */
  impactPct: number;
  /** Stonkz fee on this hop. Zero on every aggregator hop. */
  feeBps: number;
  /** Fee taken on this hop, denominated in `inSymbol`. */
  feeAmount: number;
}

/** A priced route. `amountIn` is the input the user typed: native on buys, tokens on sells. */
export interface Quote {
  sym: string;
  /** Canonical mint when known — preferred over `sym` for duplicate tickers. */
  mint?: string;
  net: Net;
  side: 'buy' | 'sell';
  /** Always SOL or ETH. */
  nativeUnit: NativeUnit;
  /** Native spent (buy) or tokens sold (sell). */
  amountIn: number;
  /** Tokens received (buy) or native received (sell). */
  amountOut: number;
  minOut: number;
  /** Ordered legs — one hop when the base mint is native, otherwise two. */
  hops: QuoteHop[];
  /** `JUPITER -> CURVE`, `UNISWAP -> CURVE`, or `CURVE`. */
  routeLabel: string;
  /** Effective curve fee, percent (cashback-aware). */
  effFeePct: number;
  /** Combined price impact, percent. */
  impactPct: number;
  /** USD per native unit when the quote server tagged a spot (`null` if oracle missed). */
  nativeUsd?: number | null;
  /** Epoch ms this quote goes stale. 8s bar. */
  expiresAt: number;
  /** True when the server fell back to an indicative (non-executable) price. */
  indicative?: boolean;
}

/** A confirmed fill on the trades tab / tape. */
export interface Fill {
  /** Epoch ms. */
  t: number;
  sym: string;
  net: Net;
  buy: boolean;
  /** Native notional (SOL or ETH). */
  sol: number;
  /** Token amount. */
  tok: number;
  /** Market cap at fill. */
  mc: number;
  /** Trader address, shortened. */
  w: string;
  /** USD notional. */
  v: number;
  /** Filled inside a cashback window. */
  cb?: boolean;
  /** Render hint for the new-fill flash. */
  fresh?: boolean;
  /** Transaction signature / hash. */
  sig?: string;
  /** `${sig}:${ordinal}` — one id for a fill's provisional and indexed prints. */
  fid?: string;
  /** The coin's mint / contract, so a reused ticker still opens the right chart. */
  mint?: string;
}
