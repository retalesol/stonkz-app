import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { adminAuditLog, tokenModeration, tokens } from '../db/schema.js';
import { ChatService } from '../social/chat.js';
import { authed, createTestApp, type TestApp } from '../test/app.js';
import { evmWallet, solanaWallet, type TestWallet } from '../test/wallets.js';
import { totp } from '../admin/totp.js';

/**
 * The admin panel's security model end to end: step-up on top of a normal
 * session, 404 for strangers, roles, TOTP, the hard auth rate limit, the IP
 * allowlist, audit rows on every mutation, and the enforcement points wired
 * into the public API (bans, feature flags, hidden tokens, KOTH pins).
 */
const OWNER = evmWallet('admin-owner');
const SOL_OWNER = solanaWallet('admin-owner-sol');
const STRANGER = evmWallet('not-an-admin');
const MOD = evmWallet('admin-moderator');

let t: TestApp;

beforeAll(async () => {
  t = await createTestApp({
    env: { ADMIN_WALLETS: `${OWNER.address.toLowerCase()},${SOL_OWNER.address}` },
  });
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.db.reset();
  await t.clearRateLimits();
  await t.deps.admin.settings.load();
});

async function json(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

/** Full ceremony: normal login, challenge, sign, verify → admin token. */
async function stepUp(
  net: 'RH' | 'SOL',
  wallet: TestWallet,
  code?: string,
): Promise<{ admin: string; access: string }> {
  const { token } = await t.login(net, wallet);
  const ch = await t.app.request('/admin/auth/challenge', { headers: authed(token) });
  if (ch.status !== 200) throw new Error(`challenge ${ch.status} ${await ch.text()}`);
  const challenge = (await ch.json()) as { message: string };
  const res = await t.app.request('/admin/auth/verify', {
    method: 'POST',
    headers: { ...authed(token), 'content-type': 'application/json' },
    body: JSON.stringify({
      message: challenge.message,
      signature: wallet.sign(challenge.message),
      totp: code,
    }),
  });
  if (res.status !== 200) throw new Error(`verify ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { adminToken: string };
  return { admin: body.adminToken, access: token };
}

const asAdmin = (adminToken: string): Record<string, string> => ({
  authorization: `Bearer ${adminToken}`,
  origin: 'https://ston.kz',
  'content-type': 'application/json',
});

async function auditActions(): Promise<string[]> {
  const rows = await t.db.db.select({ action: adminAuditLog.action }).from(adminAuditLog);
  return rows.map((r) => r.action);
}

describe('step-up', () => {
  it('a wallet outside ADMIN_WALLETS gets 404 on the challenge and everywhere under /admin', async () => {
    const { token } = await t.login('RH', STRANGER);
    expect((await t.app.request('/admin/auth/challenge', { headers: authed(token) })).status).toBe(
      404,
    );
    expect((await t.app.request('/admin/me', { headers: authed(token) })).status).toBe(404);
    expect((await t.app.request('/admin/settings', { headers: authed(token) })).status).toBe(404);
    expect((await t.app.request('/admin/does-not-exist')).status).toBe(404);
    expect((await t.app.request('/admin/me')).status).toBe(404);
  });

  it('mints a 15-minute admin token after a fresh signature (EVM and Solana)', async () => {
    for (const [net, w] of [
      ['RH', OWNER],
      ['SOL', SOL_OWNER],
    ] as const) {
      const { admin } = await stepUp(net, w);
      const me = await json(await t.app.request('/admin/me', { headers: asAdmin(admin) }));
      expect(me['role']).toBe('owner');
      expect(me['net']).toBe(net);
      expect(me['tokenTtlSeconds']).toBe(900);
    }
    expect(await auditActions()).toEqual(['auth.step_up', 'auth.step_up']);
  });

  it('the normal access token is never accepted as an admin token, nor the reverse', async () => {
    const { admin, access } = await stepUp('RH', OWNER);
    expect((await t.app.request('/admin/me', { headers: authed(access) })).status).toBe(404);
    expect((await t.app.request('/me', { headers: authed(admin) })).status).toBe(401);
  });

  it('rejects a tampered message, a wrong signer and a replayed challenge', async () => {
    const { token } = await t.login('RH', OWNER);
    const challenge = (await (
      await t.app.request('/admin/auth/challenge', { headers: authed(token) })
    ).json()) as {
      message: string;
    };
    const post = (body: unknown) =>
      t.app.request('/admin/auth/verify', {
        method: 'POST',
        headers: { ...authed(token), 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    const tampered = challenge.message.replace('Expires At', 'Expires  At');
    expect((await post({ message: tampered, signature: OWNER.sign(tampered) })).status).toBe(400);
    expect(
      (await post({ message: challenge.message, signature: STRANGER.sign(challenge.message) }))
        .status,
    ).toBe(400);
    expect(
      (await post({ message: challenge.message, signature: OWNER.sign(challenge.message) })).status,
    ).toBe(200);
    const replay = await post({
      message: challenge.message,
      signature: OWNER.sign(challenge.message),
    });
    expect(replay.status).toBe(400);
    expect((await json(replay))['error']).toBe('challenge_used');
  });

  it('expires the challenge after five minutes', async () => {
    const { token } = await t.login('RH', OWNER);
    const challenge = (await (
      await t.app.request('/admin/auth/challenge', { headers: authed(token) })
    ).json()) as {
      message: string;
    };
    t.advance(5 * 60_000 + 1);
    const res = await t.app.request('/admin/auth/verify', {
      method: 'POST',
      headers: { ...authed(token), 'content-type': 'application/json' },
      body: JSON.stringify({
        message: challenge.message,
        signature: OWNER.sign(challenge.message),
      }),
    });
    expect(res.status).toBe(400);
    expect((await json(res))['error']).toBe('challenge_expired');
    t.advance(-(5 * 60_000 + 1));
  });

  it('the admin token dies after 15 minutes and on logout', async () => {
    const { admin } = await stepUp('RH', OWNER);
    t.advance(16 * 60_000);
    expect((await t.app.request('/admin/me', { headers: asAdmin(admin) })).status).toBe(404);
    t.advance(-16 * 60_000);
    expect((await t.app.request('/admin/me', { headers: asAdmin(admin) })).status).toBe(200);
    expect(
      (await t.app.request('/admin/auth/logout', { method: 'POST', headers: asAdmin(admin) }))
        .status,
    ).toBe(200);
    expect((await t.app.request('/admin/me', { headers: asAdmin(admin) })).status).toBe(404);
  });

  it('rate-limits the auth endpoints hard (10/min per wallet)', async () => {
    const { token } = await t.login('RH', OWNER);
    let last = 200;
    for (let i = 0; i < 11; i++) {
      last = (await t.app.request('/admin/auth/challenge', { headers: authed(token) })).status;
    }
    expect(last).toBe(429);
  });

  it('honours ADMIN_IP_ALLOWLIST with a 404, not a 403', async () => {
    const gated = await createTestApp({
      env: { ADMIN_WALLETS: OWNER.address, ADMIN_IP_ALLOWLIST: '10.0.0.0/8,203.0.113.7' },
    });
    try {
      const { token } = await gated.login('RH', OWNER);
      const from = (ip: string): Record<string, string> => ({
        ...authed(token),
        'x-forwarded-for': ip,
      });
      expect(
        (await gated.app.request('/admin/auth/challenge', { headers: from('198.51.100.9') }))
          .status,
      ).toBe(404);
      expect(
        (await gated.app.request('/admin/auth/challenge', { headers: from('10.20.30.40') })).status,
      ).toBe(200);
      expect(
        (await gated.app.request('/admin/auth/challenge', { headers: from('203.0.113.7') })).status,
      ).toBe(200);
      expect(
        (await gated.app.request('/admin/auth/challenge', { headers: authed(token) })).status,
      ).toBe(404);
    } finally {
      await gated.close();
    }
  });
});

describe('roles', () => {
  it('owner grants a moderator; the moderator is refused owner/admin routes with 403 and revoked back to 404', async () => {
    const { admin: owner } = await stepUp('RH', OWNER);
    const { token: modAccess } = await t.login('RH', MOD);
    expect(
      (await t.app.request('/admin/auth/challenge', { headers: authed(modAccess) })).status,
    ).toBe(404);

    const grant = await t.app.request(`/admin/access/roles/${MOD.address}`, {
      method: 'PUT',
      headers: asAdmin(owner),
      body: JSON.stringify({ role: 'moderator', note: 'community lead' }),
    });
    expect(grant.status).toBe(200);
    const { admin: mod } = await stepUp('RH', MOD);
    expect((await json(await t.app.request('/admin/me', { headers: asAdmin(mod) })))['role']).toBe(
      'moderator',
    );
    // viewer-level read is fine; admin-level write is a 403 with a reason; owner-level is 403 too.
    expect((await t.app.request('/admin/settings', { headers: asAdmin(mod) })).status).toBe(200);
    const denied = await t.app.request('/admin/settings/features.chat', {
      method: 'PUT',
      headers: asAdmin(mod),
      body: JSON.stringify({ value: false }),
    });
    expect(denied.status).toBe(403);
    expect(
      (
        await t.app.request(`/admin/access/roles/${STRANGER.address}`, {
          method: 'PUT',
          headers: asAdmin(mod),
          body: JSON.stringify({ role: 'viewer' }),
        })
      ).status,
    ).toBe(403);
    // moderators may moderate.
    const ban = await t.app.request(`/admin/users/RH/${STRANGER.address}/moderation`, {
      method: 'PUT',
      headers: asAdmin(mod),
      body: JSON.stringify({ chatBanned: true, reason: 'spam' }),
    });
    expect(ban.status).toBe(200);

    const roles = (
      await json(await t.app.request('/admin/access/roles', { headers: asAdmin(owner) }))
    )['roles'] as { wallet: string; role: string; source: string }[];
    expect(roles.find((r) => r.wallet === MOD.address.toLowerCase())).toMatchObject({
      role: 'moderator',
      source: 'db',
    });
    expect(roles.find((r) => r.wallet === OWNER.address.toLowerCase())).toMatchObject({
      role: 'owner',
      source: 'env',
    });

    // A mod cannot grant themself owner; the owner revokes and the token is dead on the next call.
    expect(
      (
        await t.app.request(`/admin/access/roles/${MOD.address}`, {
          method: 'DELETE',
          headers: asAdmin(owner),
        })
      ).status,
    ).toBe(200);
    expect((await t.app.request('/admin/me', { headers: asAdmin(mod) })).status).toBe(404);
    // Env owners cannot be revoked through the API.
    expect(
      (
        await t.app.request(`/admin/access/roles/${OWNER.address}`, {
          method: 'DELETE',
          headers: asAdmin(owner),
        })
      ).status,
    ).toBe(409);

    expect(await auditActions()).toEqual(
      expect.arrayContaining(['access.grant', 'user.moderation', 'access.revoke']),
    );
  });
});

describe('TOTP', () => {
  it('enrol → confirm forces re-auth, then every step-up needs a code and refuses replays', async () => {
    const { admin } = await stepUp('RH', OWNER);
    const enrol = await json(
      await t.app.request('/admin/totp/enrol', { method: 'POST', headers: asAdmin(admin) }),
    );
    const secret = enrol['secret'] as string;
    expect(enrol['otpauth']).toContain(secret);

    expect(
      (
        await t.app.request('/admin/totp/confirm', {
          method: 'POST',
          headers: asAdmin(admin),
          body: JSON.stringify({ code: '000000' }),
        })
      ).status,
    ).toBe(400);
    const ok = await t.app.request('/admin/totp/confirm', {
      method: 'POST',
      headers: asAdmin(admin),
      body: JSON.stringify({ code: totp(secret, t.now()) }),
    });
    expect(ok.status).toBe(200);
    // The pre-MFA token is revoked on confirmation.
    expect((await t.app.request('/admin/me', { headers: asAdmin(admin) })).status).toBe(404);

    await t.clearRateLimits();
    await expect(stepUp('RH', OWNER)).rejects.toThrow(/totp_required/);
    await expect(stepUp('RH', OWNER, '123456')).rejects.toThrow(/bad_totp/);
    await t.clearRateLimits();
    const code = totp(secret, t.now());
    const { admin: mfa } = await stepUp('RH', OWNER, code);
    const me = await json(await t.app.request('/admin/me', { headers: asAdmin(mfa) }));
    expect(me['mfa']).toBe(true);
    expect(me['totpEnabled']).toBe(true);
    // Same code inside the same step is a replay.
    await expect(stepUp('RH', OWNER, code)).rejects.toThrow(/bad_totp/);

    // Disabling needs a live code too.
    t.advance(31_000);
    expect(
      (
        await t.app.request('/admin/totp/disable', {
          method: 'POST',
          headers: asAdmin(mfa),
          body: JSON.stringify({ code: '000000' }),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await t.app.request('/admin/totp/disable', {
          method: 'POST',
          headers: asAdmin(mfa),
          body: JSON.stringify({ code: totp(secret, t.now()) }),
        })
      ).status,
    ).toBe(200);
    t.advance(-31_000);
    await t.clearRateLimits();
    const { admin: again } = await stepUp('RH', OWNER);
    expect((await t.app.request('/admin/me', { headers: asAdmin(again) })).status).toBe(200);
    expect(await auditActions()).toEqual(
      expect.arrayContaining(['totp.enrol_started', 'totp.enabled', 'totp.disabled']),
    );
  });
});

describe('settings + audit', () => {
  it('writes an audit row with before/after for every mutation and exposes it with filters and CSV', async () => {
    const { admin } = await stepUp('RH', OWNER);
    const put = await t.app.request('/admin/settings/features.launch.RH', {
      method: 'PUT',
      headers: asAdmin(admin),
      body: JSON.stringify({ value: false }),
    });
    expect(put.status).toBe(200);
    expect(await json(put)).toMatchObject({ before: true, after: false });
    expect(
      (
        await t.app.request('/admin/settings/nope', {
          method: 'PUT',
          headers: asAdmin(admin),
          body: JSON.stringify({ value: 1 }),
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await t.app.request('/admin/settings/limits.chat.limit', {
          method: 'PUT',
          headers: asAdmin(admin),
          body: JSON.stringify({ value: 'x' }),
        })
      ).status,
    ).toBe(400);

    const listing = (
      await json(await t.app.request('/admin/settings', { headers: asAdmin(admin) }))
    )['settings'] as { key: string; value: unknown; overridden: boolean; wired: boolean }[];
    expect(listing.find((s) => s.key === 'features.launch.RH')).toMatchObject({
      value: false,
      overridden: true,
      wired: true,
    });

    const audit = (
      await json(
        await t.app.request('/admin/audit?action=settings.set', { headers: asAdmin(admin) }),
      )
    )['rows'] as Record<string, unknown>[];
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actor: OWNER.address.toLowerCase(),
      role: 'owner',
      action: 'settings.set',
      target: 'features.launch.RH',
      before: { value: true },
      after: { value: false },
      ok: true,
    });
    const csv = await t.app.request('/admin/audit.csv', { headers: asAdmin(admin) });
    expect(csv.headers.get('content-type')).toContain('text/csv');
    const text = await csv.text();
    expect(text.split('\r\n')[0]).toBe(
      'id,at,actor,actor_net,role,action,target,before,after,ip,request_id,ok',
    );
    expect(text).toContain('settings.set');

    // The log is append-only at the database (drizzle wraps the trigger's message in its own).
    await expect(
      t.db.db.delete(adminAuditLog).where(eq(adminAuditLog.action, 'settings.set')),
    ).rejects.toThrow();
    await expect(t.db.db.update(adminAuditLog).set({ ok: false })).rejects.toThrow();
    expect(await auditActions()).toContain('settings.set');
  });

  it('every mutating admin route leaves an audit row', async () => {
    const { admin } = await stepUp('RH', OWNER);
    const target = STRANGER.address;
    const calls: [string, string, unknown][] = [
      ['PUT', `/admin/users/RH/${target}/moderation`, { launchBanned: true, reason: 'test' }],
      ['POST', `/admin/users/RH/${target}/grant`, { asset: 'SP', delta: 50, reason: 'test' }],
      [
        'POST',
        `/admin/users/RH/${target}/grant`,
        { asset: 'CRATE', tier: 'BRONZE', delta: 1, reason: 'test' },
      ],
      [
        'POST',
        `/admin/users/RH/${target}/sessions/revoke`,
        { confirm: `REVOKE ${target.slice(0, 6)}` },
      ],
      ['PUT', '/admin/comms/banner', { text: 'DOWN AT 22:00', severity: 'warn' }],
      ['POST', '/admin/notices', { kind: 'notice', net: 'RH', text: 'RH RPC slow' }],
      ['POST', '/admin/comms/announce', { net: 'RH', text: 'gm', confirm: 'ANNOUNCE' }],
      ['POST', '/admin/indexer/reindex', { net: 'RH', from: 10, to: 20, confirm: 'REINDEX RH' }],
      ['POST', '/admin/indexer/cursors/RH', { position: 5, confirm: 'SET CURSOR RH' }],
      ['DELETE', '/admin/settings/features.launch.RH', undefined],
    ];
    for (const [method, path, body] of calls) {
      const init: RequestInit = { method, headers: asAdmin(admin) };
      if (body) init.body = JSON.stringify(body);
      const res = await t.app.request(path, init);
      expect(res.status, `${method} ${path}: ${await res.clone().text()}`).toBe(200);
    }
    const actions = await auditActions();
    expect(actions).toEqual(
      expect.arrayContaining([
        'user.moderation',
        'user.grant_sp',
        'user.grant_crate',
        'user.revoke_sessions',
        'comms.banner',
        'comms.notice_create',
        'comms.announce',
        'indexer.reindex_range',
        'indexer.set_cursor',
        'settings.reset',
      ]),
    );
    // Destructive actions demand the typed confirmation.
    expect(
      (
        await t.app.request('/admin/indexer/reindex', {
          method: 'POST',
          headers: asAdmin(admin),
          body: JSON.stringify({ net: 'RH', from: 1, to: 2 }),
        })
      ).status,
    ).toBe(400);
    // The public status endpoint reflects the banner and notice.
    const status = await json(await t.app.request('/platform/status?net=RH'));
    expect(status['banner']).toEqual({ text: 'DOWN AT 22:00', severity: 'warn' });
    expect((status['notices'] as unknown[]).length).toBe(1);
    // Mememan's line landed in GLOBAL and was published.
    const history = await json(await t.app.request('/chat/RH/GLOBAL/history'));
    expect(
      (history['messages'] as { wallet: string; text: string }[]).some(
        (m) => m.wallet === 'MEMEMAN' && m.text === 'gm',
      ),
    ).toBe(true);
  });
});

describe('enforcement at the integration points', () => {
  it('a launch/trade/comments ban and the per-net feature flags are enforced on the public routes', async () => {
    const { admin } = await stepUp('RH', OWNER);
    const { token: userToken, address } = await t.login('RH', STRANGER);
    const post = (path: string, body: unknown = {}) =>
      t.app.request(path, {
        method: 'POST',
        headers: { ...authed(userToken), 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

    // Before any ban: prepare fails on validation (4xx that is not 403), never as banned.
    expect((await post('/trade/prepare')).status).not.toBe(403);

    const ban = await t.app.request(`/admin/users/RH/${address}/moderation`, {
      method: 'PUT',
      headers: asAdmin(admin),
      body: JSON.stringify({
        launchBanned: true,
        tradeBanned: true,
        commentsBanned: true,
        chatBanned: true,
        reason: 'wash trading',
      }),
    });
    expect(ban.status).toBe(200);
    for (const path of ['/launch/prepare', '/trade/prepare', `/wall/RH/${OWNER.address}`]) {
      const res = await post(path);
      expect(res.status, path).toBe(403);
      expect((await json(res))['error']).toBe('banned');
    }
    const chat = await post('/chat/RH/GLOBAL', { text: 'hello' });
    expect((await json(chat))['error']).toBe('banned');

    // A ban with an `until` in the past is no ban.
    await t.app.request(`/admin/users/RH/${address}/moderation`, {
      method: 'PUT',
      headers: asAdmin(admin),
      body: JSON.stringify({ reason: 'expired', untilMs: t.now() - 1000 }),
    });
    expect((await post('/trade/prepare')).status).not.toBe(403);

    // Feature flag: trading off on RH only.
    await t.app.request('/admin/settings/features.trading.RH', {
      method: 'PUT',
      headers: asAdmin(admin),
      body: JSON.stringify({ value: false }),
    });
    const off = await post('/trade/prepare');
    expect(off.status).toBe(503);
    expect((await json(off))['error']).toBe('feature_disabled');
    await t.app.request('/admin/settings/features.launch.RH', {
      method: 'PUT',
      headers: asAdmin(admin),
      body: JSON.stringify({ value: false }),
    });
    expect((await post('/launch/prepare')).status).toBe(503);
    const { token: solToken } = await t.login('SOL');
    const solTrade = await t.app.request('/trade/prepare', {
      method: 'POST',
      headers: { ...authed(solToken), 'content-type': 'application/json' },
      body: '{}',
    });
    expect(solTrade.status).not.toBe(503);
    // Chat off globally.
    await t.app.request('/admin/settings/features.chat', {
      method: 'PUT',
      headers: asAdmin(admin),
      body: JSON.stringify({ value: false }),
    });
    expect((await json(await post('/chat/RH/GLOBAL', { text: 'hello' })))['error']).toBe(
      'chat_disabled',
    );
  });

  it('shadow-mute persists the message flagged and the admin word list flags matches', async () => {
    const { admin } = await stepUp('RH', OWNER);
    const wallet = STRANGER.address;
    await t.app.request(`/admin/users/RH/${wallet}/moderation`, {
      method: 'PUT',
      headers: asAdmin(admin),
      body: JSON.stringify({ shadowMuted: true, reason: 'bot' }),
    });
    await t.app.request('/admin/settings/moderation.words', {
      method: 'PUT',
      headers: asAdmin(admin),
      body: JSON.stringify({ value: ['rugpull'] }),
    });
    const chat = new ChatService({
      db: t.db.db,
      redis: t.redis,
      now: t.now,
      volumeGateUsd: 0,
      settings: t.deps.admin.settings,
      moderation: t.deps.admin.gate,
    });
    const muted = await chat.send('RH', 'GLOBAL', wallet, 'totally fine message');
    expect(muted.ok).toBe(true);
    expect(muted.message?.flagged).toBe(true);
    const clean = await chat.send('RH', 'GLOBAL', OWNER.address, 'gm frens');
    expect(clean.message?.flagged).toBe(false);
    const word = await chat.send('RH', 'GLOBAL', OWNER.address, 'this is a R.U.G.P.U.L.L');
    expect(word.message?.flagged).toBe(true);
    expect((await chat.history('RH', 'GLOBAL')).map((m) => m.text)).toEqual(['gm frens']);
  });

  it('admin-managed launch words reach the launch moderation stub', async () => {
    const { moderateLaunch } = await import('../router/moderation.js');
    expect(moderateLaunch({ name: 'Honest Coin', ticker: 'HON', descr: '' }, ['honest']).ok).toBe(
      false,
    );
    expect(moderateLaunch({ name: 'Honest Coin', ticker: 'HON', descr: '' }).ok).toBe(true);
  });

  it('hidden tokens leave the public board and a KOTH pin replaces the crown', async () => {
    const { admin } = await stepUp('RH', OWNER);
    const base = {
      net: 'RH',
      creator: OWNER.address,
      baseSymbol: 'WETH',
      baseMint: '0x4200000000000000000000000000000000000006',
      supply: 1e9,
      feeBps: 100,
      seed: 1,
      lane: 'new',
    };
    await t.db.db.insert(tokens).values([
      {
        ...base,
        sym: 'AAA',
        name: 'Aaa',
        mint: '0x00000000000000000000000000000000000000a1',
        mc: 1000,
      },
      {
        ...base,
        sym: 'BBB',
        name: 'Bbb',
        mint: '0x00000000000000000000000000000000000000b2',
        mc: 500,
      },
    ]);
    const before = await json(await t.app.request('/tokens?net=RH'));
    expect((before['tokens'] as { sym: string }[]).map((x) => x.sym).sort()).toEqual([
      'AAA',
      'BBB',
    ]);

    const noConfirm = await t.app.request(
      '/admin/tokens/RH/0x00000000000000000000000000000000000000a1/moderation',
      {
        method: 'PUT',
        headers: asAdmin(admin),
        body: JSON.stringify({ hidden: true, reason: 'rug' }),
      },
    );
    expect(noConfirm.status).toBe(400);
    const hide = await t.app.request(
      '/admin/tokens/RH/0x00000000000000000000000000000000000000a1/moderation',
      {
        method: 'PUT',
        headers: asAdmin(admin),
        body: JSON.stringify({ hidden: true, reason: 'rug', confirm: 'HIDE AAA' }),
      },
    );
    expect(hide.status).toBe(200);
    const after = await json(await t.app.request('/tokens?net=RH'));
    expect((after['tokens'] as { sym: string }[]).map((x) => x.sym)).toEqual(['BBB']);
    // Still visible to admins, flagged.
    const adminList = await json(
      await t.app.request('/admin/tokens?net=RH', { headers: asAdmin(admin) }),
    );
    expect(
      (adminList['tokens'] as { sym: string; hidden: boolean }[]).find((x) => x.sym === 'AAA')
        ?.hidden,
    ).toBe(true);

    // KOTH pin.
    const pin = await t.app.request(
      '/admin/tokens/RH/0x00000000000000000000000000000000000000b2/moderation',
      {
        method: 'PUT',
        headers: asAdmin(admin),
        body: JSON.stringify({ kothOverride: true, reason: 'feature week' }),
      },
    );
    expect(pin.status).toBe(200);
    const koth = await json(await t.app.request('/koth?net=RH'));
    expect((koth['kings'] as { sym: string }[]).map((k) => k.sym)).toEqual(['BBB']);
    const rows = await t.db.db.select().from(tokenModeration);
    expect(rows.filter((r) => r.kothOverride)).toHaveLength(1);

    // Metadata edit with reason, audited with before/after.
    const edit = await t.app.request(
      '/admin/tokens/RH/0x00000000000000000000000000000000000000b2/metadata',
      {
        method: 'PATCH',
        headers: asAdmin(admin),
        body: JSON.stringify({
          name: 'Bee Bee Bee',
          website: 'javascript:alert(1)',
          reason: 'typo',
        }),
      },
    );
    expect(edit.status).toBe(400);
    const edit2 = await t.app.request(
      '/admin/tokens/RH/0x00000000000000000000000000000000000000b2/metadata',
      {
        method: 'PATCH',
        headers: asAdmin(admin),
        body: JSON.stringify({ name: 'Bee Bee Bee', reason: 'typo' }),
      },
    );
    expect(await json(edit2)).toMatchObject({
      before: { name: 'Bbb' },
      after: { name: 'Bee Bee Bee' },
    });
    expect(await auditActions()).toEqual(
      expect.arrayContaining(['token.moderation', 'token.metadata']),
    );
  });

  it('users view and grants change balances and inventory', async () => {
    const { admin } = await stepUp('RH', OWNER);
    const { address } = await t.login('RH', STRANGER);
    await t.app.request(`/admin/users/RH/${address}/grant`, {
      method: 'POST',
      headers: asAdmin(admin),
      body: JSON.stringify({ asset: 'SP', delta: 120, reason: 'contest' }),
    });
    const claw = await t.app.request(`/admin/users/RH/${address}/grant`, {
      method: 'POST',
      headers: asAdmin(admin),
      body: JSON.stringify({ asset: 'SP', delta: -500, reason: 'clawback' }),
    });
    expect(claw.status, await claw.clone().text()).toBe(200);
    await t.app.request(`/admin/users/RH/${address}/grant`, {
      method: 'POST',
      headers: asAdmin(admin),
      body: JSON.stringify({ asset: 'CRATE', tier: 'GOLD', delta: 2, reason: 'contest' }),
    });
    const view = await json(
      await t.app.request(`/admin/users/RH/${address}`, { headers: asAdmin(admin) }),
    );
    expect(view['balances']).toMatchObject({ sp: 0 });
    expect(view['crates']).toEqual(expect.arrayContaining([{ tier: 'GOLD', count: 2 }]));
    expect((view['ledger'] as { reason: string }[]).map((l) => l.reason)).toEqual(
      expect.arrayContaining(['admin:grant', 'admin:revoke']),
    );
    expect((view['sessions'] as unknown[]).length).toBe(1);
    const search = await json(
      await t.app.request(`/admin/users?q=${address.slice(0, 8)}`, { headers: asAdmin(admin) }),
    );
    expect((search['users'] as { wallet: string }[]).some((u) => u.wallet === address)).toBe(true);
    // Revoke the session: refresh dies.
    const { refreshToken } = await t.login('RH', STRANGER);
    await t.app.request(`/admin/users/RH/${address}/sessions/revoke`, {
      method: 'POST',
      headers: asAdmin(admin),
      body: JSON.stringify({ confirm: `REVOKE ${address.slice(0, 6)}` }),
    });
    const refresh = await t.app.request('/auth/refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });
    expect(refresh.status).toBe(401);
  });
});

describe('chain ops', () => {
  it('prepares EVM calldata + Safe JSON and Solana transactions, gated by role and confirmation', async () => {
    const { admin } = await stepUp('RH', OWNER);
    const prep = (net: string, body: unknown) =>
      t.app.request(`/admin/chain/prepare/${net}`, {
        method: 'POST',
        headers: asAdmin(admin),
        body: JSON.stringify(body),
      });
    const res = await prep('SOL', {
      action: { kind: 'set_pause', trading: true },
      signer: SOL_OWNER.address,
      confirm: 'PREPARE set_pause',
    });
    expect(res.status, await res.clone().text()).toBe(200);
    const body = await json(res);
    expect((body['tx'] as { transaction: string; signer: string }).signer).toBe('admin');
    expect(typeof (body['tx'] as { transaction: string }).transaction).toBe('string');
    expect(
      (await prep('SOL', { action: { kind: 'set_pause' }, signer: SOL_OWNER.address })).status,
    ).toBe(400);
    const state = await json(
      await t.app.request('/admin/chain/state', { headers: asAdmin(admin) }),
    );
    expect((state['nets'] as { net: string }[]).map((n) => n.net).sort()).toEqual([
      'ARC',
      'BASE',
      'RH',
      'SOL',
    ]);
    expect(await auditActions()).toContain('chain.prepare');

    // A moderator may not prepare; an admin (non-owner) may not withdraw.
    await t.app.request(`/admin/access/roles/${MOD.address}`, {
      method: 'PUT',
      headers: asAdmin(admin),
      body: JSON.stringify({ role: 'admin' }),
    });
    const { admin: plainAdmin } = await stepUp('RH', MOD);
    const withdraw = await t.app.request('/admin/chain/prepare/SOL', {
      method: 'POST',
      headers: asAdmin(plainAdmin),
      body: JSON.stringify({
        action: {
          kind: 'withdraw_treasury',
          which: 1,
          baseMint: SOL_OWNER.address,
          amountAtoms: '1',
          to: SOL_OWNER.address,
        },
        signer: SOL_OWNER.address,
        confirm: 'PREPARE withdraw_treasury',
      }),
    });
    expect(withdraw.status).toBe(403);
  });

  it('serves a dashboard with per-net lag, metrics and alerts', async () => {
    const { admin } = await stepUp('RH', OWNER);
    await t.app.request('/admin/settings/features.trading.BASE', {
      method: 'PUT',
      headers: asAdmin(admin),
      body: JSON.stringify({ value: false }),
    });
    const dash = await json(await t.app.request('/admin/dashboard', { headers: asAdmin(admin) }));
    expect(Object.keys(dash['chains'] as object).sort()).toEqual(['ARC', 'BASE', 'RH', 'SOL']);
    expect((dash['alerts'] as { key: string }[]).some((a) => a.key === 'trading-off:BASE')).toBe(
      true,
    );
    expect(dash['ws']).toBeDefined();
    expect((dash['stats'] as { today: object }).today).toBeDefined();
  });
});
