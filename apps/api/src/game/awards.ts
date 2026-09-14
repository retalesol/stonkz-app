import {
  XP_FOLLOW,
  XP_LAUNCH,
  XP_LAUNCH_BOND,
  XP_STAKE_CLAIM,
  xpForFeeClaim,
  xpForStake,
  xpForTrade,
  type Net,
} from '@stonkz/shared';
import { DEFAULT_DUST, DEFAULT_WHALE_CUT, REASONS } from './rules.js';
import type { AwardResult, Ledger } from './ledger.js';
import type { SocialCapsService } from './social-caps.js';

/**
 * The award rule set.
 *
 * Each method sequences ledger awards and achievement unlocks. Social XP is
 * gated by {@link SocialCapsService} (comments/likes daily caps).
 */

export interface GameAwardsOptions {
  ledger: Ledger;
  socialCaps: SocialCapsService;
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

  private get socialCaps(): SocialCapsService {
    return this.opts.socialCaps;
  }

  isDust(net: Net, nativeNotional: number): boolean {
    return nativeNotional < this.dust[net];
  }

  async trade(event: TradeEvent): Promise<TradeAwardOutcome> {
    const { net, wallet, sym, txSig, side, nativeNotional } = event;
    const dust = this.isDust(net, nativeNotional);
    const unlocked: string[] = [];

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

  /** Launch a coin — 50 XP/SP. Cashback unlock still available, no double XP. */
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

  /** Creator bonus when their token bonds / graduates — 250 XP/SP. */
  async launchBonded(input: {
    net: Net;
    wallet: string;
    sym: string;
    txSig: string;
  }): Promise<{ xp: number }> {
    await this.ledger.touchStreak(input.net, input.wallet);
    const award = await this.ledger.award({
      net: input.net,
      wallet: input.wallet,
      reason: REASONS.launchBond,
      baseXp: XP_LAUNCH_BOND,
      sym: input.sym,
      txSig: input.txSig,
    });
    return { xp: award.xp };
  }

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

  /** Follow — achievement only; no XP (anti-farm). */
  async follow(input: { net: Net; wallet: string; target: string }): Promise<AwardResult> {
    await this.ledger.touchStreak(input.net, input.wallet);
    const award = await this.ledger.award({
      net: input.net,
      wallet: input.wallet,
      reason: REASONS.follow,
      baseXp: XP_FOLLOW,
      txSig: `follow:${input.target}`,
      meta: { target: input.target },
      zeroAward: true,
    });
    await this.ledger.unlock(input.net, input.wallet, 'social');
    return award;
  }

  /** Wall comment — 1 XP if under daily social cap. */
  async wallPost(input: {
    net: Net;
    wallet: string;
    target: string;
    tipSig: string;
  }): Promise<AwardResult> {
    await this.ledger.touchStreak(input.net, input.wallet);
    const { xp } = await this.socialCaps.tryComment(input.net, input.wallet, input.tipSig);
    await this.ledger.unlock(input.net, input.wallet, 'social');
    const bal = await this.ledger.readBalance(input.net, input.wallet);
    return {
      awarded: xp > 0,
      xp,
      sp: xp,
      baseXp: xp,
      totalXp: bal.xp,
      cappedBy: xp > 0 ? 'none' : 'daily_xp',
      streak: await this.ledger.currentStreak(input.net, input.wallet),
      mult: 1,
      rankBefore: 0,
      rankAfter: 0,
      rankedUp: false,
    };
  }

  /** Like a wall post — 1 XP if under daily like cap. */
  async like(input: { net: Net; wallet: string; postId: number }): Promise<{ xp: number }> {
    await this.ledger.touchStreak(input.net, input.wallet);
    const { xp } = await this.socialCaps.tryLike(input.net, input.wallet, input.postId);
    return { xp };
  }

  /** Daily check-in — 10 SP once per UTC day. */
  async dailyCheckin(input: { net: Net; wallet: string }): Promise<{ claimed: boolean; sp: number }> {
    await this.ledger.touchStreak(input.net, input.wallet);
    return this.socialCaps.tryCheckin(input.net, input.wallet);
  }

  async graduatedWhileHolding(input: {
    net: Net;
    wallet: string;
    sym: string;
    txSig: string;
  }): Promise<boolean> {
    await this.ledger.touchStreak(input.net, input.wallet);
    return (await this.ledger.unlock(input.net, input.wallet, 'grad', input.txSig)).unlocked;
  }

  async diamondHands(input: {
    net: Net;
    wallet: string;
    sym: string;
    txSig: string;
  }): Promise<boolean> {
    return (await this.ledger.unlock(input.net, input.wallet, 'diamond', input.txSig)).unlocked;
  }
}
