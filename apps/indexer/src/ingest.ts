import { and, asc, desc, eq, gt, gte, sql } from 'drizzle-orm';
import { laneOf, type Lane, type Net } from '@stonkz/shared';
import type { Db } from '@stonkz/api/db/client';
import { isUniqueViolation } from '@stonkz/api/db/errors';
import {
  candles,
  chainEvents,
  creatorVaults,
  holdersSnapshot,
  koth,
  stakePositions,
  tape,
  tokens,
  trades,
  treasuries,
  treasuryCredits,
} from '@stonkz/api/db/schema';
import type { GameAwards } from '@stonkz/api/game/awards';
import type { Ledger } from '@stonkz/api/game/ledger';
import type { Publisher } from '@stonkz/api/ws/publisher';
import type { Logger } from '@stonkz/api/observability/logger';
import { candleUpdatesFor } from './candles.js';
import {
  assertEventIntegrity,
  compareEvents,
  type ChainEvent,
  type CreatorFeesClaimedEvent,
  type FeeAccruedEvent,
  type GraduatedEvent,
  type StakeClaimedEvent,
  type StakedEvent,
  type TokenCreatedEvent,
  type TradeEvent,
  type TreasuryCreditEvent,
  type UnstakedEvent,
  type CashbackWindowEvent,
} from './events.js';

export interface IngestOptions {
  db: Db;
  ledger: Ledger;
  awards: GameAwards;
  publisher: Publisher;
  logger: Logger;
  now?: () => number;
}

export interface IngestReport {
  accepted: number;
  /** Already in `chain_events` — a replay, not an error. */
  duplicates: number;
  rejected: { event: ChainEvent; reason: string }[];
  xpAwarded: number;
  achievementsUnlocked: string[];
  /** Highest chain position accepted, per net. */
  positions: Partial<Record<Net, number>>;
}

/** How far back `chg` looks, matching the 24H label on the card. */
const CHANGE_WINDOW_MS = 86_400_000;

/**
 * Turns chain events into read tables and verified game awards.
 *
 * The order inside `apply()` is the load-bearing part: an event is appended to
 * `chain_events` **before** any award is attempted, because `Ledger.award()`
 * refuses a chain-derived reason unless that row already exists. That is the
 * mechanism behind "no XP without a verified event" — it is not a convention
 * the caller has to remember, it is a lookup that fails.
 *
 * Ingest is idempotent: the unique index on
 * `(net, tx_sig, log_index, kind)` turns a re-delivered batch into a
 * `duplicates` count, and `xp_events`' own constraint catches anything that
 * slips past.
 */
export class Ingestor {
  private readonly now: () => number;

  constructor(private readonly opts: IngestOptions) {
    this.now = opts.now ?? Date.now;
  }

  private get db(): Db {
    return this.opts.db;
  }

  /** Canonical mint for a token: hint, newest row for (net, sym), or legacy fallback. */
  private async resolveMint(net: Net, sym: string, mintHint?: string): Promise<string> {
    const hint = mintHint?.trim();
    if (hint) return hint;
    const [row] = await this.db
      .select({ mint: tokens.mint })
      .from(tokens)
      .where(and(eq(tokens.net, net), eq(tokens.sym, sym)))
      .orderBy(desc(tokens.launchedAt))
      .limit(1);
    return row?.mint ?? `legacy:${net}:${sym}`;
  }

  /** Processes a batch in chain order. */
  async apply(events: readonly ChainEvent[]): Promise<IngestReport> {
    const report: IngestReport = {
      accepted: 0,
      duplicates: 0,
      rejected: [],
      xpAwarded: 0,
      achievementsUnlocked: [],
      positions: {},
    };

    for (const event of [...events].sort(compareEvents)) {
      try {
        assertEventIntegrity(event);
      } catch (err) {
        report.rejected.push({ event, reason: err instanceof Error ? err.message : String(err) });
        this.opts.logger.error('event rejected', {
          kind: event.kind,
          net: event.net,
          txSig: event.txSig,
          reason: err instanceof Error ? err.message : String(err),
        });
        continue;
      }

      const recorded = await this.record(event);
      if (!recorded) {
        report.duplicates++;
        continue;
      }

      await this.dispatch(event, report);
      report.accepted++;
      const seen = report.positions[event.net] ?? 0;
      if (event.chainPosition > seen) report.positions[event.net] = event.chainPosition;
    }

    return report;
  }

  /** Appends to `chain_events`; false means it was already there. */
  private async record(event: ChainEvent): Promise<boolean> {
    const { net, kind, txSig, logIndex, chainPosition, blockTimeMs, ...payload } = event;
    try {
      const inserted = await this.db
        .insert(chainEvents)
        .values({
          net,
          kind,
          sym: 'sym' in event ? ((event as { sym: string | null }).sym ?? null) : null,
          wallet:
            'wallet' in event
              ? (event as { wallet: string }).wallet
              : 'trader' in event
                ? (event as { trader: string }).trader
                : 'creator' in event
                  ? (event as { creator: string }).creator
                  : null,
          txSig,
          logIndex,
          chainPosition,
          blockTime: new Date(blockTimeMs),
          payload: payload as Record<string, unknown>,
        })
        .onConflictDoNothing()
        .returning({ id: chainEvents.id });
      return inserted.length > 0;
    } catch (err) {
      if (isUniqueViolation(err)) return false;
      throw err;
    }
  }

  private async dispatch(event: ChainEvent, report: IngestReport): Promise<void> {
    switch (event.kind) {
      case 'TokenCreated':
        return this.onTokenCreated(event, report);
      case 'Trade':
        return this.onTrade(event, report);
      case 'Graduated':
        return this.onGraduated(event, report);
      case 'FeeAccrued':
        return this.onFeeAccrued(event);
      case 'CreatorFeesClaimed':
        return this.onCreatorFeesClaimed(event, report);
      case 'Staked':
        return this.onStaked(event, report);
      case 'Unstaked':
        return this.onUnstaked(event);
      case 'StakeClaimed':
        return this.onStakeClaimed(event, report);
      case 'CashbackWindow':
        return this.onCashbackWindow(event);
      case 'TreasuryCredit':
        return this.onTreasuryCredit(event);
    }
  }

  /* ------------------------------------------------------------- launches */

  private async onTokenCreated(event: TokenCreatedEvent, report: IngestReport): Promise<void> {
    const lane = laneOf({ mc: event.mc });
    const mint = event.mint?.trim() || `legacy:${event.net}:${event.sym}`;
    await this.db
      .insert(tokens)
      .values({
        net: event.net,
        sym: event.sym,
        name: event.name,
        descr: event.descr,
        creator: event.creator,
        mint,
        baseSymbol: event.baseSymbol,
        baseMint: event.baseMint,
        supply: event.supply,
        feeBps: event.feeBps,
        cashback: event.cashback,
        cbStartMs: event.cashback ? event.blockTimeMs : null,
        mc: event.mc,
        lastMc: event.mc,
        lane,
        seed: event.seed,
        xHandle: event.xHandle ?? null,
        website: event.website ?? null,
        telegram: event.telegram ?? null,
        launchedAt: new Date(event.blockTimeMs),
        updatedAt: new Date(this.now()),
        // A chain source decodes the real curve; the fixture producer has none
        // and leaves the columns at their `'0'` defaults.
        ...(event.curve
          ? {
              tokenDecimals: event.curve.tokenDecimals,
              baseDecimals: event.curve.baseDecimals,
              basePriceUsd1e6: event.curve.basePriceUsd1e6,
              curveTokensForSale: event.curve.tokensForSale,
              curveVirtualBase0: event.curve.virtualBase0,
              curveVirtualToken0: event.curve.virtualToken0,
              curveK: event.curve.k,
              curveRealBase: event.curve.realBase,
              curveRealToken: event.curve.realToken,
              curveGradMcapBase: event.curve.gradMcapBase,
            }
          : {}),
      })
      .onConflictDoNothing({ target: [tokens.net, tokens.mint] });

    // Each launch gets its own bucket — two launches never share one.
    await this.db
      .insert(creatorVaults)
      .values({ net: event.net, sym: event.sym, mint, creator: event.creator })
      .onConflictDoNothing({ target: [creatorVaults.net, creatorVaults.mint] });

    await this.opts.publisher.board({
      type: 'token_created',
      net: event.net,
      sym: event.sym,
      payload: { mint, name: event.name, creator: event.creator, mc: event.mc, lane },
    });

    const result = await this.opts.awards.launch({
      net: event.net,
      wallet: event.creator,
      sym: event.sym,
      txSig: event.txSig,
      cashback: event.cashback,
    });
    report.xpAwarded += result.xp;
    report.achievementsUnlocked.push(...result.unlocked);
  }

  /* ---------------------------------------------------------------- trades */

  private async onTrade(event: TradeEvent, report: IngestReport): Promise<void> {
    const at = new Date(event.blockTimeMs);
    const mint = await this.resolveMint(event.net, event.sym, event.mint);

    await this.db
      .insert(trades)
      .values({
        net: event.net,
        sym: event.sym,
        mint,
        txSig: event.txSig,
        logIndex: event.logIndex,
        side: event.side,
        trader: event.trader,
        nativeAmount: event.nativeAmount,
        baseAmount: event.baseAmount,
        tokenAmount: event.tokenAmount,
        usdValue: event.usdValue,
        mc: event.mc,
        price: event.tokenAmount > 0 ? event.usdValue / event.tokenAmount : 0,
        cashback: event.cashback,
        blockTime: at,
        chainPosition: event.chainPosition,
      })
      .onConflictDoNothing();

    await this.db
      .insert(tape)
      .values({
        net: event.net,
        sym: event.sym,
        side: event.side,
        trader: event.trader,
        nativeAmount: event.nativeAmount,
        tokenAmount: event.tokenAmount,
        usdValue: event.usdValue,
        mc: event.mc,
        cashback: event.cashback,
        txSig: event.txSig,
        logIndex: event.logIndex,
        blockTime: at,
        chainPosition: event.chainPosition,
      })
      .onConflictDoNothing();

    await this.updateHolder(event, mint);
    await this.updateCandles(event, mint);
    const lane = await this.updateToken(event, mint);
    await this.updateKoth(event.net);

    await this.opts.publisher.fill(event.net, event.sym, {
      t: event.blockTimeMs,
      sym: event.sym,
      net: event.net,
      buy: event.side === 'buy',
      sol: event.nativeAmount,
      tok: event.tokenAmount,
      mc: event.mc,
      w: event.trader,
      v: event.usdValue,
      cb: event.cashback,
      sig: event.txSig,
    });
    await this.opts.publisher.token(event.sym, {
      type: 'curve',
      net: event.net,
      sym: event.sym,
      mc: event.mc,
      price: event.tokenAmount > 0 ? event.usdValue / event.tokenAmount : 0,
      lane,
    });

    const result = await this.opts.awards.trade({
      net: event.net,
      wallet: event.trader,
      sym: event.sym,
      txSig: event.txSig,
      side: event.side,
      nativeNotional: event.nativeAmount,
    });
    report.xpAwarded += result.xp;
    report.achievementsUnlocked.push(...result.unlocked);
  }

  /** Position and native cost basis, per the plan's step 98. */
  private async updateHolder(event: TradeEvent, mint: string): Promise<void> {
    const key = and(
      eq(holdersSnapshot.net, event.net),
      eq(holdersSnapshot.mint, mint),
      eq(holdersSnapshot.wallet, event.trader),
    );
    const [existing] = await this.db.select().from(holdersSnapshot).where(key).limit(1);

    if (event.side === 'buy') {
      await this.db
        .insert(holdersSnapshot)
        .values({
          net: event.net,
          sym: event.sym,
          mint,
          wallet: event.trader,
          tokenAmount: event.tokenAmount,
          costNative: event.nativeAmount,
          firstSeen: new Date(event.blockTimeMs),
          updatedAt: new Date(event.blockTimeMs),
        })
        .onConflictDoUpdate({
          target: [holdersSnapshot.net, holdersSnapshot.mint, holdersSnapshot.wallet],
          set: {
            tokenAmount: sql`${holdersSnapshot.tokenAmount} + ${event.tokenAmount}`,
            costNative: sql`${holdersSnapshot.costNative} + ${event.nativeAmount}`,
            updatedAt: new Date(event.blockTimeMs),
          },
        });
      return;
    }

    // Sells retire cost basis pro rata, so the remaining position's unrealised
    // PnL — which is what the diamond-hands sweep reads — stays honest.
    const held = existing?.tokenAmount ?? 0;
    const cost = existing?.costNative ?? 0;
    const sold = Math.min(event.tokenAmount, held);
    const fraction = held > 0 ? sold / held : 0;
    const costOut = cost * fraction;

    await this.db
      .insert(holdersSnapshot)
      .values({
        net: event.net,
        sym: event.sym,
        mint,
        wallet: event.trader,
        tokenAmount: 0,
        costNative: 0,
        realizedNative: event.nativeAmount,
        firstSeen: new Date(event.blockTimeMs),
        updatedAt: new Date(event.blockTimeMs),
      })
      .onConflictDoUpdate({
        target: [holdersSnapshot.net, holdersSnapshot.mint, holdersSnapshot.wallet],
        set: {
          tokenAmount: sql`greatest(0, ${holdersSnapshot.tokenAmount} - ${sold})`,
          costNative: sql`greatest(0, ${holdersSnapshot.costNative} - ${costOut})`,
          realizedNative: sql`${holdersSnapshot.realizedNative} + ${event.nativeAmount - costOut}`,
          updatedAt: new Date(event.blockTimeMs),
        },
      });
  }

  private async updateCandles(event: TradeEvent, mint: string): Promise<void> {
    const price = event.tokenAmount > 0 ? event.usdValue / event.tokenAmount : 0;
    for (const update of candleUpdatesFor(event.blockTimeMs, price, event.usdValue, event.nativeAmount)) {
      await this.db
        .insert(candles)
        .values({
          net: event.net,
          sym: event.sym,
          mint,
          tf: update.tf,
          bucketStart: new Date(update.bucketStart),
          o: price,
          h: price,
          l: price,
          c: price,
          v: update.usdVolume,
          nativeVolume: update.nativeVolume,
          trades: 1,
        })
        .onConflictDoUpdate({
          target: [candles.net, candles.mint, candles.tf, candles.bucketStart],
          set: {
            // Open is whatever the first fill in the bucket set it to.
            h: sql`greatest(${candles.h}, ${price})`,
            l: sql`least(${candles.l}, ${price})`,
            c: price,
            v: sql`${candles.v} + ${update.usdVolume}`,
            nativeVolume: sql`${candles.nativeVolume} + ${update.nativeVolume}`,
            trades: sql`${candles.trades} + 1`,
          },
        });
    }
  }

  private async updateToken(event: TradeEvent, mint: string): Promise<Lane> {
    const [existing] = await this.db
      .select()
      .from(tokens)
      .where(and(eq(tokens.net, event.net), eq(tokens.mint, mint)))
      .limit(1);
    if (!existing) return 'new';

    const holderRows = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(holdersSnapshot)
      .where(
        and(
          eq(holdersSnapshot.net, event.net),
          eq(holdersSnapshot.mint, mint),
          gt(holdersSnapshot.tokenAmount, 0),
        ),
      );

    // 24h change against the oldest fill still in the window, falling back to
    // the launch cap when the token is younger than a day.
    const [anchor] = await this.db
      .select({ mc: trades.mc })
      .from(trades)
      .where(
        and(
          eq(trades.net, event.net),
          eq(trades.mint, mint),
          gte(trades.blockTime, new Date(event.blockTimeMs - CHANGE_WINDOW_MS)),
        ),
      )
      .orderBy(asc(trades.blockTime))
      .limit(1);
    const base = anchor?.mc ?? existing.mc;
    const chg = base > 0 ? ((event.mc - base) / base) * 100 : 0;

    // A graduated token stays graduated even if its cap falls back below $69K.
    const lane: Lane = existing.lane === 'grad' ? 'grad' : laneOf({ mc: event.mc });

    await this.db
      .update(tokens)
      .set({
        lastMc: existing.mc,
        mc: event.mc,
        chg,
        holders: holderRows[0]?.n ?? 0,
        lane,
        updatedAt: new Date(this.now()),
        // Keeps the curve columns live off the fill the chain just settled,
        // rather than frozen at the last `/trade/prepare` write-back.
        ...(event.realBase !== undefined ? { curveRealBase: event.realBase } : {}),
        ...(event.realToken !== undefined ? { curveRealToken: event.realToken } : {}),
      })
      .where(and(eq(tokens.net, event.net), eq(tokens.mint, mint)));

    if (lane !== existing.lane) {
      await this.opts.publisher.board({
        type: 'lane_move',
        net: event.net,
        sym: event.sym,
        from: existing.lane,
        to: lane,
      });
    }
    return lane;
  }

  /** Highest cap on the net that has not graduated yet wears the crown. */
  private async updateKoth(net: Net): Promise<void> {
    const [top] = await this.db
      .select({ sym: tokens.sym, mc: tokens.mc })
      .from(tokens)
      .where(and(eq(tokens.net, net), eq(tokens.lane, 'new')))
      .orderBy(desc(tokens.mc))
      .limit(1);

    const [soon] = await this.db
      .select({ sym: tokens.sym, mc: tokens.mc })
      .from(tokens)
      .where(and(eq(tokens.net, net), eq(tokens.lane, 'soon')))
      .orderBy(desc(tokens.mc))
      .limit(1);

    const best = [top, soon]
      .filter((r): r is { sym: string; mc: number } => r !== undefined)
      .sort((a, b) => b.mc - a.mc)[0];
    if (!best) return;

    const [current] = await this.db.select().from(koth).where(eq(koth.net, net)).limit(1);
    if (current?.sym === best.sym) {
      await this.db.update(koth).set({ mc: best.mc }).where(eq(koth.net, net));
      return;
    }

    await this.db
      .insert(koth)
      .values({ net, sym: best.sym, mc: best.mc, crownedAt: new Date(this.now()) })
      .onConflictDoUpdate({
        target: koth.net,
        set: { sym: best.sym, mc: best.mc, crownedAt: new Date(this.now()) },
      });

    await this.opts.publisher.board({ type: 'koth', net, sym: best.sym, mc: best.mc });
  }

  /* ------------------------------------------------------------ graduation */

  private async onGraduated(event: GraduatedEvent, report: IngestReport): Promise<void> {
    const mint = await this.resolveMint(event.net, event.sym, event.mint);

    await this.db
      .update(tokens)
      .set({ lane: 'grad', graduatedAt: new Date(event.blockTimeMs), mc: event.mc, updatedAt: new Date(this.now()) })
      .where(and(eq(tokens.net, event.net), eq(tokens.mint, mint)));

    await this.opts.publisher.board({ type: 'graduated', net: event.net, sym: event.sym });
    await this.opts.publisher.token(event.sym, { type: 'graduated', net: event.net, sym: event.sym });

    // Everyone still holding at the moment of graduation earns `grad` — except
    // dust positions. A wallet that sprayed 0.004 SOL across the board must not
    // collect a 250 XP achievement for it, which is the same rule the trade
    // path applies.
    const holders = (
      await this.db
        .select({ wallet: holdersSnapshot.wallet, costNative: holdersSnapshot.costNative })
        .from(holdersSnapshot)
        .where(
          and(
            eq(holdersSnapshot.net, event.net),
            eq(holdersSnapshot.mint, mint),
            gt(holdersSnapshot.tokenAmount, 0),
          ),
        )
    ).filter((h) => !this.opts.awards.isDust(event.net, h.costNative));

    for (const holder of holders) {
      const unlocked = await this.opts.awards.graduatedWhileHolding({
        net: event.net,
        wallet: holder.wallet,
        sym: event.sym,
        txSig: event.txSig,
      });
      if (unlocked) report.achievementsUnlocked.push('grad');
    }
    await this.updateKoth(event.net);
  }

  /* ------------------------------------------------------------------ fees */

  private async onFeeAccrued(event: FeeAccruedEvent): Promise<void> {
    // Stakers' cut comes out of the creator's 70%, never out of the other legs.
    const creatorNet = event.creatorBucket - event.stakerShare;
    const mint = await this.resolveMint(event.net, event.sym, event.mint);

    await this.db
      .insert(creatorVaults)
      .values({
        net: event.net,
        sym: event.sym,
        mint,
        creator: event.creator,
        unclaimedNative: creatorNet,
        unclaimedTokens: event.creatorTokens,
        stakerPoolNative: event.stakerShare,
        lifetimeNative: event.creatorBucket,
      })
      .onConflictDoUpdate({
        target: [creatorVaults.net, creatorVaults.mint],
        set: {
          unclaimedNative: sql`${creatorVaults.unclaimedNative} + ${creatorNet}`,
          unclaimedTokens: sql`${creatorVaults.unclaimedTokens} + ${event.creatorTokens}`,
          stakerPoolNative: sql`${creatorVaults.stakerPoolNative} + ${event.stakerShare}`,
          lifetimeNative: sql`${creatorVaults.lifetimeNative} + ${event.creatorBucket}`,
          updatedAt: new Date(this.now()),
        },
      });

    await this.creditVault(event, 'protocol', event.protocol);
    await this.creditVault(event, 'stonkz_ops', event.stonkzOps);
  }

  private async creditVault(
    event: FeeAccruedEvent | TreasuryCreditEvent,
    kind: 'protocol' | 'stonkz_ops',
    amount: number,
  ): Promise<void> {
    if (amount === 0) return;
    const { net, sym, txSig, logIndex, blockTimeMs, chainPosition } = event;
    const credited = await this.db
      .insert(treasuryCredits)
      .values({
        net,
        kind,
        sym,
        amount,
        txSig,
        logIndex,
        blockTime: new Date(blockTimeMs),
        chainPosition,
      })
      .onConflictDoNothing()
      .returning({ id: treasuryCredits.id });
    // Only move the balance if the credit row was new, so a replay cannot
    // inflate a treasury.
    if (credited.length === 0) return;

    await this.db
      .update(treasuries)
      .set({
        nativeBalance: sql`${treasuries.nativeBalance} + ${amount}`,
        lifetimeCredited: sql`${treasuries.lifetimeCredited} + ${amount}`,
        updatedAt: new Date(this.now()),
      })
      .where(and(eq(treasuries.net, net), eq(treasuries.kind, kind)));
  }

  private async onTreasuryCredit(event: TreasuryCreditEvent): Promise<void> {
    await this.creditVault(event, event.vault, event.amount);
  }

  private async onCreatorFeesClaimed(event: CreatorFeesClaimedEvent, report: IngestReport): Promise<void> {
    const mint = await this.resolveMint(event.net, event.sym, event.mint);

    await this.db
      .update(creatorVaults)
      .set({
        unclaimedNative: sql`greatest(0, ${creatorVaults.unclaimedNative} - ${event.nativeAmount})`,
        unclaimedTokens: sql`greatest(0, ${creatorVaults.unclaimedTokens} - ${event.tokenAmount})`,
        claimedNative: sql`${creatorVaults.claimedNative} + ${event.nativeAmount}`,
        updatedAt: new Date(this.now()),
      })
      .where(and(eq(creatorVaults.net, event.net), eq(creatorVaults.mint, mint)));

    const award = await this.opts.awards.feeClaim({
      net: event.net,
      wallet: event.creator,
      sym: event.sym,
      txSig: event.txSig,
      nativeTotal: event.nativeAmount,
    });
    report.xpAwarded += award.xp;
  }

  /* ----------------------------------------------------------------- stake */

  private async onStaked(event: StakedEvent, report: IngestReport): Promise<void> {
    const mint = await this.resolveMint(event.net, event.sym, event.mint);

    await this.db
      .insert(stakePositions)
      .values({
        net: event.net,
        sym: event.sym,
        mint,
        wallet: event.wallet,
        amount: event.amount,
        lockDays: event.lockDays,
        mult: event.mult,
        untilMs: event.untilMs,
      })
      .onConflictDoUpdate({
        target: [stakePositions.net, stakePositions.mint, stakePositions.wallet],
        set: {
          amount: sql`${stakePositions.amount} + ${event.amount}`,
          lockDays: event.lockDays,
          mult: event.mult,
          untilMs: event.untilMs,
          updatedAt: new Date(this.now()),
        },
      });

    const result = await this.opts.awards.stake({
      net: event.net,
      wallet: event.wallet,
      sym: event.sym,
      txSig: event.txSig,
      amount: event.amount,
      circulating: event.circulating,
    });
    report.xpAwarded += result.xp;
    report.achievementsUnlocked.push(...result.unlocked);
  }

  private async onUnstaked(event: UnstakedEvent): Promise<void> {
    const mint = await this.resolveMint(event.net, event.sym, event.mint);

    await this.db
      .update(stakePositions)
      .set({
        amount: sql`greatest(0, ${stakePositions.amount} - ${event.amount})`,
        updatedAt: new Date(this.now()),
      })
      .where(
        and(
          eq(stakePositions.net, event.net),
          eq(stakePositions.mint, mint),
          eq(stakePositions.wallet, event.wallet),
        ),
      );
  }

  private async onStakeClaimed(event: StakeClaimedEvent, report: IngestReport): Promise<void> {
    const mint = await this.resolveMint(event.net, event.sym, event.mint);

    // On-chain claim zeros unclaimed; these columns are the *claimable*
    // balance shown by GET /stake — set to 0, do not accumulate claimed totals.
    await this.db
      .update(stakePositions)
      .set({
        rewardNative: 0,
        rewardTokens: 0,
        updatedAt: new Date(this.now()),
      })
      .where(
        and(
          eq(stakePositions.net, event.net),
          eq(stakePositions.mint, mint),
          eq(stakePositions.wallet, event.wallet),
        ),
      );

    const award = await this.opts.awards.stakeClaim({
      net: event.net,
      wallet: event.wallet,
      sym: event.sym,
      txSig: event.txSig,
    });
    report.xpAwarded += award.xp;
  }

  /* -------------------------------------------------------------- cashback */

  private async onCashbackWindow(event: CashbackWindowEvent): Promise<void> {
    const mint = await this.resolveMint(event.net, event.sym, event.mint);

    await this.db
      .update(tokens)
      .set({
        cashback: event.open,
        cbStartMs: event.open ? event.startedAtMs : null,
        updatedAt: new Date(this.now()),
      })
      .where(and(eq(tokens.net, event.net), eq(tokens.mint, mint)));

    await this.opts.publisher.token(event.sym, {
      type: 'cashback',
      net: event.net,
      sym: event.sym,
      cbStartMs: event.open ? event.startedAtMs : null,
      effFeePct: event.open ? event.startFeeBps / 100 : event.baseFeeBps / 100,
    });
  }

  /* -------------------------------------------------------- diamond hands */

  /**
   * Plan step 116: `diamond` at −25% unrealised while still holding.
   *
   * A sweep over live positions, not the sim's `beat % 10` animation counter,
   * so it cannot be triggered by a client that just keeps rendering. The
   * threshold is measured in the native unit against the position's own cost
   * basis, and the fill that opened the position supplies the signature the
   * award is verified against.
   */
  async sweepDiamondHands(net: Net, nativeUsdPrice: number): Promise<string[]> {
    const positions = await this.db
      .select()
      .from(holdersSnapshot)
      .where(and(eq(holdersSnapshot.net, net), gt(holdersSnapshot.tokenAmount, 0)));

    const unlocked: string[] = [];
    for (const position of positions) {
      if (position.costNative <= 0) continue;

      const [token] = await this.db
        .select({ mc: tokens.mc, supply: tokens.supply })
        .from(tokens)
        .where(and(eq(tokens.net, net), eq(tokens.mint, position.mint)))
        .limit(1);
      if (!token || token.supply <= 0 || nativeUsdPrice <= 0) continue;

      const valueNative = (position.tokenAmount * (token.mc / token.supply)) / nativeUsdPrice;
      const pnlPct = ((valueNative - position.costNative) / position.costNative) * 100;
      if (pnlPct > -25) continue;

      const [entry] = await this.db
        .select({ txSig: trades.txSig })
        .from(trades)
        .where(
          and(eq(trades.net, net), eq(trades.mint, position.mint), eq(trades.trader, position.wallet)),
        )
        .orderBy(asc(trades.id))
        .limit(1);
      if (!entry) continue;

      if (
        await this.opts.awards.diamondHands({
          net,
          wallet: position.wallet,
          sym: position.sym,
          txSig: entry.txSig,
        })
      ) {
        unlocked.push(position.wallet);
      }
    }
    return unlocked;
  }
}
