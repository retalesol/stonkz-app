import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, authed, type TestApp } from '../test/app.js';
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
});

describe('PATCH /me', () => {
  it('sets profile fields and GET /users/:net/:addr reflects them', async () => {
    const { token, address } = await h.login('SOL');
    const res = await h.app.request('/me', {
      method: 'PATCH',
      headers: { ...authed(token), 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'TRENCHRAT', bio: 'gm', xHandle: '@degen' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      profile: { username: string; bio: string; xHandle: string };
    };
    expect(body.profile).toMatchObject({ username: 'TRENCHRAT', bio: 'gm', xHandle: 'degen' });

    const pub = await h.app.request(`/users/SOL/${address}`);
    const pubBody = (await pub.json()) as {
      profile: { username: string; bio: string };
      addr: string;
    };
    expect(pubBody.profile.username).toBe('TRENCHRAT');

    const byName = await h.app.request('/users/SOL/TRENCHRAT');
    expect(byName.status).toBe(200);
    const named = (await byName.json()) as {
      addr: string;
      resolvedFrom: string;
      profile: { username: string; bio: string };
      holdings: unknown[];
      launched: unknown[];
    };
    expect(named.addr).toBe(address);
    expect(named.resolvedFrom).toBe('username');
    expect(named.profile).toMatchObject({ username: 'TRENCHRAT', bio: 'gm' });
    expect(Array.isArray(named.holdings)).toBe(true);
    expect(Array.isArray(named.launched)).toBe(true);
  });

  it('rejects a duplicate username with 409', async () => {
    const a = await h.login('SOL', solanaWallet('user-a'));
    const b = await h.login('SOL', solanaWallet('user-b'));

    const first = await h.app.request('/me', {
      method: 'PATCH',
      headers: { ...authed(a.token), 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'SAMENAME' }),
    });
    expect(first.status).toBe(200);

    const second = await h.app.request('/me', {
      method: 'PATCH',
      headers: { ...authed(b.token), 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'SAMENAME' }),
    });
    expect(second.status).toBe(409);
  });

  it('rejects a bio over 160 chars', async () => {
    const { token } = await h.login('SOL');
    const res = await h.app.request('/me', {
      method: 'PATCH',
      headers: { ...authed(token), 'content-type': 'application/json' },
      body: JSON.stringify({ bio: 'x'.repeat(161) }),
    });
    expect(res.status).toBe(400);
  });
});

describe('follow / unfollow', () => {
  it('follows once, unlocks social, and is idempotent (no follow XP)', async () => {
    const me = await h.login('SOL');
    const target = solanaWallet('follow-target').address;

    const res = await h.app.request(`/follow/SOL/${target}`, {
      method: 'POST',
      headers: authed(me.token),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ following: true });

    expect(await h.deps.ledger.unlockedKeys('SOL', me.address)).toContain('social');
    const balance = await h.deps.ledger.readBalance('SOL', me.address);
    // Achievement XP only — follow itself pays 0.
    expect(balance.xp).toBeGreaterThan(0);

    // Following twice does not double-pay.
    await h.app.request(`/follow/SOL/${target}`, { method: 'POST', headers: authed(me.token) });
    const balanceAfter = await h.deps.ledger.readBalance('SOL', me.address);
    expect(balanceAfter.xp).toBe(balance.xp);

    const profile = await h.app.request(`/users/SOL/${target}`, { headers: authed(me.token) });
    expect((await profile.json()) as { followers: number }).toMatchObject({ followers: 1 });
  });

  it('unfollow removes the edge', async () => {
    const me = await h.login('SOL');
    const target = solanaWallet('unfollow-target').address;
    await h.app.request(`/follow/SOL/${target}`, { method: 'POST', headers: authed(me.token) });

    const res = await h.app.request(`/follow/SOL/${target}`, {
      method: 'DELETE',
      headers: authed(me.token),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ following: false });

    const profile = await h.app.request(`/users/SOL/${target}`, { headers: authed(me.token) });
    expect((await profile.json()) as { followers: number }).toMatchObject({ followers: 0 });
  });

  it('refuses following yourself', async () => {
    const me = await h.login('SOL');
    const res = await h.app.request(`/follow/SOL/${me.address}`, {
      method: 'POST',
      headers: authed(me.token),
    });
    expect(res.status).toBe(400);
  });
});

describe('POST /wall/:net/:addr — never trusts a client-asserted tip', () => {
  it('rejects a post whose signature was never verified as a real transfer', async () => {
    const me = await h.login('SOL');
    const target = solanaWallet('wall-target').address;

    const res = await h.app.request(`/wall/SOL/${target}`, {
      method: 'POST',
      headers: { ...authed(me.token), 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'gm', tipTxSig: 'sig-never-happened' }),
    });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: 'tip_rejected', reason: 'not_found' });
  });

  it('rejects a post claiming a huge tip when the real transfer was only dust', async () => {
    const me = await h.login('SOL');
    const target = solanaWallet('wall-target-2').address;

    h.rpcs.SOL.setNativeTransfer('sig-dust-post', {
      found: true,
      status: 'success',
      from: me.address,
      to: target,
      amountNative: 0.0000001,
      blockTimeMs: h.now(),
    });

    const res = await h.app.request(`/wall/SOL/${target}`, {
      method: 'POST',
      headers: { ...authed(me.token), 'content-type': 'application/json' },
      // The body claims a huge tip; only the RPC-verified amount matters.
      body: JSON.stringify({ text: 'huge tip incoming', tipTxSig: 'sig-dust-post' }),
    });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: 'tip_rejected', reason: 'below_minimum' });
  });

  it('accepts a verified tip, posts it, pays XP once, and refuses replay of the same signature', async () => {
    const me = await h.login('SOL');
    const target = solanaWallet('wall-target-3').address;

    h.rpcs.SOL.setNativeTransfer('sig-real-tip', {
      found: true,
      status: 'success',
      from: me.address,
      to: target,
      amountNative: 0.01,
      blockTimeMs: h.now(),
    });

    const res = await h.app.request(`/wall/SOL/${target}`, {
      method: 'POST',
      headers: { ...authed(me.token), 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'tipping you', tipTxSig: 'sig-real-tip' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { post: { tip: number; text: string } };
    expect(body.post).toMatchObject({ tip: 0.01, text: 'tipping you' });

    const wall = await h.app.request(`/wall/SOL/${target}`);
    const wallBody = (await wall.json()) as { posts: { text: string }[] };
    expect(wallBody.posts).toHaveLength(1);

    expect(await h.deps.ledger.unlockedKeys('SOL', me.address)).toContain('social');

    // Replaying the exact same signature (e.g. to spam the wall) is refused.
    const replay = await h.app.request(`/wall/SOL/${target}`, {
      method: 'POST',
      headers: { ...authed(me.token), 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'again', tipTxSig: 'sig-real-tip' }),
    });
    expect(replay.status).toBe(409);
  });
});
