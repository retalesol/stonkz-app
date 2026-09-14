import { and, eq, sql } from 'drizzle-orm';
import {
  CRATES,
  SP_LEVELS,
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

export interface SpLevelServiceOptions {
  db: Db;
  now?: () => number;
}

export interface SpLevelSyncResult {
  level: SpLevelInfo;
  /** Levels whose grants were applied on this call. */
  newlyClaimed: number[];
  /** Crate counts added this call, by tier. */
  granted: CrateGrant;
  inventory: { tier: CrateTier; count: number }[];
}

/**
 * Maps lifetime SP → crate inventory.
 *
 * Idempotent: each `(wallet, net, level)` is claimed at most once. Call after
 * any SP credit and on `GET /rewards` so catch-up works for existing balances.
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
    const reached = spLevelsReached(totalSp);
    const claimed = await this.db
      .select({ level: spLevelClaims.level })
      .from(spLevelClaims)
      .where(and(eq(spLevelClaims.wallet, wallet), eq(spLevelClaims.net, net)));
    const claimedSet = new Set(claimed.map((r) => r.level));

    const newlyClaimed: number[] = [];
    const granted: CrateGrant = {};
    const nowDate = new Date(this.now());

    for (const def of reached) {
      if (claimedSet.has(def.level)) continue;

      const inserted = await this.db
        .insert(spLevelClaims)
        .values({ wallet, net, level: def.level, claimedAt: nowDate })
        .onConflictDoNothing()
        .returning({ level: spLevelClaims.level });
      if (inserted.length === 0) continue;

      newlyClaimed.push(def.level);
      for (const [tier, n] of Object.entries(def.grants) as [CrateTier, number][]) {
        if (!n || n <= 0) continue;
        granted[tier] = (granted[tier] ?? 0) + n;
        await this.db
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
    }

    return {
      level: spLevelOf(totalSp),
      newlyClaimed,
      granted,
      inventory: await this.inventory(net, wallet),
    };
  }

  async inventory(net: Net, wallet: string): Promise<{ tier: CrateTier; count: number }[]> {
    const rows = await this.db
      .select()
      .from(crateInventory)
      .where(and(eq(crateInventory.wallet, wallet), eq(crateInventory.net, net)));
    const byTier = new Map(rows.map((r) => [r.tier as CrateTier, r.count]));
    return CRATES.map((c) => ({ tier: c.k, count: byTier.get(c.k) ?? 0 }));
  }

  async snapshot(net: Net, wallet: string, totalSp: number) {
    const synced = await this.sync(net, wallet, totalSp);
    const next = nextSpLevelGrants(totalSp);
    return {
      ...synced,
      nextLevel: next
        ? { level: next.level, sp: next.sp, grants: { ...next.grants } }
        : null,
      levels: SP_LEVELS.map((l) => ({
        level: l.level,
        sp: l.sp,
        grants: { ...l.grants },
        claimed: l.level <= synced.level.level,
      })),
    };
  }
}
