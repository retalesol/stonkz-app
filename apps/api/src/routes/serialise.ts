import {
  GRAD,
  cbLeft,
  curve,
  effFee,
  inCashback,
  liq,
  type Coin,
  type Lane,
  type Net,
} from '@stonkz/shared';
import type { tokens } from '../db/schema.js';
import { curveFacts, rowMcBase, snapshotBaseUsd } from './curve-facts.js';

export type TokenRow = typeof tokens.$inferSelect;

/**
 * Row -> the `Coin` shape the terminal already renders.
 *
 * `card()` and `paint()` in the sim read `mc`, `chg`, `age`, `seed`, `lane` and
 * the rest straight off this object, so keeping the wire format identical is
 * what lets the frontend swap `COINS` for `GET /tokens` without touching a
 * single template. Derived values (`lane`, `curve`, `price`, `liq`, the
 * cashback fee decay) are computed with the shared pure math so the server and
 * the client never disagree.
 *
 * **Market cap convention (Pump.fun).** The base-denominated cap (`mcBase`) is
 * the truth; `mc` is `mcBase × baseUsd`, where `baseUsd` is the base asset's
 * LIVE USD price handed in by the route (`routes/live-base-usd.ts`). Without a
 * live price the launch snapshot is used, which reproduces the indexer's own
 * `mc` column exactly. `curvePct`, `lane` and `graduationReady` are measured
 * in base units against the chain's `gradMcapBase`, so they never move when
 * ETH/SOL does; `chg` is the coin's own 24h move on its curve (base terms).
 */
export interface SerialisedToken extends Coin {
  net: Net;
  lane: Lane;
  /** Curve fill percentage toward graduation, in base terms (the chain's own progress). */
  curvePct: number;
  priceUsd: number;
  liqUsd: number;
  baseMint: string;
  /** Present on Coin; repeated here for the wire docs. */
  mint: string;
  tradeable: boolean;
  /** Cashback-aware effective curve fee, percent. */
  effFeePct: number;
  inCashback: boolean;
  cbLeftMs: number;
  graduatedAt: number | null;
  /**
   * Graduation, as the chain has it — not as `mc` implies. `lane === 'grad'`
   * only says the cap crossed the graduation cap; the curve stays open until
   * someone calls the permissionless `graduate` (oracle trigger) or the
   * allocation sells out.
   *
   * - `curveComplete`: the 80% allocation is gone (`realToken == 0`); buys
   *   revert `"curve complete"` until `graduate` lands, which needs no oracle.
   * - `graduationReady`: `graduate` should succeed now — the curve is complete
   *   or the base cap is at/over `gradMcapBase` — and `graduatedAt` is still
   *   null. What the token page turns into a "GRADUATE NOW" button
   *   (`POST /tokens/:sym/graduate/prepare`).
   * - `poolAddress` / `positionAddress`: where the liquidity went, once
   *   `LiquidityMigrated` has been indexed (a later transaction on EVM).
   */
  curveComplete: boolean;
  graduationReady: boolean;
  poolAddress: string | null;
  positionAddress: string | null;
  launchedAt: number;
  /** Market cap in the base asset (ETH / SOL / USDC …). `0` for a fixture row without a price. */
  mcBase: number;
  lastMcBase: number;
  /** Base per token. */
  priceBase: number;
  /** USD per whole base unit `mc` was converted at — live when the route had one, else the launch snapshot. */
  baseUsd: number;
  /** The oracle snapshot stamped at launch, for reference. */
  baseUsdAtLaunch: number;
  /** Whether `baseUsd` is a live mark (`true`) or the launch snapshot / none (`false`). */
  baseUsdLive: boolean;
}

/** What a route hands in to price a row in USD. */
export interface LivePricing {
  /** USD per whole base unit, right now. `<= 0` means "no live mark": fall back to the snapshot. */
  baseUsd: number;
}

export function serialiseToken(row: TokenRow, now: number, live?: LivePricing): SerialisedToken {
  const feeCoin = {
    tfee: row.feeBps / 100,
    cashback: row.cashback,
    cbStart: row.cbStartMs ?? undefined,
  };
  const facts = curveFacts(row);
  const snapshotUsd = snapshotBaseUsd(row);
  const mcBase = rowMcBase(row);
  const liveUsd = live && live.baseUsd > 0 ? live.baseUsd : 0;
  const baseUsd = liveUsd > 0 ? liveUsd : snapshotUsd;
  const baseUsdLive = liveUsd > 0;
  // A row without any base figure (fixture, no snapshot) keeps `mc` as USD.
  const priced = mcBase > 0 && baseUsd > 0;
  const mc = priced ? mcBase * baseUsd : row.mc;
  const lastMcBase =
    typeof row.lastMcBase === 'number' && row.lastMcBase > 0
      ? row.lastMcBase
      : snapshotUsd > 0 && row.lastMc > 0
        ? row.lastMc / snapshotUsd
        : mcBase;
  const lastMc = priced ? (lastMcBase > 0 ? lastMcBase : mcBase) * baseUsd : row.lastMc;
  const supply = row.supply > 0 ? row.supply : 0;
  // Curve progress in base terms when the chain state is known; the snapshot
  // `mc` (base-proportional by construction) for older rows.
  const curvePct = facts ? facts.fillPct : curve({ mc: row.mc });
  // Only a real curve (`k` set) can be complete; fixture rows default to '0'.
  const curveComplete =
    !!row.curveK && row.curveK !== '0' && (row.curveRealToken === '0' || row.curveRealToken === '');
  // Base terms when the chain state is known. The snapshot-priced `mc` is the
  // same test by construction (`gradMcapBase = $69K / snapshot price`), and
  // stays as the check for rows without curve columns.
  const atGraduation = (facts?.atGraduation ?? false) || row.mc >= GRAD;

  return {
    // The board keys cards by ticker; `(net, sym)` is the real identity.
    id: row.seed,
    sym: row.sym,
    name: row.name,
    desc: row.descr,
    mc,
    chg: row.chg,
    reps: row.replies,
    hold: row.holders,
    age: Math.max(0, Math.floor((now - row.launchedAt.getTime()) / 60_000)),
    seed: row.seed,
    dev: row.creator,
    lane: row.lane as Lane,
    lastMc: lastMc > 0 ? lastMc : mc,
    supply: row.supply,
    base: row.baseSymbol,
    baseMint: row.baseMint,
    mint: row.mint || '',
    tradeable: !!(
      row.mint &&
      row.curveK &&
      row.curveK !== '0' &&
      row.lane !== 'grad' &&
      row.graduatedAt == null
    ),
    tfee: row.feeBps / 100,
    net: row.net as Net,
    cashback: row.cashback,
    ...(row.cbStartMs === null ? {} : { cbStart: row.cbStartMs }),
    ...(row.xHandle === null ? {} : { x: row.xHandle }),
    ...(row.website === null ? {} : { web: row.website }),
    ...(row.telegram === null ? {} : { tg: row.telegram }),
    ...(row.imageUrl === null || row.imageUrl === '' ? {} : { image: row.imageUrl }),
    curvePct,
    priceUsd: supply > 0 ? mc / supply : 0,
    liqUsd: facts ? facts.realBase * baseUsd : liq({ mc }),
    effFeePct: effFee(feeCoin, now),
    inCashback: inCashback(feeCoin, now),
    cbLeftMs: cbLeft(feeCoin, now),
    graduatedAt: row.graduatedAt?.getTime() ?? null,
    curveComplete,
    graduationReady: row.graduatedAt == null && !!row.mint && (curveComplete || atGraduation),
    poolAddress: row.poolAddress ?? null,
    positionAddress: row.positionAddress ?? null,
    launchedAt: row.launchedAt.getTime(),
    mcBase,
    lastMcBase: lastMcBase > 0 ? lastMcBase : mcBase,
    priceBase: supply > 0 ? mcBase / supply : 0,
    baseUsd,
    baseUsdAtLaunch: snapshotUsd,
    baseUsdLive,
  };
}

/** `mcBase × baseUsd`, or the recorded USD when either side is unknown. */
export function usdFromBase(
  base: number | null | undefined,
  baseUsd: number,
  recordedUsd: number,
): number {
  return typeof base === 'number' && base > 0 && baseUsd > 0 ? base * baseUsd : recordedUsd;
}
