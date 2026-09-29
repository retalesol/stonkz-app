import {
  CRATES,
  GRAD,
  HOUR,
  SUPPLY,
  XP_LAUNCH,
  type CrateTier,
  type Fill,
  type Net,
  type Quote,
  type QuoteHop,
  type Venue,
  type Wallet,
  crateBy,
  FEE_SPLIT,
  crateReadyAt,
  crateXp,
  curveMc,
  effFee,
  inCashback,
  laneOf,
  liq,
  num,
  price,
  rollCrateAmount,
  rollDrop,
  rollRwaUnits,
  stakeMult,
  vol24,
  xpForFeeClaim,
  xpForStake,
  xpForTrade,
  circ,
  splitFee,
  type TokenFees,
  nativeUnit as unitFor,
} from '@stonkz/shared';
import { isEvm } from '@stonkz/shared';
import { emit } from '../lib/bus.js';
import {
  COINS,
  type SimCoin,
  bySym,
  pushTrade,
  seedSeries,
  seedTrades,
  toFill,
} from '../state/coins.js';
import { HOLD, creditTokens, holdOf, initPortfolio, noteTrade } from '../state/holdings.js';
import { SET } from '../state/settings.js';
import { ensureStake, poolFrac, stakeOf, totalWeight } from '../state/stake.js';
import {
  USER,
  addXP,
  creditRwa,
  pushDrop,
  saveUser,
  syncSpLevelGrants,
  unlock,
} from '../state/user.js';
import {
  NATIVE_PRICE,
  SIM_BALANCE,
  WALLET,
  nativeUnit,
  nativeUsd,
  selectNet,
} from '../state/wallet.js';
import { clock, fakeAddr, fmtUnits } from '../lib/fmt.js';
import type {
  ClaimResult,
  CrateResult,
  FeeVault,
  QuoteInput,
  StakeClaim,
  StakeInput,
  StonkzApi,
} from './types.js';

/**
 * The simulation adapter — everything the single-file build did, behind the
 * seam. Each method carries the Phase that deletes it.
 *
 * @see plan step 30
 */

const TICK_MS = 1100;
let timer = 0;

/* -------------------------------------------------------------------------- */
/* Stream                                                                      */
/* -------------------------------------------------------------------------- */

const NEWNAMES: Array<[string, string]> = [
  ['SZN', 'Season Finale'],
  ['GRIFT', 'Grift Capital'],
  ['CHOPZ', 'Chop Zone'],
  ['VIBEZ', 'Vibez Only'],
  ['EXITZ', 'Exit Liquidity Inc'],
  ['FLOORD', 'Floored Again'],
  ['PONZI', 'Ponzi But Honest'],
  ['MID', 'Aggressively Mid'],
];

const NEWDESC = [
  'deployed forty seconds ago and already has opinions.',
  'no utility, no roadmap, no shame.',
  'the chart is a straight line and nobody knows which way.',
  'made by someone who should be asleep.',
];

let beats = 0;

/**
 * One beat of the simulation. `index.html:4037`
 *
 * Model only: it moves numbers and announces what changed. Every DOM
 * consequence lives in `app/loop.ts`, which is what makes the Phase 1 swap a
 * one-file change — the `board` WS channel emits the same events.
 */
function beat(): void {
  beats++;
  const now = Date.now();
  NATIVE_PRICE.usd = Math.max(120, NATIVE_PRICE.usd * (1 + (Math.random() - 0.5) * 0.0018));
  NATIVE_PRICE.sol = Math.max(120, NATIVE_PRICE.sol * (1 + (Math.random() - 0.5) * 0.0018));
  NATIVE_PRICE.eth = Math.max(800, NATIVE_PRICE.eth * (1 + (Math.random() - 0.5) * 0.0018));
  NATIVE_PRICE.usd = nativeUsd(nativeUnit());

  for (const c of COINS) {
    c.lastMc = c.mc;
    const vol = c.lane === 'grad' ? 0.006 : 0.014;
    c.mc = Math.max(600, c.mc * (1 + (Math.random() - 0.485) * vol * 2));
    c.chg += (c.mc / c.lastMc - 1) * 100;
    if (Math.random() > 0.86) c.reps++;
    if (Math.random() > 0.9) c.hold++;
    accrueFees(c, now);
    if (c.h && c.hv) {
      c.h.push(c.mc);
      if (c.h.length > 260) c.h.shift();
      c.hv.push((vol24(c) / 200) * (0.35 + Math.random() * 1.7));
      if (c.hv.length > 260) c.hv.shift();
    }
    const L = laneOf(c);
    if (L !== c.lane) {
      c.lane = L;
      emit('lane', { sym: c.sym, lane: L });
    }
  }

  if (beats % 9 === 0 && COINS.length < 28) {
    const nn = NEWNAMES[(Math.random() * NEWNAMES.length) | 0] as [string, string];
    if (!bySym(nn[0])) {
      const mc = 900 + Math.random() * 5200;
      COINS.push({
        id: COINS.length,
        sym: nn[0],
        name: nn[1],
        desc: NEWDESC[(Math.random() * NEWDESC.length) | 0] as string,
        mc,
        chg: Math.random() * 120,
        reps: 1 + ((Math.random() * 9) | 0),
        hold: 1 + ((Math.random() * 40) | 0),
        age: 0,
        seed: (Math.random() * 1e6) | 0,
        dev: fakeAddr((Math.random() * 1e5) | 0),
        lane: 'new',
        el: null,
        lastMc: 0,
        x: '@' + nn[0].toLowerCase() + 'sol',
        h: null,
        hv: null,
        trades: null,
        comments: null,
      });
      emit('mint', { sym: nn[0] });
    }
  }
  if (beats % 60 === 0) for (const c of COINS) c.age++;
  if (beats % 9 === 0 && USER.stake) saveUser();
  emit('tick');
}

/**
 * Accrue this beat's creator fees and staker rewards.
 *
 * The creator only ever sees their share of the 69% bucket; the pool takes the
 * rest of it, and platform, buyback and the RWA fund never touch either. `index.html:3605`
 */
function accrueFees(c: SimCoin, now: number): void {
  if (c.cashback && !inCashback(c, now)) c.cashback = false;
  if (laneOf(c) === 'grad') return;
  const turnover = (vol24(c) / 86400) * (TICK_MS / 1000);
  const feeNative = (turnover * (effFee(c, now) / 100)) / NATIVE_PRICE.usd;
  const bucket = feeNative * FEE_SPLIT.creatorBucket;
  const share = poolFrac(c);
  if (c.mine) {
    c.fee = (c.fee ?? 0) + bucket * (1 - share);
    if (inCashback(c, now))
      c.feeTokens = (c.feeTokens ?? 0) + (bucket * (1 - share) * NATIVE_PRICE.usd) / price(c);
  }
  accrueStake(c, now);
}

/** Pay this wallet's slice of the staker pool for one beat. `index.html:1602` */
function accrueStake(c: SimCoin, now: number): void {
  const st = stakeOf(c.sym);
  if (!st || st.amt <= 0) return;
  const turnover = (vol24(c) / 86400) * (TICK_MS / 1000);
  const feeNative = (turnover * (effFee(c, now) / 100)) / NATIVE_PRICE.usd;
  // Only the creator's 69% bucket funds stakers, and poolFrac splits that
  // bucket between the creator and the pool. Platform, buyback and RWA never enter it.
  const pool = feeNative * FEE_SPLIT.creatorBucket * poolFrac(c);
  const weight = totalWeight(c);
  const mine = weight > 0 ? (st.amt * stakeMult(st, now)) / weight : 0;
  if (inCashback(c, now)) st.rewTok += (pool * mine * NATIVE_PRICE.usd) / price(c);
  else st.rewSol += pool * mine;
}

/* -------------------------------------------------------------------------- */
/* Quotes                                                                      */
/* -------------------------------------------------------------------------- */

/** The aggregator that fronts each network. `index.html` had no hop 1 at all. */
function aggregatorOf(net: Net): Venue {
  return isEvm(net) ? 'UNISWAP' : 'JUPITER';
}

/**
 * Price a route.
 *
 * Two hops whenever the pair's base mint is not the native unit, so a coin
 * paired against USDC or AAPLx still quotes as native -> base -> token. Stonkz
 * charges nothing on the aggregator hop: `feeBps` is zero there by
 * construction, which is the invariant Phase 2.R has to preserve.
 */
function buildQuote(input: QuoteInput): Quote {
  const { coin: c, side, amountIn } = input;
  const net = c.net ?? WALLET.net;
  const unit = nativeUnit();
  const base = c.base || unit;
  const twoHop = base !== unit;
  const feePct = effFee(c);
  const p = price(c);
  const impact = Math.min(32, ((amountIn * NATIVE_PRICE.usd) / Math.max(1, liq(c))) * 100 * 2.2);
  // The aggregator leg is priced at parity in the sim; only its impact is real
  // enough to show. Phase 2.R replaces it with a Jupiter / Uniswap quote.
  const hopImpact = twoHop ? Math.min(1.2, amountIn * 0.06) : 0;
  const hops: QuoteHop[] = [];

  if (side === 'buy') {
    let baseIn = amountIn;
    if (twoHop) {
      baseIn = amountIn * (1 - hopImpact / 100);
      hops.push({
        venue: aggregatorOf(net),
        inSymbol: unit,
        outSymbol: base,
        inAmount: amountIn,
        outAmount: baseIn,
        impactPct: hopImpact,
        feeBps: 0,
        feeAmount: 0,
      });
    }
    const fee = baseIn * (feePct / 100);
    const tokens = ((baseIn - fee) * NATIVE_PRICE.usd) / p / (1 + impact / 100);
    hops.push({
      venue: 'CURVE',
      inSymbol: base,
      outSymbol: c.sym,
      inAmount: baseIn,
      outAmount: tokens,
      impactPct: impact,
      feeBps: Math.round(feePct * 100),
      feeAmount: fee,
    });
  } else {
    const tokens = (amountIn * NATIVE_PRICE.usd) / p;
    const grossBase = amountIn;
    const fee = grossBase * (feePct / 100);
    hops.push({
      venue: 'CURVE',
      inSymbol: c.sym,
      outSymbol: base,
      inAmount: tokens,
      outAmount: grossBase - fee,
      impactPct: impact,
      feeBps: Math.round(feePct * 100),
      feeAmount: fee,
    });
    if (twoHop) {
      const outNative = (grossBase - fee) * (1 - hopImpact / 100);
      hops.push({
        venue: aggregatorOf(net),
        inSymbol: base,
        outSymbol: unit,
        inAmount: grossBase - fee,
        outAmount: outNative,
        impactPct: hopImpact,
        feeBps: 0,
        feeAmount: 0,
      });
    }
  }

  const last = hops[hops.length - 1] as QuoteHop;
  const out = last.outAmount;
  return {
    sym: c.sym,
    net,
    side,
    nativeUnit: unit,
    amountIn,
    amountOut: out,
    minOut: out * (1 - SET.slip / 100),
    hops,
    routeLabel: hops.map((h) => h.venue).join(' -> '),
    effFeePct: feePct,
    impactPct: hops.reduce((n, h) => n + h.impactPct, 0),
    expiresAt: Date.now() + 8000,
  };
}

/* -------------------------------------------------------------------------- */
/* Adapter                                                                     */
/* -------------------------------------------------------------------------- */

export const simApi: StonkzApi = {
  mode: 'sim',

  async ready() {
    initPortfolio();
  },

  startStream() {
    if (timer) return;
    timer = window.setInterval(beat, TICK_MS);
  },

  stopStream() {
    if (!timer) return;
    clearInterval(timer);
    timer = 0;
  },

  /** Sim data is already synchronous and local; nothing to fetch. */
  async watchToken(c) {
    seedSeries(c);
    seedTrades(c);
  },
  unwatchToken() {
    /* nothing to tear down */
  },

  /** Board search, sim: a local, case-insensitive contains match. */
  async search(query) {
    const v = query.trim().toUpperCase();
    if (!v) return [];
    return COINS.filter(
      (c) =>
        c.sym.indexOf(v) > -1 ||
        c.name.toUpperCase().indexOf(v) > -1 ||
        c.dev.toUpperCase().indexOf(v) > -1,
    );
  },

  async quote(input) {
    return buildQuote(input);
  },

  /** TODO(Phase 2.R): build, simulate, sign and send; then await confirmation. */
  async trade(q) {
    const c = bySym(q.sym);
    if (!c) throw new Error('unknown ticker ' + q.sym);
    const buy = q.side === 'buy';
    // Buy amountIn is native; sell amountIn is tokens (matches live quotes).
    const nativeAmt = buy ? q.amountIn : q.amountOut;
    const tokAmt = buy ? q.amountOut : q.amountIn;
    const t = pushTrade(c, { buy, sol: nativeAmt, tok: tokAmt, mine: true });
    noteTrade(c, buy, nativeAmt, tokAmt);
    // A fill moves the curve, which is what makes the board feel alive.
    const push = (nativeAmt * NATIVE_PRICE.usd) / Math.max(1, liq(c));
    c.lastMc = c.mc;
    c.mc = Math.max(900, c.mc * (1 + (buy ? push : -push) * 0.55));
    addXP(xpForTrade(nativeAmt), (buy ? 'BUY ' : 'SELL ') + c.sym);
    unlock('first');
    if (nativeAmt * NATIVE_PRICE.usd >= 1000) unlock('whale');
    if (inCashback(c)) unlock('cashback');
    emit('coins');
    return toFill(c, t);
  },

  /**
   * The sandbox has no ledger, so estimate the lifetime take from 24h volume
   * and age, then split it exactly the way the programs do.
   */
  async tokenFees(c: SimCoin): Promise<TokenFees> {
    const net = c.net ?? WALLET.net;
    const feePct = Number(c.tfee || 1);
    const grossUsd = vol24(c) * Math.min(40, Math.max(0.15, c.age / 1440)) * (feePct / 100);
    const gross = grossUsd / nativeUsd(unitFor(net));
    const s = splitFee(gross);
    const stakers = s.creatorBucket * poolFrac(c);
    return {
      sym: c.sym,
      net,
      unit: unitFor(net),
      feeBps: Math.round(feePct * 100),
      effFeeBps: Math.round(effFee(c) * 100),
      split: { ...FEE_SPLIT },
      totals: {
        gross,
        protocol: s.protocol,
        buyback: s.buyback,
        rwa: s.rwa,
        creatorBucket: s.creatorBucket,
        creator: s.creatorBucket - stakers,
        stakers,
        referrals: 0,
      },
      source: 'sim',
    };
  },

  /** TODO(Phase 1.B): SIWS / SIWE, then read the balance from RPC. */
  async connect(net: Net): Promise<Wallet> {
    selectNet(net);
    WALLET.on = true;
    WALLET.sol = SIM_BALANCE[nativeUnit()];
    emit('wallet');
    return WALLET;
  },

  disconnect() {
    WALLET.on = false;
    HOLD.length = 0;
    emit('wallet');
    emit('portfolio');
  },

  /** TODO(Phase 2.L): `create_coin` + optional dev buy in one transaction. */
  async launch(d) {
    const supply = d.supply || SUPPLY;
    const mc = curveMc(d.buy);
    const c: SimCoin = {
      id: COINS.length,
      sym: d.sym,
      name: d.name || d.sym,
      desc: d.desc,
      mc,
      chg: 0,
      reps: 0,
      hold: d.buy > 0 ? 1 : 0,
      age: 0,
      seed: (Math.random() * 1e6) | 0,
      dev: WALLET.on ? WALLET.addr : 'YOU..7xKQ',
      lane: null,
      lastMc: mc,
      el: null,
      h: null,
      hv: null,
      trades: null,
      comments: null,
      mine: true,
      fee: 0,
      supply,
      base: d.base,
      tfee: d.tfee,
      net: WALLET.net,
      cashback: d.cashback,
      ...(d.cashback ? { cbStart: Date.now() } : {}),
      ...(d.x ? { x: d.x } : {}),
      ...(d.web ? { web: d.web } : {}),
      ...(d.tg ? { tg: d.tg } : {}),
      ...(d.uri ? { image: d.uri } : {}),
    };
    COINS.unshift(c);
    if (d.buy > 0) {
      seedTrades(c);
      pushTrade(c, { buy: true, sol: d.buy, mine: true });
      noteTrade(c, true, d.buy);
    }
    addXP(XP_LAUNCH, 'LAUNCH ' + c.sym);
    unlock('deploy');
    emit('coins');
    return c;
  },

  /** The claim modal's live-mode row, reshaped from the sim's own coin fields. */
  async claimableFees(): Promise<FeeVault[]> {
    return COINS.filter((c) => (c.fee ?? 0) > 0 || (c.feeTokens ?? 0) > 0).map((c) => ({
      sym: c.sym,
      native: c.fee ?? 0,
      tokens: c.feeTokens ?? 0,
    }));
  },

  /** TODO(Phase 2.F): `claim_creator_fees` against the coin's fee vault. */
  async claimCreatorFees(sym) {
    const list = sym
      ? [bySym(sym)].filter(Boolean as unknown as (c: SimCoin | null) => c is SimCoin)
      : COINS.filter((c) => c.mine);
    const res: ClaimResult = { native: 0, tokens: {} };
    for (const c of list) {
      res.native += c.fee ?? 0;
      if (c.feeTokens && c.feeTokens > 0) {
        res.tokens[c.sym] = (res.tokens[c.sym] ?? 0) + c.feeTokens;
        creditTokens(c.sym, c.feeTokens);
      }
      c.fee = 0;
      c.feeTokens = 0;
    }
    if (res.native > 0) {
      WALLET.sol += res.native;
      USER.feesClaimed = (USER.feesClaimed ?? 0) + res.native;
      addXP(xpForFeeClaim(res.native), 'FEE CLAIM');
      saveUser();
      emit('wallet');
    }
    return res;
  },

  /** TODO(Phase 4.B): `stake` into the coin's escrow with the lock encoded. */
  async stake({ sym, amount, days, mult }: StakeInput) {
    const c = bySym(sym);
    if (!c) return;
    const st = ensureStake(sym);
    const h = holdOf(sym);
    const amt = Math.min(amount, h ? h.tok : 0);
    if (amt <= 0) return;
    st.amt += amt;
    st.days = days;
    st.mult = mult;
    st.until = days ? Date.now() + days * 24 * HOUR : 0;
    if (h) {
      h.cost *= Math.max(0, 1 - amt / h.tok);
      h.tok -= amt;
      if (h.tok < 1) HOLD.splice(HOLD.indexOf(h), 1);
    }
    addXP(xpForStake(amt, circ(c)), 'STAKE ' + sym);
    unlock('stake');
    saveUser();
    emit('portfolio');
  },

  /** TODO(Phase 4.B): `unstake`, rejected on-chain while the lock is live. */
  async unstake(sym, amount) {
    const st = stakeOf(sym);
    if (!st || st.amt <= 0) return 0;
    if (st.until && Date.now() < st.until) return 0;
    const amt = amount === undefined ? st.amt : Math.min(amount, st.amt);
    if (!(amt > 0)) return 0;
    st.amt -= amt;
    if (st.amt <= 0) {
      st.amt = 0;
      st.mult = 1;
      st.days = 0;
      st.until = 0;
    }
    creditTokens(sym, amt);
    saveUser();
    return amt;
  },

  /** TODO(Phase 4.B): `claim_stake_rewards`. */
  async claimStake(sym) {
    const st = stakeOf(sym);
    const out: StakeClaim = { tokens: 0, native: 0 };
    if (!st) return out;
    out.tokens = st.rewTok;
    out.native = st.rewSol;
    if (out.tokens > 0) creditTokens(sym, out.tokens);
    if (out.native > 0) WALLET.sol += out.native;
    st.rewTok = 0;
    st.rewSol = 0;
    if (out.tokens > 0 || out.native > 0) addXP(12, 'STAKE CLAIM');
    saveUser();
    emit('wallet');
    return out;
  },

  async pushSettings() {
    /* sim: localStorage only via saveSettings */
  },
  async hydrateStake() {
    /* sim: USER.stake is already local */
  },

  /** TODO(Phase 3.C): the server rolls the drop and writes the ledger. */
  async openCrate(tier: CrateTier) {
    const crate = crateBy(tier);
    if (!crate) throw new Error('unknown crate ' + tier);
    syncSpLevelGrants();
    const inv = USER.crateInventory?.[tier] ?? 0;
    if (inv <= 0) throw new Error('no_inventory');
    const now = Date.now();
    const anyReady = Object.values(USER.crates ?? {}).some((t) => typeof t === 'number' && t > now);
    if (anyReady) throw new Error('cooling_down');

    const i = rollDrop(crate);
    const drop = crate.drops[i];
    if (!drop) throw new Error('empty drop table for ' + tier);
    const tierIndex = CRATES.findIndex((c) => c.k === tier);
    const xp = crateXp(tierIndex);
    let res: CrateResult;
    if (drop[1] === 'S') {
      const amount = rollCrateAmount(drop);
      USER.stonkz = (USER.stonkz ?? 0) + amount;
      res = {
        tier,
        kind: 'S',
        amount,
        item: '',
        label: num(amount) + ' $STONKZ',
        dropIndex: i,
        xp,
      };
    } else if (drop[1] === 'R') {
      const asset = drop[2];
      const units = rollRwaUnits(drop);
      creditRwa(asset, units);
      res = {
        tier,
        kind: 'R',
        amount: 0,
        asset,
        units,
        item: '',
        label: fmtUnits(units) + ' ' + asset,
        dropIndex: i,
        xp,
      };
    } else {
      res = { tier, kind: 'I', amount: 0, item: drop[2], label: drop[2], dropIndex: i, xp };
    }

    // Global cooldown — stamp every tier with this crate's lock window.
    const ready = crateReadyAt(crate, now);
    if (!USER.crates) USER.crates = {};
    for (const c of CRATES) USER.crates[c.k] = ready;
    if (!USER.crateInventory) USER.crateInventory = {};
    USER.crateInventory[tier] = inv - 1;

    pushDrop({ t: clock(), k: tier, r: res.label, col: crate.col });
    saveUser();
    addXP(xp, 'CRATE ' + tier);
    unlock('crate');
    return res;
  },
};

/** Exposed for the board so a graduation can be detected without re-deriving. */
export const GRAD_MC = GRAD;

export type { Fill };
