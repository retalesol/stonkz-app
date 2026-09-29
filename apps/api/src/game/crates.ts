import { createHash, createHmac, randomBytes } from 'node:crypto';
import { and, desc, eq, gt, lte, sql } from 'drizzle-orm';
import {
  HOUR,
  RAR,
  crateBy,
  crateRollFromDigest,
  crateRollMessage,
  crateXp,
  isValidClientSeed,
  num,
  rollCrateAmount,
  rollDrop,
  rollRwaUnits,
  type CrateDrop,
  type CrateProof,
  type CrateTier,
  type Net,
  type RwaReward,
} from '@stonkz/shared';
import type { Db } from '../db/client.js';
import {
  crateCommitments,
  crateCooldown,
  crateInventory,
  crateOpens,
  crateState,
  itemFlags,
} from '../db/schema.js';
import type { Publisher } from '../ws/publisher.js';
import { ITEM_RHODIUM_KEY, itemExpiry } from './items.js';
import { REASONS } from './rules.js';
import type { Ledger } from './ledger.js';
import type { SpLevelService } from './sp-levels.js';
import { getCrateTables } from './tables.js';

export { itemExpiry } from './items.js';

export class CrateError extends Error {
  constructor(
    readonly code: 'unknown_tier' | 'cooling_down' | 'no_inventory' | 'bad_seed' | 'no_key',
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
  /**
   * `CRATE_HMAC_SECRET`. Kept for configuration compatibility; rolls no
   * longer derive from it (per-open committed seeds, see below). It is still
   * mixed into the seed source so a weak platform RNG cannot make seeds
   * guessable on its own.
   */
  secret?: string;
  now?: () => number;
  /** Injected in tests to pin a roll. Production draws 32 random bytes. */
  seedSource?: () => string;
}

export interface CrateRoll extends CrateProof {
  /** Whether the client supplied the seed (the only case the server provably could not grind). */
  clientSeeded: boolean;
}

export interface CrateOpenOptions {
  /** Client seed — `[A-Za-z0-9_-]{1,64}`. Omitted: the server draws one and says so. */
  clientSeed?: string | null | undefined;
  /** Spend a `RHODIUM KEY · INSTANT CRATE` to bypass an active global cooldown. */
  useKey?: boolean | undefined;
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
  /** True when a Rhodium key was spent to skip the cooldown. */
  keyUsed: boolean;
  roll: CrateRoll;
  /** sha256 of the seed already committed for the wallet's next open. */
  nextServerSeedHash: string;
  openId: number;
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

export interface CrateHistoryRow {
  id: number;
  at: number;
  tier: string;
  rarity: string;
  dropIndex: number;
  label: string;
  kind: 'S' | 'I' | 'R';
  stonkz: number;
  asset: string | null;
  units: number;
  item: string | null;
  xp: number;
  proof: CrateProof & { clientSeeded: boolean; message: string | null; verifiable: boolean };
}

/**
 * Crate opening. Server-only RNG, **global** cooldown, inventory from SP levels.
 *
 * ## Cooldown
 *
 * Opening any tier sets one `(wallet, net)` ready_at = now + that tier's `cd`
 * hours. Until then, **no** crate can be opened — a 12h Platinum open locks
 * Bronze for 12h too. A held `RHODIUM KEY · INSTANT CRATE` can be spent
 * (`useKey`) to open through a running cooldown once.
 *
 * ## Inventory
 *
 * Crates are earned when lifetime SP crosses `getLevelTable()` thresholds
 * (`SpLevelService`). You cannot open a tier with inventory 0.
 *
 * ## Randomness — commit–reveal
 *
 * 1. Before the wallet decides to open, the server holds a random 32-byte
 *    `serverSeed` for that `(wallet, net)` and publishes `sha256(serverSeed)`
 *    on `GET /rewards` (`crate_commitments`).
 * 2. The open takes a `clientSeed` from the wallet, consumes the commitment,
 *    computes `digest = HMAC-SHA256(serverSeed, net|wallet|tier|clientSeed)`
 *    and maps the first 16 bytes onto the two draws (`crateRollFromDigest`).
 * 3. The response and the drop log reveal `serverSeed`, so the wallet can
 *    check `sha256(serverSeed)` against the hash it saw earlier and recompute
 *    the digest with any HMAC tool. A fresh commitment is written for the
 *    next open in the same call.
 *
 * Because the hash is fixed before the client seed exists, the server cannot
 * pick a seed after seeing the client's choice, and the client cannot pick a
 * seed after seeing the server's. What this does not prove is that the
 * server never *abandons* an open after rolling it — only a VRF or on-chain
 * randomness does that — so odds must not be marketed as provably fair until
 * then (security finding M2). Rolls opened before commit–reveal shipped have
 * no revealed seed and are shown as not user-verifiable.
 */
export class CrateService {
  private readonly now: () => number;
  private readonly seedSource: () => string;

  constructor(private readonly opts: CrateServiceOptions) {
    this.now = opts.now ?? Date.now;
    this.seedSource =
      opts.seedSource ??
      (() =>
        createHash('sha256')
          .update(randomBytes(32))
          .update(opts.secret ?? '')
          .digest('hex'));
  }

  private get db(): Db {
    return this.opts.db;
  }

  /* -------------------------------------------------------------- commitments */

  /** The hash the wallet sees before opening. Creates the commitment if none is pending. */
  async commitment(net: Net, wallet: string): Promise<string> {
    const [existing] = await this.db
      .select({ seedHash: crateCommitments.seedHash })
      .from(crateCommitments)
      .where(and(eq(crateCommitments.wallet, wallet), eq(crateCommitments.net, net)))
      .limit(1);
    if (existing) return existing.seedHash;

    const seed = this.seedSource();
    const seedHash = sha256Hex(seed);
    // A concurrent first call may have won; the conflict path reads theirs.
    const inserted = await this.db
      .insert(crateCommitments)
      .values({ wallet, net, seed, seedHash, createdAt: new Date(this.now()) })
      .onConflictDoNothing()
      .returning({ seedHash: crateCommitments.seedHash });
    if (inserted[0]) return inserted[0].seedHash;
    const [row] = await this.db
      .select({ seedHash: crateCommitments.seedHash })
      .from(crateCommitments)
      .where(and(eq(crateCommitments.wallet, wallet), eq(crateCommitments.net, net)))
      .limit(1);
    /* v8 ignore next */
    return row?.seedHash ?? seedHash;
  }

  /** Consume the pending seed atomically; exactly one open can take it. */
  private async takeCommitment(
    net: Net,
    wallet: string,
  ): Promise<{ seed: string; seedHash: string }> {
    const taken = await this.db
      .delete(crateCommitments)
      .where(and(eq(crateCommitments.wallet, wallet), eq(crateCommitments.net, net)))
      .returning({ seed: crateCommitments.seed, seedHash: crateCommitments.seedHash });
    if (taken[0]) return taken[0];
    // No commitment was ever published for this wallet (first open with no
    // GET /rewards before it). Roll with a fresh seed; the proof still reveals
    // it, and the history marks the row as committed at open time.
    const seed = this.seedSource();
    return { seed, seedHash: sha256Hex(seed) };
  }

  /** Deterministic in `(serverSeed, net, wallet, tier, clientSeed)`. */
  roll(
    net: Net,
    wallet: string,
    tier: CrateTier,
    serverSeed: string,
    clientSeed: string,
    clientSeeded = true,
  ): CrateRoll {
    const digest = createHmac('sha256', serverSeed)
      .update(crateRollMessage(net, wallet, tier, clientSeed))
      .digest();
    const draws = crateRollFromDigest(digest);
    return {
      rollCommit: digest.toString('hex'),
      serverSeedHash: sha256Hex(serverSeed),
      serverSeed,
      clientSeed,
      clientSeeded,
      rollValue: draws.rollValue,
      amountRoll: draws.amountRoll,
      dropIndex: -1,
    };
  }

  /* -------------------------------------------------------------------- open */

  async open(
    net: Net,
    wallet: string,
    tier: CrateTier,
    options: CrateOpenOptions = {},
  ): Promise<CrateOpenResult> {
    const crate = crateBy(tier, getCrateTables());
    if (!crate) throw new CrateError('unknown_tier', `unknown crate tier ${tier}`);

    const clientSeeded = options.clientSeed !== undefined && options.clientSeed !== null;
    if (clientSeeded && !isValidClientSeed(options.clientSeed)) {
      throw new CrateError('bad_seed', 'client seed must match [A-Za-z0-9_-]{1,64}');
    }
    const clientSeed = clientSeeded
      ? (options.clientSeed as string)
      : randomBytes(16).toString('hex');

    // Catch up SP-level grants before checking inventory, and make sure a
    // commitment exists before anything is rolled.
    const bal = await this.opts.ledger.readBalance(net, wallet);
    await this.opts.spLevels.sync(net, wallet, bal.sp);
    await this.commitment(net, wallet);

    const nowMs = this.now();
    const nowDate = new Date(nowMs);
    const readyAt = new Date(nowMs + crate.cd * HOUR);

    // Global cooldown: conditional upsert wins only when ready_at <= now.
    let cdClaimed = await this.db
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

    let keyUsed = false;
    // The cooldown that was running before a key override, so a failed
    // key-open can put it back instead of clearing it.
    let priorReadyAt: Date | null = null;
    if (cdClaimed.length === 0 && options.useKey) {
      const [running] = await this.db
        .select({ readyAt: crateCooldown.readyAt })
        .from(crateCooldown)
        .where(and(eq(crateCooldown.wallet, wallet), eq(crateCooldown.net, net)))
        .limit(1);
      priorReadyAt = running?.readyAt ?? null;
      // Spend one Rhodium key (race-safe decrement), then take the lock
      // unconditionally: the key is what buys the right to jump the queue.
      const spentKey = await this.db
        .update(itemFlags)
        .set({ count: sql`${itemFlags.count} - 1` })
        .where(
          and(
            eq(itemFlags.wallet, wallet),
            eq(itemFlags.net, net),
            eq(itemFlags.item, ITEM_RHODIUM_KEY),
            gt(itemFlags.count, 0),
          ),
        )
        .returning({ count: itemFlags.count });
      if (spentKey.length === 0) {
        throw new CrateError('no_key', 'no Rhodium key held — the global cooldown still applies');
      }
      keyUsed = true;
      cdClaimed = await this.db
        .update(crateCooldown)
        .set({ readyAt, lastTier: tier, updatedAt: nowDate })
        .where(and(eq(crateCooldown.wallet, wallet), eq(crateCooldown.net, net)))
        .returning({ readyAt: crateCooldown.readyAt });
    }

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

    const restoreKey = async (): Promise<void> => {
      if (!keyUsed) return;
      await this.db
        .update(itemFlags)
        .set({ count: sql`${itemFlags.count} + 1` })
        .where(
          and(
            eq(itemFlags.wallet, wallet),
            eq(itemFlags.net, net),
            eq(itemFlags.item, ITEM_RHODIUM_KEY),
          ),
        );
    };
    const releaseCooldown = async (): Promise<void> => {
      // Without a key the claim only ever won on a clear cooldown, so `now`
      // restores it exactly; with a key, restore the lock that was running.
      const restoreTo = keyUsed && priorReadyAt ? priorReadyAt : nowDate;
      await this.db
        .update(crateCooldown)
        .set({ readyAt: restoreTo, lastTier: null, updatedAt: nowDate })
        .where(and(eq(crateCooldown.wallet, wallet), eq(crateCooldown.net, net)));
    };

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
      // Roll back the cooldown claim (and the key) so a no-inventory attempt does not lock.
      await releaseCooldown();
      await restoreKey();
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

      // Every precondition held: consume the commitment and roll.
      const { seed } = await this.takeCommitment(net, wallet);
      const roll = this.roll(net, wallet, tier, seed, clientSeed, clientSeeded);
      const dropIndex = rollDrop(crate, () => roll.rollValue / 100);
      roll.dropIndex = dropIndex;
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

      const tierIndex = getCrateTables().findIndex((c) => c.k === tier);
      const baseXp = crateXp(tierIndex);

      const [openRow] = await this.db
        .insert(crateOpens)
        .values({
          wallet,
          net,
          tier,
          rollCommit: roll.rollCommit,
          serverSeedHash: roll.serverSeedHash,
          clientNonce: clientSeed,
          serverSeed: seed,
          clientSeeded,
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

      // The next open's commitment goes out with this result.
      const nextServerSeedHash = await this.commitment(net, wallet);

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
        keyUsed,
        roll,
        nextServerSeedHash,
        openId: openRow.id,
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
      await releaseCooldown();
      await restoreKey();
      throw err;
    }
  }

  /* ------------------------------------------------------------------ reads */

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

    return getCrateTables().map((c) => {
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

  /** The wallet's recent opens with everything needed to re-derive each roll. */
  async history(net: Net, wallet: string, limit = 50): Promise<CrateHistoryRow[]> {
    const rows = await this.db
      .select()
      .from(crateOpens)
      .where(and(eq(crateOpens.wallet, wallet), eq(crateOpens.net, net)))
      .orderBy(desc(crateOpens.id))
      .limit(Math.max(1, Math.min(200, limit)));
    return rows.map((r) => {
      const p = r.payloadJson as {
        label?: string;
        kind?: 'S' | 'I' | 'R';
        amount?: number;
        asset?: string | null;
        units?: number;
        item?: string | null;
      };
      const verifiable = r.serverSeed !== null;
      return {
        id: r.id,
        at: r.openedAt.getTime(),
        tier: r.tier,
        rarity: r.rarity,
        dropIndex: r.dropIndex,
        label: p.label ?? '',
        kind: p.kind ?? (r.itemKey ? 'I' : 'S'),
        stonkz: r.stonkzAwarded,
        asset: p.asset ?? null,
        units: p.units ?? 0,
        item: r.itemKey,
        xp: r.xpAwarded,
        proof: {
          serverSeedHash: r.serverSeedHash,
          serverSeed: r.serverSeed,
          clientSeed: verifiable ? r.clientNonce : null,
          clientSeeded: r.clientSeeded,
          rollCommit: r.rollCommit,
          rollValue: r.rollValue,
          amountRoll: r.amountRoll,
          dropIndex: r.dropIndex,
          message: verifiable ? crateRollMessage(net, wallet, r.tier, r.clientNonce) : null,
          verifiable,
        },
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

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}
