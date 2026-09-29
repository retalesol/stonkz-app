import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Net } from '@stonkz/shared';
import { chainEvents, crateOpens, tokens, trades, xpEvents } from '../db/schema.js';
import { createTestApp, authed, type TestApp } from '../test/app.js';
import { evmWallet, solanaWallet } from '../test/wallets.js';

/**
 * Profile privacy, portfolio cost basis, recent actions and follow lists —
 * `routes/social.ts` on top of `social/profile.ts`. Every private-profile
 * assertion is made against the API, not the UI: a redacted card and a 403
 * are the contract the web client renders from.
 */

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

const json = { 'content-type': 'application/json' };

async function patchMe(token: string, body: unknown): Promise<Response> {
  return h.app.request('/me', {
    method: 'PATCH',
    headers: { ...authed(token), ...json },
    body: JSON.stringify(body),
  });
}

async function seedToken(net: Net, sym: string, mint: string, creator = 'creator'): Promise<void> {
  await h.deps.db.insert(tokens).values({
    net,
    sym,
    name: sym,
    creator,
    mint,
    baseSymbol: net === 'SOL' ? 'SOL' : 'ETH',
    baseMint: 'base',
    supply: 1_000_000,
    feeBps: 100,
    // $1 per token.
    mc: 1_000_000,
    seed: 7,
    launchedAt: new Date(h.now() - 10 * 60_000),
  });
}

let tradeSeq = 0;
async function seedTrade(
  net: Net,
  trader: string,
  opts: {
    sym: string;
    mint: string;
    side: 'buy' | 'sell';
    tok: number;
    usd: number;
    atMs?: number;
  },
): Promise<string> {
  tradeSeq++;
  const sig = `sig-${tradeSeq}`;
  await h.deps.db.insert(trades).values({
    net,
    sym: opts.sym,
    mint: opts.mint,
    txSig: sig,
    logIndex: 0,
    side: opts.side,
    trader,
    nativeAmount: opts.usd / 200,
    baseAmount: opts.usd / 200,
    tokenAmount: opts.tok,
    usdValue: opts.usd,
    mc: 1_000_000,
    price: opts.usd / opts.tok,
    blockTime: new Date(opts.atMs ?? h.now() - tradeSeq * 60_000),
    chainPosition: tradeSeq,
  });
  return sig;
}

describe('PATCH /me — validation', () => {
  it('rejects reserved, malformed and over-long usernames with the field named', async () => {
    const { token } = await h.login('SOL');
    for (const username of ['admin', 'Support', 'bad name', 'x'.repeat(23), '___', 'a<b>']) {
      const res = await patchMe(token, { username });
      expect(res.status, username).toBe(400);
      expect(await res.json()).toMatchObject({ error: 'bad_request', field: 'username' });
    }
  });

  it('treats usernames case-insensitively for uniqueness and reports 409 with the field', async () => {
    const a = await h.login('SOL', solanaWallet('user-a'));
    const b = await h.login('SOL', solanaWallet('user-b'));
    expect((await patchMe(a.token, { username: 'Mememan' })).status).toBe(200);
    const clash = await patchMe(b.token, { username: 'MEMEMAN' });
    expect(clash.status).toBe(409);
    expect(await clash.json()).toMatchObject({ error: 'username_taken', field: 'username' });
  });

  it('validates links: http(s) website, X handle, t.me telegram, https avatar', async () => {
    const { token } = await h.login('SOL');
    const bad: Array<Record<string, unknown>> = [
      { website: 'javascript:alert(1)' },
      { website: 'data:text/html,hi' },
      { website: 'not a url' },
      { xHandle: 'has space' },
      { telegram: 'https://evil.example/stonkz' },
      { avatarUrl: 'http://plain.example/a.png' },
      { private: 'true' },
    ];
    for (const body of bad) {
      const res = await patchMe(token, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      const out = (await res.json()) as { field: string };
      expect(out.field).toBe(Object.keys(body)[0]);
    }

    const ok = await patchMe(token, {
      website: 'ston.kz/about',
      xHandle: '@degen',
      telegram: 't.me/stonkz_chat',
      bio: '  gm​ fren  ',
      private: true,
    });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { profile: Record<string, unknown> };
    expect(body.profile).toMatchObject({
      website: 'https://ston.kz/about',
      xHandle: 'degen',
      telegram: 'https://t.me/stonkz_chat',
      bio: 'gm fren',
      private: true,
    });

    // GET /me returns the whole editable set so the dialog can prefill it.
    const me = await h.app.request('/me', { headers: authed(token) });
    expect(await me.json()).toMatchObject({
      website: 'https://ston.kz/about',
      xHandle: 'degen',
      telegram: 'https://t.me/stonkz_chat',
      private: true,
      profile: { private: true, telegram: 'https://t.me/stonkz_chat' },
    });
  });

  it('refuses an empty patch and a non-object body', async () => {
    const { token } = await h.login('SOL');
    expect((await patchMe(token, {})).status).toBe(400);
    expect((await patchMe(token, [1, 2])).status).toBe(400);
    expect((await patchMe(token, { unknownField: 1 })).status).toBe(400);
  });
});

describe('private profiles — enforced on every endpoint', () => {
  async function privateMember(): Promise<{ token: string; address: string }> {
    const owner = await h.login('SOL', solanaWallet('private-owner'));
    expect((await patchMe(owner.token, { username: 'Hermit', private: true })).status).toBe(200);
    return owner;
  }

  it('redacts the member card for strangers and followers, never for the owner', async () => {
    const owner = await privateMember();
    const follower = await h.login('SOL', solanaWallet('private-follower'));
    await h.app.request(`/follow/SOL/${owner.address}`, {
      method: 'POST',
      headers: authed(follower.token),
    });
    await seedToken('SOL', 'HERM', 'mint-herm', owner.address);

    for (const headers of [{}, authed(follower.token)]) {
      const res = await h.app.request(`/users/SOL/${owner.address}`, { headers });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).toMatchObject({
        private: true,
        own: false,
        followers: null,
        following: null,
        followingWallets: [],
        portfolioUsd: null,
        holdings: [],
        holdingsSource: 'private',
        staked: [],
        native: { unit: 'SOL', balance: null },
      });
      // Identity and on-chain creator attribution stay public.
      expect(body['profile']).toMatchObject({ username: 'Hermit', private: true });
      expect((body['launched'] as unknown[]).length).toBe(1);
      expect(body).not.toHaveProperty('pnl');
    }

    const mine = await h.app.request(`/users/SOL/${owner.address}`, {
      headers: authed(owner.token),
    });
    const mineBody = (await mine.json()) as Record<string, unknown>;
    expect(mineBody).toMatchObject({ private: true, own: true, followers: 1, following: 0 });
    expect(Array.isArray(mineBody['holdings'])).toBe(true);
    expect(mineBody).toHaveProperty('pnl');
    // Username lookup takes the same path.
    const byName = await h.app.request('/users/SOL/hermit');
    expect(((await byName.json()) as { holdingsSource: string }).holdingsSource).toBe('private');
  });

  it('403s activity, wall, followers, following and friends for anyone but the owner', async () => {
    const owner = await privateMember();
    const other = await h.login('SOL', solanaWallet('private-other'));
    const paths = ['activity', 'followers', 'following', 'friends'].map(
      (p) => `/users/SOL/${owner.address}/${p}`,
    );
    paths.push(`/wall/SOL/${owner.address}`);
    for (const path of paths) {
      for (const headers of [{}, authed(other.token)]) {
        const res = await h.app.request(path, { headers });
        expect(res.status, path).toBe(403);
        expect(await res.json()).toMatchObject({ error: 'private_profile' });
      }
      const mine = await h.app.request(path, { headers: authed(owner.token) });
      expect(mine.status, path).toBe(200);
    }
  });

  it('refuses posts and likes on a private wall from anyone but the owner', async () => {
    const owner = await privateMember();
    const other = await h.login('SOL', solanaWallet('private-tipper'));
    h.rpcs.SOL.setNativeTransfer('sig-private-tip', {
      found: true,
      status: 'success',
      from: other.address,
      to: owner.address,
      amountNative: 0.01,
      blockTimeMs: h.now(),
    });
    const post = await h.app.request(`/wall/SOL/${owner.address}`, {
      method: 'POST',
      headers: { ...authed(other.token), ...json },
      body: JSON.stringify({ text: 'hello?', tipTxSig: 'sig-private-tip' }),
    });
    expect(post.status).toBe(403);

    // Flip public: the same tip now posts; flip private again and a stranger
    // cannot like the post that is already there.
    await patchMe(owner.token, { private: false });
    const posted = await h.app.request(`/wall/SOL/${owner.address}`, {
      method: 'POST',
      headers: { ...authed(other.token), ...json },
      body: JSON.stringify({ text: 'hello!', tipTxSig: 'sig-private-tip' }),
    });
    expect(posted.status).toBe(200);
    const { post: p } = (await posted.json()) as { post: { id: number } };
    await patchMe(owner.token, { private: true });
    const like = await h.app.request(`/wall/SOL/posts/${p.id}/like`, {
      method: 'POST',
      headers: { ...authed(other.token), ...json },
      body: '{}',
    });
    expect(like.status).toBe(403);
  });

  it('follow still works against a private profile (the follower owns that edge)', async () => {
    const owner = await privateMember();
    const other = await h.login('SOL', solanaWallet('private-fan'));
    const res = await h.app.request(`/follow/SOL/${owner.address}`, {
      method: 'POST',
      headers: authed(other.token),
    });
    expect(res.status).toBe(200);
    const card = await h.app.request(`/users/SOL/${owner.address}`, {
      headers: authed(other.token),
    });
    expect(await card.json()).toMatchObject({ isFollowing: true, followers: null });
  });

  it('never leaks private data through the identity batch', async () => {
    const owner = await privateMember();
    const res = await h.app.request(`/identities/SOL?wallets=${owner.address},nobody`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      net: 'SOL',
      identities: [
        { wallet: owner.address, username: 'Hermit', avatarUrl: null },
        { wallet: 'nobody', username: null, avatarUrl: null },
      ],
    });
  });
});

describe('portfolio — cost basis from the trades table', () => {
  it('nets buys against sells, prices at the curve, and reports PnL + dust filtering', async () => {
    const me = await h.login('SOL');
    await seedToken('SOL', 'WOJAK', 'mint-wojak');
    await seedToken('SOL', 'DUST', 'mint-dust');
    // 200 bought for $100 (avg $0.50), 50 sold for $75 → 150 held at $1 = $150.
    await seedTrade('SOL', me.address, {
      sym: 'WOJAK',
      mint: 'mint-wojak',
      side: 'buy',
      tok: 200,
      usd: 100,
    });
    await seedTrade('SOL', me.address, {
      sym: 'WOJAK',
      mint: 'mint-wojak',
      side: 'sell',
      tok: 50,
      usd: 75,
    });
    // A fully exited position must not show as a holding.
    await seedTrade('SOL', me.address, {
      sym: 'DUST',
      mint: 'mint-dust',
      side: 'buy',
      tok: 10,
      usd: 10,
    });
    await seedTrade('SOL', me.address, {
      sym: 'DUST',
      mint: 'mint-dust',
      side: 'sell',
      tok: 10,
      usd: 12,
    });

    const res = await h.app.request(`/users/SOL/${me.address}`);
    const body = (await res.json()) as {
      holdings: Array<Record<string, unknown>>;
      holdingsSource: string;
      portfolioUsd: number;
      pnl: { unrealisedUsd: number; realisedUsd: number };
    };
    // The fake RPC has no SPL balance source, so the indexer's trades are the source.
    expect(body.holdingsSource).toBe('index');
    expect(body.holdings).toHaveLength(1);
    expect(body.holdings[0]).toMatchObject({
      sym: 'WOJAK',
      mint: 'mint-wojak',
      tok: 150,
      cost: 75,
      value: 150,
      pnlUsd: 75,
      pnlPct: 100,
      basis: 'trades',
      // 50 sold at $1.50 against a $0.50 basis.
      realisedUsd: 50,
    });
    expect(body.portfolioUsd).toBe(150);
    expect(body.pnl).toEqual({ unrealisedUsd: 75, realisedUsd: 52 });
  });

  it("lists the wallet's staked positions read-only from the indexer", async () => {
    const me = await h.login('RH', evmWallet('staker'));
    await seedToken('RH', 'STK', '0x00000000000000000000000000000000000000aa');
    await h.deps.db.insert((await import('../db/schema.js')).stakePositions).values({
      net: 'RH',
      sym: 'STK',
      mint: '0x00000000000000000000000000000000000000aa',
      wallet: me.address.toLowerCase(),
      amount: 500,
      lockDays: 30,
      mult: 2,
      untilMs: h.now() + 86_400_000,
      rewardNative: 0.01,
      rewardTokens: 3,
    });
    const res = await h.app.request(`/users/RH/${me.address}`);
    const body = (await res.json()) as { staked: Array<Record<string, unknown>> };
    expect(body.staked).toHaveLength(1);
    expect(body.staked[0]).toMatchObject({ sym: 'STK', amt: 500, lockDays: 30, valueUsd: 500 });
  });
});

describe('GET /users/:net/:addr/activity', () => {
  it('merges launches, trades, stakes, crates, level-ups and follows newest first, and pages', async () => {
    const me = await h.login('SOL');
    const now = h.now();
    await seedToken('SOL', 'MINE', 'mint-mine', me.address);
    await h.deps.db.insert(chainEvents).values({
      net: 'SOL',
      kind: 'TokenCreated',
      sym: 'MINE',
      wallet: me.address,
      txSig: 'sig-launch',
      logIndex: 0,
      chainPosition: 1,
      blockTime: new Date(now - 10 * 60_000),
      payload: { mint: 'mint-mine' },
    });
    await seedTrade('SOL', me.address, {
      sym: 'MINE',
      mint: 'mint-mine',
      side: 'buy',
      tok: 10,
      usd: 5,
      atMs: now - 9 * 60_000,
    });
    const sellSig = await seedTrade('SOL', me.address, {
      sym: 'MINE',
      mint: 'mint-mine',
      side: 'sell',
      tok: 4,
      usd: 3,
      atMs: now - 8 * 60_000,
    });
    await h.deps.db.insert(chainEvents).values([
      {
        net: 'SOL',
        kind: 'Staked',
        sym: 'MINE',
        wallet: me.address,
        txSig: 'sig-stake',
        logIndex: 0,
        chainPosition: 2,
        blockTime: new Date(now - 7 * 60_000),
        payload: { mint: 'mint-mine', amount: 6 },
      },
      {
        net: 'SOL',
        kind: 'StakeClaimed',
        sym: 'MINE',
        wallet: me.address,
        txSig: 'sig-claim',
        logIndex: 0,
        chainPosition: 3,
        blockTime: new Date(now - 6 * 60_000),
        payload: { mint: 'mint-mine', rewardNative: 0.002, rewardTokens: 1 },
      },
    ]);
    await h.deps.db.insert(crateOpens).values({
      wallet: me.address,
      net: 'SOL',
      tier: 'BRONZE',
      rollCommit: 'c1',
      serverSeedHash: 's1',
      clientNonce: 'n1',
      rollValue: 0.5,
      amountRoll: 0.5,
      dropIndex: 0,
      rarity: 'common',
      payloadJson: { label: '180 $STONKZ' },
      openedAt: new Date(now - 5 * 60_000),
    });
    // 240 XP then +20 crosses BAG HOLDER (250) → one level-up at the second event.
    await h.deps.db.insert(xpEvents).values([
      {
        wallet: me.address,
        net: 'SOL',
        amount: 240,
        baseAmount: 240,
        reason: 'trade',
        txSig: 'x1',
        dayUtc: '2026-09-06',
        createdAt: new Date(now - 4 * 60_000),
      },
      {
        wallet: me.address,
        net: 'SOL',
        amount: 20,
        baseAmount: 20,
        reason: 'trade',
        txSig: 'x2',
        dayUtc: '2026-09-06',
        createdAt: new Date(now - 3 * 60_000),
      },
    ]);
    const friend = solanaWallet('activity-friend').address;
    await h.app.request(`/follow/SOL/${friend}`, { method: 'POST', headers: authed(me.token) });

    const res = await h.app.request(`/users/SOL/${me.address}/activity?limit=4`);
    expect(res.status).toBe(200);
    const page1 = (await res.json()) as {
      items: Array<Record<string, unknown>>;
      nextBefore: number | null;
    };
    expect(page1.items.map((i) => i['kind'])).toEqual([
      'follow',
      'level_up',
      'crate',
      'stake_claim',
    ]);
    expect(page1.items[1]).toMatchObject({ level: 2, label: 'BAG HOLDER' });
    expect(page1.items[2]).toMatchObject({ tier: 'BRONZE', label: '180 $STONKZ' });
    expect(page1.items[3]).toMatchObject({ sig: 'sig-claim', native: 0.002, tokens: 1 });
    expect(page1.nextBefore).toBe(now - 6 * 60_000);

    const res2 = await h.app.request(
      `/users/SOL/${me.address}/activity?limit=4&before=${page1.nextBefore}`,
    );
    const page2 = (await res2.json()) as typeof page1;
    expect(page2.items.map((i) => i['kind'])).toEqual(['stake', 'sell', 'buy', 'launch']);
    expect(page2.items[0]).toMatchObject({ sig: 'sig-stake', tokens: 6 });
    expect(page2.items[1]).toMatchObject({ sig: sellSig, native: 3 / 200, usd: 3 });
    expect(page2.items[3]).toMatchObject({ sym: 'MINE', mint: 'mint-mine', sig: 'sig-launch' });
    expect(page2.nextBefore).toBeNull();

    // Stable ids: nothing repeats across the two pages.
    const ids = [...page1.items, ...page2.items].map((i) => i['id']);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('404s an unknown username', async () => {
    const res = await h.app.request('/users/SOL/nobody_here/activity');
    expect(res.status).toBe(404);
  });
});

describe('follow lists', () => {
  it('followers / following / friends carry public identity and page newest-first', async () => {
    const me = await h.login('SOL', solanaWallet('lists-me'));
    const a = await h.login('SOL', solanaWallet('lists-a'));
    const b = await h.login('SOL', solanaWallet('lists-b'));
    await patchMe(a.token, { username: 'Alice' });
    await patchMe(b.token, { username: 'Bob' });

    // me → a, me → b, a → me. Friends(me) = {a}.
    await h.app.request(`/follow/SOL/${a.address}`, { method: 'POST', headers: authed(me.token) });
    h.advance(1000);
    await h.app.request(`/follow/SOL/${b.address}`, { method: 'POST', headers: authed(me.token) });
    h.advance(1000);
    await h.app.request(`/follow/SOL/${me.address}`, { method: 'POST', headers: authed(a.token) });

    const following = (await (
      await h.app.request(`/users/SOL/${me.address}/following`)
    ).json()) as {
      entries: Array<{ wallet: string; username: string | null }>;
      nextBefore: number | null;
    };
    expect(following.entries.map((e) => e.username)).toEqual(['Bob', 'Alice']);
    expect(following.nextBefore).toBeNull();

    const paged = (await (
      await h.app.request(`/users/SOL/${me.address}/following?limit=1`)
    ).json()) as typeof following;
    expect(paged.entries.map((e) => e.username)).toEqual(['Bob']);
    expect(paged.nextBefore).not.toBeNull();
    const rest = (await (
      await h.app.request(`/users/SOL/${me.address}/following?limit=1&before=${paged.nextBefore}`)
    ).json()) as typeof following;
    expect(rest.entries.map((e) => e.username)).toEqual(['Alice']);

    const followers = (await (
      await h.app.request(`/users/SOL/${me.address}/followers`)
    ).json()) as typeof following;
    expect(followers.entries.map((e) => e.username)).toEqual(['Alice']);

    const friends = (await (await h.app.request(`/users/SOL/${me.address}/friends`)).json()) as {
      entries: Array<{ username: string | null }>;
    };
    expect(friends.entries.map((e) => e.username)).toEqual(['Alice']);

    // The card of a mutual reports both directions.
    const card = (await (
      await h.app.request(`/users/SOL/${a.address}`, { headers: authed(me.token) })
    ).json()) as { isFollowing: boolean; followsYou: boolean };
    expect(card).toMatchObject({ isFollowing: true, followsYou: true });
  });

  it('follow/unfollow of an unknown username is a 404, not a stored garbage edge', async () => {
    const me = await h.login('SOL');
    const res = await h.app.request('/follow/SOL/nobody_here', {
      method: 'POST',
      headers: authed(me.token),
    });
    expect(res.status).toBe(404);
    const del = await h.app.request('/follow/SOL/nobody_here', {
      method: 'DELETE',
      headers: authed(me.token),
    });
    expect(del.status).toBe(404);
  });
});

describe('wall — moderation, hygiene and paging', () => {
  it('hides a flagged post from readers, pays it no XP, and pages newest-first', async () => {
    const me = await h.login('SOL');
    const target = solanaWallet('wall-page-target').address;
    await patchMe(me.token, { username: 'Tipper' });
    const sigs = ['w1', 'w2', 'w3'];
    for (const sig of sigs) {
      h.rpcs.SOL.setNativeTransfer(sig, {
        found: true,
        status: 'success',
        from: me.address,
        to: target,
        amountNative: 0.01,
        blockTimeMs: h.now(),
      });
    }
    const post = (text: string, sig: string) =>
      h.app.request(`/wall/SOL/${target}`, {
        method: 'POST',
        headers: { ...authed(me.token), ...json },
        body: JSON.stringify({ text, tipTxSig: sig }),
      });
    expect((await post('first​ post', 'w1')).status).toBe(200);
    const flagged = await post('what the fuck', 'w2');
    expect(flagged.status).toBe(200);
    expect(await flagged.json()).toMatchObject({ flagged: true, xpAwarded: 0 });
    expect((await post('third', 'w3')).status).toBe(200);

    const wall = (await (await h.app.request(`/wall/SOL/${target}?limit=1`)).json()) as {
      posts: Array<{ id: number; text: string; fromUsername: string | null }>;
      nextBefore: number | null;
    };
    expect(wall.posts.map((p) => p.text)).toEqual(['third']);
    expect(wall.posts[0]?.fromUsername).toBe('Tipper');
    expect(wall.nextBefore).toBe(wall.posts[0]?.id);

    const older = (await (
      await h.app.request(`/wall/SOL/${target}?limit=5&before=${wall.nextBefore}`)
    ).json()) as typeof wall;
    // The zero-width space was stripped; the flagged post never appears.
    expect(older.posts.map((p) => p.text)).toEqual(['first post']);
    expect(older.nextBefore).toBeNull();
  });

  it('rejects control characters in the signature and a post to an unknown username', async () => {
    const me = await h.login('SOL');
    const res = await h.app.request('/wall/SOL/nobody_here', {
      method: 'POST',
      headers: { ...authed(me.token), ...json },
      body: JSON.stringify({ text: 'gm', tipTxSig: 'sig' }),
    });
    expect(res.status).toBe(404);
    const target = solanaWallet('wall-ctl').address;
    const bad = await h.app.request(`/wall/SOL/${target}`, {
      method: 'POST',
      headers: { ...authed(me.token), ...json },
      body: JSON.stringify({ text: 'gm', tipTxSig: 'sig\nwith newline' }),
    });
    expect(bad.status).toBe(400);
  });
});

describe('POST /me/sessions/revoke-others', () => {
  it('revokes every other session for the wallet and keeps the caller signed in', async () => {
    const w = solanaWallet('multi-device');
    const phone = await h.login('SOL', w);
    const laptop = await h.login('SOL', w);
    expect(await h.deps.auth.countLiveSessions('SOL', w.address)).toBe(2);

    const res = await h.app.request('/me/sessions/revoke-others', {
      method: 'POST',
      headers: { ...authed(laptop.token), ...json },
      body: '{}',
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, revoked: 1 });
    expect(await h.deps.auth.countLiveSessions('SOL', w.address)).toBe(1);

    // The phone's refresh token is dead; the laptop's still works.
    const phoneRefresh = await h.app.request('/auth/refresh', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ refreshToken: phone.refreshToken }),
    });
    expect(phoneRefresh.status).toBeGreaterThanOrEqual(400);
    const laptopRefresh = await h.app.request('/auth/refresh', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ refreshToken: laptop.refreshToken }),
    });
    expect(laptopRefresh.status).toBe(200);
  });
});
