import { type Member, type Wall, hash, rng } from '@stonkz/shared';
import { fakeAddr } from '../lib/fmt.js';
import { WALLET } from './wallet.js';
import { USER, saveUser } from './user.js';

/**
 * Member profiles, follows and walls.
 *
 * Phase 5 replaces every generator here with `GET /users/:addr`,
 * `POST /follow` and a `wall_posts` table; tips become a real transfer whose
 * signature the server verifies before the post is accepted. `index.html:2860`
 */

const NAMES = [
  'trench rat',
  'liquidity goblin',
  'exit liquidity',
  'chart astrologer',
  'serial larper',
  'bag holder prime',
  'candle whisperer',
  'rug survivor',
  'sniper #4',
  'the floor guy',
];

const BIOS = [
  'i buy the top so you do not have to',
  'onchain since the second rug',
  'i do not have a thesis, i have a wallet',
  'up only, spiritually',
  'my exit strategy is hope',
];

const MEMBERS = new Map<string, Member>();

/** Resolve an address to a stable profile. `index.html:2864` */
export function memberOf(addr: string): Member {
  const cached = MEMBERS.get(addr);
  if (cached) return cached;
  const seed = hash(addr);
  const r = rng(seed);
  const m: Member = {
    addr,
    seed,
    name: NAMES[(r() * NAMES.length) | 0] as string,
    bio: BIOS[(r() * BIOS.length) | 0] as string,
    followers: (r() * 4200) | 0,
    following: (r() * 380) | 0,
    joined: ['MAR 2024', 'AUG 2024', 'JAN 2025', 'NOV 2023'][(r() * 4) | 0] as string,
    xp: (r() * 24000) | 0,
  };
  MEMBERS.set(addr, m);
  return m;
}

/** The connected wallet's own profile, with local overrides applied. */
export function me(): Member {
  const m = memberOf(WALLET.full);
  return {
    ...m,
    seed: WALLET.seed,
    name: USER.name || 'anon degen',
    bio: USER.bio || 'no bio yet. probably down bad.',
    xp: USER.xp,
  };
}

export function isMe(addr: string): boolean {
  return addr === WALLET.full || addr === WALLET.addr || addr === 'YOU..7xKQ';
}

/* -------------------------------------------------------------------------- */
/* Follows                                                                     */
/* -------------------------------------------------------------------------- */

export function following(addr: string): boolean {
  return !!(USER.follow && USER.follow[addr]);
}

export function followCount(): number {
  return USER.follow ? Object.keys(USER.follow).length : 0;
}

/** Returns the new state. TODO(Phase 5.A): `POST /follow`. `index.html:2884` */
export function toggleFollow(addr: string): boolean {
  if (!USER.follow) USER.follow = {};
  const now = !USER.follow[addr];
  if (now) USER.follow[addr] = 1;
  else delete USER.follow[addr];
  saveUser();
  return now;
}

/* -------------------------------------------------------------------------- */
/* Walls                                                                       */
/* -------------------------------------------------------------------------- */

const WALLS = new Map<string, Wall[]>();

const WALL_POOL = [
  'called giga at 400k. still waiting on my thank you',
  'sold the bottom again. ask me anything',
  'if you are reading this you are already exit liquidity',
  'ser your last coin owes me a kidney',
];

export function wallOf(addr: string): Wall[] {
  const cached = WALLS.get(addr);
  if (cached) return cached;
  const r = rng(hash(addr) + 17);
  const posts: Wall[] = WALL_POOL.slice(0, 3).map((text, i) => ({
    from: fakeAddr(hash(addr) + i * 71),
    text,
    tip: r() > 0.6 ? Number((0.01 + r() * 0.4).toFixed(3)) : 0,
    t: (i + 1) * 7 + 'm',
  }));
  WALLS.set(addr, posts);
  return posts;
}

/** TODO(Phase 5.C): `POST /wall` with the tip signature attached. */
export function postToWall(addr: string, post: Wall): void {
  const list = wallOf(addr);
  list.unshift(post);
  if (list.length > 30) list.pop();
}
