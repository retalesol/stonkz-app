import {
  GRAD,
  RANKS,
  ago,
  inCashback,
  inferNetFromAddress,
  isEvm,
  num,
  pct,
  price,
  rankOf,
  usd,
} from '@stonkz/shared';
import { api } from '../api/index.js';
import {
  follow as liveFollow,
  likeWallPost,
  postWallTip,
  unfollow as liveUnfollow,
  fetchMember,
  fetchWall,
  SocialApiError,
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
import { openClaim } from '../modals/claim.js';
import { openEdit } from '../modals/edit.js';
import { openRewards } from './rewards.js';

/**
 * Member profiles: your own wallet, or anyone whose address appears in a
 * table, on a card or on the tape.
 *
 * Live mode reads `GET /users/:net/:addr` and `GET /wall/:net/:addr` rather
 * than the RNG `memberOf` / `wallOf` generators. Sim keeps those generators.
 */

/** Live profile cache so re-renders after follow/tip do not flash RNG flavour. */
const LIVE_MEMBERS = new Map<string, LiveMember>();
const LIVE_WALLS = new Map<string, LiveWallPost[]>();
const LIVE_HYDRATED = new Set<string>();


export interface ProfileState {
  addr: string | null;
  tabHold: 'holdings' | 'staked';
  tabAct: 'shout' | 'act';
  win: '24h' | '7d' | '1m';
}

export const PF: ProfileState = { addr: null, tabHold: 'holdings', tabAct: 'shout', win: '24h' };

export function feeTotal(): number {
  return myCoins().reduce((t, c) => t + (c.fee ?? 0), 0);
}

export function feeTokensTotal(): number {
  return myCoins().reduce((t, c) => t + (c.feeTokens ?? 0), 0);
}

/* -------------------------------- blocks ---------------------------------- */

function liveQuadHTML(mem: LiveMember): Html {
  const r = rankOf(mem.xp);
  const launched = mem.launched?.length ?? 0;
  const bal = mem.native?.balance;
  const unit = mem.native?.unit || nativeUnit();
  return html`<div class="quad" id="pfQuad">
    <div><div class="lbl">${unit} BALANCE</div><div class="val up">${bal == null ? '—' : Number(bal).toFixed(2)}</div></div
    ><div><div class="lbl">PORTFOLIO</div><div class="val am">${usd(mem.portfolioUsd ?? 0)}</div></div
    ><div><div class="lbl">COINS LAUNCHED</div><div class="val gd">${launched}</div></div
    ><div><div class="lbl">TOTAL XP</div><div class="val">${num(mem.xp)}<span class="hint"> ${DOT} LV ${r.i + 1}</span></div></div>
  </div>`;
}

function quadHTML(own: boolean, m: SimMember | null, liveMem?: LiveMember): Html {
  if (api.mode === 'live' && liveMem) return liveQuadHTML(liveMem);
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
      ><div><div class="lbl">STONK OPTIONZ</div><div class="val gd">${num(USER.optionz ?? 0)}</div></div
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

function holdRows(list: Array<{ sym: string; tok: number; cost: number; value?: number }>): Html {
  if (!list.length) return html`<div class="empty">NO POSITIONS</div>`;
  return html`<table class="tbl"><thead><tr><th scope="col">TOKEN</th><th scope="col" class="r">AMOUNT</th
    ><th scope="col" class="r">VALUE</th><th scope="col" class="r">COST</th><th scope="col" class="r">PNL</th></tr></thead><tbody
    >${list.map((h) => {
      const c = bySym(h.sym);
      const v = h.value ?? (c ? h.tok * price(c) : 0);
      const cost = h.cost || 0;
      const p = cost > 0 ? (v / cost - 1) * 100 : 0;
      return html`<tr><td class="gd">${h.sym}</td><td class="r">${num(h.tok)}</td><td class="r">${usd(v)}</td
        ><td class="r dm">${cost > 0 ? usd(cost) : '—'}</td><td class="r ${cost > 0 ? ud(p) : 'dm'}">${
          cost > 0 ? pct(p) : '—'
        }</td></tr>`;
    })}</tbody></table>`;
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

/** Staked positions and their unclaimed rewards. `index.html:3213` */
function stakedPanelHTML(): Html {
  const list = stakedList();
  if (!list.length) return html`<div class="empty">NO STAKED POSITIONS ${DOT}<br>OPEN A TOKEN AND HIT STAKE</div>`;
  return html`${list.map(({ c, st }) => {
    const cb = inCashback(c);
    const locked = st.until > Date.now();
    const earn = cb ? num(st.rewTok || 0) + ' ' + c.sym : (st.rewSol || 0).toFixed(4) + ' ' + nativeUnit();
    return html`<div class="stk-row" data-stk="${attr(c.sym)}" data-mint="${attr(c.mint || '')}">
      <div><div class="sy">${c.sym}${locked ? html`<span class="lockbadge">${st.mult}x ${st.days}D</span>` : ''}</div
        ><div class="mt">${num(st.amt)} STAKED ${DOT} ${(yourShare(c) * 100).toFixed(2)}% OF POOL</div></div
      ><div class="earn"><b>${earn}</b><span>${cb ? 'CASHBACK' : 'FEES'}</span></div
      ><button type="button" class="claimbtn" data-claim="${attr(c.sym)}">CLAIM</button></div>`;
  })}`;
}

function shoutHTML(addr: string, own: boolean, livePosts?: LiveWallPost[] | null): Html {
  const tip = minTip();
  const live = api.mode === 'live';
  const liveWho = LIVE_MEMBERS.get(addr)?.profile?.username?.trim();
  const who = own
    ? myDisplayName()
    : liveWho || displayName(addr);

  const postsHtml =
    live && livePosts === undefined
      ? [html`<div class="empty">LOADING WALL…</div>`]
      : live && livePosts
        ? livePosts.length
          ? livePosts.map((o) => {
              const mine = isMe(o.from) || o.from === WALLET.full;
              const fromName = displayName(o.from);
              const likes = o.likes ?? 0;
              const likeBtn =
                typeof o.id === 'number'
                  ? html` <button type="button" class="tip" data-like="${attr(o.id)}" title="Like">♥ ${likes}</button>`
                  : html` <span class="tip">♥ ${likes}</span>`;
              return html`<div class="shout${mine ? ' mine' : ''}"><div class="sh-hd"
                ><span class="who addrlink" data-addr="${attr(o.from)}">${fromName}</span
                ><span class="tip">+${Number(o.tip).toFixed(4)} ${nativeUnit()}</span
                >${likeBtn}<span class="t">${clockSec(new Date(o.createdAtMs))}</span></div
                ><p>${o.text}</p></div>`;
            })
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

function friendsHTML(addr: string): Html {
  if (api.mode === 'live') {
    const liveMem = LIVE_MEMBERS.get(addr);
    const followed = liveMem?.followingWallets?.length
      ? liveMem.followingWallets
      : Object.keys(follows());
    if (!followed.length) {
      return html`<div class="empty">${
        liveMem ? 'FOLLOW SOMEONE TO SEE THEM HERE' : 'LOADING…'
      }</div>`;
    }
    return html`${followed.slice(0, 6).map(
      (a) => {
        const lm = LIVE_MEMBERS.get(a);
        const name = lm?.profile?.username || a.slice(0, 8) + '…';
        return html`<div class="friend" data-addr="${attr(a)}"><canvas width="60" height="60" data-seed="${attr(
          (hashSeed(a)),
        )}" aria-hidden="true"></canvas><div><div class="fn">${name}</div><div class="fa">${a.slice(0, 10)}…</div></div
          ><div class="fp dm">—<span>LIVE</span></div></div>`;
      },
    )}`;
  }
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

function hashSeed(addr: string): number {
  let h = 0;
  for (let i = 0; i < addr.length; i++) h = (h * 31 + addr.charCodeAt(i)) | 0;
  return Math.abs(h) % 1_000_000;
}

function minedHTML(list: SimCoin[]): Html {
  if (!list.length) return html`<div class="empty">NO COINS LAUNCHED YET</div>`;
  return html`${list.map(
    (c) => html`<div class="mine-row" data-sym="${attr(c.sym)}" data-mint="${attr(c.mint || '')}" role="button" tabindex="0"
      ><canvas width="64" height="64" data-seed="${attr(c.seed)}" aria-hidden="true"></canvas
      ><div><div class="sy">${c.sym}</div><div class="mt">${c.name} ${DOT} ${ago(c.age)}</div></div
      ><div style="text-align:right"><div class="am">${usd(c.mc)}</div><div class="mt ${ud(c.chg)}">${pct(c.chg)}</div></div></div>`,
  )}`;
}

/* --------------------------------- page ----------------------------------- */

export function renderProfile(addr?: string): void {
  PF.addr = addr || PF.addr || myProfileAddr() || WALLET.addr;
  const own = isMe(PF.addr as string);
  const live = api.mode === 'live';
  const liveMem = live
    ? LIVE_MEMBERS.get(PF.addr as string) ||
      [...LIVE_MEMBERS.values()].find(
        (m) => m.addr === PF.addr || m.profile?.username?.toLowerCase() === String(PF.addr).toLowerCase(),
      )
    : undefined;
  const liveWall = live
    ? LIVE_WALLS.get(PF.addr as string) || (liveMem ? LIVE_WALLS.get(liveMem.addr) : undefined)
    : undefined;

  const m = own
    ? null
    : liveMem
      ? ({
          addr: liveMem.addr,
          seed: hashSeed(liveMem.addr),
          name: liveMem.profile?.username || liveMem.addr.slice(0, 8) + '…',
          bio: liveMem.profile?.bio || 'NO BIO YET.',
          followers: liveMem.followers,
          following: liveMem.following,
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

  const r = own ? rankOf(USER.xp) : rankOf(liveMem?.xp ?? (m as SimMember).xp);
  const name = own
    ? liveMem?.profile?.username || myName() || myDisplayName()
    : (m as SimMember).name;
  const bio = own
    ? liveMem?.profile?.bio || myBio()
    : liveMem?.profile?.bio || (live ? (liveMem ? 'NO BIO YET.' : 'LOADING…') : (m as SimMember).bio);

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
          }) as SimCoin,
      )
    : own
      ? myCoins()
      : coinsBy(PF.addr as string);
  const fees = feeTotal();
  const canClaim = api.mode === 'live' || fees >= 0.01;

  const followers = live
    ? liveMem?.followers ?? (own ? Object.keys(follows()).length : 0)
    : own
      ? SOCIAL.followers + Object.keys(follows()).length
      : (m as SimMember).followers + (isFollowing(PF.addr as string) ? 1 : 0);
  const following = live
    ? liveMem?.following ?? (own ? Object.keys(follows()).length : 0)
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

  render(
    must('#profileView'),
    html`<div style="display:flex;align-items:center;gap:10px">
        <button class="back" id="pf-back">${ARR} BACK</button
        ><span class="hint">${sessionHint}</span></div>
      <div class="pf-bar"><canvas width="128" height="128" id="pfAv" aria-hidden="true"></canvas
        ><div class="pf-id"><div class="pf-name"><h1>${name}</h1><span class="addr">${displayAddr}</span></div
          ><div class="pf-bio">${bio || 'NO BIO YET.'}</div></div
        ><div class="pf-social">
          <div><span class="lbl">FOLLOWERS</span><div class="v">${num(followers)}</div></div
          ><div><span class="lbl">FOLLOWING</span><div class="v">${num(following)}</div></div>
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
              PF.tabHold === 'holdings'
                ? holdRows(holdings)
                : own
                  ? stakedPanelHTML()
                  : html`<div class="empty">STAKED POSITIONS ARE PRIVATE</div>`
            }</div></section
          ><section class="pnl"><div class="pnl-hd"><h2>Wall</h2
            ><span class="pnl-tabs"><button class="tab${PF.tabAct === 'shout' ? ' on' : ''}" data-atab="shout">SHOUTBOX</button
              ><button class="tab${PF.tabAct === 'act' ? ' on' : ''}" data-atab="act">RECENT ACTIVITY</button></span></div
            ><div id="pfAct">${PF.tabAct === 'shout' ? shoutHTML(displayAddr, own, liveWall) : actRows(acts)}</div></section>
        </div>
        <div style="display:flex;flex-direction:column;gap:10px">
          <section class="pnl"><div class="pnl-hd"><h2>${own ? 'Coins You Launched' : 'Coins Launched'}</h2
            >${own ? html`<button class="hdbtn" id="claimBtn"${canClaim ? '' : ' disabled'}>CLAIM FEES</button>` : ''}</div
            ><div id="pfMine">${minedHTML(mine)}</div
            >${own ? html`<div class="pnl-note">DEPLOYING A COIN PAYS 50 XP ${DOT} BONDING PAYS 250 XP ${DOT} LP BURNS AT ${usd(GRAD)}</div>` : ''}</section
          ><section class="pnl"><div class="pnl-hd"><h2>Most Profitable Friends</h2
            ><span class="pnl-tabs">${(['24h', '7d', '1m'] as const).map(
              (w) => html`<button class="tab${PF.win === w ? ' on' : ''}" data-fwin="${w}">${w.toUpperCase()}</button>`,
            )}</span></div
            ><div id="pfFriends">${friendsHTML(displayAddr)}</div></section>
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
    const target = PF.addr;
    // An 0x address could be on RH, Base or Arc; prefer the net of a coin this
    // wallet created, then the session's net, then RH.
    const created = coinsBy(target)[0];
    const evmHint = created?.net && isEvm(created.net) ? created.net : isEvm(WALLET.net) ? WALLET.net : 'RH';
    const profileNet = inferNetFromAddress(target, evmHint);
    void Promise.all([
      fetchMember(profileNet, target).catch(() => null),
      fetchWall(profileNet, target).catch(() => null),
    ]).then(([mem, wall]) => {
      if (PF.addr !== target && (!mem || (PF.addr !== mem.addr && PF.addr !== target))) return;
      if (!mem) {
        toast('PROFILE LOAD FAILED', 'red');
        LIVE_WALLS.set(target, []);
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
      // Mirror *own* outgoing follows into local state for friendsHTML.
      // Never copy another member's following list into USER.follow.
      if (own && mem.followingWallets) {
        for (const w of mem.followingWallets) {
          if (!isFollowing(w)) toggleFollow(w);
        }
      }
      PF.addr = mem.addr;
      const wallKey = mem.addr;
      LIVE_WALLS.set(wallKey, wall?.posts ?? []);
      LIVE_WALLS.set(target, wall?.posts ?? []);
      renderProfile(mem.addr);
    });
  }
}

function paintFriends(): void {
  for (const cv of $$<HTMLCanvasElement>('#pfFriends canvas')) {
    paintAvatar(cv, { seed: cv.dataset['seed'] || '0', size: 40 });
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
  const liveMem = LIVE_MEMBERS.get(addr);
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
      if (mem && res.following !== wasFollowing) {
        mem.followers = Math.max(0, (mem.followers ?? 0) + (res.following ? 1 : -1));
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
    await postWallTip(WALLET.net, addr, txt, sig);
    toast(
      'TIPPED ' +
        tip.toFixed(4) +
        ' ' +
        nativeUnit() +
        ' TO ' +
        (LIVE_MEMBERS.get(addr)?.profile?.username || addr.slice(0, 8)),
    );
    unlock('social');
    LIVE_HYDRATED.delete(addr);
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
  if (tip < minTip()) {
    toast('MINIMUM TIP IS ' + minTip() + ' ' + unit);
    return;
  }
  if (api.mode === 'live') {
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
  const list = stakedList().filter((o) => (o.st.rewTok || 0) > 0.0001 || (o.st.rewSol || 0) > 0.000001);
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
  const liveMem = live
    ? LIVE_MEMBERS.get(addr) ||
      [...LIVE_MEMBERS.values()].find(
        (m) => m.addr === addr || m.profile?.username?.toLowerCase() === addr.toLowerCase(),
      )
    : undefined;
  const q = $('#pfQuad');
  if (q) replaceWith(q, quadHTML(own, own || live ? null : memberOf(addr), liveMem));
  if (PF.tabHold === 'holdings') {
    const holdings = live
      ? own && !liveMem
        ? HOLD
        : (liveMem?.holdings ?? [])
      : own
        ? HOLD
        : memHold(memberOf(addr), price);
    render($('#pfHold'), holdRows(holdings));
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
  if (api.mode === 'live' && PF.addr) LIVE_HYDRATED.delete(PF.addr);
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
          for (const [key, posts] of LIVE_WALLS) {
            const hit = posts.find((p) => p.id === postId);
            if (hit) {
              hit.likes = (hit.likes ?? 0) + (res.already ? 0 : 1);
              LIVE_WALLS.set(key, [...posts]);
            }
          }
          if (PF.addr) renderProfile(PF.addr);
        } catch (err) {
          toast(err instanceof Error ? err.message : 'LIKE FAILED');
        }
      })();
      return;
    }
    const t = target?.closest<HTMLElement>('[data-ptab]');
    const a = target?.closest<HTMLElement>('[data-atab]');
    const w = target?.closest<HTMLElement>('[data-fwin]');
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
    const row = target?.closest<HTMLElement>('[data-stk]');
    if (row) {
      const mint = row.dataset['mint'];
      navigate({
        view: 'token',
        sym: row.dataset['stk'] as string,
        ...(mint ? { mint } : {}),
      });
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
