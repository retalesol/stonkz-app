import { and, eq, sql } from 'drizzle-orm';
import {
  nextSpLevelGrants,
  spLevelOf,
  spLevelsReached,
  type CrateGrant,
  type CrateTier,
  type Net,
  type SpLevelInfo,
} from '@stonkz/shared';
import type { Db } from '../db/client.js';
import { crateInventory, spLevelClaims } from '../db/schema.js';
import type { Publisher } from '../ws/publisher.js';
import { getCrateTables, getLevelTable } from './tables.js';

export interface SpLevelServiceOptions {
  db: Db;
  /** Optional so existing tests that build the service bare keep working. */
  publisher?: Publisher;
  now?: () => number;
}

export interface SpLevelSyncResult {
  level: SpLevelInfo;
  /** Levels whose grants were applied on this call. */
  newlyClaimed: number[];
  /** Crate counts added this call, by tier. */
  granted: CrateGrant;
  inventory: { tier: CrateTier; count: number }[];
  /** Every level already granted, ascending. */
  claimed: number[];
}

export interface SpLevelRow {
  level: number;
  sp: number;
  grants: CrateGrant;
  /** Grants already in inventory. */
  claimed: boolean;
  /** SP threshold met. Equal to `claimed` unless a grant is mid-flight. */
  reached: boolean;
}

/**
 * Maps lifetime SP → crate inventory.
 *
 * Grants are automatic: the moment a wallet's SP crosses a threshold the
 * level's crates land in inventory. There is no manual "claim" button to
 * forget — a crate the wallet cannot open yet (global cooldown) simply waits
 * in inventory, so nothing is ever lost.
 *
 * Idempotent and race-safe: each `(wallet, net, level)` is claimed at most
 * once by the `sp_level_claims` primary key, and the claim row plus its
 * inventory credits are one transaction, so a crash between them cannot
 * leave a level marked claimed with no crates behind it. Call after any SP
 * credit and on `GET /rewards` so catch-up works for existing balances (and
 * after an operator raises a threshold: a wallet keeps what it already has).
 */
export class SpLevelService {
  private readonly now: () => number;

  constructor(private readonly opts: SpLevelServiceOptions) {
    this.now = opts.now ?? Date.now;
  }

  private get db(): Db {
    return this.opts.db;
  }

  async sync(net: Net, wallet: string, totalSp: number): Promise<SpLevelSyncResult> {
    const levels = getLevelTable();
    const reached = spLevelsReached(totalSp, levels);
    const claimedSet = new Set(await this.claimedLevels(net, wallet));

    const newlyClaimed: number[] = [];
    const granted: CrateGrant = {};
    const nowDate = new Date(this.now());

    for (const def of reached) {
      if (claimedSet.has(def.level)) continue;

      const won = await this.db.transaction(async (tx) => {
        const inserted = await tx
          .insert(spLevelClaims)
          .values({ wallet, net, level: def.level, claimedAt: nowDate })
          .onConflictDoNothing()
          .returning({ level: spLevelClaims.level });
        if (inserted.length === 0) return false;

        for (const [tier, n] of Object.entries(def.grants) as [CrateTier, number][]) {
          if (!n || n <= 0) continue;
          await tx
            .insert(crateInventory)
            .values({ wallet, net, tier, count: n, updatedAt: nowDate })
            .onConflictDoUpdate({
              target: [crateInventory.wallet, crateInventory.net, crateInventory.tier],
              set: {
                count: sql`${crateInventory.count} + ${n}`,
                updatedAt: nowDate,
              },
            });
        }
        return true;
      });
      if (!won) continue;

      newlyClaimed.push(def.level);
      claimedSet.add(def.level);
      for (const [tier, n] of Object.entries(def.grants) as [CrateTier, number][]) {
        if (n && n > 0) granted[tier] = (granted[tier] ?? 0) + n;
      }
      if (this.opts.publisher) {
        await this.opts.publisher.user(net, wallet, {
          type: 'level_up',
          net,
          wallet,
          level: def.level,
          grants: { ...def.grants } as Record<string, number>,
          totalSp,
        });
      }
    }

    return {
      level: spLevelOf(totalSp, levels),
      newlyClaimed,
      granted,
      inventory: await this.inventory(net, wallet),
      claimed: [...claimedSet].sort((a, b) => a - b),
    };
  }

  async claimedLevels(net: Net, wallet: string): Promise<number[]> {
    const rows = await this.db
      .select({ level: spLevelClaims.level })
      .from(spLevelClaims)
      .where(and(eq(spLevelClaims.wallet, wallet), eq(spLevelClaims.net, net)));
    return rows.map((r) => r.level).sort((a, b) => a - b);
  }

  async inventory(net: Net, wallet: string): Promise<{ tier: CrateTier; count: number }[]> {
    const rows = await this.db
      .select()
      .from(crateInventory)
      .where(and(eq(crateInventory.wallet, wallet), eq(crateInventory.net, net)));
    const byTier = new Map(rows.map((r) => [r.tier as CrateTier, r.count]));
    return getCrateTables().map((c) => ({ tier: c.k, count: byTier.get(c.k) ?? 0 }));
  }

  /** `GET /rewards`' level block: current level, the next grant, the whole ladder. */
  async snapshot(net: Net, wallet: string, totalSp: number) {
    const levels = getLevelTable();
    const synced = await this.sync(net, wallet, totalSp);
    const next = nextSpLevelGrants(totalSp, levels);
    const claimed = new Set(synced.claimed);
    const rows: SpLevelRow[] = levels.map((l) => ({
      level: l.level,
      sp: l.sp,
      grants: { ...l.grants },
      claimed: claimed.has(l.level),
      reached: totalSp >= l.sp,
    }));
    return {
      ...synced,
      nextLevel: next ? { level: next.level, sp: next.sp, grants: { ...next.grants } } : null,
      levels: rows,
    };
  }
}
