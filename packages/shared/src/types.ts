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

/** §5.2 — the local/ledger user record. */
export interface User {
  xp: number;
  /** Legacy sim balance. Phase 3 splits this into SP + Stonk Optionz. */
  stonkz: number;
  /** Stonk Pointz (Phase 3 server ledger). */
  sp?: number;
  /** Stonk Optionz (Phase 3 server ledger; crate `S` drops pay this). */
  optionz?: number;
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
  };
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

/** A row in the crate drop log. */
export interface DropLogEntry {
  /** HH:MM local clock. */
  t: string;
  k: CrateTier;
  /** Rendered reward label. */
  r: string;
  /** Tier colour. */
  col: string;
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
  split: { protocol: number; creatorBucket: number; stonkzOps: number; burn: number };
  totals: {
    /** Everything taken in fees since launch. */
    gross: number;
    protocol: number;
    /** Stonkz Game buyback vault (`stonkz_ops`). */
    game: number;
    burn: number;
    /** The 60% bucket before the staker peel. */
    creatorBucket: number;
    /** What the creator kept (claimed + unclaimed). */
    creator: number;
    /** What this coin's stakers were paid out of the bucket. */
    stakers: number;
    /** Referral commissions paid out of the protocol leg for this coin's fills. */
    referrals: number;
  };
  source: 'chain' | 'sim';
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
}
