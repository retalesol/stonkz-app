import { price, rng } from '@stonkz/shared';
import { emit } from '../lib/bus.js';
import { type SimCoin, bySym } from './coins.js';
import { NATIVE_PRICE, WALLET, nativeUnit } from './wallet.js';

/**
 * The connected wallet's positions and recent activity.
 *
 * Phase 1.D sources these from indexer holdings with an optimistic overlay;
 * cost basis is recorded in the native unit and value is shown in USD.
 * `index.html:2680`
 */

export interface Holding {
  sym: string;
  tok: number;
  /** Cost basis in USD. */
  cost: number;
  /** Opened during this session — gates the `diamond` and `grad` checks. */
  live?: boolean;
}

export interface MyTrade {
  t: Date;
  sym: string;
  buy: boolean;
  sol: number;
}

export const HOLD: Holding[] = [];
export const MYTRADES: MyTrade[] = [];

/** Seed a plausible portfolio so the profile view has something to show. */
export function initPortfolio(): void {
  HOLD.length = 0;
  MYTRADES.length = 0;
  const r = rng(9931);
  for (const sym of ['WOJAK', 'HOPIUM', 'BONKD', 'TRENCH', 'LARP']) {
    const c = bySym(sym);
    if (!c) continue;
    const sol = 0.4 + r() * 5.5;
    const cost = sol * NATIVE_PRICE.usd;
    HOLD.push({ sym, tok: (cost / price(c)) * (0.55 + r() * 0.6), cost });
  }
  const t = Date.now();
  const seedTrades: Array<[string, number]> = [
    ['WOJAK', 1],
    ['HOPIUM', 0],
    ['BONKD', 1],
    ['LARP', 0],
  ];
  seedTrades.forEach((a, i) => {
    MYTRADES.push({ t: new Date(t - (i * 2100 + 400) * 1000), sym: a[0], buy: !!a[1], sol: 0.3 + r() * 3 });
  });
}

export function holdOf(sym: string): Holding | null {
  for (const h of HOLD) if (h.sym === sym) return h;
  return null;
}

/** Total USD value of the portfolio at current prices. `index.html:2714` */
export function pfValue(): number {
  let v = 0;
  for (const h of HOLD) {
    const c = bySym(h.sym);
    if (c) v += h.tok * price(c);
  }
  return v;
}

/**
 * Apply a fill to the portfolio and the native balance.
 *
 * A coin paired against a stock or stablecoin still debits the native balance
 * from Phase 2 — the router buys the base with SOL/ETH on hop 1. In the sim we
 * keep the oracle's shortcut of only moving the balance for native pairs and
 * flag it, because the balance line is fake either way. `index.html:2695`
 */
export function noteTrade(c: SimCoin, buy: boolean, sol: number): void {
  const h = holdOf(c.sym);
  const usdIn = sol * NATIVE_PRICE.usd;
  const tok = usdIn / price(c);
  // TODO(Phase 2.R): every fill debits native once hop 1 is real.
  const native = !c.base || c.base === nativeUnit();
  if (buy) {
    if (h) {
      h.tok += tok;
      h.cost += usdIn;
      h.live = true;
    } else {
      HOLD.unshift({ sym: c.sym, tok, cost: usdIn, live: true });
    }
    if (native) WALLET.sol = Math.max(0, WALLET.sol - sol);
  } else {
    if (h) {
      const sold = Math.min(h.tok, tok);
      h.cost *= Math.max(0, 1 - sold / h.tok);
      h.tok -= sold;
      if (h.tok < 1) HOLD.splice(HOLD.indexOf(h), 1);
    }
    if (native) WALLET.sol += sol;
  }
  MYTRADES.unshift({ t: new Date(), sym: c.sym, buy, sol });
  if (MYTRADES.length > 20) MYTRADES.pop();
  emit('portfolio');
  if (WALLET.on) emit('wallet');
}

/** Credit tokens without spending native — fee claims and stake claims. */
export function creditTokens(sym: string, tok: number): void {
  const c = bySym(sym);
  if (!c || tok <= 0) return;
  const h = holdOf(sym);
  if (h) h.tok += tok;
  else HOLD.unshift({ sym, tok, cost: tok * price(c) });
  emit('portfolio');
}
