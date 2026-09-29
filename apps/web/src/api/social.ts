import type { CrateProof, EvmNet, Net, RwaReward } from '@stonkz/shared';
import {
  authHeader,
  ensureSession,
  hasSession,
  peekStoredSession,
  restoreSession,
} from '../app/session.js';
import type { ChatAccess } from '../views/chat-access.js';

/**
 * Phase 5's social client.
 *
 * Kept as its own module rather than folded into `StonkzApi`
 * (`api/types.ts`): every existing adapter method is either "sim vs live"
 * for a feature with real state on both sides (trading, launching) or purely
 * simulated (staking, crates). Profiles/follows/walls have no sim-side
 * *server* to mirror — `state/social.ts`'s generators stay exactly as they
 * are for `api.mode === 'sim'` — so views call this module directly, gated
 * on `api.mode === 'live'`, the same seam `api/index.ts`'s `disclosure()`
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
  /** Owner-only portfolio, PnL, actions, wall and friends. */
  private: boolean;
  createdAtMs: number;
}

export interface LiveHolding {
  sym: string;
  mint?: string | null;
  tok: number;
  /** USD cost of the tokens still held; 0 when the basis is unknown. */
  cost: number;
  value: number;
  priceUsd?: number;
  pnlUsd?: number | null;
  pnlPct?: number | null;
  realisedUsd?: number;
  /** `trades` = fully explained by fills; `partial` = some tokens arrived by transfer; `unknown` = no buys on record. */
  basis?: 'trades' | 'partial' | 'unknown';
}

export interface LiveStaked {
  sym: string;
  mint: string;
  amt: number;
  lockDays: number;
  mult: number;
  untilMs: number;
  rewardNative: number;
  rewardTokens: number;
  valueUsd: number;
}

export interface LiveMember {
  net: Net;
  addr: string;
  resolvedFrom?: 'wallet' | 'username';
  profile: LiveProfile | null;
  /** True when the server redacted this card (private profile, viewer is not the owner). */
  private?: boolean;
  /** True when the authenticated caller *is* this member. */
  own?: boolean;
  /** `null` on a redacted card. */
  followers: number | null;
  following: number | null;
  /** Outgoing follow edges (wallets), when the API includes them. */
  followingWallets?: string[];
  isFollowing: boolean;
  followsYou?: boolean;
  xp: number;
  native?: { unit: string; balance: number | null };
  portfolioUsd?: number | null;
  pnl?: { unrealisedUsd: number; realisedUsd: number };
  holdings?: LiveHolding[];
  holdingsSource?: 'chain' | 'index' | 'private';
  staked?: LiveStaked[];
  launched?: Array<{
    sym: string;
    name: string;
    mc: number;
    chg: number;
    age: number;
    seed: number;
    hold?: number;
    mint?: string;
    net?: Net;
  }>;
}

export interface LiveWallPost {
  id?: number;
  from: string;
  fromUsername?: string | null;
  fromAvatarUrl?: string | null;
  text: string;
  tip: number;
  sig: string;
  likes?: number;
  createdAtMs: number;
}

export type LiveActivityKind =
  'buy' | 'sell' | 'launch' | 'stake' | 'unstake' | 'stake_claim' | 'crate' | 'level_up' | 'follow';

export interface LiveActivity {
  id: string;
  kind: LiveActivityKind;
  net: Net;
  t: number;
  sym?: string;
  mint?: string;
  sig?: string;
  native?: number;
  usd?: number;
  tokens?: number;
  tier?: string;
  label?: string;
  level?: number;
  target?: string;
}

export interface LiveActivityPage {
  items: LiveActivity[];
  nextBefore: number | null;
}

export interface LiveIdentity {
  wallet: string;
  username: string | null;
  avatarUrl: string | null;
}

export interface LiveFollowEntry extends LiveIdentity {
  createdAtMs: number;
}

export interface LiveFollowPage {
  entries: LiveFollowEntry[];
  nextBefore: number | null;
}

export interface LiveWall {
  minTip: number;
  posts: LiveWallPost[];
  nextBefore?: number | null;
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

/**
 * Public member card. Sent with the session's bearer when one exists so the
 * server can tell the owner (full card) from a visitor (redacted when private)
 * — an anonymous read never carries a token.
 */
export function fetchMember(net: Net, addr: string): Promise<LiveMember> {
  return memberJson<LiveMember>(net, `/users/${net}/${encodeURIComponent(addr)}`);
}

/**
 * Bearer for a *read*: a fresh token when held, a silent refresh when only
 * the stored refresh token is (a reload), and no header at all otherwise.
 * Never prompts the wallet to sign — a visitor stays anonymous.
 */
async function viewerHeaders(net: Net): Promise<Record<string, string>> {
  if (!hasSession(net) && peekStoredSession()?.net === net) {
    await restoreSession(BASE).catch(() => null);
  }
  return hasSession(net) ? authHeader(net) : {};
}

async function memberJson<T>(net: Net, path: string): Promise<T> {
  const headers = await viewerHeaders(net);
  const res = await fetch(BASE + path, { headers });
  if (!res.ok) {
    const { code, detail } = await readError(res);
    throw new SocialApiError(code, detail);
  }
  return (await res.json()) as T;
}

function pageQuery(opts: { before?: number | null; limit?: number }): string {
  const q = new URLSearchParams();
  if (opts.before) q.set('before', String(opts.before));
  if (opts.limit) q.set('limit', String(opts.limit));
  const s = q.toString();
  return s ? '?' + s : '';
}

/** Recent actions, newest first. Owner-only on a private profile (403 `private_profile`). */
export function fetchActivity(
  net: Net,
  addr: string,
  opts: { before?: number | null; limit?: number } = {},
): Promise<LiveActivityPage> {
  return memberJson(net, `/users/${net}/${encodeURIComponent(addr)}/activity${pageQuery(opts)}`);
}

export function fetchFollowList(
  net: Net,
  addr: string,
  direction: 'followers' | 'following',
  opts: { before?: number | null; limit?: number } = {},
): Promise<LiveFollowPage> {
  return memberJson(
    net,
    `/users/${net}/${encodeURIComponent(addr)}/${direction}${pageQuery(opts)}`,
  );
}

/** Mutual follows. */
export function fetchFriends(net: Net, addr: string): Promise<{ entries: LiveFollowEntry[] }> {
  return memberJson(net, `/users/${net}/${encodeURIComponent(addr)}/friends`);
}

/** Public username + avatar for up to 100 wallets — what holder tables and creator labels need. */
export function fetchIdentities(
  net: Net,
  wallets: string[],
): Promise<{ identities: LiveIdentity[] }> {
  const unique = [...new Set(wallets.filter(Boolean))].slice(0, 100);
  if (!unique.length) return Promise.resolve({ identities: [] });
  return getJson(`/identities/${net}?wallets=${encodeURIComponent(unique.join(','))}`);
}

export interface ProfilePatch {
  username: string;
  bio: string;
  avatarUrl: string;
  xHandle: string;
  website: string;
  telegram: string;
  private: boolean;
}

/**
 * A field-level refusal from `PATCH /me`: `field` names the input the
 * settings dialog should mark, `detail` is the copy to show under it.
 */
export class ProfileFieldError extends SocialApiError {
  constructor(
    readonly field: keyof ProfilePatch,
    code: string,
    detail: string,
  ) {
    super(code, detail);
    this.name = 'ProfileFieldError';
  }
}

export async function patchMyProfile(
  net: Net,
  patch: Partial<ProfilePatch>,
): Promise<{ profile: LiveProfile }> {
  await ensureSession(BASE, net);
  const res = await fetch(BASE + '/me', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...authHeader(net) },
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as {
      error?: unknown;
      field?: unknown;
      detail?: unknown;
    };
    const code = typeof body.error === 'string' ? body.error : 'request_failed';
    const detail = typeof body.detail === 'string' ? body.detail : code;
    if (typeof body.field === 'string')
      throw new ProfileFieldError(body.field as keyof ProfilePatch, code, detail);
    throw new SocialApiError(code, detail);
  }
  return (await res.json()) as { profile: LiveProfile };
}

/** "Sign out everywhere": revokes every other device's session for this wallet. */
export function revokeOtherSessions(net: Net): Promise<{ ok: true; revoked: number }> {
  return authedJson('/me/sessions/revoke-others', net, { method: 'POST', body: '{}' });
}

export function follow(net: Net, addr: string): Promise<{ following: boolean }> {
  return authedJson(`/follow/${net}/${addr}`, net, { method: 'POST' });
}

export function unfollow(net: Net, addr: string): Promise<{ following: boolean }> {
  return authedJson(`/follow/${net}/${addr}`, net, { method: 'DELETE' });
}

/** The wall's backscroll, newest first. Owner-only on a private profile (403 `private_profile`). */
export function fetchWall(
  net: Net,
  addr: string,
  opts: { before?: number | null; limit?: number } = {},
): Promise<LiveWall> {
  return memberJson(net, `/wall/${net}/${encodeURIComponent(addr)}${pageQuery(opts)}`);
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
): Promise<{ post: LiveWallPost; xpAwarded: number; flagged?: boolean }> {
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

/**
 * `GET /chat/:net/:room/access` — the gate snapshot behind the composer
 * (`views/chat-access.ts`'s `ChatAccess`). Optional auth: sent with the
 * session token when one is held, so a guest still gets the read-only view.
 */
export async function fetchChatAccess(net: Net, room: string): Promise<ChatAccess> {
  const res = await fetch(BASE + `/chat/${net}/${encodeURIComponent(room)}/access`, {
    headers: authHeader(net),
  });
  if (!res.ok) {
    const { code, detail } = await readError(res);
    throw new SocialApiError(code, detail);
  }
  return (await res.json()) as ChatAccess;
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

export interface LiveRwaUsd {
  total: number | null;
  positions: { asset: string; units: number; usd: number | null; price?: number | null }[];
}

export interface LiveClaimsState {
  open: boolean;
  stonkz: { open: boolean; reason: string };
  rwa: { open: boolean; reason: string };
}

export interface LiveRewardsSnapshot {
  net: Net;
  wallet: string;
  xp: number;
  sp: number;
  /** `$STONKZ` reward credits. */
  stonkz: number;
  /** RWA positions won from crates. */
  rwa?: RwaReward[];
  /** USD value of `rwa` from DefiLlama; `total: null` while unpriced. */
  rwaUsd?: LiveRwaUsd;
  /** On-chain claim availability (`docs/rewards-claims-design.md`). */
  claims?: LiveClaimsState;
  streak: number;
  streakMult: number;
  cratesReady: number;
  globalCooldown?: { readyAt: number; ready: boolean };
  /** sha256 of the server seed committed for this wallet's next crate open. */
  nextCommit?: string;
  items?: {
    item: string;
    count: number;
    expiresAt: number | null;
    active: boolean;
    effect: string | null;
    implemented: boolean;
    blurb: string | null;
  }[];
  spLevel?: {
    level: number;
    sp: number;
    cur?: number;
    next: number | null;
    pct: number;
    toNext: number;
    nextLevel: { level: number; sp: number; grants: Record<string, number> } | null;
    newlyClaimed?: number[];
    granted?: Record<string, number>;
    claimed?: number[];
    levels?: {
      level: number;
      sp: number;
      grants: Record<string, number>;
      claimed: boolean;
      reached: boolean;
    }[];
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
    kind?: 'S' | 'I' | 'R';
    stonkz?: number;
    item: string | null;
    xp?: number;
    proof?: CrateProof & { clientSeeded: boolean; verifiable: boolean };
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
  keyUsed?: boolean;
  openId?: number;
  proof?: CrateProof & { clientSeeded: boolean; message: string; verifiable: boolean };
  nextCommit?: string;
}

export interface LiveCrateHistory {
  net: Net;
  wallet: string;
  nextCommit: string;
  formula: string;
  opens: {
    id: number;
    at: number;
    tier: string;
    rarity: string;
    dropIndex: number;
    label: string;
    kind: 'S' | 'I' | 'R';
    xp: number;
    proof: CrateProof & { clientSeeded: boolean; message: string | null; verifiable: boolean };
  }[];
}

export function fetchRewards(net: Net): Promise<LiveRewardsSnapshot> {
  return authedJson(`/rewards`, net);
}

export function openCrateLive(
  net: Net,
  tier: string,
  body: { clientSeed?: string; useKey?: boolean } = {},
): Promise<LiveCrateOpenResult> {
  return authedJson(`/rewards/crates/${encodeURIComponent(tier)}/open`, net, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export function fetchCrateHistory(net: Net, limit = 50): Promise<LiveCrateHistory> {
  return authedJson(`/rewards/crates/history?limit=${limit}`, net);
}

/* -------------------------------------------------------------------------- */
/* Referrals                                                                   */
/* -------------------------------------------------------------------------- */

export interface LiveReferralTier {
  tier: 1 | 2 | 3;
  rate: number;
  pendingNative: number;
  lifetimeNative: number;
  fills: number;
}

export interface LiveReferralPayout {
  id: number;
  amountNative: number;
  mode: 'stonkz' | 'native';
  /** `batch` — the treasury signer pays it; `onchain` — the referrer redeemed a voucher. Absent on older API builds. */
  method?: 'batch' | 'onchain';
  status: 'requested' | 'paid' | 'void';
  stonkz: number | null;
  txSig: string | null;
  requestedAt: number;
  settledAt: number | null;
}

export interface LiveReferralSnapshot {
  code: string;
  rates: number[];
  spKickbackRate: number;
  referredBy: string | null;
  directReferrals: number;
  pendingNative: number;
  lifetimeNative: number;
  /** Per-tier earnings; absent on older API builds. */
  tiers?: LiveReferralTier[];
  /** Native payouts requested and awaiting the treasury signer. */
  requestedNative?: number;
  /** Native payouts settled on chain. */
  paidNative?: number;
  payouts?: LiveReferralPayout[];
  /** True when this net has a referral vault + signer: the panel offers CLAIM ON CHAIN. */
  onchainClaims?: boolean;
}

export function fetchReferrals(net: Net): Promise<LiveReferralSnapshot> {
  return authedJson(`/referrals`, net);
}

export function attachReferral(net: Net, code: string): Promise<{ ok: true; referrer: string }> {
  return authedJson(`/referrals/attach`, net, { method: 'POST', body: JSON.stringify({ code }) });
}

export interface LiveReferralClaim {
  ok?: true;
  mode?: 'stonkz' | 'native';
  claimedNative: number;
  stonkz: number;
  stonkzTotal: number;
  payoutId?: number | null;
}

/**
 * `stonkz` converts the pending commission to `$STONKZ` credits at once;
 * `native` books a payout request the protocol treasury signer settles from
 * the on-chain protocol vault.
 */
export function claimReferralFees(
  net: Net,
  payout: 'stonkz' | 'native' = 'stonkz',
): Promise<LiveReferralClaim> {
  return authedJson(`/referrals/claim`, net, { method: 'POST', body: JSON.stringify({ payout }) });
}

/* ---- self-serve on-chain claims (docs/referral-payouts.md) ---- */

export interface LiveReferralClaimAsset {
  asset: string;
  symbol: string;
  decimals: number;
  vault: string;
  /** What a fresh voucher would pay right now, in whole units. */
  claimableNative: number;
  claimableAtoms: string;
  pendingNative: number;
  /** Signed but not yet confirmed on chain. */
  awaitingConfirmAtoms: string;
  paidCumulativeAtoms: string;
  cumulativeAtoms: string;
  outstandingIds: number[];
}

export interface LiveReferralClaimable {
  net: Net;
  wallet: string;
  /** False = no vault on this net; the panel keeps the REQUEST PAYOUT flow. */
  configured: boolean;
  assets: LiveReferralClaimAsset[];
}

export function fetchReferralClaimable(net: Net): Promise<LiveReferralClaimable> {
  return authedJson(`/referrals/claimable`, net);
}

interface LiveReferralPrepareCommon {
  net: Net;
  asset: string;
  symbol: string;
  decimals: number;
  vault: string;
  cumulativeAtoms: string;
  amountAtoms: string;
  amountNative: number;
  deadline: number;
  payoutId: number;
  signature: string;
}

export type LiveReferralPrepare =
  | (LiveReferralPrepareCommon & {
      net: 'SOL';
      /** Base64 unsigned transaction: create-ATA, Ed25519 verify, `claim_referral`. */
      transaction: string;
      lastValidBlockHeight: number;
    })
  | (LiveReferralPrepareCommon & {
      net: EvmNet;
      chainId: number;
      to: string;
      /** `claim(...)`: pays WETH. */
      data: string;
      /** `claimAsEth(...)`: the same voucher paid as ETH. Only the recipient may send it. */
      dataUnwrap: string;
      value: string;
    });

/** Drains pending into a signed cumulative voucher and returns the transaction to sign. */
export function prepareReferralClaim(net: Net, asset?: string): Promise<LiveReferralPrepare> {
  return authedJson(`/referrals/claim/prepare`, net, {
    method: 'POST',
    body: JSON.stringify(asset ? { asset } : {}),
  });
}

export interface LiveReferralConfirm {
  ok: true;
  net: Net;
  asset: string;
  paidAtoms: string;
  paidNative: number;
  cumulativeAtoms: string;
  /** Payout rows this transaction settled. */
  settled: number;
}

/** Reads the receipt / logs back and marks the payout rows paid. */
export function confirmReferralClaim(net: Net, signature: string): Promise<LiveReferralConfirm> {
  return authedJson(`/referrals/claim/confirm`, net, {
    method: 'POST',
    body: JSON.stringify({ signature }),
  });
}

export function likeWallPost(
  net: Net,
  postId: number,
): Promise<{ ok: true; liked: boolean; xpAwarded: number; already?: boolean }> {
  return authedJson(`/wall/${net}/posts/${postId}/like`, net, { method: 'POST', body: '{}' });
}
