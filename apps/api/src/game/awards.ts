import {
  XP_FOLLOW,
  XP_LAUNCH,
  XP_STAKE_CLAIM,
  XP_WALL_POST,
  xpForFeeClaim,
  xpForStake,
  xpForTrade,
  type Net,
} from '@stonkz/shared';
import { DEFAULT_DUST, DEFAULT_WHALE_CUT, REASONS } from './rules.js';
import type { AwardResult, Ledger } from './ledger.js';

/**
 * The award rule set, ported one-for-one from `legacy/index.html`.
 *
 * Each method is the server-side counterpart of a call site in the sim, cited
 * by line. The arithmetic is imported from `@stonkz/shared`, so this file only
 * sequences the awards and the achievement unlocks — in the same order the sim
 * fired them, because that order decides which award hits the daily cap first
 * and therefore what the user sees.
 */

export interface GameAwardsOptions {
  ledger: Ledger;
  dust?: Record<Net, number>;
  whaleCut?: Record<Net, number>;
}

export interface TradeEvent {
  net: Net;
  wallet: string;
  sym: string;
  txSig: string;
  side: 'buy' | 'sell';
  /** Native notional — SOL or ETH. Awards weight on this, never on USD. */
  nativeNotional: number;
}

export interface TradeAwardOutcome {
  xp: number;
  sp: number;
  dust: boolean;
  unlocked: string[];
  rankedUp: boolean;
}

export class GameAwards {
  private readonly dust: Record<Net, number>;
  private readonly whaleCut: Record<Net, number>;

  constructor(private readonly opts: GameAwardsOptions) {
    this.dust = opts.dust ?? DEFAULT_DUST;
    this.whaleCut = opts.whaleCut ?? DEFAULT_WHALE_CUT;
  }

  private get ledger(): Ledger {
    return this.opts.ledger;
  }

  isDust(net: Net, nativeNotional: number): boolean {
    return nativeNotional < this.dust[net];
  }

  /**
   * `index.html:1972-1974`
   *
   *   unlock("first");
   *   if (buy && sol >= 5) unlock("whale");
   *   addXP(max(5, round(sol*40)), "TRADE");
   *
   * Dust fills (plan step 106) award nothing and unlock nothing, but the event
   * is still recorded at zero so a replay cannot revisit the decision.
   */
  async trade(event: TradeEvent): Promise<TradeAwardOutcome> {
    const { net, wallet, sym, txSig, side, nativeNotional } = event;
    const dust = this.isDust(net, nativeNotional);
    const unlocked: string[] = [];

    // The streak gates every multiplier below, so it moves first.
    await this.ledger.touchStreak(net, wallet);

    if (!dust) {
      if ((await this.ledger.unlock(net, wallet, 'first', txSig)).unlocked) unlocked.push('first');
      if (side === 'buy' && nativeNotional >= this.whaleCut[net]) {
        if ((await this.ledger.unlock(net, wallet, 'whale', txSig)).unlocked) unlocked.push('whale');
      }
    }

    const award = await this.ledger.award({
      net,
      wallet,
      reason: REASONS.trade,
      baseXp: dust ? 0 : xpForTrade(nativeNotional),
      sym,
      txSig,
      zeroAward: dust,
      meta: { side, nativeNotional },
    });

    return { xp: award.xp, sp: award.sp, dust, unlocked, rankedUp: award.rankedUp };
  }

  /** `index.html:3967-3968` — addXP(150); unlock("deploy"); cashback ? unlock("cashback"). */
  async launch(input: {
    net: Net;
    wallet: string;
    sym: string;
    txSig: string;
    cashback: boolean;
  }): Promise<{ xp: number; unlocked: string[] }> {
    await this.ledger.touchStreak(input.net, input.wallet);
    const award = await this.ledger.award({
      net: input.net,
      wallet: input.wallet,
      reason: REASONS.launch,
      baseXp: XP_LAUNCH,
      sym: input.sym,
      txSig: input.txSig,
    });

    const unlocked: string[] = [];
    if ((await this.ledger.unlock(input.net, input.wallet, 'deploy', input.txSig)).unlocked) {
      unlocked.push('deploy');
    }
    if (input.cashback) {
      if ((await this.ledger.unlock(input.net, input.wallet, 'cashback', input.txSig)).unlocked) {
        unlocked.push('cashback');
      }
    }
    return { xp: award.xp, unlocked };
  }

  /** `index.html:3047` — addXP(max(10, round(tot*30)), "FEE CLAIM"). */
  async feeClaim(input: {
    net: Net;
    wallet: string;
    sym?: string;
    txSig: string;
    nativeTotal: number;
  }): Promise<AwardResult> {
    await this.ledger.touchStreak(input.net, input.wallet);
    return this.ledger.award({
      net: input.net,
      wallet: input.wallet,
      reason: REASONS.feeClaim,
      baseXp: xpForFeeClaim(input.nativeTotal),
      sym: input.sym,
      txSig: input.txSig,
      meta: { nativeTotal: input.nativeTotal },
    });
  }

  /**
   * `index.html:3177-3178` — addXP(max(5, round(amt/circ*400)), "STAKE");
   * unlock("stake"). Live from Phase 4; the rule is ported now so the ledger
   * does not need a second pass.
   */
  async stake(input: {
    net: Net;
    wallet: string;
    sym: string;
    txSig: string;
    amount: number;
    circulating: number;
  }): Promise<{ xp: number; unlocked: string[] }> {
    await this.ledger.touchStreak(input.net, input.wallet);
    const award = await this.ledger.award({
      net: input.net,
      wallet: input.wallet,
      reason: REASONS.stake,
      baseXp: xpForStake(input.amount, input.circulating),
      sym: input.sym,
      txSig: input.txSig,
    });
    const unlocked: string[] = [];
    if ((await this.ledger.unlock(input.net, input.wallet, 'stake', input.txSig)).unlocked) {
      unlocked.push('stake');
    }
    return { xp: award.xp, unlocked };
  }

  /** `index.html:3203` — addXP(12, "STAKE CLAIM"). */
  async stakeClaim(input: { net: Net; wallet: string; sym: string; txSig: string }): Promise<AwardResult> {
    await this.ledger.touchStreak(input.net, input.wallet);
    return this.ledger.award({
      net: input.net,
      wallet: input.wallet,
      reason: REASONS.stakeClaim,
      baseXp: XP_STAKE_CLAIM,
      sym: input.sym,
      txSig: input.txSig,
    });
  }

  /**
   * `index.html:3270` — addXP(6, "FOLLOW"); unlock("social").
   * `target` becomes the dedupe key so the pair only ever pays once (gate 5.A).
   */
  async follow(input: { net: Net; wallet: string; target: string }): Promise<AwardResult> {
    await this.ledger.touchStreak(input.net, input.wallet);
    const award = await this.ledger.award({
      net: input.net,
      wallet: input.wallet,
      reason: REASONS.follow,
      baseXp: XP_FOLLOW,
      txSig: `follow:${input.target}`,
      meta: { target: input.target },
    });
    await this.ledger.unlock(input.net, input.wallet, 'social');
    return award;
  }

  /** `index.html:3332-3333` — addXP(8, "WALL POST"); unlock("social"). */
  async wallPost(input: {
    net: Net;
    wallet: string;
    target: string;
    /** The tip signature. Phase 5 requires one post per signature. */
    tipSig: string;
  }): Promise<AwardResult> {
    await this.ledger.touchStreak(input.net, input.wallet);
    const award = await this.ledger.award({
      net: input.net,
      wallet: input.wallet,
      reason: REASONS.wallPost,
      baseXp: XP_WALL_POST,
      txSig: input.tipSig,
      meta: { target: input.target },
    });
    await this.ledger.unlock(input.net, input.wallet, 'social');
    return award;
  }

  /**
   * `index.html:4059` — unlock("grad") for a holder at the moment of
   * graduation. The achievement itself pays the 250 XP of plan step 115.
   */
  async graduatedWhileHolding(input: {
    net: Net;
    wallet: string;
    sym: string;
    txSig: string;
  }): Promise<boolean> {
    await this.ledger.touchStreak(input.net, input.wallet);
    return (await this.ledger.unlock(input.net, input.wallet, 'grad', input.txSig)).unlocked;
  }

  /**
   * `index.html:4082` — unlock("diamond") at −25% unrealised. Runs as an
   * indexer sweep (plan step 116), not off the client's animation counter.
   * `txSig` is the fill that established the position, which is what makes the
   * award verifiable.
   */
  async diamondHands(input: {
    net: Net;
    wallet: string;
    sym: string;
    txSig: string;
  }): Promise<boolean> {
    return (await this.ledger.unlock(input.net, input.wallet, 'diamond', input.txSig)).unlocked;
  }
}
