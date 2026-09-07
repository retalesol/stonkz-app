import { type Member, type Wall, hash, minTip as minTipFor, rng } from '@stonkz/shared';
import { fakeAddr } from '../lib/fmt.js';
import { COINS, type SimCoin } from './coins.js';
import { USER, saveUser } from './user.js';
import { WALLET, nativeUnit } from './wallet.js';

/**
 * Members, follows and walls.
 *
 * Phase 5 replaces every generator here with `GET /users/:addr`,
 * `POST /follow` and a `wall_posts` table; a tip becomes a real transfer whose
 * signature the server verifies before the post is accepted, which is why
 * `Wall.sig` already exists in the shared type. `index.html:3230`
 */

export const SOCIAL = { followers: 1284, following: 312 };

const MNAME = ['TRENCH', 'FLOOR', 'CURVE', 'JEET', 'WHALE', 'COPE', 'BAG', 'MOON', 'SNIPE', 'EXIT', 'GAS', 'DEGEN', 'CANDLE', 'ANON'];
const MTAIL = ['RAT', 'LORD', 'GOBLIN', 'MAXI', 'WATCH', 'HANDS', 'SEEKER', 'JANITOR', 'PILOT', 'SZN', 'CHAD', 'MONK'];

const MBIOS = [
  'professional bag holder since the first candle. not selling, ever, probably.',
  'i read contract authority before i buy. usually. sometimes. once.',
  'here for the charts, staying for the psychological damage.',
  'sniping block zero and telling my therapist it is a hobby.',
  'long term investor on a five minute timeframe.',
  'i only ape into tickers with four letters. it is a system.',
  'made it, lost it, made it again, currently in phase two.',
  'liquidity is temporary, screenshots are forever.',
];

const SHOUTS = [
  'gm, your last call actually printed. respect',
  'still holding the bag you handed me. no hard feelings',
  'thanks for the alpha, buying you a coffee',
  'your chart takes are unhinged and usually right',
  'followed. do not make me regret it',
  'saw your entry on that one. filthy',
  'tipping so you remember me when it moons',
];

/** A member, plus the memoised tables only the sim needs. */
export interface SimMember extends Member {
  _h?: Array<{ sym: string; tok: number; cost: number }>;
  _t?: Array<{ t: Date; sym: string; buy: boolean; sol: number }>;
}

const MEMBERS: Record<string, SimMember> = {};

/** TODO(Phase 5.A): `GET /users/:addr`. `index.html:3253` */
export function memberOf(addr: string): SimMember {
  const cached = MEMBERS[addr];
  if (cached) return cached;
  const r = rng(hash(addr));
  const m: SimMember = {
    addr,
    seed: (r() * 1e6) | 0,
    name: (MNAME[(r() * MNAME.length) | 0] as string) + '_' + (MTAIL[(r() * MTAIL.length) | 0] as string),
    bio: MBIOS[(r() * MBIOS.length) | 0] as string,
    followers: (40 + r() * 5200) | 0,
    following: (8 + r() * 700) | 0,
    joined: String((1 + r() * 380) | 0),
    xp: (180 + r() * 34000) | 0,
  };
  MEMBERS[addr] = m;
  return m;
}

export function isMe(addr: string): boolean {
  return WALLET.on && addr === WALLET.addr;
}

export function myName(): string {
  return USER.name || 'UNNAMED DEGEN';
}

export function myBio(): string {
  return USER.bio || 'NO BIO YET. HIT EDIT PROFILE AND SAY SOMETHING.';
}

export function follows(): Record<string, 1> {
  if (!USER.follow) USER.follow = {};
  return USER.follow;
}

export function isFollowing(a: string): boolean {
  return !!follows()[a];
}

/** Returns the new state. TODO(Phase 5.A): `POST /follow`. `index.html:3267` */
export function toggleFollow(a: string): boolean {
  const f = follows();
  const now = !f[a];
  if (now) f[a] = 1;
  else delete f[a];
  saveUser();
  return now;
}

let followerCache: string[] | null = null;

export function followerAddrs(): string[] {
  if (followerCache) return followerCache;
  const r = rng(90210);
  const out: string[] = [];
  for (let i = 0; i < 8; i++) out.push(fakeAddr((r() * 1e6) | 0));
  followerCache = out;
  return out;
}

export function friendAddrs(addr: string): string[] {
  if (isMe(addr)) {
    return followerAddrs()
      .concat(Object.keys(follows()))
      .filter((a, i, arr) => a !== WALLET.addr && arr.indexOf(a) === i);
  }
  const r = rng(hash(addr) + 3);
  const out: string[] = [];
  for (let i = 0; i < 6; i++) out.push(fakeAddr((r() * 1e6) | 0));
  return out;
}

/** Simulated PnL over a window. `index.html:3286` */
export function memProfit(addr: string, win: string): number {
  const r = rng(hash(addr + win));
  const scale = win === '24h' ? 1200 : win === '7d' ? 5400 : 19000;
  return (r() * 1.9 - 0.45) * scale;
}

export function memHold(m: SimMember, priceOf: (c: SimCoin) => number): Array<{ sym: string; tok: number; cost: number }> {
  if (m._h) return m._h;
  const r = rng(m.seed + 11);
  const out: Array<{ sym: string; tok: number; cost: number }> = [];
  const n = 2 + ((r() * 4) | 0);
  for (let i = 0; i < n; i++) {
    const c = COINS[(r() * COINS.length) | 0];
    if (!c || out.some((o) => o.sym === c.sym)) continue;
    const cost = 60 + r() * 4200;
    out.push({ sym: c.sym, tok: (cost / priceOf(c)) * (0.55 + r() * 0.9), cost });
  }
  m._h = out;
  return out;
}

export function memTrades(m: SimMember): Array<{ t: Date; sym: string; buy: boolean; sol: number }> {
  if (m._t) return m._t;
  const r = rng(m.seed + 29);
  const out: Array<{ t: Date; sym: string; buy: boolean; sol: number }> = [];
  const now = Date.now();
  for (let i = 0; i < 6; i++) {
    const c = COINS[(r() * COINS.length) | 0];
    if (!c) continue;
    out.push({ t: new Date(now - (i * 2400 + 600) * 1000), sym: c.sym, buy: r() > 0.42, sol: 0.2 + r() * 4 });
  }
  m._t = out;
  return out;
}

/** Minimum tip in the chain's native unit: 0.001 SOL / 0.0001 ETH. */
export function minTip(): number {
  return minTipFor(nativeUnit());
}

const WALLS: Record<string, Wall[]> = {};

export function wallOf(addr: string): Wall[] {
  const cached = WALLS[addr];
  if (cached) return cached;
  const r = rng(hash(addr) + 77);
  const n = 2 + ((r() * 4) | 0);
  const out: Wall[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      from: fakeAddr((r() * 1e6) | 0),
      text: SHOUTS[(r() * SHOUTS.length) | 0] as string,
      tip: Number((minTip() + r() * 0.35).toFixed(4)),
      t: (i + 1) * 37 + ((r() * 20) | 0) + 'm',
    });
  }
  WALLS[addr] = out;
  return out;
}

/** TODO(Phase 5.C): `POST /wall`, with the tip signature attached. */
export function postToWall(addr: string, post: Wall): void {
  wallOf(addr).unshift(post);
}
