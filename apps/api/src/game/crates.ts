import { createHash, createHmac, randomBytes } from 'node:crypto';
import { and, eq, lte, sql } from 'drizzle-orm';
import {
  CRATES,
  HOUR,
  RAR,
  crateBy,
  crateXp,
  num,
  rollCrateAmount,
  rollDrop,
  rollRwaUnits,
  type CrateDrop,
  type CrateTier,
  type Net,
  type RwaReward,
} from '@stonkz/shared';
import type { Db } from '../db/client.js';
import { crateCooldown, crateInventory, crateOpens, crateState } from '../db/schema.js';
import type { Publisher } from '../ws/publisher.js';
import { REASONS } from './rules.js';
import type { Ledger } from './ledger.js';
import type { SpLevelService } from './sp-levels.js';

export class CrateError extends Error {
  constructor(
    readonly code: 'unknown_tier' | 'cooling_down' | 'no_inventory',
    message: string,
    readonly readyAt?: number,
  ) {
    super(message);
    this.name = 'CrateError';
  }
}

export interface CrateServiceOptions {
  db: Db;
  ledger: Ledger;
  publisher: Publisher;
  spLevels: SpLevelService;
  /** `CRATE_HMAC_SECRET`. Server-only; never sent to a client. */
  secret: string;
  now?: () => number;
  /** Injected in tests to pin a roll. Production always uses the HMAC path. */
  nonceSource?: () => string;
}

export interface CrateRoll {
  rollCommit: string;
  serverSeedHash: string;
  clientNonce: string;
  /** `[0, 100)` — compared against the cumulative odds column. */
  rollValue: number;
  /** `[0, 1)` — positions the payout inside the chosen row's range. */
  amountRoll: number;
}

export interface CrateOpenResult {
  tier: CrateTier;
  dropIndex: number;
  rarity: string;
  label: string;
  /** Which kind of row paid: `$STONKZ` credits, an RWA position, or an item. */
  kind: 'S' | 'I' | 'R';
  /** `$STONKZ` rolled for an `S` row; zero otherwise. */
  amount: number;
  /** RWA catalog key for an `R` row; null otherwise. */
  asset: string | null;
  /** RWA units credited for an `R` row; zero otherwise. */
  units: number;
  /** `$STONKZ` credits credited by this open. Zero unless `S`. */
  stonkz: number;
  /** `$STONKZ` credit balance after this open. */
  stonkzTotal: number;
  /** Every RWA position held after this open. */
  rwa: RwaReward[];
  item: string | null;
  xp: number;
  rankedUp: boolean;
  /** Global ready time — every tier is locked until this. */
  readyAt: number;
  cooldownHours: number;
  inventoryLeft: number;
  roll: CrateRoll;
}

export interface CrateTierState {
  tier: CrateTier;
  cooldownHours: number;
  colour: string;
  /** Global cooldown end (same for every tier). */
  readyAt: number;
  ready: boolean;
  /** Tier that started the current global cooldown, if any. */
  lastTier: CrateTier | null;
  opens: number;
  /** Unopened crates of this tier in inventory. */
  inventory: number;
  /** True when inventory > 0 and global cooldown elapsed. */
  openable: boolean;
}

/**
 * Crate opening. Server-only RNG, **global** cooldown, inventory from SP levels.
 *
 * ## Cooldown
 *
 * Opening any tier sets one `(wallet, net)` ready_at = now + that tier's `cd`
 * hours. Until then, **no** crate can be opened — a 12h Platinum open locks
 * Bronze for 12h too.
 *
 * ## Inventory
 *
 * Crates are earned when lifetime SP crosses `SP_LEVELS` thresholds
 * (`SpLevelService`). You cannot open a tier with inventory 0.
 *
 * ## Randomness
 *
 * HMAC-SHA256(CRATE_HMAC_SECRET, net|wallet|tier|nonce) — auditable, not VRF.
 * See security finding M2 before marketing odds as provably fair.
 */
export class CrateService {
  private readonly now: () => number;
  private readonly nonceSource: () => string;

  constructor(private readonly opts: CrateServiceOptions) {
    this.now = opts.now ?? Date.now;
    this.nonceSource = opts.nonceSource ?? (() => randomBytes(16).toString('hex'));
  }

  private get db(): Db {
    return this.opts.db;
  }

  /** Deterministic in `(secret, net, wallet, tier, nonce)`. */
  roll(net: Net, wallet: string, tier: CrateTier, nonce: string = this.nonceSource()): CrateRoll {
    const digest = createHmac('sha256', this.opts.secret)
      .update(`${net}|${wallet}|${tier}|${nonce}`)
      .digest();

    const dropDraw = digest.readBigUInt64BE(0);
    const amountDraw = digest.readBigUInt64BE(8);
    const SCALE = 2n ** 64n;

    return {
      rollCommit: digest.toString('hex'),
      serverSeedHash: createHash('sha256').update(this.opts.secret).digest('hex'),
      clientNonce: nonce,
      rollValue: Number((dropDraw * 100_000_000n) / SCALE) / 1_000_000,
      amountRoll: Number((amountDraw * 1_000_000_000n) / SCALE) / 1_000_000_000,
    };
  }

  async open(net: Net, wallet: string, tier: CrateTier): Promise<CrateOpenResult> {
    const crate = crateBy(tier);
    if (!crate) throw new CrateError('unknown_tier', `unknown crate tier ${tier}`);

    // Catch up SP-level grants before checking inventory.
    const bal = await this.opts.ledger.readBalance(net, wallet);
    await this.opts.spLevels.sync(net, wallet, bal.sp);

    const nowMs = this.now();
    const nowDate = new Date(nowMs);
    const readyAt = new Date(nowMs + crate.cd * HOUR);

    // Global cooldown: conditional upsert wins only when ready_at <= now.
    const cdClaimed = await this.db
      .insert(crateCooldown)
      .values({ wallet, net, readyAt, lastTier: tier, updatedAt: nowDate })
      .onConflictDoUpdate({
        target: [crateCooldown.wallet, crateCooldown.net],
        set: { readyAt, lastTier: tier, updatedAt: nowDate },
        // Typed comparison, not a raw `${Date}`: postgres.js would send the
        // Date's toString() form, which Postgres cannot parse.
        setWhere: lte(crateCooldown.readyAt, nowDate),
      })
      .returning({ readyAt: crateCooldown.readyAt });

    if (cdClaimed.length === 0) {
      const [state] = await this.db
        .select()
        .from(crateCooldown)
        .where(and(eq(crateCooldown.wallet, wallet), eq(crateCooldown.net, net)))
        .limit(1);
      throw new CrateError(
        'cooling_down',
        `all crates are locked until the global cooldown ends`,
        state?.readyAt.getTime() ?? nowMs,
      );
    }

    // Spend one inventory unit (race-safe).
    const spent = await this.db
      .update(crateInventory)
      .set({ count: sql`${crateInventory.count} - 1`, updatedAt: nowDate })
      .where(
        and(
          eq(crateInventory.wallet, wallet),
          eq(crateInventory.net, net),
          eq(crateInventory.tier, tier),
          sql`${crateInventory.count} > 0`,
        ),
      )
      .returning({ count: crateInventory.count });

    if (spent.length === 0) {
      // Roll back the cooldown claim so a no-inventory attempt does not lock.
      await this.db
        .update(crateCooldown)
        .set({ readyAt: nowDate, lastTier: null, updatedAt: nowDate })
        .where(and(eq(crateCooldown.wallet, wallet), eq(crateCooldown.net, net)));
      throw new CrateError(
        'no_inventory',
        `no ${tier} crates in inventory — trade to earn SP and unlock levels`,
      );
    }

    try {
      // Per-tier open counter (stats only).
      await this.db
        .insert(crateState)
        .values({ wallet, net, tier, readyAt, opens: 1, updatedAt: nowDate })
        .onConflictDoUpdate({
          target: [crateState.wallet, crateState.net, crateState.tier],
          set: { readyAt, opens: sql`${crateState.opens} + 1`, updatedAt: nowDate },
        });

      const roll = this.roll(net, wallet, tier);
      const dropIndex = rollDrop(crate, () => roll.rollValue / 100);
      const drop = crate.drops[dropIndex] as CrateDrop;
      const kind = drop[1];
      // One provable draw (`amountRoll`) positions the payout inside whichever
      // range the row carries: `$STONKZ` for `S`, units for `R`.
      const amount = kind === 'S' ? rollCrateAmount(drop, () => roll.amountRoll) : 0;
      const asset = drop[1] === 'R' ? drop[2] : null;
      const units = kind === 'R' ? rollRwaUnits(drop, () => roll.amountRoll) : 0;
      const item = drop[1] === 'I' ? drop[2] : null;
      const rarity = (RAR[dropIndex] as (typeof RAR)[number])[0];
      const label =
        kind === 'S'
          ? `${num(amount)} $STONKZ`
          : kind === 'R'
            ? `${units.toFixed(4)} ${asset ?? ''}`
            : (item ?? '');

      const tierIndex = CRATES.findIndex((c) => c.k === tier);
      const baseXp = crateXp(tierIndex);

      const [openRow] = await this.db
        .insert(crateOpens)
        .values({
          wallet,
          net,
          tier,
          rollCommit: roll.rollCommit,
          serverSeedHash: roll.serverSeedHash,
          clientNonce: roll.clientNonce,
          rollValue: roll.rollValue,
          amountRoll: roll.amountRoll,
          dropIndex,
          rarity,
          payloadJson: { label, kind, amount, asset, units, item, tierIndex },
          stonkzAwarded: amount,
          itemKey: item,
          xpAwarded: 0,
          openedAt: nowDate,
        })
        .returning({ id: crateOpens.id });
      if (!openRow) throw new CrateError('unknown_tier', 'could not record the crate open');

      const refId = String(openRow.id);
      const stonkzTotal =
        kind === 'S'
          ? await this.opts.ledger.creditStonkz(net, wallet, amount, REASONS.crate, refId)
          : (await this.opts.ledger.readBalance(net, wallet)).stonkz;
      if (asset !== null) {
        await this.opts.ledger.creditRwa(net, wallet, asset, units, REASONS.crate, refId);
      }
      const rwa = await this.opts.ledger.readRwa(net, wallet);

      if (item !== null) {
        await this.opts.ledger.grantItem(net, wallet, item, itemExpiry(item, nowMs));
      }

      const award = await this.opts.ledger.award({
        net,
        wallet,
        reason: REASONS.crate,
        baseXp,
        meta: { tier, dropIndex, rarity, crateOpenId: openRow.id },
      });
      await this.db
        .update(crateOpens)
        .set({ xpAwarded: award.xp })
        .where(eq(crateOpens.id, openRow.id));

      await this.opts.ledger.unlock(net, wallet, 'crate');

      return {
        tier,
        dropIndex,
        rarity,
        label,
        kind,
        amount,
        asset,
        units,
        stonkz: amount,
        stonkzTotal,
        rwa,
        item,
        xp: award.xp,
        rankedUp: award.rankedUp,
        readyAt: readyAt.getTime(),
        cooldownHours: crate.cd,
        inventoryLeft: spent[0]?.count ?? 0,
        roll,
      };
    } catch (err) {
      // Restore inventory + clear the global lock so a mid-open failure is not
      // a permanent soft-lock. Stats/opens rows may linger; payouts do not.
      await this.db
        .update(crateInventory)
        .set({ count: sql`${crateInventory.count} + 1`, updatedAt: nowDate })
        .where(
          and(
            eq(crateInventory.wallet, wallet),
            eq(crateInventory.net, net),
            eq(crateInventory.tier, tier),
          ),
        );
      await this.db
        .update(crateCooldown)
        .set({ readyAt: nowDate, lastTier: null, updatedAt: nowDate })
        .where(and(eq(crateCooldown.wallet, wallet), eq(crateCooldown.net, net)));
      throw err;
    }
  }

  /** Cooldown + inventory for every tier — `GET /rewards`. */
  async states(net: Net, wallet: string): Promise<CrateTierState[]> {
    const bal = await this.opts.ledger.readBalance(net, wallet);
    await this.opts.spLevels.sync(net, wallet, bal.sp);

    const [cdRow] = await this.db
      .select()
      .from(crateCooldown)
      .where(and(eq(crateCooldown.wallet, wallet), eq(crateCooldown.net, net)))
      .limit(1);
    const inv = await this.opts.spLevels.inventory(net, wallet);
    const invMap = new Map(inv.map((r) => [r.tier, r.count]));

    const openRows = await this.db
      .select()
      .from(crateState)
      .where(and(eq(crateState.wallet, wallet), eq(crateState.net, net)));
    const opensMap = new Map(openRows.map((r) => [r.tier, r.opens]));

    const nowMs = this.now();
    const readyAt = cdRow?.readyAt.getTime() ?? nowMs;
    const ready = readyAt <= nowMs;
    const lastTier = (cdRow?.lastTier as CrateTier | null) ?? null;

    return CRATES.map((c) => {
      const inventory = invMap.get(c.k) ?? 0;
      return {
        tier: c.k,
        cooldownHours: c.cd,
        colour: c.col,
        readyAt,
        ready,
        lastTier,
        opens: opensMap.get(c.k) ?? 0,
        inventory,
        openable: ready && inventory > 0,
      };
    });
  }

  async publishReady(net: Net, wallet: string): Promise<CrateTier[]> {
    const ready = (await this.states(net, wallet)).filter((s) => s.openable).map((s) => s.tier);
    for (const tier of ready) {
      await this.opts.publisher.user(net, wallet, { type: 'crate_ready', net, wallet, tier });
    }
    return ready;
  }
}

/** Timed item drops carry their window in the label; the rest never expire. */
export function itemExpiry(item: string, nowMs: number): Date | null {
  const match = /(\d+)\s*(H|D)\b/.exec(item);
  if (!match) return null;
  const value = Number.parseInt(match[1] as string, 10);
  const unit = match[2] === 'D' ? 24 * HOUR : HOUR;
  return new Date(nowMs + value * unit);
}
