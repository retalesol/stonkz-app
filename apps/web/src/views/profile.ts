import {
  RANKS,
  ago,
  inCashback,
  inferNetFromAddress,
  isEvm,
  nativeUnit as unitOfNet,
  num,
  pct,
  price,
  rankOf,
  usd,
  type Net,
} from '@stonkz/shared';
import { api } from '../api/index.js';
import {
  follow as liveFollow,
  fetchActivity,
  fetchFollowList,
  fetchFriends,
  likeWallPost,
  postWallTip,
  unfollow as liveUnfollow,
  fetchMember,
  fetchWall,
  SocialApiError,
  type LiveActivity,
  type LiveFollowEntry,
  type LiveMember,
  type LiveWallPost,
} from '../api/social.js';
import { back, navigate } from '../app/route.js';
import { TipBroadcastError, attemptTip } from '../app/tip.js';
import { showView } from '../app/view.js';
import { pix } from '../canvas/pix.js';
import { toast } from '../fx/toast.js';
import { paintAvatar } from '../lib/avatar.js';
import { $, $$, must } from '../lib/dom.js';
import { ARR, DOT, clockSec, ud } from '../lib/fmt.js';
import { type Html, attr, html, render, replaceWith } from '../lib/html.js';
import { displayName, myDisplayName, rememberIdentity } from '../lib/identity.js';
import { type SimCoin, bySym, coinsBy, myCoins } from '../state/coins.js';
import { HOLD, MYTRADES, pfValue } from '../state/holdings.js';
import { stakedList, yourShare } from '../state/stake.js';
import {
  SOCIAL,
  type SimMember,
  follows,
  friendAddrs,
  isFollowing,
  isMe,
  memHold,
  memProfit,
  memTrades,
  memberOf,
  minTip,
  myBio,
  myName,
  myProfileAddr,
  postToWall,
  toggleFollow,
  wallOf,
} from '../state/social.js';
import { USER, addXP, saveUser, unlock } from '../state/user.js';
import { NATIVE_PRICE, WALLET, nativeUnit } from '../state/wallet.js';
import { coinParams, currentParams } from '../state/params.js';
import { explorerTxUrl } from '../wallet/chain.js';
import { openClaim } from '../modals/claim.js';
import { openEdit } from '../modals/edit.js';
import {
  activityTableHTML,
  followRowsHTML,
  holdingsTableHTML,
  linksHTML,
  pnlSummaryHTML,
  privateBadgeHTML,
  privateNoticeHTML,
  stakedRowsHTML,
} from './profile-render.js';
import { openRewards } from './rewards.js';

/**
 * Member profiles: your own wallet, or anyone whose address appears in a
 * table, on a card or on the tape.
 *
 * Live mode reads `GET /users/:net/:addr`, `/wall`, `/activity` and the
 * follow lists rather than the RNG `memberOf` / `wallOf` generators. Sim
 * keeps those generators. A private profile arrives from the API already
 * redacted (`holdingsSource: 'private'`, 403 on the sub-resources); this
 * view only decides what to say in the empty space.
 */

/** Live profile cache so re-renders after follow/tip do not flash RNG flavour. */
const LIVE_MEMBERS = new Map<string, LiveMember>();
const LIVE_WALLS = new Map<string, { posts: LiveWallPost[]; nextBefore: number | null }>();
const LIVE_ACTS = new Map<string, { items: LiveActivity[]; nextBefore: number | null }>();
const LIVE_FRIENDS = new Map<string, { entries: LiveFollowEntry[]; nextBefore: number | null }>();
const LIVE_HYDRATED = new Set<string>();
const LOADING = new Set<string>();

export type FriendsTab = 'friends' | 'followers' | 'following';

export interface ProfileState {
  addr: string | null;
  tabHold: 'holdings' | 'staked';
  tabAct: 'shout' | 'act';
  win: '24h' | '7d' | '1m';
  tabFriends: FriendsTab;
}

export const PF: ProfileState = {
  addr: null,
  tabHold: 'holdings',
  tabAct: 'shout',
  win: '24h',
  tabFriends: 'friends',
};

/**
 * Forget what we know about `addr` (or everything) so the next render
 * re-fetches — after the owner edits their profile, follows, tips, or
 * switches privacy. Username keys are dropped too.
 */
export function invalidateProfile(addr?: string): void {
  if (!addr) {
    LIVE_MEMBERS.clear();
    LIVE_WALLS.clear();
    LIVE_ACTS.clear();
    LIVE_FRIENDS.clear();
    LIVE_HYDRATED.clear();
    return;
  }
  const keys = new Set<string>([addr]);
  for (const [k, m] of LIVE_MEMBERS) {
    if (m.addr === addr || k === addr || m.addr.toLowerCase() === addr.toLowerCase()) {
      keys.add(k);
      keys.add(m.addr);
      if (m.profile?.username) keys.add(m.profile.username);
    }
  }
  for (const k of keys) {
    LIVE_MEMBERS.delete(k);
    LIVE_WALLS.delete(k);
    LIVE_ACTS.delete(k);
    LIVE_FRIENDS.delete(k);
    LIVE_HYDRATED.delete(k);
  }
}

export function feeTotal(): number {
  return myCoins().reduce((t, c) => t + (c.fee ?? 0), 0);
}

export function feeTokensTotal(): number {
  return myCoins().reduce((t, c) => t + (c.feeTokens ?? 0), 0);
}

function liveMemberFor(addr: string): LiveMember | undefined {
  return (
    LIVE_MEMBERS.get(addr) ||
    [...LIVE_MEMBERS.values()].find(
      (m) =>
        m.addr === addr ||
        m.addr.toLowerCase() === addr.toLowerCase() ||
        m.profile?.username?.toLowerCase() === addr.toLowerCase(),
    )
  );
}

/** The server redacted this card: private profile, and the viewer is not the owner. */
function isRedacted(mem: LiveMember | undefined): boolean {
  return !!mem && mem.holdingsSource === 'private';
}

/* -------------------------------- blocks ---------------------------------- */

function liveQuadHTML(mem: LiveMember, own: boolean): Html {
  const r = rankOf(mem.xp);
  const launched = mem.launched?.length ?? 0;
  const bal = mem.native?.balance;
  const unit = mem.native?.unit || nativeUnit();
  const redacted = isRedacted(mem);
  const portfolio = redacted || mem.portfolioUsd == null ? '—' : usd(mem.portfolioUsd);
  if (own) {
    return html`<div class="quad five" id="pfQuad">
      <div><div class="lbl">${unit} BALANCE</div><div class="val up">${bal == null ? WALLET.sol.toFixed(2) : Number(bal).toFixed(2)}</div></div
      ><div><div class="lbl">PORTFOLIO</div><div class="val am">${portfolio}</div></div
      ><div><div class="lbl">CREATOR FEES</div><div class="val up" id="pfEarn">${feeTotal().toFixed(3)}</div
        ><span class="hint" id="pfEarnSub">${usd(feeTotal() * NATIVE_PRICE.usd)} UNCLAIMED</span></div
      ><div><div class="lbl">$STONKZ</div><div class="val gd">${num(USER.stonkz)}</div></div
      ><div><div class="lbl">TOTAL XP</div><div class="val">${num(mem.xp)}<span class="hint"> ${DOT} LV ${r.i + 1}</span></div></div>
    </div>`;
  }
  return html`<div class="quad" id="pfQuad">
    <div><div class="lbl">${unit} BALANCE</div><div class="val up">${bal == null ? '—' : Number(bal).toFixed(2)}</div></div
    ><div><div class="lbl">PORTFOLIO</div><div class="val am">${portfolio}</div></div
    ><div><div class="lbl">COINS LAUNCHED</div><div class="val gd">${launched}</div></div
    ><div><div class="lbl">TOTAL XP</div><div class="val">${num(mem.xp)}<span class="hint"> ${DOT} LV ${r.i + 1}</span></div></div>
  </div>`;
}

function quadHTML(own: boolean, m: SimMember | null, liveMem?: LiveMember): Html {
  if (api.mode === 'live' && liveMem) return liveQuadHTML(liveMem, own);
  if (api.mode === 'live' && !own) {
    // Loading / unknown member — never invent sim portfolio numbers.
    return html`<div class="quad" id="pfQuad">
      <div><div class="lbl">${nativeUnit()} BALANCE</div><div class="val up">—</div></div
      ><div><div class="lbl">PORTFOLIO</div><div class="val am">—</div></div
      ><div><div class="lbl">COINS LAUNCHED</div><div class="val gd">—</div></div
      ><div><div class="lbl">TOTAL XP</div><div class="val">—</div></div>
    </div>`;
  }
  const r = own ? rankOf(USER.xp) : rankOf((m as SimMember).xp);
  if (own) {
    return html`<div class="quad five" id="pfQuad">
      <div><div class="lbl">${nativeUnit()} BALANCE</div><div class="val up">${WALLET.sol.toFixed(2)}</div></div
      ><div><div class="lbl">PORTFOLIO</div><div class="val am">${usd(pfValue())}</div></div
      ><div><div class="lbl">CREATOR FEES</div><div class="val up" id="pfEarn">${feeTotal().toFixed(3)}</div
        ><span class="hint" id="pfEarnSub">${usd(feeTotal() * NATIVE_PRICE.usd)} UNCLAIMED</span></div
      ><div><div class="lbl">$STONKZ</div><div class="val gd">${num(USER.stonkz)}</div></div
      ><div><div class="lbl">TOTAL XP</div><div class="val">${num(USER.xp)}<span class="hint"> ${DOT} LV ${r.i + 1}</span></div></div>
    </div>`;
  }
  const mm = m as SimMember;
  let pv = 0;
  for (const h of memHold(mm, price)) {
    const c = bySym(h.sym);
    if (c) pv += h.tok * price(c);
  }
  const p24 = memProfit(mm.addr, '24h');
  return html`<div class="quad" id="pfQuad">
    <div><div class="lbl">PORTFOLIO</div><div class="val am">${usd(pv)}</div></div
    ><div><div class="lbl">24H PNL</div><div class="val ${ud(p24)}">${p24 >= 0 ? '+' : '-'}${usd(Math.abs(p24))}</div></div
    ><div><div class="lbl">COINS LAUNCHED</div><div class="val gd">${coinsBy(mm.addr).length}</div></div
    ><div><div class="lbl">TOTAL XP</div><div class="val">${num(mm.xp)}<span class="hint"> ${DOT} LV ${r.i + 1}</span></div></div>
  </div>`;
}

/** Sim holdings (local `HOLD` / `memHold`) — live uses `holdingsTableHTML`. */
function simHoldRows(list: Array<{ sym: string; tok: number; cost: number; value?: number }>): Html {
  return holdingsTableHTML(
    list.map((h) => {
      const c = bySym(h.sym);
      const value = h.value ?? (c ? h.tok * price(c) : 0);
      return { sym: h.sym, tok: h.tok, cost: h.cost || 0, value, basis: h.cost > 0 ? 'trades' : 'unknown' };
    }),
  );
}

function actRows(list: Array<{ t: Date; sym: string; buy: boolean; sol: number }>): Html {
  if (!list.length) return html`<div class="empty">NO ACTIVITY YET</div>`;
  return html`<div class="scrolly"><table class="tbl"><thead><tr><th scope="col">TIME</th><th scope="col">SIDE</th
    ><th scope="col">TOKEN</th><th scope="col" class="r">${nativeUnit()}</th></tr></thead><tbody
    >${list.map(
      (t) => html`<tr><td class="dm">${clockSec(t.t)}</td><td class="${t.buy ? 'up' : 'dn'}">${t.buy ? 'BUY' : 'SELL'}</td
        ><td class="gd">${t.sym}</td><td class="r">${t.sol.toFixed(2)}</td></tr>`,
    )}</tbody></table></div>`;
}

const ACT_OPTS = {
  unitOf: (net: Net) => unitOfNet(net),
  txUrl: (net: Net, sig: string) => explorerTxUrl(net, sig),
  nameOf: (wallet: string) => displayName(wallet),
};

function liveActivityHTML(key: string): Html {
  const page = LIVE_ACTS.get(key);
  if (!page) return html`<div class="empty">LOADING ACTIVITY…</div>`;
  return activityTableHTML(page.items, page.nextBefore, ACT_OPTS);
}

/** Staked positions and their unclaimed rewards. `index.html:3213` */
function stakedPanelHTML(): Html {
  const list = stakedList();
  if (!list.length) return html`<div class="empty">NO STAKED POSITIONS ${DOT}<br>OPEN A TOKEN AND HIT STAKE</div>`;
  return html`${list.map(({ c, st }) => {
    const cb = inCashback(c, Date.now(), coinParams(c));
    const locked = st.until > Date.now();
    const earn = cb ? num(st.rewTok || 0) + ' ' + c.sym : (st.rewSol || 0).toFixed(4) + ' ' + nativeUnit();
    return html`<div class="stk-row" data-stk="${attr(c.sym)}" data-mint="${attr(c.mint || '')}">
      <div><div class="sy">${c.sym}${locked ? html`<span class="lockbadge">${st.mult}x ${st.days}D</span>` : ''}</div
        ><div class="mt">${num(st.amt)} STAKED ${DOT} ${(yourShare(c) * 100).toFixed(2)}% OF POOL</div></div
      ><div class="earn"><b>${earn}</b><span>${cb ? 'CASHBACK' : 'FEES'}</span></div
      ><button type="button" class="claimbtn" data-claim="${attr(c.sym)}">CLAIM</button></div>`;
  })}`;
}

function shoutHTML(
  addr: string,
  own: boolean,
  liveWall?: { posts: LiveWallPost[]; nextBefore: number | null } | null,
): Html {
  const tip = minTip();
  const live = api.mode === 'live';
  const liveWho = LIVE_MEMBERS.get(addr)?.profile?.username?.trim();
  const who = own ? myDisplayName() : liveWho || displayName(addr);

  const postsHtml =
    live && liveWall === undefined
      ? [html`<div class="empty">LOADING WALL…</div>`]
      : live && liveWall
        ? liveWall.posts.length
          ? [
              ...liveWall.posts.map((o) => {
                const mine = isMe(o.from) || o.from === WALLET.full;
                const fromName = o.fromUsername || displayName(o.from);
                const likes = o.likes ?? 0;
                const likeBtn =
                  typeof o.id === 'number'
                    ? html` <button type="button" class="tip" data-like="${attr(o.id)}" title="Like">♥ ${likes}</button>`
                    : html` <span class="tip">♥ ${likes}</span>`;
                return html`<div class="shout${mine ? ' mine' : ''}"><div class="sh-hd"
                  ><span class="who addrlink" data-addr="${attr(o.from)}">${fromName}</span
                  ><span class="tip">+${Number(o.tip).toFixed(4)} ${nativeUnit()}</span
                  >${likeBtn}<span class="t" title="${attr(new Date(o.createdAtMs).toISOString())}">${clockSec(new Date(o.createdAtMs))}</span></div
                  ><p>${o.text}</p></div>`;
              }),
              liveWall.nextBefore
                ? html`<button type="button" class="pf-more" id="pfWallMore" data-before="${attr(liveWall.nextBefore)}">OLDER SHOUTS</button>`
                : html``,
            ]
          : [html`<div class="empty">NO SHOUTS YET</div>`]
        : live
          ? [html`<div class="empty">LOADING WALL…</div>`]
          : (() => {
              const w = wallOf(addr);
              return w.length
                ? w.map(
                    (o) => html`<div class="shout${o.mine ? ' mine' : ''}"><div class="sh-hd"
                      ><span class="who addrlink" data-addr="${attr(o.from)}">${
                        o.mine ? myDisplayName() : memberOf(o.from).name
                      }</span
                      ><span class="tip">+${Number(o.tip).toFixed(4)} ${nativeUnit()}</span><span class="t">${o.t}</span></div
                      ><p>${o.text}</p></div>`,
                  )
                : [html`<div class="empty">NO SHOUTS YET</div>`];
            })();

  return html`<div class="pnl-bd"
    >${own
      ? html`<p class="hint">THIS IS YOUR WALL ${DOT} OTHERS TIP ${tip} ${nativeUnit()} OR MORE TO POST HERE.</p>`
      : html`<form class="shout-form" id="shoutForm"><input class="fld" id="shout-txt" maxlength="140"
          placeholder="SAY SOMETHING TO ${attr(who)}"><input class="fld r" id="shout-tip"
          value="${attr(tip.toFixed(4))}" inputmode="decimal"><button class="send" type="submit">TIP + POST</button></form
        ><p class="hint">MINIMUM ${tip} ${nativeUnit()} ${DOT} 100% OF THE TIP GOES STRAIGHT TO ${who}.</p>`}<div
      class="scrolly" style="display:flex;flex-direction:column;gap:7px"
      >${postsHtml}</div></div>`;
}

function liveFriendsHTML(key: string, own: boolean): Html {
  const page = LIVE_FRIENDS.get(key + ':' + PF.tabFriends);
  if (!page) return html`<div class="empty">LOADING…</div>`;
  const empty =
    PF.tabFriends === 'friends'
      ? own
        ? 'FOLLOW SOMEONE WHO FOLLOWS YOU BACK TO SEE THEM HERE'
        : 'NO MUTUAL FOLLOWS YET'
      : PF.tabFriends === 'followers'
        ? 'NO FOLLOWERS YET'
        : own
          ? 'FOLLOW SOMEONE TO SEE THEM HERE'
          : 'NOT FOLLOWING ANYONE YET';
  return followRowsHTML(page.entries, {
    empty,
    tag: PF.tabFriends === 'friends' ? 'MUTUAL' : '',
    nextBefore: page.nextBefore,
  });
}

function simFriendsHTML(addr: string): Html {
  const list = friendAddrs(addr)
    .map((a) => ({ a, m: memberOf(a), p: memProfit(a, PF.win) }))
    .sort((x, y) => y.p - x.p)
    .slice(0, 6);
  if (!list.length) return html`<div class="empty">FOLLOW SOMEONE TO SEE THEM HERE</div>`;
  return html`${list.map(
    (o) => html`<div class="friend" data-addr="${attr(o.a)}"><canvas width="60" height="60" data-seed="${attr(o.m.seed)}"
      aria-hidden="true"></canvas><div><div class="fn">${o.m.name}</div><div class="fa">${o.a}</div></div
      ><div class="fp ${ud(o.p)}">${o.p >= 0 ? '+' : '-'}${usd(Math.abs(o.p))}<span>${PF.win.toUpperCase()}</span></div></div>`,
  )}`;
}

function minedHTML(list: SimCoin[]): Html {
  if (!list.length) return html`<div class="empty">NO COINS LAUNCHED YET</div>`;
  return html`${list.map(
    (c) => html`<div class="mine-row" data-sym="${attr(c.sym)}" data-mint="${attr(c.mint || '')}" role="button" tabindex="0"
      ><canvas width="64" height="64" data-seed="${attr(c.seed)}" aria-hidden="true"></canvas
      ><div><div class="sy">${c.sym}</div><div class="mt">${c.name} ${DOT} ${ago(c.age)}${
        typeof c.hold === 'number' ? html` ${DOT} ${num(c.hold)} HOLDER${c.hold === 1 ? '' : 'S'}` : ''
      }</div></div
      ><div style="text-align:right"><div class="am">${usd(c.mc)}</div><div class="mt ${ud(c.chg)}">${pct(c.chg)}</div></div></div>`,
  )}`;
}

/* --------------------------------- page ----------------------------------- */

export function renderProfile(addr?: string): void {
  PF.addr = addr || PF.addr || myProfileAddr() || WALLET.addr;
  const own = isMe(PF.addr as string);
  const live = api.mode === 'live';
  const liveMem = live ? liveMemberFor(PF.addr as string) : undefined;
  const memberKey = liveMem?.addr ?? (PF.addr as string);
  const liveWall = live ? LIVE_WALLS.get(memberKey) ?? LIVE_WALLS.get(PF.addr as string) : undefined;
  const redacted = live && isRedacted(liveMem);

  const m = own
    ? null
    : liveMem
      ? ({
          addr: liveMem.addr,
          seed: hashSeed(liveMem.addr),
          name: liveMem.profile?.username || liveMem.addr.slice(0, 8) + '…',
          bio: liveMem.profile?.bio || 'NO BIO YET.',
          followers: liveMem.followers ?? 0,
          following: liveMem.following ?? 0,
          joined: '—',
          xp: liveMem.xp,
        } satisfies SimMember)
      : live
        ? ({
            addr: PF.addr as string,
            seed: hashSeed(PF.addr as string),
            name: (PF.addr as string).slice(0, 8) + '…',
            bio: 'LOADING…',
            followers: 0,
            following: 0,
            joined: '—',
            xp: 0,
          } satisfies SimMember)
        : memberOf(PF.addr as string);

  const r = own ? rankOf(liveMem?.xp ?? USER.xp) : rankOf(liveMem?.xp ?? (m as SimMember).xp);
  const name = own
    ? liveMem?.profile?.username || myName() || myDisplayName()
    : (m as SimMember).name;
  const bio = own
    ? liveMem?.profile?.bio || myBio()
    : liveMem?.profile?.bio || (live ? (liveMem ? 'NO BIO YET.' : 'LOADING…') : (m as SimMember).bio);
  const links = own
    ? {
        website: liveMem?.profile?.website ?? USER.website ?? null,
        xHandle: liveMem?.profile?.xHandle ?? USER.xHandle ?? null,
        telegram: liveMem?.profile?.telegram ?? USER.telegram ?? null,
      }
    : {
        website: liveMem?.profile?.website ?? null,
        xHandle: liveMem?.profile?.xHandle ?? null,
        telegram: liveMem?.profile?.telegram ?? null,
      };
  const isPrivate = own
    ? !!(liveMem?.profile?.private ?? USER.private)
    : !!liveMem?.private;

  if (liveMem?.profile) {
    rememberIdentity(liveMem.addr, {
      username: liveMem.profile.username,
      avatarUrl: liveMem.profile.avatarUrl,
    });
  }

  const holdings = live
    ? // Only fall back to local HOLD before the first successful hydrate
      // (`liveMem` missing). An empty server list means empty — do not invent.
      own && !liveMem
      ? HOLD
      : (liveMem?.holdings ?? [])
    : own
      ? HOLD
      : memHold(m as SimMember, price);
  const acts = own ? MYTRADES : live ? [] : memTrades(m as SimMember);
  const mine = live
    ? (liveMem?.launched ?? []).map(
        (t) =>
          ({
            sym: t.sym,
            name: t.name,
            mc: t.mc,
            chg: t.chg,
            age: t.age,
            seed: t.seed,
            hold: t.hold ?? 0,
            mint: t.mint,
            net: t.net,
          }) as SimCoin,
      )
    : own
      ? myCoins()
      : coinsBy(PF.addr as string);
  const fees = feeTotal();
  const canClaim = api.mode === 'live' || fees >= 0.01;

  const followers: number | null = live
    ? liveMem
      ? liveMem.followers
      : own
        ? Object.keys(follows()).length
        : 0
    : own
      ? SOCIAL.followers + Object.keys(follows()).length
      : (m as SimMember).followers + (isFollowing(PF.addr as string) ? 1 : 0);
  const following: number | null = live
    ? liveMem
      ? liveMem.following
      : own
        ? Object.keys(follows()).length
        : 0
    : own
      ? SOCIAL.following + Object.keys(follows()).length
      : (m as SimMember).following;

  const sessionHint = live
    ? own
      ? 'YOUR PROFILE'
      : 'MEMBER PROFILE'
    : own
      ? 'YOUR PROFILE ' + DOT + ' SIMULATED WALLET SESSION'
      : 'MEMBER PROFILE ' + DOT + ' JOINED ' + (m as SimMember).joined + ' DAYS AGO';

  const displayAddr = liveMem?.addr || (PF.addr as string);
  const unit = liveMem?.native?.unit || nativeUnit();
  const friendsTitle = live ? 'Friends' : 'Most Profitable Friends';

  render(
    must('#profileView'),
    html`<div style="display:flex;align-items:center;gap:10px">
        <button class="back" id="pf-back">${ARR} BACK</button
        ><span class="hint">${sessionHint}</span></div>
      <div class="pf-bar"><canvas width="128" height="128" id="pfAv" aria-hidden="true"></canvas
        ><div class="pf-id"><div class="pf-name"><h1>${name}</h1><span class="addr">${displayAddr}</span>${
          isPrivate ? privateBadgeHTML() : ''
        }${liveMem?.followsYou ? html`<span class="pf-you">FOLLOWS YOU</span>` : ''}</div
          ><div class="pf-bio">${bio || 'NO BIO YET.'}</div>${linksHTML(links)}</div
        ><div class="pf-social">
          <div><span class="lbl">FOLLOWERS</span><div class="v">${followers == null ? '—' : num(followers)}</div></div
          ><div><span class="lbl">FOLLOWING</span><div class="v">${following == null ? '—' : num(following)}</div></div>
        </div
      >${own
        ? html`<button class="pf-rank" id="pfRank" title="Open rewards"><span class="lv">${r.i + 1}</span
            ><div><div class="nm">${r.name}</div><div class="sub">${r.next === null ? 'MAX RANK' : num(r.toNext) + ' XP TO ' + (RANKS[r.i + 1] as (typeof RANKS)[number])[0]}</div></div></button
            ><span class="pf-acts"><button class="editbtn" id="pfEdit">EDIT PROFILE</button></span>`
        : html`<div class="pf-rank"><span class="lv">${r.i + 1}</span
            ><div><div class="nm">${r.name}</div><div class="sub">RANK ${r.i + 1} OF ${RANKS.length}</div></div></div
            ><span class="pf-acts"><button class="followbtn${
              (live ? !!liveMem?.isFollowing : isFollowing(displayAddr)) ? ' on' : ''
            }" id="pfFollow"${live && !liveMem ? ' disabled' : ''}>${
              live && !liveMem
                ? 'LOADING…'
                : (live ? !!liveMem?.isFollowing : isFollowing(displayAddr))
                  ? 'FOLLOWING'
                  : 'FOLLOW'
            }</button></span>`}</div
      >${quadHTML(own, m, liveMem)}
      <div class="pf-grid">
        <div style="display:flex;flex-direction:column;gap:10px">
          <section class="pnl"><div class="pnl-hd"><h2>Portfolio</h2
            ><span class="pnl-tabs"><button class="tab${PF.tabHold === 'holdings' ? ' on' : ''}" data-ptab="holdings">HOLDINGS</button
              ><button class="tab${PF.tabHold === 'staked' ? ' on' : ''}" data-ptab="staked">STAKED</button></span
            >${own && PF.tabHold === 'staked' ? html`<button class="hdbtn" id="claimAllBtn">CLAIM ALL</button>` : ''}</div
            ><div id="pfHold">${
              redacted
                ? privateNoticeHTML('holdings and pnl are')
                : PF.tabHold === 'holdings'
                  ? live && liveMem
                    ? html`${holdingsTableHTML(liveMem.holdings ?? [])}${pnlSummaryHTML(liveMem.pnl)}`
                    : simHoldRows(holdings)
                  : own
                    ? stakedPanelHTML()
                    : live
                      ? stakedRowsHTML(liveMem?.staked ?? [], unit, Date.now())
                      : html`<div class="empty">STAKED POSITIONS ARE PRIVATE</div>`
            }</div></section
          ><section class="pnl"><div class="pnl-hd"><h2>Wall</h2
            ><span class="pnl-tabs"><button class="tab${PF.tabAct === 'shout' ? ' on' : ''}" data-atab="shout">SHOUTBOX</button
              ><button class="tab${PF.tabAct === 'act' ? ' on' : ''}" data-atab="act">RECENT ACTIVITY</button></span></div
            ><div id="pfAct">${
              redacted
                ? privateNoticeHTML('the wall and recent activity are')
                : PF.tabAct === 'shout'
                  ? shoutHTML(displayAddr, own, liveWall)
                  : live
                    ? liveActivityHTML(memberKey)
                    : actRows(acts)
            }</div></section>
        </div>
        <div style="display:flex;flex-direction:column;gap:10px">
          <section class="pnl"><div class="pnl-hd"><h2>${own ? 'Coins You Launched' : 'Coins Launched'}</h2
            >${own ? html`<button class="hdbtn" id="claimBtn"${canClaim ? '' : ' disabled'}>CLAIM FEES</button>` : ''}</div
            ><div id="pfMine">${minedHTML(mine)}</div
            >${own ? html`<div class="pnl-note">DEPLOYING A COIN PAYS 50 XP ${DOT} BONDING PAYS 250 XP ${DOT} LP BURNS AT ${usd(currentParams().gradUsd)}</div>` : ''}</section
          ><section class="pnl"><div class="pnl-hd"><h2>${friendsTitle}</h2
            ><span class="pnl-tabs">${
              live
                ? (['friends', 'followers', 'following'] as const).map(
                    (t) => html`<button class="tab${PF.tabFriends === t ? ' on' : ''}" data-ftab="${t}">${t.toUpperCase()}</button>`,
                  )
                : (['24h', '7d', '1m'] as const).map(
                    (w) => html`<button class="tab${PF.win === w ? ' on' : ''}" data-fwin="${w}">${w.toUpperCase()}</button>`,
                  )
            }</span></div
            ><div id="pfFriends">${
              redacted
                ? privateNoticeHTML('friends are')
                : live
                  ? liveMem
                    ? liveFriendsHTML(memberKey, own)
                    : html`<div class="empty">LOADING…</div>`
                  : simFriendsHTML(displayAddr)
            }</div></section>
        </div>
      </div>`,
  );

  const avUrl = own
    ? USER.avatarUrl ?? liveMem?.profile?.avatarUrl ?? null
    : liveMem?.profile?.avatarUrl ?? null;
  paintAvatar($<HTMLCanvasElement>('#pfAv'), {
    seed: own ? WALLET.full || WALLET.seed : liveMem ? liveMem.addr : (m as SimMember).addr || (PF.addr as string),
    avatarUrl: avUrl,
    size: 52,
  });
  paintMine();
  paintFriends();
  must('#pf-back').addEventListener('click', () => back());
  if (own) {
    $('#pfRank')?.addEventListener('click', () => navigate({ view: 'rewards' }));
    $('#pfEdit')?.addEventListener('click', (e) => openEdit(e.currentTarget as Element));
    const cb = $('#claimBtn') as HTMLButtonElement | null;
    cb?.addEventListener('click', () => {
      if (!cb.disabled) openClaim();
    });
    $('#claimAllBtn')?.addEventListener('click', () => void claimAllStakes());
  } else {
    $('#pfFollow')?.addEventListener('click', () => {
      void onFollowClick(displayAddr);
    });
    $('#shoutForm')?.addEventListener('submit', (e) => {
      e.preventDefault();
      postShout(displayAddr);
    });
  }

  // Live: hydrate from the API after first paint so we never flash RNG flavour.
  if (live && PF.addr && !LIVE_HYDRATED.has(PF.addr) && !(liveMem && LIVE_HYDRATED.has(liveMem.addr))) {
    void hydrate(PF.addr, own);
  } else if (live && liveMem && !redacted) {
    // Lazy sub-resources for the open tabs.
    if (PF.tabAct === 'act' && !LIVE_ACTS.has(memberKey)) void loadActivity(liveMem.net, memberKey, null);
    if (!LIVE_FRIENDS.has(memberKey + ':' + PF.tabFriends))
      void loadFriends(liveMem.net, memberKey, PF.tabFriends, null);
  }
}

function profileNetFor(target: string): Net {
  // An 0x address could be on RH, Base or Arc; prefer the net of a coin this
  // wallet created, then the session's net, then RH.
  const created = coinsBy(target)[0];
  const evmHint = created?.net && isEvm(created.net) ? created.net : isEvm(WALLET.net) ? WALLET.net : 'RH';
  return inferNetFromAddress(target, evmHint);
}

async function hydrate(target: string, own: boolean): Promise<void> {
  if (LOADING.has(target)) return;
  LOADING.add(target);
  const profileNet = profileNetFor(target);
  try {
    const mem = await fetchMember(profileNet, target).catch(() => null);
    if (PF.addr !== target && (!mem || PF.addr !== mem.addr)) return;
    if (!mem) {
      toast('PROFILE LOAD FAILED', 'red');
      LIVE_WALLS.set(target, { posts: [], nextBefore: null });
      LIVE_HYDRATED.add(target);
      renderProfile(target);
      return;
    }
    LIVE_HYDRATED.add(target);
    LIVE_MEMBERS.set(target, mem);
    LIVE_MEMBERS.set(mem.addr, mem);
    if (mem.profile?.username) {
      LIVE_MEMBERS.set(mem.profile.username, mem);
      LIVE_HYDRATED.add(mem.profile.username);
    }
    LIVE_HYDRATED.add(mem.addr);
    // Mirror *own* outgoing follows into local state for sim-only reads.
    // Never copy another member's following list into USER.follow.
    if (own && mem.followingWallets) {
      for (const w of mem.followingWallets) {
        if (!isFollowing(w)) toggleFollow(w);
      }
    }
    PF.addr = mem.addr;
    if (isRedacted(mem)) {
      LIVE_WALLS.set(mem.addr, { posts: [], nextBefore: null });
      renderProfile(mem.addr);
      return;
    }
    const wall = await fetchWall(mem.net, mem.addr).catch(() => null);
    const wallState = { posts: wall?.posts ?? [], nextBefore: wall?.nextBefore ?? null };
    for (const p of wallState.posts) {
      if (p.fromUsername !== undefined || p.fromAvatarUrl !== undefined)
        rememberIdentity(p.from, { username: p.fromUsername ?? null, avatarUrl: p.fromAvatarUrl ?? null });
    }
    LIVE_WALLS.set(mem.addr, wallState);
    LIVE_WALLS.set(target, wallState);
    renderProfile(mem.addr);
  } finally {
    LOADING.delete(target);
  }
}

async function loadActivity(net: Net, key: string, before: number | null): Promise<void> {
  const lk = 'act:' + key + ':' + (before ?? 0);
  if (LOADING.has(lk)) return;
  LOADING.add(lk);
  try {
    const page = await fetchActivity(net, key, { before, limit: 30 });
    const prev = before ? LIVE_ACTS.get(key) : undefined;
    const seen = new Set((prev?.items ?? []).map((i) => i.id));
    const items = [...(prev?.items ?? []), ...page.items.filter((i) => !seen.has(i.id))];
    LIVE_ACTS.set(key, { items, nextBefore: page.nextBefore });
    for (const i of items) if (i.target) void i.target;
  } catch (err) {
    LIVE_ACTS.set(key, { items: [], nextBefore: null });
    if (!(err instanceof SocialApiError && (err.code === 'private_profile' || err.code === 'not_found')))
      toast('ACTIVITY LOAD FAILED', 'red');
  } finally {
    LOADING.delete(lk);
    if (PF.addr === key || liveMemberFor(PF.addr as string)?.addr === key) renderProfile(PF.addr as string);
  }
}

async function loadFriends(net: Net, key: string, tab: FriendsTab, before: number | null): Promise<void> {
  const ck = key + ':' + tab;
  const lk = 'fr:' + ck + ':' + (before ?? 0);
  if (LOADING.has(lk)) return;
  LOADING.add(lk);
  try {
    const prev = before ? LIVE_FRIENDS.get(ck) : undefined;
    let entries: LiveFollowEntry[];
    let nextBefore: number | null = null;
    if (tab === 'friends') {
      entries = (await fetchFriends(net, key)).entries;
    } else {
      const page = await fetchFollowList(net, key, tab, { before, limit: 24 });
      entries = page.entries;
      nextBefore = page.nextBefore;
    }
    for (const e of entries) rememberIdentity(e.wallet, { username: e.username, avatarUrl: e.avatarUrl });
    const seen = new Set((prev?.entries ?? []).map((e) => e.wallet));
    LIVE_FRIENDS.set(ck, {
      entries: [...(prev?.entries ?? []), ...entries.filter((e) => !seen.has(e.wallet))],
      nextBefore,
    });
  } catch (err) {
    LIVE_FRIENDS.set(ck, { entries: [], nextBefore: null });
    if (!(err instanceof SocialApiError && (err.code === 'private_profile' || err.code === 'not_found')))
      toast('FRIENDS LOAD FAILED', 'red');
  } finally {
    LOADING.delete(lk);
    if (PF.addr === key || liveMemberFor(PF.addr as string)?.addr === key) renderProfile(PF.addr as string);
  }
}

async function loadMoreWall(key: string, before: number): Promise<void> {
  const mem = liveMemberFor(key);
  if (!mem) return;
  const lk = 'wall:' + mem.addr + ':' + before;
  if (LOADING.has(lk)) return;
  LOADING.add(lk);
  try {
    const page = await fetchWall(mem.net, mem.addr, { before, limit: 30 });
    const prev = LIVE_WALLS.get(mem.addr) ?? { posts: [], nextBefore: null };
    const seen = new Set(prev.posts.map((p) => p.id));
    const state = {
      posts: [...prev.posts, ...page.posts.filter((p) => !seen.has(p.id))],
      nextBefore: page.nextBefore ?? null,
    };
    LIVE_WALLS.set(mem.addr, state);
    LIVE_WALLS.set(key, state);
  } catch {
    toast('WALL LOAD FAILED', 'red');
  } finally {
    LOADING.delete(lk);
    if (PF.addr === key || PF.addr === mem.addr) renderProfile(PF.addr as string);
  }
}

function hashSeed(addr: string): number {
  let h = 0;
  for (let i = 0; i < addr.length; i++) h = (h * 31 + addr.charCodeAt(i)) | 0;
  return Math.abs(h) % 1_000_000;
}

function paintFriends(): void {
  for (const cv of $$<HTMLCanvasElement>('#pfFriends canvas')) {
    const avatarUrl = cv.dataset['avatar'] || null;
    cv.classList.toggle('has-img', !!avatarUrl);
    paintAvatar(cv, { seed: cv.dataset['seed'] || '0', avatarUrl, size: 40 });
  }
}

function paintMine(): void {
  for (const cv of $$<HTMLCanvasElement>('#pfMine canvas')) pix(cv, Number(cv.dataset['seed']));
}

/**
 * Toggles a follow. Live mode calls the real `POST`/`DELETE /follow/:net/:addr`
 * (`routes/social.ts`) so the relationship survives a reload on the server's
 * own `follows` table; the local `USER.follow` mirror still updates too so
 * the button and friend list stay in sync with `state/social.ts`'s other
 * sim-only reads (friend PnL, avatars) that Phase 5 does not replace.
 */
async function onFollowClick(addr: string): Promise<void> {
  if (api.mode === 'live' && !WALLET.on) {
    toast('CONNECT A WALLET TO FOLLOW', 'red');
    return;
  }
  const liveMem = liveMemberFor(addr);
  if (api.mode === 'live' && !liveMem) {
    toast('PROFILE STILL LOADING', 'red');
    return;
  }
  const target = liveMem?.addr || addr;
  // Live mode: the server's `isFollowing` is truth. Local `USER.follow` can
  // lag after a reload and was making every click look like a fresh FOLLOW.
  const wasFollowing = api.mode === 'live' ? !!liveMem?.isFollowing : isFollowing(target);
  if (api.mode === 'live') {
    try {
      const res = wasFollowing
        ? await liveUnfollow(WALLET.net, target)
        : await liveFollow(WALLET.net, target);
      const mem = LIVE_MEMBERS.get(target) || liveMem;
      if (mem) mem.isFollowing = res.following;
      // Keep the local mirror aligned for sim-only friend lists.
      if (res.following !== isFollowing(target)) toggleFollow(target);
      // Optimistically bump follower counts on the cached member.
      if (mem && res.following !== wasFollowing && mem.followers != null) {
        mem.followers = Math.max(0, mem.followers + (res.following ? 1 : -1));
      }
      // Follow lists changed on both sides.
      for (const k of [...LIVE_FRIENDS.keys()]) {
        if (k.startsWith(target + ':') || k.startsWith(WALLET.full + ':')) LIVE_FRIENDS.delete(k);
      }
      const now = !!mem?.isFollowing;
      toast((now ? 'FOLLOWING ' : 'UNFOLLOWED ') + (mem?.profile?.username || displayName(target)));
      if (now && !wasFollowing) unlock('social');
      renderProfile(target);
    } catch (err) {
      toast(err instanceof SocialApiError ? err.message : 'FOLLOW FAILED', 'red');
    }
    return;
  }
  toggleFollow(target);
  const now = isFollowing(target);
  toast((now ? 'FOLLOWING ' : 'UNFOLLOWED ') + displayName(target));
  if (now && !wasFollowing) unlock('social');
  renderProfile(target);
}

/**
 * Live mode: attempts a real transfer (`app/tip.ts`), then `POST
 * /wall/:net/:addr` with the confirmed signature — the server re-verifies
 * the amount and sender on-chain itself (`social/tips.ts`'s `verifyTip`),
 * so nothing asserted here is trusted. The practice wallet is never funded,
 * so this is expected to fail with a clear reason rather than silently fall
 * back to the simulated post.
 */
async function liveShout(addr: string, txt: string, tip: number): Promise<void> {
  let sig: string;
  try {
    sig = await attemptTip(WALLET.net, addr, tip);
  } catch (err) {
    toast(err instanceof TipBroadcastError ? err.message : 'TIP FAILED ' + DOT + ' NO FUNDED WALLET', 'red');
    return;
  }
  try {
    const res = await postWallTip(WALLET.net, addr, txt, sig);
    toast(
      'TIPPED ' +
        tip.toFixed(4) +
        ' ' +
        nativeUnit() +
        ' TO ' +
        (LIVE_MEMBERS.get(addr)?.profile?.username || addr.slice(0, 8)),
    );
    if (res.flagged) toast('POST HIDDEN ' + DOT + ' IT TRIPPED THE WORD FILTER', 'red');
    unlock('social');
    invalidateProfile(addr);
    renderProfile(addr);
  } catch (err) {
    toast(
      err instanceof SocialApiError
        ? err.message + ' ' + DOT + ' TIP ALREADY SENT ON CHAIN'
        : 'WALL POST FAILED ' + DOT + ' TIP ALREADY SENT ON CHAIN',
      'red',
    );
  }
}

/** Sim wall tip + post. Live uses `liveShout`. */
function postShout(addr: string): void {
  const txt = (($('#shout-txt') as HTMLInputElement | null)?.value || '').trim();
  const tip = parseFloat(($('#shout-tip') as HTMLInputElement | null)?.value ?? '') || 0;
  const unit = nativeUnit();
  if (!txt) {
    toast('WRITE SOMETHING FIRST');
    return;
  }
  if (txt.length > 140) {
    toast('KEEP IT UNDER 140 CHARACTERS');
    return;
  }
  if (tip < minTip()) {
    toast('MINIMUM TIP IS ' + minTip() + ' ' + unit);
    return;
  }
  if (api.mode === 'live') {
    const mem = liveMemberFor(addr);
    if (mem && isRedacted(mem)) {
      toast('THIS WALL IS PRIVATE', 'red');
      return;
    }
    void liveShout(addr, txt, tip);
    return;
  }
  if (tip > WALLET.sol) {
    toast('NOT ENOUGH ' + unit + ' IN THE WALLET');
    return;
  }
  WALLET.sol -= tip;
  postToWall(addr, { from: WALLET.addr, text: txt, tip, t: 'now', mine: true });
  toast('TIPPED ' + tip.toFixed(4) + ' ' + unit + ' TO ' + memberOf(addr).name + ' ' + DOT + ' SIMULATED');
  addXP(1, 'WALL POST');
  unlock('social');
  renderProfile(addr);
}

async function claimStakeFor(sym: string): Promise<void> {
  try {
    const res = await api.claimStake(sym);
    if (res.tokens <= 0 && res.native <= 0) {
      toast('NOTHING TO CLAIM YET');
      return;
    }
    const parts = [
      res.tokens > 0 ? num(res.tokens) + ' ' + sym : '',
      res.tokens > 0 && res.native > 0 ? ' + ' : '',
      res.native > 0 ? res.native.toFixed(4) + ' ' + nativeUnit() : '',
    ];
    toast('CLAIMED ' + parts.join(''));
    saveUser();
    renderProfile(PF.addr as string);
  } catch (err) {
    toast(err instanceof Error ? err.message.toUpperCase() : 'CLAIM FAILED', 'red');
  }
}

async function claimAllStakes(): Promise<void> {
  const list = stakedList().filter(
    (o) => (o.st.rewTok || 0) > 0.0001 || (o.st.rewSol || 0) > 0.000001 || (o.st.rewBase || 0) > 0,
  );
  if (!list.length) {
    toast('NOTHING TO CLAIM YET');
    return;
  }
  let ok = 0;
  for (const o of list) {
    try {
      await api.claimStake(o.c.sym);
      ok += 1;
    } catch (err) {
      toast(err instanceof Error ? err.message.toUpperCase() : 'CLAIM FAILED', 'red');
      break;
    }
  }
  if (ok > 0) toast('CLAIMED ' + ok + ' POSITION' + (ok > 1 ? 'S' : ''));
  renderProfile(PF.addr as string);
}

/** Patch the numbers that move under a live profile. Never inject sim memberOf data. */
export function syncProfile(): void {
  if (must('#profileView').hidden) return;
  const addr = PF.addr;
  if (!addr) return;
  const own = isMe(addr);
  const live = api.mode === 'live';
  const liveMem = live ? liveMemberFor(addr) : undefined;
  const q = $('#pfQuad');
  if (q) replaceWith(q, quadHTML(own, own || live ? null : memberOf(addr), liveMem));
  if (live && isRedacted(liveMem)) return;
  if (PF.tabHold === 'holdings') {
    if (live && liveMem) {
      render($('#pfHold'), html`${holdingsTableHTML(liveMem.holdings ?? [])}${pnlSummaryHTML(liveMem.pnl)}`);
    } else {
      const holdings = live
        ? own && !liveMem
          ? HOLD
          : (liveMem?.holdings ?? [])
        : own
          ? HOLD
          : memHold(memberOf(addr), price);
      render($('#pfHold'), simHoldRows(holdings));
    }
  } else if (own) {
    render($('#pfHold'), stakedPanelHTML());
  }
  if (own) {
    const fees = feeTotal();
    const e = $('#pfEarn');
    const es = $('#pfEarnSub');
    const cb = $('#claimBtn') as HTMLButtonElement | null;
    if (e) e.textContent = fees.toFixed(3);
    if (es) es.textContent = usd(fees * NATIVE_PRICE.usd) + ' UNCLAIMED';
    if (cb) cb.disabled = api.mode === 'sim' && fees < 0.01;
  }
}

export function openProfile(addr?: string): void {
  if (!WALLET.on && !addr) {
    toast('CONNECT A WALLET FIRST');
    return;
  }
  PF.addr = addr || myProfileAddr() || WALLET.addr;
  // Re-fetch when reopening so follow counts stay fresh.
  if (api.mode === 'live' && PF.addr) invalidateProfile(PF.addr);
  renderProfile(PF.addr);
  showView('profile');
  window.scrollTo(0, 0);
}

export function initProfileView(): void {
  must('#profileView').addEventListener('click', (e) => {
    const target = e.target as Element | null;
    const likeBtn = target?.closest<HTMLElement>('[data-like]');
    if (likeBtn && api.mode === 'live') {
      const postId = Number.parseInt(likeBtn.dataset['like'] ?? '', 10);
      if (!Number.isFinite(postId)) return;
      void (async () => {
        try {
          const res = await likeWallPost(WALLET.net, postId);
          if (res.xpAwarded > 0) toast('+' + res.xpAwarded + ' XP FOR LIKE', 'gold');
          else if (res.already) toast('ALREADY LIKED');
          else toast('LIKED');
          // Bump local count.
          for (const [key, wall] of LIVE_WALLS) {
            const hit = wall.posts.find((p) => p.id === postId);
            if (hit) {
              hit.likes = (hit.likes ?? 0) + (res.already ? 0 : 1);
              LIVE_WALLS.set(key, { ...wall, posts: [...wall.posts] });
            }
          }
          if (PF.addr) renderProfile(PF.addr);
        } catch (err) {
          toast(err instanceof Error ? err.message : 'LIKE FAILED');
        }
      })();
      return;
    }
    const more = target?.closest<HTMLElement>('.pf-more');
    if (more && api.mode === 'live' && PF.addr) {
      const before = Number(more.dataset['before']);
      const mem = liveMemberFor(PF.addr);
      if (!mem || !Number.isFinite(before)) return;
      (more as HTMLButtonElement).disabled = true;
      if (more.id === 'pfActMore') void loadActivity(mem.net, mem.addr, before);
      else if (more.id === 'pfFriendsMore') void loadFriends(mem.net, mem.addr, PF.tabFriends, before);
      else if (more.id === 'pfWallMore') void loadMoreWall(mem.addr, before);
      return;
    }
    const t = target?.closest<HTMLElement>('[data-ptab]');
    const a = target?.closest<HTMLElement>('[data-atab]');
    const w = target?.closest<HTMLElement>('[data-fwin]');
    const f = target?.closest<HTMLElement>('[data-ftab]');
    if (t) {
      PF.tabHold = t.dataset['ptab'] as ProfileState['tabHold'];
      renderProfile(PF.addr as string);
      return;
    }
    if (a) {
      PF.tabAct = a.dataset['atab'] as ProfileState['tabAct'];
      renderProfile(PF.addr as string);
      return;
    }
    if (w) {
      PF.win = w.dataset['fwin'] as ProfileState['win'];
      renderProfile(PF.addr as string);
      return;
    }
    if (f) {
      PF.tabFriends = f.dataset['ftab'] as FriendsTab;
      renderProfile(PF.addr as string);
      return;
    }
    const st = target?.closest<HTMLElement>('[data-claim]');
    if (st) {
      void claimStakeFor(st.dataset['claim'] as string);
      return;
    }
    const friend = target?.closest<HTMLElement>('.friend[data-addr]');
    if (friend) {
      navigate({ view: 'profile', addr: friend.dataset['addr'] as string });
      return;
    }
    const link = target?.closest<HTMLElement>('.addrlink');
    if (link) {
      navigate({ view: 'profile', addr: link.dataset['addr'] as string });
      return;
    }
    const row = target?.closest<HTMLElement>('[data-stk], .pf-hold tr[data-sym]');
    if (row) {
      const mint = row.dataset['mint'];
      const sym = (row.dataset['stk'] ?? row.dataset['sym']) as string;
      navigate({ view: 'token', sym, ...(mint ? { mint } : {}) });
      return;
    }
    const mn = target?.closest<HTMLElement>('#pfMine [data-sym]');
    if (mn) {
      const mint = mn.dataset['mint'];
      navigate({
        view: 'token',
        sym: mn.dataset['sym'] as string,
        ...(mint ? { mint } : {}),
      });
    }
  });
}

/** The rewards page is reachable from the profile rank chip. */
export { openRewards };
