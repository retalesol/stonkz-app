/**
 * `X-Forwarded-For` is `client, proxy1, proxy2, …` — each hop *appends* its
 * own observed connecting IP to the right as a request passes through it.
 * That means the header is only trustworthy from the right: anything a
 * client sends arrives as the *left* end of whatever the first trusted proxy
 * sees, so a client can prepend as many fake entries as it likes. The only
 * entries safe to trust are the last `trustedProxyDepth` ones, because those
 * are the ones our own infrastructure wrote — never the client.
 *
 * Confirmed for this deployment: Railway's edge proxy appends the real
 * connecting IP as a single extra hop and does not strip whatever a client
 * already sent (`apps/api/README.md`'s "Production deployment" table names
 * Railway as the intended host for both the API and the indexer). That is
 * exactly one trusted hop, hence `TRUSTED_PROXY_DEPTH` defaulting to `1` in
 * `env.ts` — a client that sends `X-Forwarded-For: 9.9.9.9, 8.8.8.8` still
 * only ever gets the real IP Railway appended, at the right end of the
 * chain, used as the rate-limit identity.
 */
export function resolveClientIp(
  forwardedFor: string | undefined | null,
  trustedProxyDepth: number,
): string | null {
  // No trusted proxy in front (e.g. reachable directly) means the header is
  // entirely client-controlled — never trust any of it.
  if (trustedProxyDepth <= 0) return null;
  if (!forwardedFor) return null;

  const hops = forwardedFor
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  // Fewer hops than the configured trusted depth means the chain doesn't
  // look like what this deployment's topology should produce (a
  // misconfigured edge, a direct hit that skipped the proxy, or similar).
  // Fail closed to "unknown" rather than guessing at a possibly
  // client-supplied entry.
  if (hops.length < trustedProxyDepth) return null;

  const ip = hops[hops.length - trustedProxyDepth];
  return ip || null;
}
