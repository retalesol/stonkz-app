import { Hono, type Context } from 'hono';
import { ALL_NETS } from '@stonkz/shared';
import {
  adminClientIp,
  ipAllowed,
  requireAdmin,
  audited,
  type AdminEnv,
} from '../admin/middleware.js';
import { auditToCsv } from '../admin/audit.js';
import { bad, int, netParam, num, readBody, str } from '../admin/http.js';
import { isAdminRole, normaliseAdminAddress } from '../admin/roles.js';
import { AdminAuthError } from '../admin/service.js';
import { limit, requireAuth } from '../app/middleware.js';
import type { AppEnv } from '../app/context.js';
import { isNetDeployed } from './health.js';
import { adminChainRoutes } from './admin-chain.js';
import { adminCommsRoutes } from './admin-comms.js';
import { adminDashboardRoutes } from './admin-dashboard.js';
import { adminSettingsRoutes } from './admin-settings.js';
import { adminTokenRoutes } from './admin-tokens.js';
import { adminUserRoutes } from './admin-users.js';

/**
 * `/admin/*` — the admin panel's API.
 *
 * Two layers of auth:
 *
 * - `/admin/auth/challenge` and `/admin/auth/verify` take the caller's normal
 *   SIWS/SIWE access token (`requireAuth`) and, for a wallet that holds a
 *   role, run the step-up ceremony (`admin/service.ts`) that mints the
 *   15-minute admin token. Anyone else sees a 404 — the same 404 as an unknown
 *   route, so the panel's existence is not enumerable.
 * - Everything else under `/admin/*` demands that admin token via
 *   `requireAdmin(role)` (`admin/middleware.ts`), which re-checks the role on
 *   every call and enforces TOTP once enrolled.
 *
 * Every mutating route writes an `admin_audit_log` row through `audited()`.
 */
const ADMIN_AUTH_LIMIT = { bucket: 'admin_auth', limit: 10, windowSeconds: 60 } as const;

const NOT_FOUND = { error: 'not_found' } as const;

function authErrorResponse(c: Context<AppEnv>, err: unknown): Response {
  if (err instanceof AdminAuthError) {
    if (err.code === 'not_admin') return c.json(NOT_FOUND, 404);
    if (err.code === 'totp_required' || err.code === 'bad_totp') {
      return c.json({ error: err.code, detail: err.message }, 401);
    }
    return c.json({ error: err.code, detail: err.message }, 400);
  }
  throw err;
}

function stepUpRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get('/admin/auth/challenge', requireAuth(), limit(ADMIN_AUTH_LIMIT), async (c) => {
    const deps = c.get('deps');
    const user = c.get('user');
    if (!user) return c.json(NOT_FOUND, 404);
    if (
      !ipAllowed(adminClientIp(c.req.header('X-Forwarded-For'), deps), deps.env.adminIpAllowlist)
    ) {
      return c.json(NOT_FOUND, 404);
    }
    try {
      const challenge = await deps.admin.auth.issueChallenge(user.net, user.wallet);
      return c.json({ net: user.net, wallet: user.wallet, ...challenge });
    } catch (err) {
      return authErrorResponse(c, err);
    }
  });

  app.post('/admin/auth/verify', requireAuth(), limit(ADMIN_AUTH_LIMIT), async (c) => {
    const deps = c.get('deps');
    const user = c.get('user');
    if (!user) return c.json(NOT_FOUND, 404);
    const ip = adminClientIp(c.req.header('X-Forwarded-For'), deps);
    if (!ipAllowed(ip, deps.env.adminIpAllowlist)) return c.json(NOT_FOUND, 404);
    const body = await readBody(c);
    const message = typeof body['message'] === 'string' ? body['message'] : '';
    const signature = str(body['signature'], 4096);
    if (!message || !signature) return c.json(NOT_FOUND, 404);
    const totp = str(body['totp'], 16);
    try {
      const result = await deps.admin.auth.stepUp({
        net: user.net,
        wallet: user.wallet,
        message,
        signature,
        totp,
      });
      await deps.admin.audit.record({
        actor: normaliseAdminAddress(user.wallet),
        actorNet: user.net,
        role: result.role,
        action: 'auth.step_up',
        target: null,
        after: { mfa: result.mfa, expiresAt: result.expiresAt },
        ip,
        requestId: c.get('requestId'),
      });
      return c.json({
        adminToken: result.token,
        expiresAt: result.expiresAt,
        role: result.role,
        mfa: result.mfa,
        wallet: user.wallet,
        net: user.net,
      });
    } catch (err) {
      if (err instanceof AdminAuthError && err.code !== 'not_admin') {
        await deps.admin.audit.record({
          actor: normaliseAdminAddress(user.wallet),
          actorNet: user.net,
          role: 'unknown',
          action: 'auth.step_up',
          target: null,
          after: { error: err.code },
          ip,
          requestId: c.get('requestId'),
          ok: false,
        });
      }
      return authErrorResponse(c, err);
    }
  });

  return app;
}

function sessionRoutes(): Hono<AdminEnv> {
  const app = new Hono<AdminEnv>();

  app.get('/admin/me', requireAdmin('viewer'), async (c) => {
    const deps = c.get('deps');
    const actor = c.get('admin');
    return c.json({
      address: actor.address,
      net: actor.net,
      role: actor.role,
      mfa: actor.mfa,
      totpEnabled: await deps.admin.auth.totpEnabled(actor.address),
      tokenTtlSeconds: deps.env.adminTokenTtlSeconds,
      nets: ALL_NETS.map((net) => ({ net, deployed: isNetDeployed(deps.env, net) })),
      env: deps.env.nodeEnv,
    });
  });

  app.post('/admin/auth/logout', requireAdmin('viewer'), async (c) => {
    const deps = c.get('deps');
    await deps.admin.tokens.revoke(c.get('admin').jti);
    await audited(c, 'auth.logout', null, null, null);
    return c.json({ ok: true });
  });

  /* ------------------------------------------------------------------ TOTP */

  app.post('/admin/totp/enrol', requireAdmin('viewer'), async (c) => {
    const deps = c.get('deps');
    try {
      const out = await deps.admin.auth.beginTotpEnrolment(c.get('admin').address);
      await audited(c, 'totp.enrol_started', null, null, null);
      return c.json(out);
    } catch (err) {
      if (err instanceof AdminAuthError)
        return c.json({ error: err.code, detail: err.message }, 409);
      throw err;
    }
  });

  app.post('/admin/totp/confirm', requireAdmin('viewer'), async (c) => {
    const deps = c.get('deps');
    const code = str((await readBody(c))['code'], 16) ?? '';
    try {
      await deps.admin.auth.confirmTotpEnrolment(c.get('admin').address, code);
      await audited(c, 'totp.enabled', null, { enabled: false }, { enabled: true });
      // The current token was minted without MFA; the admin re-steps-up with a code.
      await deps.admin.tokens.revoke(c.get('admin').jti);
      return c.json({ ok: true, reauth: true });
    } catch (err) {
      if (err instanceof AdminAuthError)
        return c.json({ error: err.code, detail: err.message }, 400);
      throw err;
    }
  });

  app.post('/admin/totp/disable', requireAdmin('viewer'), async (c) => {
    const deps = c.get('deps');
    const code = str((await readBody(c))['code'], 16) ?? '';
    try {
      await deps.admin.auth.disableTotp(c.get('admin').address, code);
      await audited(c, 'totp.disabled', null, { enabled: true }, { enabled: false });
      return c.json({ ok: true });
    } catch (err) {
      if (err instanceof AdminAuthError)
        return c.json({ error: err.code, detail: err.message }, 400);
      throw err;
    }
  });

  /* ---------------------------------------------------------------- access */

  app.get('/admin/access/roles', requireAdmin('viewer'), async (c) => {
    const deps = c.get('deps');
    return c.json({ roles: await deps.admin.auth.listRoles() });
  });

  app.put('/admin/access/roles/:wallet', requireAdmin('owner'), async (c) => {
    const deps = c.get('deps');
    const wallet = c.req.param('wallet');
    const body = await readBody(c);
    const role = body['role'];
    if (!isAdminRole(role)) return bad(c, 'role must be owner | admin | moderator | viewer');
    if (!/^(0x[0-9a-fA-F]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$/.test(wallet))
      return bad(c, 'not a wallet address');
    const note = str(body['note'], 200) ?? null;
    const result = await deps.admin.auth.grantRole(wallet, role, c.get('admin').address, note);
    await audited(
      c,
      'access.grant',
      normaliseAdminAddress(wallet),
      { role: result.before },
      { role: result.after, note },
    );
    return c.json({ ok: true, wallet: normaliseAdminAddress(wallet), ...result });
  });

  app.delete('/admin/access/roles/:wallet', requireAdmin('owner'), async (c) => {
    const deps = c.get('deps');
    const wallet = c.req.param('wallet');
    try {
      const result = await deps.admin.auth.revokeRole(wallet);
      await audited(
        c,
        'access.revoke',
        normaliseAdminAddress(wallet),
        { role: result.before },
        { role: result.after },
      );
      return c.json({ ok: true, wallet: normaliseAdminAddress(wallet), ...result });
    } catch (err) {
      if (err instanceof AdminAuthError)
        return c.json({ error: err.code, detail: err.message }, 409);
      throw err;
    }
  });

  /* ----------------------------------------------------------------- audit */

  app.get('/admin/audit', requireAdmin('viewer'), async (c) => {
    const deps = c.get('deps');
    const q = c.req.query();
    const rows = await deps.admin.audit.list({
      actor: q['actor'] ? normaliseAdminAddress(q['actor']) : undefined,
      action: q['action'] || undefined,
      target: q['target'] || undefined,
      sinceMs: num(q['since']),
      untilMs: num(q['until']),
      beforeId: int(q['before']),
      limit: int(q['limit']),
    });
    return c.json({ rows, nextBefore: rows.length ? rows[rows.length - 1]?.id : null });
  });

  app.get('/admin/audit.csv', requireAdmin('viewer'), async (c) => {
    const deps = c.get('deps');
    const q = c.req.query();
    const rows = await deps.admin.audit.list({
      actor: q['actor'] ? normaliseAdminAddress(q['actor']) : undefined,
      action: q['action'] || undefined,
      target: q['target'] || undefined,
      sinceMs: num(q['since']),
      untilMs: num(q['until']),
      limit: 1000,
    });
    c.header('Content-Type', 'text/csv; charset=utf-8');
    c.header('Content-Disposition', `attachment; filename="stonkz-admin-audit-${Date.now()}.csv"`);
    return c.body(auditToCsv(rows));
  });

  return app;
}

export function adminRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.route('/', stepUpRoutes());
  app.route('/', sessionRoutes());
  app.route('/', adminDashboardRoutes());
  app.route('/', adminSettingsRoutes());
  app.route('/', adminUserRoutes());
  app.route('/', adminTokenRoutes());
  app.route('/', adminChainRoutes());
  app.route('/', adminCommsRoutes());
  // Anything else under /admin is indistinguishable from a route that does not exist.
  app.all('/admin/*', (c) => c.json(NOT_FOUND, 404));
  return app;
}

export { netParam };
