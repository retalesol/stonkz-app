import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { referralFeePayouts } from '@stonkz/shared';
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
  await h.clearRateLimits();
  h.setNow(FROZEN_NOW);
});

describe('referrals', () => {
  it('issues a code and attaches a referee once', async () => {
    const referrer = await h.login('SOL', solanaWallet('ref-a'));
    const referee = await h.login('SOL', solanaWallet('ref-b'));

    const mine = await h.app.request('/referrals', { headers: authed(referrer.token) });
    expect(mine.status).toBe(200);
    const snap = (await mine.json()) as { code: string };
    expect(snap.code).toMatch(/^[A-F0-9]{8}$/);

    const attach = await h.app.request('/referrals/attach', {
      method: 'POST',
      headers: { ...authed(referee.token), 'content-type': 'application/json' },
      body: JSON.stringify({ code: snap.code }),
    });
    expect(attach.status).toBe(200);
    expect(await attach.json()).toMatchObject({ ok: true, referrer: referrer.address });

    const again = await h.app.request('/referrals/attach', {
      method: 'POST',
      headers: { ...authed(referee.token), 'content-type': 'application/json' },
      body: JSON.stringify({ code: snap.code }),
    });
    expect(again.status).toBe(409);
  });

  it('kicks back 5% SP to the direct referrer (SP-only, no XP)', async () => {
    const referrer = await h.login('SOL', solanaWallet('ref-sp-a'));
    const referee = await h.login('SOL', solanaWallet('ref-sp-b'));
    const { code } = (await (
      await h.app.request('/referrals', { headers: authed(referrer.token) })
    ).json()) as {
      code: string;
    };
    await h.app.request('/referrals/attach', {
      method: 'POST',
      headers: { ...authed(referee.token), 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
    });

    const before = await h.deps.ledger.readBalance('SOL', referrer.address);
    await h.deps.ledger.award({
      net: 'SOL',
      wallet: referee.address,
      reason: 'follow',
      baseXp: 100,
      mirrorSp: true,
    });

    const bal = await h.deps.ledger.readBalance('SOL', referrer.address);
    expect(bal.sp - before.sp).toBe(5);
    expect(bal.xp).toBe(before.xp);
  });

  it('claims pending referral fees as $STONKZ credits', async () => {
    const referrer = await h.login('SOL', solanaWallet('ref-claim-a'));
    const trader = await h.login('SOL', solanaWallet('ref-claim-b'));
    const { code } = (await (
      await h.app.request('/referrals', { headers: authed(referrer.token) })
    ).json()) as {
      code: string;
    };
    await h.app.request('/referrals/attach', {
      method: 'POST',
      headers: { ...authed(trader.token), 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    await h.deps.referrals.creditFeesFromFill({
      net: 'SOL',
      trader: trader.address,
      feeAmount: 1,
      protocolLeg: 0.2,
      txSig: 'fee-claim-sig',
    });

    const res = await h.app.request('/referrals/claim', {
      method: 'POST',
      headers: authed(referrer.token),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      claimedNative: number;
      stonkz: number;
      stonkzTotal: number;
    };
    expect(body.claimedNative).toBeCloseTo(0.15, 10);
    expect(body.stonkz).toBe(1500); // 0.15 * REFERRAL_STONKZ_PER_NATIVE (10_000)
    expect(body.stonkzTotal).toBe(1500);
    expect((await h.deps.ledger.readBalance('SOL', referrer.address)).stonkz).toBe(1500);

    const snap = await h.deps.referrals.snapshot('SOL', referrer.address);
    expect(snap.pendingNative).toBe(0);
  });

  it('credits T1 fee share from a fill', async () => {
    const referrer = await h.login('SOL', solanaWallet('ref-fee-a'));
    const trader = await h.login('SOL', solanaWallet('ref-fee-b'));
    const { code } = (await (
      await h.app.request('/referrals', { headers: authed(referrer.token) })
    ).json()) as {
      code: string;
    };
    await h.app.request('/referrals/attach', {
      method: 'POST',
      headers: { ...authed(trader.token), 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
    });

    const cut = await h.deps.referrals.creditFeesFromFill({
      net: 'SOL',
      trader: trader.address,
      feeAmount: 1,
      protocolLeg: 0.2,
      txSig: 'fee-sig-1',
    });
    const expected = referralFeePayouts(1, 0.2, 1)[0]!.amount;
    expect(cut).toBeCloseTo(expected, 10);

    const snap = await h.deps.referrals.snapshot('SOL', referrer.address);
    expect(snap.pendingNative).toBeCloseTo(expected, 10);
    expect(snap.lifetimeNative).toBeCloseTo(expected, 10);
  });

  /** Three wallets in a chain: C is referred by B, B by A. A fill by C pays B (T1) and A (T2). */
  async function chain3(prefix: string) {
    const a = await h.login('SOL', solanaWallet(`${prefix}-a`));
    const b = await h.login('SOL', solanaWallet(`${prefix}-b`));
    const c = await h.login('SOL', solanaWallet(`${prefix}-c`));
    const codeOf = async (t: string): Promise<string> =>
      (
        (await (await h.app.request('/referrals', { headers: authed(t) })).json()) as {
          code: string;
        }
      ).code;
    const attach = (t: string, code: string) =>
      h.app.request('/referrals/attach', {
        method: 'POST',
        headers: { ...authed(t), 'content-type': 'application/json' },
        body: JSON.stringify({ code }),
      });
    await attach(b.token, await codeOf(a.token));
    await attach(c.token, await codeOf(b.token));
    return { a, b, c };
  }

  it('reports earnings per tier and a replayed fill credits nothing twice', async () => {
    const { a, b, c } = await chain3('ref-tier');
    // feeAmount 1, protocol leg 0.15: T1 0.15 + T2 0.10 = 0.25 > 0.15, scaled by 0.6.
    const fill = { net: 'SOL' as const, trader: c.address, feeAmount: 1, protocolLeg: 0.15 };
    const cut = await h.deps.referrals.creditFeesFromFill({ ...fill, txSig: 'tier-sig-1' });
    const [t1, t2] = referralFeePayouts(1, 0.15, 2);
    expect(cut).toBeCloseTo(t1!.amount + t2!.amount, 10);
    expect(cut).toBeCloseTo(0.15, 10); // never more than the protocol leg

    const again = await h.deps.referrals.creditFeesFromFill({ ...fill, txSig: 'tier-sig-1' });
    // The replay reports the same cut (it still came off the protocol leg)…
    expect(again).toBeCloseTo(cut, 10);

    const bSnap = await h.deps.referrals.snapshot('SOL', b.address);
    const aSnap = await h.deps.referrals.snapshot('SOL', a.address);
    // …but credits nobody twice.
    expect(bSnap.pendingNative).toBeCloseTo(t1!.amount, 10);
    expect(aSnap.pendingNative).toBeCloseTo(t2!.amount, 10);
    expect(bSnap.tiers.map((t) => t.tier)).toEqual([1, 2, 3]);
    expect(bSnap.tiers[0]).toMatchObject({ tier: 1, rate: 0.15, fills: 1 });
    expect(bSnap.tiers[0]!.pendingNative).toBeCloseTo(t1!.amount, 10);
    expect(bSnap.tiers[1]!.pendingNative).toBe(0);
    expect(aSnap.tiers[1]).toMatchObject({ tier: 2, rate: 0.1, fills: 1 });
    expect(aSnap.tiers[1]!.pendingNative).toBeCloseTo(t2!.amount, 10);
    expect(aSnap.tiers[0]!.pendingNative).toBe(0);
    // Tiers always sum to the wallet balance.
    const sum = (s: typeof aSnap) => s.tiers.reduce((x, t) => x + t.pendingNative, 0);
    expect(sum(aSnap)).toBeCloseTo(aSnap.pendingNative, 10);
    expect(sum(bSnap)).toBeCloseTo(bSnap.pendingNative, 10);
  });

  it('books a native claim as a payout request the treasury signer settles', async () => {
    const { a, b, c } = await chain3('ref-native');
    await h.deps.referrals.creditFeesFromFill({
      net: 'SOL',
      trader: c.address,
      feeAmount: 2,
      protocolLeg: 0.3,
      txSig: 'native-sig-1',
    });
    const [t1] = referralFeePayouts(2, 0.3, 2);

    const res = await h.app.request('/referrals/claim', {
      method: 'POST',
      headers: { ...authed(b.token), 'content-type': 'application/json' },
      body: JSON.stringify({ payout: 'native' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      mode: string;
      claimedNative: number;
      stonkz: number;
      payoutId: number;
      tiers: Record<string, number>;
    };
    expect(body.mode).toBe('native');
    expect(body.claimedNative).toBeCloseTo(t1!.amount, 10);
    expect(body.stonkz).toBe(0);
    expect(body.tiers['1']).toBeCloseTo(t1!.amount, 10);
    // No credits were minted for a native request.
    expect((await h.deps.ledger.readBalance('SOL', b.address)).stonkz).toBe(0);

    let snap = await h.deps.referrals.snapshot('SOL', b.address);
    expect(snap.pendingNative).toBe(0);
    expect(snap.tiers[0]!.pendingNative).toBe(0);
    expect(snap.tiers[0]!.lifetimeNative).toBeCloseTo(t1!.amount, 10);
    expect(snap.requestedNative).toBeCloseTo(t1!.amount, 10);
    expect(snap.paidNative).toBe(0);
    expect(snap.payouts[0]).toMatchObject({
      id: body.payoutId,
      mode: 'native',
      status: 'requested',
    });

    // A second claim finds nothing.
    const empty = await h.app.request('/referrals/claim', {
      method: 'POST',
      headers: { ...authed(b.token), 'content-type': 'application/json' },
      body: JSON.stringify({ payout: 'native' }),
    });
    expect(((await empty.json()) as { claimedNative: number }).claimedNative).toBe(0);

    // The operator batch sees it, settles it, and the snapshot follows.
    const queue = await h.deps.referrals.listPayoutRequests('SOL');
    expect(queue.map((p) => p.id)).toContain(body.payoutId);
    expect(await h.deps.referrals.markPayoutsPaid([body.payoutId], 'withdrawSig1')).toBe(1);
    expect(await h.deps.referrals.markPayoutsPaid([body.payoutId], 'withdrawSig1')).toBe(0);
    snap = await h.deps.referrals.snapshot('SOL', b.address);
    expect(snap.requestedNative).toBe(0);
    expect(snap.paidNative).toBeCloseTo(t1!.amount, 10);
    expect(snap.payouts[0]).toMatchObject({ status: 'paid', txSig: 'withdrawSig1' });
    // A's T2 is untouched by B's claim.
    expect((await h.deps.referrals.snapshot('SOL', a.address)).pendingNative).toBeGreaterThan(0);
  });

  it('voiding a native request returns the money to pending, per tier', async () => {
    const { b, c } = await chain3('ref-void');
    await h.deps.referrals.creditFeesFromFill({
      net: 'SOL',
      trader: c.address,
      feeAmount: 1,
      protocolLeg: 0.15,
      txSig: 'void-sig-1',
    });
    const before = await h.deps.referrals.snapshot('SOL', b.address);
    const claim = await h.deps.referrals.claimFees('SOL', b.address, 'native');
    expect(claim.payoutId).not.toBeNull();
    expect(await h.deps.referrals.voidPayoutRequest(claim.payoutId!, 'test')).toBe(true);
    expect(await h.deps.referrals.voidPayoutRequest(claim.payoutId!, 'test')).toBe(false);
    const after = await h.deps.referrals.snapshot('SOL', b.address);
    expect(after.pendingNative).toBeCloseTo(before.pendingNative, 10);
    expect(after.tiers[0]!.pendingNative).toBeCloseTo(before.tiers[0]!.pendingNative, 10);
    expect(after.requestedNative).toBe(0);
  });

  it('rejects an unknown payout mode', async () => {
    const w = await h.login('SOL', solanaWallet('ref-mode'));
    const res = await h.app.request('/referrals/claim', {
      method: 'POST',
      headers: { ...authed(w.token), 'content-type': 'application/json' },
      body: JSON.stringify({ payout: 'cash' }),
    });
    expect(res.status).toBe(400);
  });
});
