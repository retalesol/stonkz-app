import type { Context, MiddlewareHandler } from 'hono';
import type { Net } from '@stonkz/shared';
import type { AppDeps, AppVariables } from '../app/context.js';
import { resolveClientIp } from '../net/client-ip.js';
import type { AdminRole } from './roles.js';
import { roleAtLeast } from './roles.js';

/** Who is acting, as `requireAdmin` resolved it from the step-up token and the role store. */
export interface AdminActor {
  /** Normalised wallet address (see `roles.ts`). */
  address: string;
  net: Net;
  role: AdminRole;
  jti: string;
  mfa: boolean;
  ip: string | null;
}

export type AdminEnv = { Variables: AppVariables & { admin: AdminActor } };
export type AdminContext = Context<AdminEnv>;

/** Client IP under the same trusted-proxy rules the rate limiter uses. */
export function adminClientIp(forwardedFor: string | undefined, deps: AppDeps): string | null {
  return resolveClientIp(forwardedFor, deps.env.trustedProxyDepth);
}

/** `1.2.3.4`, `10.0.0.0/8` and `2001:db8::/32` entries; IPv6 only as an exact match or prefix. */
export function ipAllowed(ip: string | null, allowlist: readonly string[]): boolean {
  if (allowlist.length === 0) return true;
  if (!ip) return false;
  for (const entry of allowlist) {
    const [base, bitsRaw] = entry.split('/');
    if (!base) continue;
    if (bitsRaw === undefined) {
      if (ip === base) return true;
      continue;
    }
    const bits = Number.parseInt(bitsRaw, 10);
    if (ip.includes(':') || base.includes(':')) {
      // IPv6: compare the hextet prefix textually (good enough for /16…/64 style allowlists).
      if (
        ip.includes(':') === base.includes(':') &&
        ipv6Prefix(ip, bits) === ipv6Prefix(base, bits)
      )
        return true;
      continue;
    }
    const a = ipv4ToInt(ip);
    const b = ipv4ToInt(base);
    if (a === null || b === null || !Number.isInteger(bits) || bits < 0 || bits > 32) continue;
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    if ((a & mask) >>> 0 === (b & mask) >>> 0) return true;
  }
  return false;
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let out = 0;
  for (const p of parts) {
    const n = Number.parseInt(p, 10);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    out = ((out << 8) | n) >>> 0;
  }
  return out;
}

function ipv6Prefix(ip: string, bits: number): string {
  const groups = Math.max(0, Math.min(8, Math.floor(bits / 16)));
  return ip.toLowerCase().split(':').slice(0, groups).join(':');
}

const NOT_FOUND = { error: 'not_found' } as const;

/**
 * The single gate on `/admin/*`.
 *
 * Order matters and every refusal is a plain `404 not_found`, identical to an
 * unknown route, so an outsider cannot tell "no such endpoint" from "not an
 * admin" from "wrong role" — the one exception is a *valid* admin whose role is
 * too low, who gets a 403 they can act on.
 *
 * 1. IP allowlist (`ADMIN_IP_ALLOWLIST`), when configured.
 * 2. A live admin step-up token (`admin/token.ts`), never a normal access token.
 * 3. The address still holds a role at least `minRole` — re-read on every
 *    request, so a revoke lands before the 15-minute token expires.
 * 4. TOTP, when the admin has enrolled it, must have been part of the step-up.
 */
export function requireAdmin(minRole: AdminRole = 'viewer'): MiddlewareHandler<AdminEnv> {
  return async (c, next) => {
    const deps = c.get('deps');
    const ip = adminClientIp(c.req.header('X-Forwarded-For'), deps);
    if (!ipAllowed(ip, deps.env.adminIpAllowlist)) return c.json(NOT_FOUND, 404);

    const match = /^Bearer\s+(.+)$/i.exec(c.req.header('Authorization') ?? '');
    if (!match?.[1]) return c.json(NOT_FOUND, 404);

    let claims;
    try {
      claims = await deps.admin.tokens.verify(match[1]);
    } catch {
      return c.json(NOT_FOUND, 404);
    }

    const role = await deps.admin.auth.roleFor(claims.sub);
    if (!role) return c.json(NOT_FOUND, 404);
    if (!claims.mfa && (await deps.admin.auth.totpEnabled(claims.sub)))
      return c.json(NOT_FOUND, 404);
    if (!roleAtLeast(role, minRole)) {
      return c.json({ error: 'forbidden', detail: `requires the ${minRole} role` }, 403);
    }

    c.set('admin', {
      address: claims.sub,
      net: claims.net,
      role,
      jti: claims.jti,
      mfa: claims.mfa,
      ip,
    });
    await next();
    return undefined;
  };
}

/**
 * Writes the audit row for a mutating admin route. Call it *after* the change
 * so `before`/`after` are real; a thrown handler still records `ok: false`
 * through `auditFailure`.
 */
export async function audited(
  c: AdminContext,
  action: string,
  target: string | null,
  before: unknown,
  after: unknown,
  ok = true,
): Promise<number> {
  const deps = c.get('deps');
  const actor = c.get('admin');
  return deps.admin.audit.record({
    actor: actor.address,
    actorNet: actor.net,
    role: actor.role,
    action,
    target,
    before,
    after,
    ip: actor.ip,
    requestId: c.get('requestId'),
    ok,
  });
}
