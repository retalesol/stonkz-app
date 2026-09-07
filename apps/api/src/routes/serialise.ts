import { cbLeft, curve, effFee, inCashback, liq, price, type Coin, type Lane, type Net } from '@stonkz/shared';
import type { tokens } from '../db/schema.js';

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
 */
export interface SerialisedToken extends Coin {
  net: Net;
  lane: Lane;
  /** Curve fill percentage against the $69K graduation cap. */
  curvePct: number;
  priceUsd: number;
  liqUsd: number;
  baseMint: string;
  /** Cashback-aware effective curve fee, percent. */
  effFeePct: number;
  inCashback: boolean;
  cbLeftMs: number;
  graduatedAt: number | null;
  launchedAt: number;
}

export function serialiseToken(row: TokenRow, now: number): SerialisedToken {
  const feeCoin = {
    tfee: row.feeBps / 100,
    cashback: row.cashback,
    cbStart: row.cbStartMs ?? undefined,
  };
  const curveCoin = { mc: row.mc, supply: row.supply, seed: row.seed };

  return {
    // The board keys cards by ticker; `(net, sym)` is the real identity.
    id: row.seed,
    sym: row.sym,
    name: row.name,
    desc: row.descr,
    mc: row.mc,
    chg: row.chg,
    reps: row.replies,
    hold: row.holders,
    age: Math.max(0, Math.floor((now - row.launchedAt.getTime()) / 60_000)),
    seed: row.seed,
    dev: row.creator,
    lane: row.lane as Lane,
    lastMc: row.lastMc,
    supply: row.supply,
    base: row.baseSymbol,
    baseMint: row.baseMint,
    tfee: row.feeBps / 100,
    net: row.net as Net,
    cashback: row.cashback,
    ...(row.cbStartMs === null ? {} : { cbStart: row.cbStartMs }),
    ...(row.xHandle === null ? {} : { x: row.xHandle }),
    ...(row.website === null ? {} : { web: row.website }),
    ...(row.telegram === null ? {} : { tg: row.telegram }),
    curvePct: curve(curveCoin),
    priceUsd: price(curveCoin),
    liqUsd: liq(curveCoin),
    effFeePct: effFee(feeCoin, now),
    inCashback: inCashback(feeCoin, now),
    cbLeftMs: cbLeft(feeCoin, now),
    graduatedAt: row.graduatedAt?.getTime() ?? null,
    launchedAt: row.launchedAt.getTime(),
  };
}
