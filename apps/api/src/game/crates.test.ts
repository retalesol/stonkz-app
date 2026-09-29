import { createHash, createHmac } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import {
  CRATES,
  HOUR,
  RAR,
  crateRollFromDigest,
  crateRollMessage,
  crateXp,
  rollDrop,
  type Crate,
  type CrateDrop,
} from '@stonkz/shared';
import {
  crateCommitments,
  crateInventory,
  crateOpens,
  crateState,
  itemFlags,
  rwaRewards,
} from '../db/schema.js';
import { CrateService, itemExpiry } from './crates.js';
import { ITEM_RHODIUM_KEY } from './items.js';
import { authed, createTestApp, FROZEN_NOW, type TestApp } from '../test/app.js';
import { solanaWallet } from '../test/wallets.js';

let h: TestApp;

beforeAll(async () => {
  h = await createTestApp();
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  await h.db.reset();
  h.setNow(FROZEN_NOW);
});

const W = 'CrateWallet11111111111111111111111111111111';

/** Review gate 3.A — crate opens are server-authored end to end, commit–reveal since 0025. */
describe('crate RNG (commit–reveal)', () => {
  const SEED = 'a'.repeat(64);

  it('is deterministic in (serverSeed, net, wallet, tier, clientSeed)', () => {
    const a = h.deps.crates.roll('SOL', W, 'BRONZE', SEED, 'client-1');
    const b = h.deps.crates.roll('SOL', W, 'BRONZE', SEED, 'client-1');
    expect(a).toEqual(b);
  });

  it('changes with the client seed, the server seed, the wallet, the tier and the net', () => {
    const base = h.deps.crates.roll('SOL', W, 'BRONZE', SEED, 'n');
    const commit = (r: { rollCommit: string }) => r.rollCommit;
    expect(commit(h.deps.crates.roll('SOL', W, 'BRONZE', SEED, 'n2'))).not.toBe(commit(base));
    expect(commit(h.deps.crates.roll('SOL', W, 'BRONZE', 'b'.repeat(64), 'n'))).not.toBe(
      commit(base),
    );
    expect(commit(h.deps.crates.roll('SOL', 'other', 'BRONZE', SEED, 'n'))).not.toBe(commit(base));
    expect(commit(h.deps.crates.roll('SOL', W, 'GOLD', SEED, 'n'))).not.toBe(commit(base));
    expect(commit(h.deps.crates.roll('RH', W, 'BRONZE', SEED, 'n'))).not.toBe(commit(base));
  });

  it('is recomputable by anyone from the published formula', () => {
    const roll = h.deps.crates.roll('SOL', W, 'SILVER', SEED, 'audit-me');
    const digest = createHmac('sha256', SEED)
      .update(crateRollMessage('SOL', W, 'SILVER', 'audit-me'))
      .digest();
    expect(digest.toString('hex')).toBe(roll.rollCommit);
    expect(crateRollFromDigest(digest)).toEqual({
      rollValue: roll.rollValue,
      amountRoll: roll.amountRoll,
    });
    expect(createHash('sha256').update(SEED).digest('hex')).toBe(roll.serverSeedHash);
  });

  it('produces two independent draws in range', () => {
    for (let i = 0; i < 400; i++) {
      const roll = h.deps.crates.roll('SOL', W, 'SILVER', SEED, `nonce-${i}`);
      expect(roll.rollValue).toBeGreaterThanOrEqual(0);
      expect(roll.rollValue).toBeLessThan(100);
      expect(roll.amountRoll).toBeGreaterThanOrEqual(0);
      expect(roll.amountRoll).toBeLessThan(1);
    }
  });

  it('spreads rolls across the drop table rather than pinning one row', () => {
    const seen = new Set<number>();
    const bronze = CRATES[0];
    for (let i = 0; i < 600 && seen.size < 3; i++) {
      const roll = h.deps.crates.roll('SOL', W, 'BRONZE', SEED, `spread-${i}`);
      if (bronze) seen.add(rollDrop(bronze, () => roll.rollValue / 100));
    }
    expect(seen.size).toBeGreaterThanOrEqual(2);
  });

  it('publishes the seed hash before the open and reveals a matching seed after it', async () => {
    const before = await h.deps.crates.commitment('SOL', W);
    expect(before).toMatch(/^[0-9a-f]{64}$/);
    // Asking again does not rotate it — the wallet can pin it.
    expect(await h.deps.crates.commitment('SOL', W)).toBe(before);

    const result = await h.deps.crates.open('SOL', W, 'BRONZE', { clientSeed: 'my-seed' });
    expect(result.roll.serverSeedHash).toBe(before);
    expect(result.roll.serverSeed).not.toBeNull();
    expect(
      createHash('sha256')
        .update(result.roll.serverSeed as string)
        .digest('hex'),
    ).toBe(before);
    expect(result.roll.clientSeed).toBe('my-seed');
    expect(result.roll.clientSeeded).toBe(true);
    // Recompute the roll the way a user would.
    const recomputed = h.deps.crates.roll(
      'SOL',
      W,
      'BRONZE',
      result.roll.serverSeed as string,
      'my-seed',
    );
    expect(recomputed.rollCommit).toBe(result.roll.rollCommit);
    expect(rollDrop(CRATES[0] as Crate, () => recomputed.rollValue / 100)).toBe(result.dropIndex);

    // A fresh commitment is in force for the next open, and it differs.
    expect(result.nextServerSeedHash).not.toBe(before);
    expect(await h.deps.crates.commitment('SOL', W)).toBe(result.nextServerSeedHash);

    // The seed is never persisted anywhere a client could read it early: only
    // the consumed row holds it, and it is gone.
    const pending = await h.deps.db
      .select()
      .from(crateCommitments)
      .where(and(eq(crateCommitments.wallet, W), eq(crateCommitments.net, 'SOL')));
    expect(pending).toHaveLength(1);
    expect(pending[0]?.seedHash).toBe(result.nextServerSeedHash);
    expect(pending[0]?.seed).not.toBe(result.roll.serverSeed);
  });

  it('draws and discloses a server seed when the client sends none', async () => {
    const result = await h.deps.crates.open('SOL', W, 'BRONZE');
    expect(result.roll.clientSeeded).toBe(false);
    expect(result.roll.clientSeed).toMatch(/^[0-9a-f]{32}$/);
    const [row] = await h.deps.db.select().from(crateOpens).where(eq(crateOpens.wallet, W));
    expect(row?.clientSeeded).toBe(false);
    expect(row?.serverSeed).toBe(result.roll.serverSeed);
  });

  it('rejects a malformed client seed before touching cooldown or inventory', async () => {
    await expect(
      h.deps.crates.open('SOL', W, 'BRONZE', { clientSeed: 'has spaces!' }),
    ).rejects.toMatchObject({ code: 'bad_seed' });
    const states = await h.deps.crates.states('SOL', W);
    expect(states.find((s) => s.tier === 'BRONZE')?.inventory).toBe(2);
    expect(states.every((s) => s.ready)).toBe(true);
  });
});

describe('crate opens', () => {
  it('records the roll, credits the payout and awards XP', async () => {
    const result = await h.deps.crates.open('SOL', W, 'BRONZE');

    expect(result.tier).toBe('BRONZE');
    expect(RAR.map((r) => r[0])).toContain(result.rarity);
    expect(result.xp).toBe(crateXp(0));

    const [row] = await h.deps.db
      .select()
      .from(crateOpens)
      .where(eq(crateOpens.wallet, W))
      .limit(1);
    expect(row?.rollCommit).toBe(result.roll.rollCommit);
    expect(row?.xpAwarded).toBe(result.xp);

    // Bronze has no `R` row: it pays `$STONKZ` credits or an item.
    expect(result.asset).toBeNull();
    expect(result.units).toBe(0);
    if (result.item === null) {
      expect(result.kind).toBe('S');
      expect(result.label).toContain('$STONKZ');
      expect(result.stonkz).toBeGreaterThan(0);
      expect(result.amount).toBe(result.stonkz);
      expect(row?.stonkzAwarded).toBe(result.stonkz);
      expect((await h.deps.ledger.readBalance('SOL', W)).stonkz).toBe(result.stonkzTotal);
    } else {
      expect(result.kind).toBe('I');
      expect(result.stonkz).toBe(0);
      const flags = await h.deps.db.select().from(itemFlags).where(eq(itemFlags.wallet, W));
      expect(flags.map((f) => f.item)).toContain(result.item);
    }
  });

  it('credits an RWA position for an `R` drop', async () => {
    const tier = 'SILVER' as const;
    const silver = CRATES.find((c) => c.k === tier);
    const rIndex = silver?.drops.findIndex((d) => d[1] === 'R') ?? -1;
    expect(rIndex).toBeGreaterThanOrEqual(0);
    const rDrop = silver?.drops[rIndex] as Extract<CrateDrop, readonly [number, 'R', ...unknown[]]>;

    // Pin the server seed, then search for a client seed whose provable roll
    // lands on the `R` row — exactly what a user could do if the seed leaked
    // early, which is why the hash goes out first and the seed only after.
    const seed = 'c'.repeat(64);
    let clientSeed = '';
    for (let i = 0; i < 5_000 && !clientSeed; i++) {
      const roll = h.deps.crates.roll('SOL', W, tier, seed, `rwa-${i}`);
      if (silver && rollDrop(silver, () => roll.rollValue / 100) === rIndex)
        clientSeed = `rwa-${i}`;
    }
    expect(clientSeed).not.toBe('');
    const crates = new CrateService({
      db: h.deps.db,
      ledger: h.deps.ledger,
      publisher: h.deps.publisher,
      spLevels: h.deps.spLevels,
      now: h.now,
      seedSource: () => seed,
    });
    await h.deps.db.insert(crateInventory).values({ wallet: W, net: 'SOL', tier, count: 1 });

    const before = h.userEvents.length;
    const result = await crates.open('SOL', W, tier, { clientSeed });

    expect(result.kind).toBe('R');
    expect(result.dropIndex).toBe(rIndex);
    expect(result.asset).toBe(rDrop[2]);
    expect(result.units).toBeGreaterThanOrEqual(rDrop[3]);
    expect(result.units).toBeLessThanOrEqual(rDrop[4]);
    expect(result.amount).toBe(0);
    expect(result.stonkz).toBe(0);
    expect(result.item).toBeNull();
    expect(result.label).toBe(`${result.units.toFixed(4)} ${rDrop[2]}`);
    expect(result.rwa).toEqual([{ asset: rDrop[2], units: result.units }]);

    const held = await h.deps.db.select().from(rwaRewards).where(eq(rwaRewards.wallet, W));
    expect(held).toEqual([
      expect.objectContaining({ net: 'SOL', wallet: W, asset: rDrop[2], units: result.units }),
    ]);
    const [row] = await h.deps.db.select().from(crateOpens).where(eq(crateOpens.wallet, W));
    expect(row?.stonkzAwarded).toBe(0);
    expect(row?.payloadJson).toMatchObject({ kind: 'R', asset: rDrop[2], units: result.units });

    const rwaEvents = h.userEvents.slice(before).filter((e) => e.event.type === 'rwa');
    expect(rwaEvents.map((e) => e.event)).toEqual([
      expect.objectContaining({ asset: rDrop[2], units: result.units, total: result.units }),
    ]);
    expect((await h.deps.ledger.snapshot('SOL', W)).rwa).toEqual(result.rwa);
  });

  it('unlocks the crate achievement on the first open', async () => {
    await h.deps.crates.open('SOL', W, 'BRONZE');
    expect(await h.deps.ledger.unlockedKeys('SOL', W)).toContain('crate');
  });

  it('enforces a global cooldown from the opened tier', async () => {
    const bronze = CRATES[0];
    const first = await h.deps.crates.open('SOL', W, 'BRONZE');
    expect(first.cooldownHours).toBe(bronze?.cd);

    // Same tier still cooling.
    await expect(h.deps.crates.open('SOL', W, 'BRONZE')).rejects.toMatchObject({
      code: 'cooling_down',
    });
    // Every other tier is locked too — global cooldown.
    await expect(h.deps.crates.open('SOL', W, 'IRON')).rejects.toMatchObject({
      code: 'cooling_down',
    });

    h.advance((bronze?.cd ?? 1) * HOUR - 1);
    await expect(h.deps.crates.open('SOL', W, 'BRONZE')).rejects.toMatchObject({
      code: 'cooling_down',
    });

    h.advance(1);
    const second = await h.deps.crates.open('SOL', W, 'BRONZE');
    expect(second.tier).toBe('BRONZE');

    const [state] = await h.deps.db
      .select()
      .from(crateState)
      .where(and(eq(crateState.wallet, W), eq(crateState.tier, 'BRONZE')))
      .limit(1);
    expect(state?.opens).toBe(2);
  });

  it('locks all crates for the longer cooldown when a higher tier is opened', async () => {
    // SP level 3 (750) grants IRON×1.
    await h.deps.ledger.award({
      net: 'SOL',
      wallet: W,
      reason: 'follow',
      baseXp: 750,
      mirrorSp: true,
    });
    const iron = CRATES[1];
    await h.deps.crates.open('SOL', W, 'IRON');
    await expect(h.deps.crates.open('SOL', W, 'BRONZE')).rejects.toMatchObject({
      code: 'cooling_down',
    });
    h.advance((iron?.cd ?? 2) * HOUR);
    // After IRON's 2h window, BRONZE inventory from L1 may still remain.
    const states = await h.deps.crates.states('SOL', W);
    expect(states.every((s) => s.ready)).toBe(true);
  });

  it('refuses a tier with empty inventory', async () => {
    await expect(h.deps.crates.open('SOL', W, 'RHODIUM')).rejects.toMatchObject({
      code: 'no_inventory',
    });
  });

  it('keeps cooldowns per net, so switching nets is not a second crate', async () => {
    await h.deps.crates.open('SOL', W, 'BRONZE');
    const rh = await h.deps.crates.open('RH', W, 'BRONZE');
    expect(rh.tier).toBe('BRONZE');

    await expect(h.deps.crates.open('RH', W, 'BRONZE')).rejects.toMatchObject({
      code: 'cooling_down',
    });
  });

  it('survives a concurrent double-open with exactly one payout', async () => {
    // SP level 7 (11_000) grants GOLD×1.
    await h.deps.ledger.award({
      net: 'SOL',
      wallet: W,
      reason: 'follow',
      baseXp: 11_000,
      mirrorSp: true,
    });
    const results = await Promise.allSettled([
      h.deps.crates.open('SOL', W, 'GOLD'),
      h.deps.crates.open('SOL', W, 'GOLD'),
      h.deps.crates.open('SOL', W, 'GOLD'),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    expect(fulfilled).toHaveLength(1);
    expect(await h.deps.db.select().from(crateOpens).where(eq(crateOpens.wallet, W))).toHaveLength(
      1,
    );
  });

  it('rejects an unknown tier', async () => {
    await expect(
      h.deps.crates.open('SOL', W, 'UNOBTAINIUM' as unknown as 'GOLD'),
    ).rejects.toMatchObject({ code: 'unknown_tier' });
  });

  it('gives higher tiers more XP', async () => {
    const xps = CRATES.map((_, i) => crateXp(i));
    expect(xps).toEqual([...xps].sort((a, b) => a - b));
    expect(xps[0]).toBeLessThan(xps.at(-1) as number);
  });
});

describe('Rhodium key — instant crate', () => {
  it('spends one key to open through the global cooldown, and only with useKey', async () => {
    await h.deps.crates.open('SOL', W, 'BRONZE');
    await h.deps.ledger.grantItem('SOL', W, ITEM_RHODIUM_KEY, null);

    // Without opting in, the cooldown still applies.
    await expect(h.deps.crates.open('SOL', W, 'BRONZE')).rejects.toMatchObject({
      code: 'cooling_down',
    });

    const result = await h.deps.crates.open('SOL', W, 'BRONZE', { useKey: true });
    expect(result.keyUsed).toBe(true);
    const [flag] = await h.deps.db
      .select()
      .from(itemFlags)
      .where(and(eq(itemFlags.wallet, W), eq(itemFlags.item, ITEM_RHODIUM_KEY)));
    expect(flag?.count).toBe(0);

    // The key is gone; the third open is locked again.
    await expect(h.deps.crates.open('SOL', W, 'BRONZE', { useKey: true })).rejects.toMatchObject({
      code: 'no_key',
    });
  });

  it('does not burn a key when the cooldown is already clear or inventory is empty', async () => {
    await h.deps.ledger.grantItem('SOL', W, ITEM_RHODIUM_KEY, null);
    const first = await h.deps.crates.open('SOL', W, 'BRONZE', { useKey: true });
    expect(first.keyUsed).toBe(false);

    // Cooling now, no RHODIUM inventory: the key is restored on the failure path.
    await expect(h.deps.crates.open('SOL', W, 'RHODIUM', { useKey: true })).rejects.toMatchObject({
      code: 'no_inventory',
    });
    const [flag] = await h.deps.db
      .select()
      .from(itemFlags)
      .where(and(eq(itemFlags.wallet, W), eq(itemFlags.item, ITEM_RHODIUM_KEY)));
    expect(flag?.count).toBe(1);
    // …and the cooldown claimed by the failed attempt was released, so a
    // Rhodium key still lets the next real open through.
    const second = await h.deps.crates.open('SOL', W, 'BRONZE', { useKey: true });
    expect(second.keyUsed).toBe(true);
  });
});

describe('crate history', () => {
  it('lists every open with a proof a user can re-derive', async () => {
    const a = await h.deps.crates.open('SOL', W, 'BRONZE', { clientSeed: 'first' });
    h.advance(HOUR);
    const b = await h.deps.crates.open('SOL', W, 'BRONZE', { clientSeed: 'second' });

    const rows = await h.deps.crates.history('SOL', W);
    expect(rows.map((r) => r.id)).toEqual([b.openId, a.openId]);
    for (const row of rows) {
      expect(row.proof.verifiable).toBe(true);
      expect(row.proof.clientSeeded).toBe(true);
      const digest = createHmac('sha256', row.proof.serverSeed as string)
        .update(row.proof.message as string)
        .digest();
      expect(digest.toString('hex')).toBe(row.proof.rollCommit);
      expect(crateRollFromDigest(digest).rollValue).toBe(row.proof.rollValue);
      expect(rollDrop(CRATES[0] as Crate, () => row.proof.rollValue / 100)).toBe(row.dropIndex);
    }
  });

  it('marks pre-commit-reveal rows as not user-verifiable', async () => {
    await h.deps.db.insert(crateOpens).values({
      wallet: W,
      net: 'SOL',
      tier: 'BRONZE',
      rollCommit: 'f'.repeat(64),
      serverSeedHash: 'e'.repeat(64),
      clientNonce: 'legacy-nonce',
      rollValue: 12.5,
      amountRoll: 0.5,
      dropIndex: 0,
      rarity: 'COMMON',
      payloadJson: { label: '100 $STONKZ', kind: 'S', amount: 100 },
      stonkzAwarded: 100,
      openedAt: new Date(h.now()),
    });
    const [row] = await h.deps.crates.history('SOL', W);
    expect(row?.proof).toMatchObject({ verifiable: false, serverSeed: null, clientSeed: null });
  });

  it('serves GET /rewards/crates/history and the next commitment', async () => {
    const wallet = solanaWallet('crate-history');
    const { token } = await h.login('SOL', wallet);
    await h.app.request('/rewards/crates/bronze/open', {
      method: 'POST',
      headers: { ...authed(token), 'content-type': 'application/json' },
      body: JSON.stringify({ clientSeed: 'http-seed' }),
    });
    const res = await h.app.request('/rewards/crates/history?limit=5', { headers: authed(token) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      nextCommit: string;
      opens: { proof: { clientSeed: string; serverSeed: string; serverSeedHash: string } }[];
    };
    expect(body.opens).toHaveLength(1);
    expect(body.opens[0]?.proof.clientSeed).toBe('http-seed');
    expect(body.nextCommit).toMatch(/^[0-9a-f]{64}$/);
    expect(body.nextCommit).not.toBe(body.opens[0]?.proof.serverSeedHash);

    const rewards = (await (
      await h.app.request('/rewards', { headers: authed(token) })
    ).json()) as { nextCommit: string; dropLog: { proof: { verifiable: boolean } }[] };
    expect(rewards.nextCommit).toBe(body.nextCommit);
    expect(rewards.dropLog[0]?.proof.verifiable).toBe(true);
  });
});

describe('item expiry', () => {
  it('reads the window out of the item label', () => {
    const now = FROZEN_NOW;
    expect(itemExpiry('FEE REBATE 24H', now)?.getTime()).toBe(now + 24 * HOUR);
    expect(itemExpiry('2X XP 1H', now)?.getTime()).toBe(now + HOUR);
    expect(itemExpiry('PRIORITY PASS 7D', now)?.getTime()).toBe(now + 7 * 24 * HOUR);
    // Permanent items carry no window.
    expect(itemExpiry('OG BADGE', now)).toBeNull();
  });
});

describe('POST /rewards/crates/:tier/open', () => {
  it('opens over HTTP and returns the commitment but not the secret', async () => {
    const wallet = solanaWallet('crate-http');
    const { token } = await h.login('SOL', wallet);

    const res = await h.app.request('/rewards/crates/bronze/open', {
      method: 'POST',
      headers: authed(token),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      rarity: string;
      xp: number;
      nextCommit: string;
      proof: {
        rollCommit: string;
        serverSeedHash: string;
        serverSeed: string;
        clientSeed: string;
        clientSeeded: boolean;
        message: string;
        verifiable: boolean;
      };
    };
    expect(body.xp).toBe(crateXp(0));
    expect(body.proof.rollCommit).toMatch(/^[0-9a-f]{64}$/);
    expect(body.proof.serverSeedHash).toMatch(/^[0-9a-f]{64}$/);
    expect(body.proof.verifiable).toBe(true);
    expect(body.proof.clientSeeded).toBe(false);
    expect(createHash('sha256').update(body.proof.serverSeed).digest('hex')).toBe(
      body.proof.serverSeedHash,
    );
    expect(
      createHmac('sha256', body.proof.serverSeed).update(body.proof.message).digest('hex'),
    ).toBe(body.proof.rollCommit);
    // The next open's commitment is disclosed as a hash only.
    expect(body.nextCommit).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(body)).not.toContain('test-crate-secret');
  });

  it('returns 429 with readyAt while cooling', async () => {
    const wallet = solanaWallet('crate-http-cd');
    const { token } = await h.login('SOL', wallet);
    await h.app.request('/rewards/crates/bronze/open', { method: 'POST', headers: authed(token) });

    const res = await h.app.request('/rewards/crates/bronze/open', {
      method: 'POST',
      headers: authed(token),
    });
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: string; readyAt: number };
    expect(body.error).toBe('cooling_down');
    expect(body.readyAt).toBeGreaterThan(h.now());
  });

  it('404s an unknown tier and 401s without a session', async () => {
    const { token } = await h.login('SOL', solanaWallet('crate-http-404'));
    const bad = await h.app.request('/rewards/crates/unobtainium/open', {
      method: 'POST',
      headers: authed(token),
    });
    expect(bad.status).toBe(404);

    const anon = await h.app.request('/rewards/crates/bronze/open', { method: 'POST' });
    expect(anon.status).toBe(401);
  });

  it('surfaces the drop log and cooldowns on GET /rewards', async () => {
    const wallet = solanaWallet('crate-http-rewards');
    const { token } = await h.login('SOL', wallet);
    await h.app.request('/rewards/crates/bronze/open', { method: 'POST', headers: authed(token) });

    const res = await h.app.request('/rewards', { headers: authed(token) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      stonkz: number;
      rwa: unknown[];
      crates: {
        tier: string;
        ready: boolean;
        drops: { kind: string; asset: string | null; min: number | null; max: number | null }[];
      }[];
      dropLog: { tier: string; rarity: string }[];
    };
    expect(body.crates).toHaveLength(CRATES.length);
    // Global cooldown: opening BRONZE locks every tier, including IRON.
    expect(body.crates.find((c) => c.tier === 'BRONZE')?.ready).toBe(false);
    expect(body.crates.find((c) => c.tier === 'IRON')?.ready).toBe(false);
    expect(body.crates.every((c) => c.ready === false)).toBe(true);
    expect(body.crates[0]?.drops).toHaveLength(5);
    expect(typeof body.stonkz).toBe('number');
    expect(body.rwa).toEqual([]);
    const silverR = body.crates
      .find((c) => c.tier === 'SILVER')
      ?.drops.find((d) => d.kind === 'RWA');
    expect(silverR).toMatchObject({ asset: 'PAXG', min: 0.002, max: 0.01 });
    expect(new Set(body.crates.flatMap((c) => c.drops.map((d) => d.kind)))).toEqual(
      new Set(['STONKZ', 'RWA', 'ITEM']),
    );
    expect(body.dropLog).toHaveLength(1);
    expect(body.dropLog[0]?.tier).toBe('BRONZE');
  });

  it('publishes xp and the crate achievement on the user channel', async () => {
    const wallet = solanaWallet('crate-http-ws');
    const { token } = await h.login('SOL', wallet);
    const before = h.userEvents.length;
    await h.app.request('/rewards/crates/bronze/open', { method: 'POST', headers: authed(token) });

    const emitted = h.userEvents.slice(before).map((e) => e.event.type);
    expect(emitted).toContain('xp');
    expect(emitted).toContain('achievement');
  });
});
