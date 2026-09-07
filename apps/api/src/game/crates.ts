import { createHash, createHmac, randomBytes } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import {
  CRATES,
  HOUR,
  RAR,
  crateBy,
  crateXp,
  num,
  rollCrateAmount,
  rollDrop,
  type CrateDrop,
  type CrateTier,
  type Net,
} from '@stonkz/shared';
import type { Db } from '../db/client.js';
import { crateOpens, crateState } from '../db/schema.js';
import type { Publisher } from '../ws/publisher.js';
import { REASONS } from './rules.js';
import type { Ledger } from './ledger.js';

export class CrateError extends Error {
  constructor(
    readonly code: 'unknown_tier' | 'cooling_down',
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
  /** Stonk Optionz credited. Zero for an `I` row. */
  optionz: number;
  optionzTotal: number;
  item: string | null;
  xp: number;
  rankedUp: boolean;
  readyAt: number;
  cooldownHours: number;
  roll: CrateRoll;
}

/**
 * Crate opening. Server-only RNG, server-only cooldown.
 *
 * ## Randomness
 *
 * The roll is `HMAC-SHA256(CRATE_HMAC_SECRET, net|wallet|tier|nonce)`, split
 * into two independent 64-bit draws: the first picks the drop row against the
 * odds column, the second positions the payout inside that row. This is
 * unpredictable to the client and reproducible for an auditor who holds the
 * secret, and every open persists `roll_commit` (the digest),
 * `server_seed_hash` (SHA-256 of the secret in use, so a rotation is visible)
 * and the nonce.
 *
 * ## Upgrade path to VRF — required before odds are marketed
 *
 * HMAC is *auditable* but not *publicly verifiable*: a user cannot prove the
 * house did not grind nonces, because only the house holds the secret. Before
 * the drop tables are advertised as odds, this must become a commit-reveal VRF:
 *
 *  1. Publish `server_seed_hash` for an epoch **before** any open in it.
 *  2. Mix a client-supplied nonce into the input (already stored as
 *     `client_nonce`) so neither side alone determines the outcome.
 *  3. Replace the digest with a VRF proof (Switchboard or ORAO on Solana,
 *     Chainlink VRF on the EVM side), storing the proof in `payload_json`.
 *  4. Reveal the epoch seed at rollover so every historical roll in that epoch
 *     is independently checkable.
 *
 * The schema already carries all four fields, so this is a swap inside
 * `roll()` plus a verification endpoint — not a migration.
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

    // Two disjoint 64-bit windows so the row choice cannot bias the amount.
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

  /**
   * Opens a crate.
   *
   * The cooldown is enforced by a single conditional upsert: the `ready_at`
   * guard lives in the statement's `WHERE`, so two concurrent requests cannot
   * both win. If it matches nothing the crate is still cooling and no roll
   * happens at all.
   */
  async open(net: Net, wallet: string, tier: CrateTier): Promise<CrateOpenResult> {
    const crate = crateBy(tier);
    if (!crate) throw new CrateError('unknown_tier', `unknown crate tier ${tier}`);

    const nowMs = this.now();
    const nowDate = new Date(nowMs);
    const readyAt = new Date(nowMs + crate.cd * HOUR);

    const claimed = await this.db
      .insert(crateState)
      .values({ wallet, net, tier, readyAt, opens: 1, updatedAt: nowDate })
      .onConflictDoUpdate({
        target: [crateState.wallet, crateState.net, crateState.tier],
        set: { readyAt, opens: sql`${crateState.opens} + 1`, updatedAt: nowDate },
        setWhere: sql`${crateState.readyAt} <= ${nowDate}`,
      })
      .returning({ opens: crateState.opens });

    if (claimed.length === 0) {
      const [state] = await this.db
        .select()
        .from(crateState)
        .where(and(eq(crateState.wallet, wallet), eq(crateState.net, net), eq(crateState.tier, tier)))
        .limit(1);
      throw new CrateError(
        'cooling_down',
        `${tier} crate is still cooling down`,
        state?.readyAt.getTime() ?? nowMs,
      );
    }

    const roll = this.roll(net, wallet, tier);
    // Reuse the shared table walk so the server and the sim pick the same row.
    const dropIndex = rollDrop(crate, () => roll.rollValue / 100);
    const drop = crate.drops[dropIndex] as CrateDrop;
    const isToken = drop[1] === 'S';
    const amount = isToken ? rollCrateAmount(drop, () => roll.amountRoll) : 0;
    const item = isToken ? null : (drop[2] as string);
    const rarity = (RAR[dropIndex] as (typeof RAR)[number])[0];
    // The sim rendered `$STONKZ`; the ledger pays Stonk Optionz.
    const label = isToken ? `${num(amount)} STONK OPTIONZ` : (item as string);

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
        payloadJson: { label, kind: drop[1], amount, item, tierIndex },
        optionzAwarded: amount,
        itemKey: item,
        xpAwarded: 0,
        openedAt: nowDate,
      })
      .returning({ id: crateOpens.id });
    if (!openRow) throw new CrateError('unknown_tier', 'could not record the crate open');

    const refId = String(openRow.id);
    const optionzTotal = isToken
      ? await this.opts.ledger.creditOptionz(net, wallet, amount, REASONS.crate, refId)
      : (await this.opts.ledger.readBalance(net, wallet)).optionz;

    if (item !== null) {
      // 24H/1H/7D items get an expiry; passes and badges are permanent.
      await this.opts.ledger.grantItem(net, wallet, item, itemExpiry(item, nowMs));
    }

    // Crate XP is server-authored, so it carries no tx signature — which is
    // also why `crate` is absent from CHAIN_VERIFIED_REASONS.
    const award = await this.opts.ledger.award({
      net,
      wallet,
      reason: REASONS.crate,
      baseXp,
      meta: { tier, dropIndex, rarity, crateOpenId: openRow.id },
    });
    await this.db.update(crateOpens).set({ xpAwarded: award.xp }).where(eq(crateOpens.id, openRow.id));

    await this.opts.ledger.unlock(net, wallet, 'crate');

    return {
      tier,
      dropIndex,
      rarity,
      label,
      optionz: amount,
      optionzTotal,
      item,
      xp: award.xp,
      rankedUp: award.rankedUp,
      readyAt: readyAt.getTime(),
      cooldownHours: crate.cd,
      roll,
    };
  }

  /** Cooldown state for every tier — `GET /rewards`. */
  async states(net: Net, wallet: string): Promise<
    { tier: CrateTier; cooldownHours: number; colour: string; readyAt: number; ready: boolean; opens: number }[]
  > {
    const rows = await this.db
      .select()
      .from(crateState)
      .where(and(eq(crateState.wallet, wallet), eq(crateState.net, net)));
    const byTier = new Map(rows.map((r) => [r.tier, r]));
    const nowMs = this.now();

    return CRATES.map((c) => {
      const row = byTier.get(c.k);
      const readyAt = row?.readyAt.getTime() ?? nowMs;
      return {
        tier: c.k,
        cooldownHours: c.cd,
        colour: c.col,
        readyAt,
        ready: readyAt <= nowMs,
        opens: row?.opens ?? 0,
      };
    });
  }

  /** Emits `crate_ready` for every tier whose cooldown has just elapsed. */
  async publishReady(net: Net, wallet: string): Promise<CrateTier[]> {
    const ready = (await this.states(net, wallet)).filter((s) => s.ready).map((s) => s.tier);
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
