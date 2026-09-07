import type { Net } from '@stonkz/shared';
import { authHeader, ensureSession } from '../app/session.js';

/**
 * Phase 5's social client.
 *
 * Kept as its own module rather than folded into `StonkzApi`
 * (`api/types.ts`): every existing adapter method is either "sim vs live"
 * for a feature with real state on both sides (trading, launching) or purely
 * simulated (staking, crates). Profiles/follows/walls have no sim-side
 * *server* to mirror — `state/social.ts`'s generators stay exactly as they
 * are for `api.mode === 'sim'` — so views call this module directly, gated
 * on `api.mode === 'live'`, the same seam `api/index.ts`'s `DISCLOSURE`
 * comment already uses for "some features are live, some are not". See the
 * final report for the tradeoff.
 */

const BASE = import.meta.env['VITE_API_URL'] ?? '';

export class SocialApiError extends Error {
  constructor(
    readonly code: string,
    detail: string,
  ) {
    super(detail);
    this.name = 'SocialApiError';
  }
}

async function readError(res: Response): Promise<{ code: string; detail: string }> {
  const body = (await res.json().catch(() => ({}))) as { error?: unknown; reason?: unknown; detail?: unknown };
  const code = typeof body.error === 'string' ? body.error : 'request_failed';
  const detail =
    typeof body.detail === 'string' ? body.detail : typeof body.reason === 'string' ? body.reason : code;
  return { code, detail };
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(BASE + path);
  if (!res.ok) {
    const { code, detail } = await readError(res);
    throw new SocialApiError(code, detail);
  }
  return (await res.json()) as T;
}

async function authedJson<T>(path: string, net: Net, init: RequestInit = {}): Promise<T> {
  await ensureSession(BASE, net);
  const res = await fetch(BASE + path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...authHeader(net), ...(init.headers ?? {}) },
  });
  if (!res.ok) {
    const { code, detail } = await readError(res);
    throw new SocialApiError(code, detail);
  }
  return (await res.json()) as T;
}

export interface LiveProfile {
  username: string | null;
  bio: string | null;
  avatarUrl: string | null;
  xHandle: string | null;
  website: string | null;
  telegram: string | null;
  createdAtMs: number;
}

export interface LiveMember {
  net: Net;
  addr: string;
  profile: LiveProfile | null;
  followers: number;
  following: number;
  isFollowing: boolean;
  xp: number;
}

export interface LiveWallPost {
  from: string;
  text: string;
  tip: number;
  sig: string;
  createdAtMs: number;
}

export interface LiveXProfile {
  handle: string;
  displayName: string | null;
  avatarUrl: string | null;
  verified: boolean;
  found: boolean;
  source: 'x_api' | 'placeholder';
}

export function fetchMember(net: Net, addr: string): Promise<LiveMember> {
  return getJson<LiveMember>(`/users/${net}/${addr}`);
}

export function patchMyProfile(
  net: Net,
  patch: Partial<{ username: string; bio: string; avatarUrl: string; xHandle: string; website: string; telegram: string }>,
): Promise<{ profile: LiveProfile }> {
  return authedJson(`/me`, net, { method: 'PATCH', body: JSON.stringify(patch) });
}

export function follow(net: Net, addr: string): Promise<{ following: boolean }> {
  return authedJson(`/follow/${net}/${addr}`, net, { method: 'POST' });
}

export function unfollow(net: Net, addr: string): Promise<{ following: boolean }> {
  return authedJson(`/follow/${net}/${addr}`, net, { method: 'DELETE' });
}

export function fetchWall(net: Net, addr: string): Promise<{ minTip: number; posts: LiveWallPost[] }> {
  return getJson(`/wall/${net}/${addr}`);
}

/**
 * `tipTxSig` must already be a confirmed, on-chain signature of a real
 * native transfer to `addr` — `app/tip.ts`'s job — never a value this
 * function invents. The server re-derives the amount from the chain; nothing
 * about the tip amount here is authoritative.
 */
export function postWallTip(
  net: Net,
  addr: string,
  text: string,
  tipTxSig: string,
): Promise<{ post: LiveWallPost; xpAwarded: number }> {
  return authedJson(`/wall/${net}/${addr}`, net, { method: 'POST', body: JSON.stringify({ text, tipTxSig }) });
}

export function fetchXProfile(handle: string): Promise<LiveXProfile> {
  return getJson(`/x/${encodeURIComponent(handle.replace(/^@/, ''))}`);
}

export function fetchChatHistory(
  net: Net,
  room: string,
): Promise<{ room: string; messages: { id: number; wallet: string; text: string; createdAtMs: number }[] }> {
  return getJson(`/chat/${net}/${encodeURIComponent(room)}/history`);
}
