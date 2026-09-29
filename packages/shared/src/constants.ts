import type { AchievementKey, CrateTier, NativeUnit, Net } from './types.js';

/** Graduation market cap, USD. `index.html:1084` */
export const GRAD = 69000;

/**
 * Implied USD market cap at launch from virtual reserves (`GRAD / 16`, matching
 * `VIRTUAL_TOKEN_NUM` in `@stonkz/curve-sim`). Fill % is progress from this
 * floor to `GRAD`, so a fresh mint reads 0% — not ~6.25%.
 */
export const CURVE_START_MC = GRAD / 16;

/** Default fixed supply when a coin does not set one. `index.html:1084` */
export const SUPPLY = 1e9;

/** Cashback window length, ms (5 minutes). `index.html:1563` */
export const CB_MS = 300000;

/** Fee, in percent, the cashback window decays from down to the coin's own fee. `index.html:1564` */
export const CB_START_FEE = 50;

/** One hour in ms — crate cooldown unit. `index.html:2088` */
export const HOUR = 3600000;

/**
 * Fraction of supply treated as circulating in the simulation.
 * TODO(Phase 4): replaced by curve-reserve-derived circulating supply.
 */
export const CIRC_FRACTION = 0.8;

/** Lane thresholds as a percentage of `GRAD`. `index.html:1132` */
export const LANE_SOON_PCT = 55;
export const LANE_GRAD_PCT = 100;

/** Simulated liquidity as a fraction of market cap. `index.html:1135` */
export const LIQ_FRACTION = 0.14;

/** Bonding-curve preview stand-in: `mc = 1400 + 2600 * sol^1.12`. `index.html:3745` */
export const CURVE_MC_BASE = 1400;
export const CURVE_MC_COEFF = 2600;
export const CURVE_MC_EXP = 1.12;

/** Creator-set curve fee bounds, percent. Launch slider range. */
export const MIN_CURVE_FEE_PCT = 1.0;
export const MAX_CURVE_FEE_PCT = 5.0;

/** Max ticker length enforced by the launch stepper. `index.html:3859` */
export const MAX_TICKER_LEN = 10;

/** Minimum wall tip per native unit. `index.html:3312` */
export const MIN_TIP_SOL = 0.001;
export const MIN_TIP_ETH = 0.0001;
/** Arc tips are denominated in USDC, so the floor is a quarter dollar. */
export const MIN_TIP_USDC = 0.25;

/**
 * `Settings.cap` ("abort above this total") is in the connected net's native
 * unit, so its default and ceiling scale with the unit: 5 SOL / 5 ETH are
 * a few thousand dollars, and USDC needs the same order of magnitude.
 */
export const DEFAULT_TRADE_CAP: Record<NativeUnit, number> = { SOL: 5, ETH: 5, USDC: 5_000 };
export const MAX_TRADE_CAP: Record<NativeUnit, number> = { SOL: 50, ETH: 50, USDC: 50_000 };

/**
 * Fill size, in native units, that unlocks the WHALE achievement.
 *
 * Deliberately **not** USD-parity across the two chains: five SOL and two ETH
 * are nowhere near the same amount of money. Parity would make the
 * achievement roughly twenty times easier to earn on the chain whose gas token
 * is worth twenty times more, so the threshold is set to keep it comparably
 * rare on each chain instead.
 *
 * Lives here rather than in `apps/api` so the sim and the server award it on
 * exactly the same boundary (security review L3).
 */
export const DEFAULT_WHALE_CUT: Record<Net, number> = { SOL: 5, RH: 2, BASE: 2, ARC: 500 };

/**
 * Dust floor, in native units. Below this a fill awards nothing at all — no
 * XP, no SP, and no achievement unlock either, since a 0.000001 SOL trade
 * earning FIRST BLOOD is exactly the farm the daily cap exists to stop.
 *
 * The event is still recorded server-side (with `amount = 0`) so a replay
 * cannot later decide the same fill was worth paying for.
 *
 * Shared with the sim for the same reason as `DEFAULT_WHALE_CUT`.
 */
export const DEFAULT_DUST: Record<Net, number> = { SOL: 0.01, RH: 0.0005, BASE: 0.0005, ARC: 1 };

/** `[days, weightMultiplier, label]`. `index.html:1565` */
export const LOCKS = [
  [0, 1, 'FLEX'],
  [1, 1.1, '1D'],
  [7, 1.25, '7D'],
  [30, 1.5, '30D'],
  [90, 2.5, '90D'],
  [180, 5, '180D'],
  [365, 8, '1Y'],
] as const satisfies readonly (readonly [days: number, mult: number, label: string])[];

/** `[name, xpRequired]`, ascending. `index.html:2075` */
export const RANKS = [
  ['LURKER', 0],
  ['BAG HOLDER', 250],
  ['DEGEN', 700],
  ['TRENCH RAT', 1500],
  ['SNIPER', 3000],
  ['WHALE WATCHER', 6000],
  ['MARKET MAKER', 11000],
  ['CURVE BENDER', 19000],
  ['LIQUIDITY LORD', 32000],
  ['STONK LORD', 55000],
] as const satisfies readonly (readonly [name: string, xp: number])[];

/** A `$STONKZ` payout row: `[oddsPct, 'S', minAmount, maxAmount]`, funded by the buyback leg. */
export type CrateTokenDrop = readonly [odds: number, kind: 'S', min: number, max: number];
/** A utility item row: `[oddsPct, 'I', label]`. Costs the fund nothing. */
export type CrateItemDrop = readonly [odds: number, kind: 'I', item: string];
/** An RWA row: `[oddsPct, 'R', asset, minUnits, maxUnits]`, funded by the 6% RWA leg. */
export type CrateRwaDrop = readonly [
  odds: number,
  kind: 'R',
  asset: string,
  min: number,
  max: number,
];
export type CrateDrop = CrateTokenDrop | CrateItemDrop | CrateRwaDrop;

/**
 * The RWA catalog crates can pay out of. Tokenized stocks exist on Robinhood
 * Chain today; tokenized gold is the chain-agnostic fallback. What the fund
 * actually holds per net is an operator table on the API; this is the label
 * set the drop tables reference.
 */
export const RWA_ASSETS = [
  ['PAXG', 'TOKENIZED GOLD'],
  ['TSLA', 'TESLA'],
  ['AMZN', 'AMAZON'],
  ['PLTR', 'PALANTIR'],
  ['NFLX', 'NETFLIX'],
  ['AMD', 'AMD'],
] as const satisfies readonly (readonly [asset: string, name: string])[];

export interface Crate {
  readonly k: CrateTier;
  /** Cooldown in hours. */
  readonly cd: number;
  readonly col: string;
  /** Odds sum to 100. Index maps 1:1 onto `RAR`. */
  readonly drops: readonly [CrateDrop, CrateDrop, CrateDrop, CrateDrop, CrateDrop];
}

/**
 * All eight tiers with full drop tables. `S` rows pay `$STONKZ`, `R` rows pay
 * a real-world-asset position (Silver and up), `I` rows are utility items.
 * Odds per tier sum to 100 and index maps onto `RAR`. `index.html:2077-2086`
 */
export const CRATES = [
  {
    k: 'BRONZE',
    cd: 1,
    col: '#c07434',
    drops: [
      [58, 'S', 50, 150],
      [26, 'S', 150, 400],
      [11, 'S', 400, 900],
      [4, 'S', 1000, 2500],
      [1, 'I', 'FEE REBATE 24H'],
    ],
  },
  {
    k: 'IRON',
    cd: 2,
    col: '#98a4b0',
    drops: [
      [52, 'S', 150, 400],
      [28, 'S', 400, 900],
      [14, 'S', 900, 2000],
      [5, 'S', 2000, 5000],
      [1, 'I', 'XP BOOST 2X 1H'],
    ],
  },
  {
    k: 'SILVER',
    cd: 4,
    col: '#d7dde3',
    drops: [
      [48, 'S', 400, 1000],
      [30, 'S', 1000, 2500],
      [15, 'S', 2500, 6000],
      [6, 'R', 'PAXG', 0.002, 0.01],
      [1, 'I', 'PRIORITY LANE PASS'],
    ],
  },
  {
    k: 'GOLD',
    cd: 6,
    col: '#ffd23f',
    drops: [
      [44, 'S', 1000, 3000],
      [31, 'S', 3000, 7000],
      [17, 'S', 7000, 15000],
      [7, 'R', 'TSLA', 0.01, 0.05],
      [1, 'I', 'SNIPER ALERT PASS 7D'],
    ],
  },
  {
    k: 'PLATINUM',
    cd: 12,
    col: '#a9e0e8',
    drops: [
      [40, 'S', 3000, 8000],
      [32, 'S', 8000, 18000],
      [19, 'S', 18000, 40000],
      [8, 'R', 'AMZN', 0.02, 0.1],
      [1, 'I', 'EARLY MINT ACCESS'],
    ],
  },
  {
    k: 'IRIDIUM',
    cd: 24,
    col: '#c9b6ff',
    drops: [
      [36, 'S', 8000, 20000],
      [33, 'S', 20000, 45000],
      [21, 'S', 45000, 100000],
      [9, 'R', 'PLTR', 0.1, 0.5],
      [1, 'I', 'IRIDIUM TICKER BADGE'],
    ],
  },
  {
    k: 'PALLADIUM',
    cd: 72,
    col: '#7ef0c0',
    drops: [
      [32, 'S', 25000, 60000],
      [34, 'S', 60000, 140000],
      [23, 'S', 140000, 300000],
      [10, 'R', 'NFLX', 0.05, 0.3],
      [1, 'I', 'FEE FREE WEEK'],
    ],
  },
  {
    k: 'RHODIUM',
    cd: 168,
    col: '#ff9ad5',
    drops: [
      [28, 'S', 80000, 200000],
      [33, 'S', 200000, 500000],
      [25, 'S', 500000, 1200000],
      [12, 'R', 'PAXG', 0.05, 0.25],
      [2, 'I', 'RHODIUM KEY \u00B7 INSTANT CRATE'],
    ],
  },
] as const satisfies readonly Crate[];

/** `[label, cssClass]` per drop index. `index.html:2087` */
export const RAR = [
  ['COMMON', 'c'],
  ['UNCOMMON', 'u'],
  ['RARE', 'r'],
  ['EPIC', 'e'],
  ['LEGENDARY', 'l'],
] as const satisfies readonly (readonly [name: string, cls: string])[];

export interface Achievement {
  readonly k: AchievementKey;
  readonly n: string;
  readonly d: string;
  readonly xp: number;
}

/** The ten achievements. `index.html:2166-2177` */
export const ACH = [
  { k: 'first', n: 'FIRST BLOOD', d: 'Make your first trade.', xp: 50 },
  {
    k: 'whale',
    n: 'WHALE',
    d: 'Hit the chain-specific whale fill threshold (5 SOL or 2 ETH).',
    xp: 120,
  },
  { k: 'deploy', n: 'DEPLOYER', d: 'Launch a coin.', xp: 100 },
  {
    k: 'cashback',
    n: 'CASHBACK KING',
    d: 'Launch with cashback instead of a dev buy.',
    xp: 150,
  },
  { k: 'stake', n: 'STAKER', d: 'Stake any token.', xp: 60 },
  { k: 'crate', n: 'CRATE OPENER', d: 'Open a Stonkdrop.', xp: 40 },
  { k: 'diamond', n: 'DIAMOND HANDS', d: 'Hold a position through minus 25%.', xp: 200 },
  { k: 'grad', n: 'GRADUATE', d: 'Hold a coin the moment it graduates.', xp: 250 },
  { k: 'social', n: 'SOCIAL DEGEN', d: 'Follow someone or post on a wall.', xp: 40 },
  { k: 'streak7', n: 'SEVEN DAYS', d: 'Show up seven days in a row.', xp: 300 },
] as const satisfies readonly Achievement[];

/**
 * Top 20 tokenized stocks on Solana, from
 * geckoterminal.com/category/tokenized-stocks/solana.
 * Snapshot taken 2026-09-06 — edit STOCKS to refresh. `index.html:3709-3717`
 */
export const STOCKS = [
  ['MCDx', 'McDonalds xStock'],
  ['SPYx', 'SP500 xStock'],
  ['PLTRx', 'Palantir xStock'],
  ['CRCLx', 'Circle xStock'],
  ['MSTRx', 'MicroStrategy xStock'],
  ['AAPLx', 'Apple xStock'],
  ['GLDx', 'Gold xStock'],
  ['QQQx', 'Nasdaq xStock'],
  ['NVDAx', 'NVIDIA xStock'],
  ['HOODx', 'Robinhood xStock'],
  ['TSLAx', 'Tesla xStock'],
  ['MSFTx', 'Microsoft xStock'],
  ['GOOGLx', 'Alphabet xStock'],
  ['KOx', 'Coca-Cola xStock'],
  ['AMZNx', 'Amazon xStock'],
  ['COINx', 'Coinbase xStock'],
  ['METAx', 'Meta xStock'],
  ['GMEx', 'Gamestop xStock'],
  ['INTCx', 'Intel xStock'],
  ['STRCx', 'Strategy PP xStock'],
] as const satisfies readonly (readonly [symbol: string, name: string])[];

/**
 * Robinhood Chain stock / ETF bases (canonical RH tickers, not Solana `xStock`).
 * Testnet addresses for the subset Robinhood documents on 46630 are wired in
 * `apps/api/src/router/base-mints.ts`. Graduation is still $69K USD mcap on the
 * curve regardless of which allow-listed base is chosen.
 */
export const RH_STOCKS = [
  ['TSLA', 'Tesla'],
  ['AMZN', 'Amazon'],
  ['PLTR', 'Palantir'],
  ['NFLX', 'Netflix'],
  ['AMD', 'AMD'],
  ['AAPL', 'Apple'],
  ['NVDA', 'NVIDIA'],
  ['MSFT', 'Microsoft'],
  ['GOOGL', 'Alphabet'],
  ['META', 'Meta'],
  ['COIN', 'Coinbase'],
  ['HOOD', 'Robinhood'],
  ['SPY', 'SPDR S&P 500'],
  ['QQQ', 'Invesco QQQ'],
  ['MSTR', 'MicroStrategy'],
  ['CRCL', 'Circle'],
  ['GLD', 'SPDR Gold'],
  ['INTC', 'Intel'],
  ['KO', 'Coca-Cola'],
  ['GME', 'GameStop'],
] as const satisfies readonly (readonly [symbol: string, name: string])[];

/** Major base mints per network. `index.html:3718-3723` */
export const MAJORS = {
  SOL: [
    ['SOL', 'Solana'],
    ['USDC', 'USD Coin'],
    ['USDT', 'Tether'],
    ['JUP', 'Jupiter'],
    ['JITOSOL', 'Jito Staked SOL'],
    ['BONK', 'Bonk'],
    ['WIF', 'dogwifhat'],
    ['JTO', 'Jito'],
    ['RAY', 'Raydium'],
    ['PYTH', 'Pyth Network'],
  ],
  RH: [
    ['ETH', 'Ethereum'],
    ['WETH', 'Wrapped Ether'],
    ['USDG', 'Global Dollar'],
    ['USDC', 'USD Coin'],
    ['BTC', 'Bitcoin'],
    ['SOL', 'Solana'],
    ['XRP', 'XRP'],
    ['DOGE', 'Dogecoin'],
    ['ADA', 'Cardano'],
    ['AVAX', 'Avalanche'],
    ['LINK', 'Chainlink'],
    ['LTC', 'Litecoin'],
  ],
  /** Coinbase Base — the chain's top majors; no RH stock tokens. */
  BASE: [
    ['ETH', 'Ethereum'],
    ['WETH', 'Wrapped Ether'],
    ['USDC', 'USD Coin'],
    ['CBBTC', 'Coinbase Wrapped BTC'],
    ['AERO', 'Aerodrome'],
    ['DEGEN', 'Degen'],
    ['BRETT', 'Brett'],
    ['VIRTUAL', 'Virtuals Protocol'],
    ['DAI', 'Dai'],
    ['USDT', 'Tether'],
  ],
  /** Circle's Arc — USDC is the gas token, so the list is stablecoin-first. */
  ARC: [
    ['USDC', 'USD Coin'],
    ['EURC', 'Euro Coin'],
    ['USYC', 'Circle USYC'],
    ['WETH', 'Wrapped Ether'],
    ['WBTC', 'Wrapped BTC'],
    ['CBBTC', 'Coinbase Wrapped BTC'],
    ['USDT', 'Tether'],
    ['DAI', 'Dai'],
    ['PYUSD', 'PayPal USD'],
    ['FRAX', 'Frax'],
  ],
} as const satisfies Record<Net, readonly (readonly [symbol: string, name: string])[]>;

/**
 * Coinbase Base stock-token bases. Empty until Base lists tokenized stocks:
 * adding a row here, plus its address (`apps/api/src/router/base-mints.ts` or
 * `BASE_MINT_OVERRIDES_BASE`), is all it takes for the launch picker, the
 * API's allow-list and its stock pricing to pick it up (`STOCK_BASES`).
 */
export const BASE_STOCKS = [] as const satisfies readonly (readonly [
  symbol: string,
  name: string,
])[];

/**
 * Which tokenized-stock bases each net offers, config-driven per net. EVM
 * stock bases trade 24/7 on DEX pools (Uniswap V3 against WETH) and are priced
 * on-chain from those pools, so they are never gated on US market hours.
 */
export const STOCK_BASES: Readonly<
  Record<Net, readonly (readonly [symbol: string, name: string])[]>
> = {
  SOL: STOCKS,
  RH: RH_STOCKS,
  BASE: BASE_STOCKS,
  ARC: [],
};

/** The stock-base list for `net` (empty when it has none). */
export function stockBasesFor(net: Net): readonly (readonly [symbol: string, name: string])[] {
  return STOCK_BASES[net];
}

/** Whether `symbol` (any case) is one of `net`'s stock bases. */
export function isStockBase(net: Net, symbol: string): boolean {
  const upper = symbol.trim().toUpperCase();
  return STOCK_BASES[net].some(([sym]) => sym.toUpperCase() === upper);
}

/** `[value, label]` — the four fixed supplies. `index.html:3724` */
export const SUPPLIES = [
  [1e6, '1M'],
  [5e8, '500M'],
  [1e9, '1B'],
  [1e12, '1T'],
] as const satisfies readonly (readonly [value: number, label: string])[];
