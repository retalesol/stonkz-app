import type { Net, RwaReward } from '@stonkz/shared';
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
  const body = (await res.json().catch(() => ({}))) as {
    error?: unknown;
    reason?: unknown;
    detail?: unknown;
  };
  const code = typeof body.error === 'string' ? body.error : 'request_failed';
  const detail =
    typeof body.detail === 'string'
      ? body.detail
      : typeof body.reason === 'string'
        ? body.reason
        : code;
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

export interface LiveHolding {
  sym: string;
  tok: number;
  cost: number;
  value: number;
}

export interface LiveMember {
  net: Net;
  addr: string;
  resolvedFrom?: 'wallet' | 'username';
  profile: LiveProfile | null;
  followers: number;
  following: number;
  /** Outgoing follow edges (wallets), when the API includes them. */
  followingWallets?: string[];
  isFollowing: boolean;
  xp: number;
  native?: { unit: string; balance: number | null };
  portfolioUsd?: number;
  holdings?: LiveHolding[];
  holdingsSource?: 'chain' | 'index';
  launched?: Array<{
    sym: string;
    name: string;
    mc: number;
    chg: number;
    age: number;
    seed: number;
  }>;
}

export interface LiveWallPost {
  id?: number;
  from: string;
  text: string;
  tip: number;
  sig: string;
  likes?: number;
  createdAtMs: number;
}

export interface LiveXProfile {
  handle: string;
  displayName: string | null;
  avatarUrl: string | null;
  verified: boolean;
  found: boolean;
  status?: 'ok' | 'not_found' | 'suspended' | 'unavailable';
  reason?: string;
  source: 'x_api' | 'none' | 'placeholder';
}

export function fetchMember(net: Net, addr: string): Promise<LiveMember> {
  return getJson<LiveMember>(`/users/${net}/${addr}`);
}

export function patchMyProfile(
  net: Net,
  patch: Partial<{
    username: string;
    bio: string;
    avatarUrl: string;
    xHandle: string;
    website: string;
    telegram: string;
  }>,
): Promise<{ profile: LiveProfile }> {
  return authedJson(`/me`, net, { method: 'PATCH', body: JSON.stringify(patch) });
}

export function follow(net: Net, addr: string): Promise<{ following: boolean }> {
  return authedJson(`/follow/${net}/${addr}`, net, { method: 'POST' });
}

export function unfollow(net: Net, addr: string): Promise<{ following: boolean }> {
  return authedJson(`/follow/${net}/${addr}`, net, { method: 'DELETE' });
}

export function fetchWall(
  net: Net,
  addr: string,
): Promise<{ minTip: number; posts: LiveWallPost[] }> {
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
  return authedJson(`/wall/${net}/${addr}`, net, {
    method: 'POST',
    body: JSON.stringify({ text, tipTxSig }),
  });
}

export function fetchXProfile(handle: string): Promise<LiveXProfile> {
  return getJson(`/x/${encodeURIComponent(handle.replace(/^@/, ''))}`);
}

/**
 * Posts over `POST /chat/:net/:room` — the same `ChatService.send` the WS
 * `send_chat` path uses (`routes/chat.ts`), so REST-only clients (this one:
 * `views/chat.ts` never opens its own socket to send, only to receive over
 * `api/live.ts`'s `subscribeChatRoom`) get the identical rate-limit and
 * moderation behaviour.
 */
export function sendChatMessage(
  net: Net,
  room: string,
  text: string,
): Promise<{
  ok: true;
  message: { id: number; room: string; text: string; flagged: boolean; createdAtMs: number } | null;
}> {
  return authedJson(`/chat/${net}/${encodeURIComponent(room)}`, net, {
    method: 'POST',
    body: JSON.stringify({ text }),
  });
}

export function fetchChatHistory(
  net: Net,
  room: string,
): Promise<{
  room: string;
  messages: {
    id: number;
    wallet: string;
    text: string;
    createdAtMs: number;
    username?: string | null;
    avatarUrl?: string | null;
  }[];
}> {
  return getJson(`/chat/${net}/${encodeURIComponent(room)}/history`);
}

/** Multipart upload to `POST /me/avatar` → Pinata gateway URL. */
export async function uploadAvatar(net: Net, file: File): Promise<{ avatarUrl: string }> {
  await ensureSession(BASE, net);
  const body = new FormData();
  body.append('file', file);
  const res = await fetch(BASE + '/me/avatar', {
    method: 'POST',
    headers: { ...authHeader(net) },
    body,
  });
  if (!res.ok) {
    const { code, detail } = await readError(res);
    throw new SocialApiError(code, detail);
  }
  return (await res.json()) as { avatarUrl: string };
}

/** Multipart upload to `POST /uploads/image` → Pinata gateway URL (launch art). */
export async function uploadImage(
  net: Net,
  file: Blob,
  filename = 'token.png',
): Promise<{ url: string; cid: string }> {
  await ensureSession(BASE, net);
  const body = new FormData();
  body.append('file', file, filename);
  const res = await fetch(BASE + '/uploads/image', {
    method: 'POST',
    headers: { ...authHeader(net) },
    body,
  });
  if (!res.ok) {
    const { code, detail } = await readError(res);
    throw new SocialApiError(code, detail);
  }
  return (await res.json()) as { url: string; cid: string };
}

/* -------------------------------------------------------------------------- */
/* Rewards — `GET /rewards`, `POST /rewards/crates/:tier/open`                 */
/* -------------------------------------------------------------------------- */

export interface LiveRewardsSnapshot {
  net: Net;
  wallet: string;
  xp: number;
  sp: number;
  /** `$STONKZ` reward credits. */
  stonkz: number;
  /** RWA positions won from crates. */
  rwa?: RwaReward[];
  streak: number;
  streakMult: number;
  cratesReady: number;
  globalCooldown?: { readyAt: number; ready: boolean };
  spLevel?: {
    level: number;
    sp: number;
    next: number | null;
    pct: number;
    toNext: number;
    nextLevel: { level: number; sp: number; grants: Record<string, number> } | null;
  };
  crates: {
    tier: string;
    readyAt: number;
    ready: boolean;
    opens: number;
    inventory: number;
    openable: boolean;
    cooldownHours: number;
    /** Drop table (display only — the web renders `CRATES` from shared). */
    drops?: LiveCrateDropRow[];
  }[];
  dropLog: {
    at: number;
    tier: string;
    rarity: string;
    label: string;
    stonkz?: number;
    item: string | null;
  }[];
  achievements: { key: string; unlockedAt: number }[];
}

/** One drop row of a server crate table from `GET /rewards`. */
export interface LiveCrateDropRow {
  rarity?: string;
  rarityClass?: string;
  odds: number;
  kind: 'STONKZ' | 'RWA' | 'ITEM';
  min: number | null;
  max: number | null;
  /** RWA catalog key, on `RWA` rows. */
  asset?: string | null;
  item: string | null;
}

export interface LiveCrateOpenResult {
  tier: string;
  /** `S` = `$STONKZ` credits, `I` = item, `R` = real-world asset. */
  kind: 'S' | 'I' | 'R';
  amount: number;
  asset: string | null;
  units: number;
  item: string | null;
  label: string;
  dropIndex: number;
  /** `$STONKZ` credited by this open. */
  stonkz: number;
  /** `$STONKZ` reward credit balance after this open. */
  stonkzTotal: number;
  /** Full RWA holdings after this open. */
  rwa: RwaReward[];
  rarity?: string;
  xp: number;
  rankedUp: boolean;
  readyAt: number;
  cooldownHours: number;
  inventoryLeft: number;
}

export function fetchRewards(net: Net): Promise<LiveRewardsSnapshot> {
  return authedJson(`/rewards`, net);
}

export function openCrateLive(net: Net, tier: string): Promise<LiveCrateOpenResult> {
  return authedJson(`/rewards/crates/${encodeURIComponent(tier)}/open`, net, {
    method: 'POST',
    body: '{}',
  });
}

/* -------------------------------------------------------------------------- */
/* Referrals                                                                   */
/* -------------------------------------------------------------------------- */

export interface LiveReferralSnapshot {
  code: string;
  rates: number[];
  spKickbackRate: number;
  referredBy: string | null;
  directReferrals: number;
  pendingNative: number;
  lifetimeNative: number;
}

export function fetchReferrals(net: Net): Promise<LiveReferralSnapshot> {
  return authedJson(`/referrals`, net);
}

export function attachReferral(net: Net, code: string): Promise<{ ok: true; referrer: string }> {
  return authedJson(`/referrals/attach`, net, { method: 'POST', body: JSON.stringify({ code }) });
}

export function claimReferralFees(
  net: Net,
): Promise<{ ok?: true; claimedNative: number; stonkz: number; stonkzTotal: number }> {
  return authedJson(`/referrals/claim`, net, { method: 'POST', body: '{}' });
}

export function likeWallPost(
  net: Net,
  postId: number,
): Promise<{ ok: true; liked: boolean; xpAwarded: number; already?: boolean }> {
  return authedJson(`/wall/${net}/posts/${postId}/like`, net, { method: 'POST', body: '{}' });
}
