import { GRAD, RANKS, ago, inCashback, num, pct, price, rankOf, usd } from '@stonkz/shared';
import { api } from '../api/index.js';
import { back, navigate } from '../app/route.js';
import { showView } from '../app/view.js';
import { pix } from '../canvas/pix.js';
import { toast } from '../fx/toast.js';
import { $, $$, must } from '../lib/dom.js';
import { ARR, DOT, clockSec, ud } from '../lib/fmt.js';
import { type Html, attr, html, render, replaceWith } from '../lib/html.js';
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
 * table, on a card or on the tape. `index.html:3338`
 */

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

function quadHTML(own: boolean, m: SimMember | null): Html {
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

function holdRows(list: Array<{ sym: string; tok: number; cost: number }>): Html {
  if (!list.length) return html`<div class="empty">NO POSITIONS</div>`;
  return html`<table class="tbl"><thead><tr><th scope="col">TOKEN</th><th scope="col" class="r">AMOUNT</th
    ><th scope="col" class="r">VALUE</th><th scope="col" class="r">COST</th><th scope="col" class="r">PNL</th></tr></thead><tbody
    >${list.map((h) => {
      const c = bySym(h.sym);
      if (!c) return '';
      const v = h.tok * price(c);
      const p = (v / h.cost - 1) * 100;
      return html`<tr><td class="gd">${h.sym}</td><td class="r">${num(h.tok)}</td><td class="r">${usd(v)}</td
        ><td class="r dm">${usd(h.cost)}</td><td class="r ${ud(p)}">${pct(p)}</td></tr>`;
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
    return html`<div class="stk-row" data-stk="${attr(c.sym)}">
      <div><div class="sy">${c.sym}${locked ? html`<span class="lockbadge">${st.mult}x ${st.days}D</span>` : ''}</div
        ><div class="mt">${num(st.amt)} STAKED ${DOT} ${(yourShare(c) * 100).toFixed(2)}% OF POOL</div></div
      ><div class="earn"><b>${earn}</b><span>${cb ? 'CASHBACK' : 'FEES'}</span></div
      ><button type="button" class="claimbtn" data-claim="${attr(c.sym)}">CLAIM</button></div>`;
  })}`;
}

function shoutHTML(addr: string, own: boolean): Html {
  const w = wallOf(addr);
  const who = own ? 'YOU' : memberOf(addr).name;
  const tip = minTip();
  return html`<div class="pnl-bd"
    >${own
      ? html`<p class="hint">THIS IS YOUR WALL ${DOT} OTHERS TIP ${tip} ${nativeUnit()} OR MORE TO POST HERE.</p>`
      : html`<form class="shout-form" id="shoutForm"><input class="fld" id="shout-txt" maxlength="140"
          placeholder="SAY SOMETHING TO ${attr(who)}"><input class="fld r" id="shout-tip"
          value="${attr(tip.toFixed(4))}" inputmode="decimal"><button class="send" type="submit">TIP + POST</button></form
        ><p class="hint">MINIMUM ${tip} ${nativeUnit()} ${DOT} 100% OF THE TIP GOES STRAIGHT TO ${who}.</p>`}<div
      class="scrolly" style="display:flex;flex-direction:column;gap:7px"
      >${w.length
        ? w.map(
            (o) => html`<div class="shout${o.mine ? ' mine' : ''}"><div class="sh-hd"
              ><span class="who addrlink" data-addr="${attr(o.from)}">${o.mine ? 'YOU' : memberOf(o.from).name}</span
              ><span class="tip">+${Number(o.tip).toFixed(4)} ${nativeUnit()}</span><span class="t">${o.t}</span></div
              ><p>${o.text}</p></div>`,
          )
        : html`<div class="empty">NO SHOUTS YET</div>`}</div></div>`;
}

function friendsHTML(addr: string): Html {
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
    (c) => html`<div class="mine-row" data-sym="${attr(c.sym)}" role="button" tabindex="0"
      ><canvas width="64" height="64" data-seed="${attr(c.seed)}" aria-hidden="true"></canvas
      ><div><div class="sy">${c.sym}</div><div class="mt">${c.name} ${DOT} ${ago(c.age)}</div></div
      ><div style="text-align:right"><div class="am">${usd(c.mc)}</div><div class="mt ${ud(c.chg)}">${pct(c.chg)}</div></div></div>`,
  )}`;
}

/* --------------------------------- page ----------------------------------- */

export function renderProfile(addr?: string): void {
  PF.addr = addr || PF.addr || WALLET.addr;
  const own = isMe(PF.addr);
  const m = own ? null : memberOf(PF.addr);
  const r = own ? rankOf(USER.xp) : rankOf((m as SimMember).xp);
  const name = own ? myName() : (m as SimMember).name;
  const bio = own ? myBio() : (m as SimMember).bio;
  const holdings = own ? HOLD : memHold(m as SimMember, price);
  const acts = own ? MYTRADES : memTrades(m as SimMember);
  const mine = own ? myCoins() : coinsBy(PF.addr);
  const fees = feeTotal();

  render(
    must('#profileView'),
    html`<div style="display:flex;align-items:center;gap:10px">
        <button class="back" id="pf-back">${ARR} BACK</button
        ><span class="hint">${own ? 'YOUR PROFILE ' + DOT + ' SIMULATED WALLET SESSION' : 'MEMBER PROFILE ' + DOT + ' JOINED ' + (m as SimMember).joined + ' DAYS AGO'}</span></div>
      <div class="pf-bar"><canvas width="128" height="128" id="pfAv" aria-hidden="true"></canvas
        ><div class="pf-id"><div class="pf-name"><h1>${name}</h1><span class="addr">${PF.addr}</span></div
          ><div class="pf-bio">${bio}</div></div
        ><div class="pf-social">
          <div><span class="lbl">FOLLOWERS</span><div class="v">${num(
            own ? SOCIAL.followers + Object.keys(follows()).length : (m as SimMember).followers + (isFollowing(PF.addr) ? 1 : 0),
          )}</div></div
          ><div><span class="lbl">FOLLOWING</span><div class="v">${num(
            own ? SOCIAL.following + Object.keys(follows()).length : (m as SimMember).following,
          )}</div></div>
        </div
      >${own
        ? html`<button class="pf-rank" id="pfRank" title="Open rewards"><span class="lv">${r.i + 1}</span
            ><div><div class="nm">${r.name}</div><div class="sub">${r.next === null ? 'MAX RANK' : num(r.toNext) + ' XP TO ' + (RANKS[r.i + 1] as (typeof RANKS)[number])[0]}</div></div></button
            ><span class="pf-acts"><button class="editbtn" id="pfEdit">EDIT PROFILE</button></span>`
        : html`<div class="pf-rank"><span class="lv">${r.i + 1}</span
            ><div><div class="nm">${r.name}</div><div class="sub">RANK ${r.i + 1} OF ${RANKS.length}</div></div></div
            ><span class="pf-acts"><button class="followbtn${isFollowing(PF.addr) ? ' on' : ''}" id="pfFollow">${
              isFollowing(PF.addr) ? 'FOLLOWING' : 'FOLLOW'
            }</button></span>`}</div
      >${quadHTML(own, m)}
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
            ><div id="pfAct">${PF.tabAct === 'shout' ? shoutHTML(PF.addr, own) : actRows(acts)}</div></section>
        </div>
        <div style="display:flex;flex-direction:column;gap:10px">
          <section class="pnl"><div class="pnl-hd"><h2>${own ? 'Coins You Launched' : 'Coins Launched'}</h2
            >${own ? html`<button class="hdbtn" id="claimBtn"${fees >= 0.01 ? '' : ' disabled'}>CLAIM FEES</button>` : ''}</div
            ><div id="pfMine">${minedHTML(mine)}</div
            >${own ? html`<div class="pnl-note">DEPLOYING A COIN PAYS 150 XP ${DOT} LP BURNS AT ${usd(GRAD)}</div>` : ''}</section
          ><section class="pnl"><div class="pnl-hd"><h2>Most Profitable Friends</h2
            ><span class="pnl-tabs">${(['24h', '7d', '1m'] as const).map(
              (w) => html`<button class="tab${PF.win === w ? ' on' : ''}" data-fwin="${w}">${w.toUpperCase()}</button>`,
            )}</span></div
            ><div id="pfFriends">${friendsHTML(PF.addr)}</div></section>
        </div>
      </div>`,
  );

  pix($<HTMLCanvasElement>('#pfAv'), own ? WALLET.seed : (m as SimMember).seed);
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
      const now = toggleFollow(PF.addr as string);
      toast((now ? 'FOLLOWING ' : 'UNFOLLOWED ') + memberOf(PF.addr as string).name);
      if (now) {
        addXP(6, 'FOLLOW');
        unlock('social');
      }
      renderProfile(PF.addr as string);
    });
    $('#shoutForm')?.addEventListener('submit', (e) => {
      e.preventDefault();
      postShout(PF.addr as string);
    });
  }
}

function paintFriends(): void {
  for (const cv of $$<HTMLCanvasElement>('#pfFriends canvas')) pix(cv, Number(cv.dataset['seed']));
}

function paintMine(): void {
  for (const cv of $$<HTMLCanvasElement>('#pfMine canvas')) pix(cv, Number(cv.dataset['seed']));
}

/** TODO(Phase 5.C): send the tip, then `POST /wall` with its signature. `index.html:3322` */
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
  if (tip > WALLET.sol) {
    toast('NOT ENOUGH ' + unit + ' IN THE WALLET');
    return;
  }
  WALLET.sol -= tip;
  postToWall(addr, { from: WALLET.addr, text: txt, tip, t: 'now', mine: true });
  toast('TIPPED ' + tip.toFixed(4) + ' ' + unit + ' TO ' + memberOf(addr).name + ' ' + DOT + ' SIMULATED');
  addXP(8, 'WALL POST');
  unlock('social');
  renderProfile(addr);
}

async function claimStakeFor(sym: string): Promise<void> {
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
}

async function claimAllStakes(): Promise<void> {
  const list = stakedList().filter((o) => (o.st.rewTok || 0) > 0.0001 || (o.st.rewSol || 0) > 0.000001);
  if (!list.length) {
    toast('NOTHING TO CLAIM YET');
    return;
  }
  for (const o of list) await api.claimStake(o.c.sym);
  toast('CLAIMED ' + list.length + ' POSITION' + (list.length > 1 ? 'S' : ''));
  renderProfile(PF.addr as string);
}

/** Patch the numbers that move under a live profile. `index.html:3506` */
export function syncProfile(): void {
  if (must('#profileView').hidden) return;
  const addr = PF.addr;
  if (!addr) return;
  const own = isMe(addr);
  const q = $('#pfQuad');
  if (q) replaceWith(q, quadHTML(own, own ? null : memberOf(addr)));
  if (PF.tabHold === 'holdings') {
    render($('#pfHold'), holdRows(own ? HOLD : memHold(memberOf(addr), price)));
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
    if (cb) cb.disabled = fees < 0.01;
  }
}

export function openProfile(addr?: string): void {
  if (!WALLET.on && !addr) {
    toast('CONNECT A WALLET FIRST');
    return;
  }
  PF.addr = addr || WALLET.addr;
  renderProfile(PF.addr);
  showView('profile');
  window.scrollTo(0, 0);
}

export function initProfileView(): void {
  must('#profileView').addEventListener('click', (e) => {
    const target = e.target as Element | null;
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
      navigate({ view: 'token', sym: row.dataset['stk'] as string });
      return;
    }
    const mn = target?.closest<HTMLElement>('#pfMine [data-sym]');
    if (mn) navigate({ view: 'token', sym: mn.dataset['sym'] as string });
  });
}

/** The rewards page is reachable from the profile rank chip. */
export { openRewards };
