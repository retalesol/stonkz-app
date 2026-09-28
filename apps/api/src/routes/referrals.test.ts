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
});
