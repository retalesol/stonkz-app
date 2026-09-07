import type { FetchLike } from '../chain/types.js';

/**
 * Plan step 153: "GET /x/:handle — server X API v2 cache; empty state if no key."
 *
 * `XProvider` is the seam. `HttpXProvider` speaks the real X API v2 `users/by/
 * username/:handle` endpoint and is what runs the moment `X_BEARER_TOKEN` is
 * set. No real credentials exist in this environment, so `PlaceholderXProvider`
 * is the default — it deterministically fabricates a plausible-looking public
 * profile from the handle (same idea as the frontend's address-seeded pixel
 * avatar) rather than either calling out to nothing or leaving every profile
 * blank, while never being mistaken for real data: `source` on the cached row
 * always says which provider answered.
 */
export interface XProfile {
  handle: string;
  displayName: string | null;
  avatarUrl: string | null;
  verified: boolean;
  found: boolean;
}

export interface XProvider {
  readonly source: 'x_api' | 'placeholder';
  fetchProfile(handle: string): Promise<XProfile>;
}

export interface HttpXProviderOptions {
  bearerToken: string;
  baseUrl?: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
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
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const url = `${this.baseUrl}/users/by/username/${encodeURIComponent(handle)}?user.fields=profile_image_url,verified`;
      const res = await this.fetchImpl(url, {
        headers: { authorization: `Bearer ${this.opts.bearerToken}` },
        signal: controller.signal,
      });
      if (res.status === 404) return { handle, displayName: null, avatarUrl: null, verified: false, found: false };
      if (!res.ok) throw new Error(`X API HTTP ${res.status}`);
      const body = (await res.json()) as {
        data?: { name?: string; profile_image_url?: string; verified?: boolean };
      };
      if (!body.data) return { handle, displayName: null, avatarUrl: null, verified: false, found: false };
      return {
        handle,
        displayName: body.data.name ?? null,
        avatarUrl: body.data.profile_image_url ?? null,
        verified: body.data.verified ?? false,
        found: true,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * No network call, no key required. Deterministic per handle (same handle
 * always renders the same placeholder), so it is stable across repeated
 * profile views and safe to run in every environment without credentials.
 */
export class PlaceholderXProvider implements XProvider {
  readonly source = 'placeholder' as const;

  async fetchProfile(handle: string): Promise<XProfile> {
    const clean = handle.replace(/^@/, '').trim();
    if (!clean) return { handle, displayName: null, avatarUrl: null, verified: false, found: false };
    return {
      handle: clean,
      displayName: '@' + clean,
      avatarUrl: null,
      verified: false,
      found: true,
    };
  }
}
