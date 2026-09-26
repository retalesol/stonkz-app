import { MAJORS, nativeUnit, rng, splitFee, type Net } from '@stonkz/shared';
import type { ChainEvent } from '../events.js';

/**
 * The fixture producer (plan step 56).
 *
 * The programs do not exist yet, so this is what drives the event schema
 * end to end: it emits the same `ChainEvent` shapes the decoders will, on both
 * chains, with plausible positions, signatures and timings. Everything is
 * seeded through the shared `rng()` LCG, so a scenario is
 * byte-identical on every run and a test failure reproduces exactly.
 *
 * Two properties matter for the review gates:
 *
 *  - fee legs are produced with `splitFee()`, so the 20/60/10/10 assertion in
 *    `assertFeeSplit` is checking real arithmetic rather than a copy of itself;
 *  - amounts straddle the dust floor and the whale cut deliberately, so a
 *    replay exercises the zero-award and achievement paths, not just the happy
 *    middle.
 */

export interface ProducerOptions {
  net: Net;
  seed?: number;
  /** Epoch ms of the first event. */
  startMs?: number;
  /** Slot (Solana) or block (EVM) to start at. */
  startPosition?: number;
  /** Wall-clock gap between consecutive events. */
  stepMs?: number;
}

const CHAIN_DEFAULTS: Record<Net, { position: number; positionsPerStep: number }> = {
  // ~400ms slots and ~2s blocks, so one event every 5s is 12 slots or 2 blocks.
  SOL: { position: 250_000_000, positionsPerStep: 12 },
  RH: { position: 21_000_000, positionsPerStep: 2 },
  BASE: { position: 46_000_000, positionsPerStep: 2 },
  // ~1s blocks: one event every 5s is 5 blocks.
  ARC: { position: 1_000_000, positionsPerStep: 5 },
};

export class FixtureProducer {
  private readonly net: Net;
  private readonly rand: () => number;
  private atMs: number;
  private position: number;
  private readonly stepMs: number;
  private readonly positionsPerStep: number;
  private txCounter = 0;
  private readonly events: ChainEvent[] = [];

  constructor(opts: ProducerOptions) {
    this.net = opts.net;
    this.rand = rng(opts.seed ?? 0xc0ffee);
    this.atMs = opts.startMs ?? Date.parse('2026-09-06T00:00:00.000Z');
    this.position = opts.startPosition ?? CHAIN_DEFAULTS[opts.net].position;
    this.stepMs = opts.stepMs ?? 5_000;
    this.positionsPerStep = CHAIN_DEFAULTS[opts.net].positionsPerStep;
  }

  /** Deterministic, chain-shaped signature: base58-ish on SOL, 0x-hex on RH. */
  private nextSig(): string {
    const n = ++this.txCounter;
    if (this.net === 'SOL') {
      const body = `${this.net}${n}`.padEnd(12, 'x');
      return `sig${body}${Math.floor(this.rand() * 1e12).toString(36)}`;
    }
    return `0x${n.toString(16).padStart(8, '0')}${Math.floor(this.rand() * 1e15)
      .toString(16)
      .padStart(56, '0')}`.slice(0, 66);
  }

  private tick(): void {
    this.atMs += this.stepMs;
    this.position += this.positionsPerStep;
  }

  private base(logIndex = 0): {
    net: Net;
    txSig: string;
    logIndex: number;
    chainPosition: number;
    blockTimeMs: number;
  } {
    return {
      net: this.net,
      txSig: this.nextSig(),
      logIndex,
      chainPosition: this.position,
      blockTimeMs: this.atMs,
    };
  }

  private push<T extends ChainEvent>(event: T): T {
    this.events.push(event);
    return event;
  }

  /** A launch, optionally with the 5-minute cashback window open. */
  launch(input: {
    sym: string;
    name: string;
    creator: string;
    feeBps?: number;
    cashback?: boolean;
    supply?: number;
    mc?: number;
    baseSymbol?: string;
  }): ChainEvent {
    this.tick();
    const base = this.base();
    const majors = MAJORS[this.net];
    const baseSymbol = input.baseSymbol ?? majors[0]?.[0] ?? nativeUnit(this.net);

    const created = this.push({
      ...base,
      kind: 'TokenCreated' as const,
      sym: input.sym,
      name: input.name,
      descr: `${input.name} — fixture launch on ${this.net}`,
      creator: input.creator,
      baseSymbol,
      baseMint: `${baseSymbol}-mint-${this.net}`,
      supply: input.supply ?? 1_000_000_000,
      feeBps: input.feeBps ?? 250,
      cashback: input.cashback ?? false,
      seed: Math.floor(this.rand() * 1e9),
      mc: input.mc ?? 4_200,
    });

    if (input.cashback ?? false) {
      this.push({
        ...this.base(1),
        chainPosition: base.chainPosition,
        blockTimeMs: base.blockTimeMs,
        txSig: base.txSig,
        kind: 'CashbackWindow' as const,
        sym: input.sym,
        open: true,
        startedAtMs: base.blockTimeMs,
        baseFeeBps: input.feeBps ?? 250,
        // The window opens at 5x the base fee and decays back over 5 minutes.
        startFeeBps: (input.feeBps ?? 250) * 5,
      });
    }
    return created;
  }

  /**
   * A fill, plus the `FeeAccrued` it settles. They share a transaction
   * signature and differ by log index, exactly as the program will emit them.
   */
  trade(input: {
    sym: string;
    trader: string;
    side: 'buy' | 'sell';
    nativeAmount: number;
    mc: number;
    tokenAmount?: number;
    feeBps?: number;
    cashback?: boolean;
    nativeUsd?: number;
    stakerShare?: number;
  }): ChainEvent[] {
    this.tick();
    const base = this.base(0);
    const nativeUsd = input.nativeUsd ?? (this.net === 'SOL' ? 214.08 : 4200);
    const usdValue = input.nativeAmount * nativeUsd;
    const feeBps = input.feeBps ?? 250;
    const feeAmount = input.nativeAmount * (feeBps / 10_000);
    const legs = splitFee(feeAmount);
    const stakerShare = input.stakerShare ?? 0;

    const trade = this.push({
      ...base,
      kind: 'Trade' as const,
      sym: input.sym,
      trader: input.trader,
      side: input.side,
      nativeAmount: input.nativeAmount,
      baseAmount: input.nativeAmount,
      tokenAmount: input.tokenAmount ?? usdValue / (input.mc / 1_000_000_000),
      usdValue,
      mc: input.mc,
      cashback: input.cashback ?? false,
    });

    const fee = this.push({
      ...base,
      logIndex: 1,
      kind: 'FeeAccrued' as const,
      sym: input.sym,
      creator: `creator-${input.sym}`,
      feeAmount,
      protocol: legs.protocol,
      creatorBucket: legs.creatorBucket,
      stonkzOps: legs.stonkzOps,
      burn: legs.burn,
      stakerShare,
      // In a cashback window the creator's cut arrives as tokens, not native.
      creatorTokens: (input.cashback ?? false) ? legs.creatorBucket * nativeUsd : 0,
    });

    return [trade, fee];
  }

  graduate(sym: string, mc = 69_000): ChainEvent {
    this.tick();
    return this.push({ ...this.base(), kind: 'Graduated' as const, sym, mc });
  }

  claimCreatorFees(input: {
    sym: string;
    creator: string;
    nativeAmount: number;
    tokenAmount?: number;
  }): ChainEvent {
    this.tick();
    return this.push({
      ...this.base(),
      kind: 'CreatorFeesClaimed' as const,
      sym: input.sym,
      creator: input.creator,
      nativeAmount: input.nativeAmount,
      tokenAmount: input.tokenAmount ?? 0,
    });
  }

  stake(input: {
    sym: string;
    wallet: string;
    amount: number;
    lockDays?: number;
    mult?: number;
    circulating?: number;
  }): ChainEvent {
    this.tick();
    const lockDays = input.lockDays ?? 7;
    return this.push({
      ...this.base(),
      kind: 'Staked' as const,
      sym: input.sym,
      wallet: input.wallet,
      amount: input.amount,
      lockDays,
      mult: input.mult ?? 1.5,
      untilMs: this.atMs + lockDays * 86_400_000,
      circulating: input.circulating ?? 800_000_000,
    });
  }

  unstake(input: { sym: string; wallet: string; amount: number }): ChainEvent {
    this.tick();
    return this.push({ ...this.base(), kind: 'Unstaked' as const, ...input });
  }

  claimStake(input: {
    sym: string;
    wallet: string;
    rewardNative: number;
    rewardTokens?: number;
  }): ChainEvent {
    this.tick();
    return this.push({
      ...this.base(),
      kind: 'StakeClaimed' as const,
      sym: input.sym,
      wallet: input.wallet,
      rewardNative: input.rewardNative,
      rewardTokens: input.rewardTokens ?? 0,
    });
  }

  closeCashback(input: { sym: string; baseFeeBps?: number }): ChainEvent {
    this.tick();
    return this.push({
      ...this.base(),
      kind: 'CashbackWindow' as const,
      sym: input.sym,
      open: false,
      startedAtMs: 0,
      baseFeeBps: input.baseFeeBps ?? 250,
      startFeeBps: input.baseFeeBps ?? 250,
    });
  }

  treasuryCredit(input: {
    vault: 'protocol' | 'stonkz_ops';
    amount: number;
    sym?: string;
  }): ChainEvent {
    this.tick();
    return this.push({
      ...this.base(),
      kind: 'TreasuryCredit' as const,
      vault: input.vault,
      sym: input.sym ?? null,
      amount: input.amount,
    });
  }

  /** Everything produced so far, in emission order. */
  all(): ChainEvent[] {
    return [...this.events];
  }

  get head(): number {
    return this.position;
  }

  get clockMs(): number {
    return this.atMs;
  }
}

export interface ScenarioResult {
  events: ChainEvent[];
  heads: Record<Net, number>;
  /** Handy anchors for assertions. */
  actors: {
    solTrader: string;
    solWhale: string;
    solDust: string;
    solCreator: string;
    rhTrader: string;
    rhWhale: string;
    rhCreator: string;
  };
}

/**
 * The canonical replay used by the review gates.
 *
 * It covers, on both chains: a plain launch and a cashback launch, a whale
 * buy, an ordinary buy, a dust buy, a sell that retires cost basis, fee
 * accrual, a creator claim, a stake and a stake claim, a graduation with a
 * live holder, and a standalone treasury credit.
 */
export function canonicalScenario(seed = 0xc0ffee): ScenarioResult {
  const actors: ScenarioResult['actors'] = {
    solTrader: 'SoLtrader1111111111111111111111111111111111',
    solWhale: 'SoLwhale22222222222222222222222222222222222',
    solDust: 'SoLdust333333333333333333333333333333333333',
    solCreator: 'creator-DOGGO',
    rhTrader: '0x1111111111111111111111111111111111111111',
    rhWhale: '0x2222222222222222222222222222222222222222',
    rhCreator: 'creator-RHDOG',
  };

  const sol = new FixtureProducer({
    net: 'SOL',
    seed,
    startMs: Date.parse('2026-09-06T00:00:00.000Z'),
  });
  const rh = new FixtureProducer({
    net: 'RH',
    seed: seed ^ 0x5eed,
    startMs: Date.parse('2026-09-06T00:00:00.000Z'),
  });

  // --- Solana -------------------------------------------------------------
  sol.launch({ sym: 'DOGGO', name: 'Doggo Coin', creator: actors.solCreator, feeBps: 250 });
  sol.launch({
    sym: 'CASHY',
    name: 'Cashy Coin',
    creator: actors.solCreator,
    feeBps: 300,
    cashback: true,
  });

  // 6 SOL is over the 5 SOL whale cut.
  sol.trade({ sym: 'DOGGO', trader: actors.solWhale, side: 'buy', nativeAmount: 6, mc: 12_000 });
  sol.trade({ sym: 'DOGGO', trader: actors.solTrader, side: 'buy', nativeAmount: 1.5, mc: 18_000 });
  // 0.004 SOL is under the 0.01 SOL dust floor: zero award, no achievement.
  sol.trade({ sym: 'DOGGO', trader: actors.solDust, side: 'buy', nativeAmount: 0.004, mc: 18_100 });
  sol.trade({
    sym: 'CASHY',
    trader: actors.solTrader,
    side: 'buy',
    nativeAmount: 2,
    mc: 30_000,
    cashback: true,
    feeBps: 300,
  });
  sol.trade({
    sym: 'DOGGO',
    trader: actors.solTrader,
    side: 'sell',
    nativeAmount: 0.75,
    mc: 17_000,
    tokenAmount: 4_000_000,
  });

  sol.claimCreatorFees({ sym: 'DOGGO', creator: actors.solCreator, nativeAmount: 0.42 });
  sol.stake({ sym: 'DOGGO', wallet: actors.solTrader, amount: 40_000_000, lockDays: 30, mult: 2 });
  sol.claimStake({ sym: 'DOGGO', wallet: actors.solTrader, rewardNative: 0.05 });
  sol.closeCashback({ sym: 'CASHY', baseFeeBps: 300 });

  // Push DOGGO through graduation with the whale still holding.
  sol.trade({ sym: 'DOGGO', trader: actors.solWhale, side: 'buy', nativeAmount: 9, mc: 69_500 });
  sol.graduate('DOGGO', 69_500);
  sol.treasuryCredit({ vault: 'stonkz_ops', amount: 0.01 });

  // --- Robinhood ----------------------------------------------------------
  rh.launch({ sym: 'RHDOG', name: 'RH Doggo', creator: actors.rhCreator, feeBps: 200 });
  // 2.5 ETH is over the 2 ETH cut documented in game/rules.ts.
  rh.trade({
    sym: 'RHDOG',
    trader: actors.rhWhale,
    side: 'buy',
    nativeAmount: 2.5,
    mc: 15_000,
    feeBps: 200,
  });
  // Crosses 55% of the $69K cap, so RHDOG moves from the `new` lane to `soon`.
  rh.trade({
    sym: 'RHDOG',
    trader: actors.rhTrader,
    side: 'buy',
    nativeAmount: 0.2,
    mc: 40_000,
    feeBps: 200,
  });
  // 0.0002 ETH is under the 0.0005 ETH dust floor.
  rh.trade({
    sym: 'RHDOG',
    trader: actors.rhTrader,
    side: 'buy',
    nativeAmount: 0.0002,
    mc: 40_100,
    feeBps: 200,
  });
  rh.claimCreatorFees({ sym: 'RHDOG', creator: actors.rhCreator, nativeAmount: 0.008 });

  return {
    events: [...sol.all(), ...rh.all()],
    heads: { SOL: sol.head, RH: rh.head, BASE: rh.head, ARC: rh.head },
    actors,
  };
}
