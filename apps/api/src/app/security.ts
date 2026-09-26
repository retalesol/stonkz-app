import type { MiddlewareHandler } from 'hono';

/**
 * The API's Content-Security-Policy.
 *
 * `frame-ancestors` can only travel as a real response header — the
 * `<meta http-equiv>` form is ignored by browsers — which is why the web shell
 * omits it and why it is set here. It applies to this origin's own responses;
 * the static host serving ston.kz must send its own copy for the app shell
 * (see apps/api/README.md).
 *
 * Everything else is locked to nothing: this origin only ever returns JSON, so
 * there is no legitimate script, style, image or frame for it to load.
 */
export const API_CSP = [
  "default-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  'sandbox',
].join('; ');

export interface SecurityHeaderOptions {
  /** HSTS is pointless (and harmful) over plain HTTP in local dev. */
  hsts?: boolean;
}

export function securityHeaders({ hsts = false }: SecurityHeaderOptions = {}): MiddlewareHandler {
  return async (c, next) => {
    await next();
    c.header('Content-Security-Policy', API_CSP);
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('X-Frame-Options', 'DENY');
    c.header('Referrer-Policy', 'no-referrer');
    c.header('Cross-Origin-Resource-Policy', 'same-site');
    c.header('Permissions-Policy', 'geolocation=(), camera=(), microphone=(), payment=()');
    if (hsts) c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  };
}

/**
 * CORS locked to ston.kz and localhost (plan step 41). Unknown origins get no
 * `Access-Control-Allow-Origin` at all rather than a wildcard, because these
 * endpoints are credentialed.
 */
export function cors(allowed: readonly string[]): MiddlewareHandler {
  const allowSet = new Set(allowed);
  return async (c, next) => {
    const origin = c.req.header('Origin');
    const permitted = origin !== undefined && allowSet.has(origin);

    if (permitted) {
      c.header('Access-Control-Allow-Origin', origin);
      c.header('Access-Control-Allow-Credentials', 'true');
      c.header('Vary', 'Origin');
    }

    if (c.req.method === 'OPTIONS') {
      if (!permitted) return c.body(null, 403);
      c.header('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
      c.header('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      c.header('Access-Control-Max-Age', '600');
      return c.body(null, 204);
    }

    // A browser request from a disallowed origin is rejected outright; a
    // server-side or same-origin call (no Origin header) is left alone.
    if (origin !== undefined && !permitted) {
      return c.json({ error: 'origin_not_allowed' }, 403);
    }
    await next();
    return undefined;
  };
}
