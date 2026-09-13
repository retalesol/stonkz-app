import type { FetchLike } from '../chain/types.js';

/**
 * Plan step 153: "GET /x/:handle — server X API v2 cache; empty state if no key."
 *
 * `HttpXProvider` speaks the real X API v2 when `X_BEARER_TOKEN` is set.
 * Without a token, `PlaceholderXProvider` returns an honest "unavailable"
 * miss — it never fabricates a found profile (that used to make the token
 * page claim every handle existed while still rendering mock posts).
 */
export type XProfileStatus = 'ok' | 'not_found' | 'suspended' | 'unavailable';

export interface XProfile {
  handle: string;
  displayName: string | null;
  avatarUrl: string | null;
  verified: boolean;
  found: boolean;
  /** Why the lookup succeeded or failed — drives the token-page empty states. */
  status: XProfileStatus;
  /** Short operator/user-facing reason when `found` is false. */
  reason?: string;
}

export interface XProvider {
  readonly source: 'x_api' | 'none';
  fetchProfile(handle: string): Promise<XProfile>;
}

export interface HttpXProviderOptions {
  bearerToken: string;
  baseUrl?: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

function miss(handle: string, status: Exclude<XProfileStatus, 'ok'>, reason: string): XProfile {
  return { handle, displayName: null, avatarUrl: null, verified: false, found: false, status, reason };
}

/** The real thing — only reachable when `X_BEARER_TOKEN` is configured. */
export class HttpXProvider implements XProvider {
  readonly source = 'x_api' as const;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  constructor(private readonly opts: HttpXProviderOptions) {
    this.baseUrl = opts.baseUrl ?? 'https://api.x.com/2';
    this.fetchImpl = opts.fetchImpl ?? ((u, i) => fetch(u, i));
    this.timeoutMs = opts.timeoutMs ?? 5000;
  }

  async fetchProfile(handle: string): Promise<XProfile> {
    const clean = handle.replace(/^@/, '').trim();
    if (!clean) return miss(handle, 'not_found', "Username doesn't exist");

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const url = `${this.baseUrl}/users/by/username/${encodeURIComponent(clean)}?user.fields=profile_image_url,verified`;
      const res = await this.fetchImpl(url, {
        headers: { authorization: `Bearer ${this.opts.bearerToken}` },
        signal: controller.signal,
      });

      if (res.status === 404) return miss(clean, 'not_found', "Username doesn't exist");

      const body = (await res.json().catch(() => ({}))) as {
        data?: { name?: string; profile_image_url?: string; verified?: boolean; protected?: boolean };
        errors?: Array<{ title?: string; detail?: string; type?: string; status?: number }>;
      };

      if (res.status === 402) {
        return miss(clean, 'unavailable', 'X API plan required for profile lookup');
      }

      if (res.status === 403 || res.status === 401) {
        const detail = (body.errors?.[0]?.detail || body.errors?.[0]?.title || '').toLowerCase();
        if (detail.includes('suspend') || detail.includes('banned') || detail.includes('forbidden')) {
          return miss(clean, 'suspended', 'User is banned or suspended');
        }
        return miss(clean, 'unavailable', 'X API refused this lookup');
      }

      if (!res.ok) {
        const detail = (body.errors?.[0]?.detail || '').toLowerCase();
        if (detail.includes('suspend') || detail.includes('banned')) {
          return miss(clean, 'suspended', 'User is banned or suspended');
        }
        return miss(clean, 'unavailable', `X API error (${res.status})`);
      }

      if (!body.data) {
        const errType = (body.errors?.[0]?.type || body.errors?.[0]?.title || '').toLowerCase();
        if (errType.includes('not found') || errType.includes('could not find')) {
          return miss(clean, 'not_found', "Username doesn't exist");
        }
        if (errType.includes('suspend') || errType.includes('banned')) {
          return miss(clean, 'suspended', 'User is banned or suspended');
        }
        return miss(clean, 'not_found', "Username doesn't exist");
      }

      return {
        handle: clean,
        displayName: body.data.name ?? null,
        avatarUrl: body.data.profile_image_url ?? null,
        verified: body.data.verified ?? false,
        found: true,
        status: 'ok',
      };
    } catch {
      return miss(clean, 'unavailable', 'X API unreachable');
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * No bearer token configured. Never invents a found profile — the UI must
 * show that X lookup is offline rather than claiming every handle exists.
 */
export class PlaceholderXProvider implements XProvider {
  readonly source = 'none' as const;

  async fetchProfile(handle: string): Promise<XProfile> {
    const clean = handle.replace(/^@/, '').trim();
    if (!clean) return miss(handle, 'not_found', "Username doesn't exist");
    return miss(
      clean,
      'unavailable',
      'X API not configured on this server',
    );
  }
}
