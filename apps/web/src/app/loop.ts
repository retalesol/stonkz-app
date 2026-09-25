import { type Lane, price } from '@stonkz/shared';
import { api } from '../api/index.js';
import { toast } from '../fx/toast.js';
import { must } from '../lib/dom.js';
import { DOT } from '../lib/fmt.js';
import { on } from '../lib/bus.js';
import { NATIVE_PRICE } from '../state/wallet.js';
import { COINS, bySym, pushTrade } from '../state/coins.js';
import { HOLD, holdOf } from '../state/holdings.js';
import { USER, unlock } from '../state/user.js';
import { addCoin, counts, king, landIn, paint, renderBoard } from '../views/board.js';
import { addChat } from '../views/chat.js';
import { pushFill, clearTape } from '../views/tape.js';
import { TV, drawTChart, renderTab, syncToken } from '../views/token.js';
import { syncProfile } from '../views/profile.js';
import { isStakeOpen, syncStake } from '../modals/stake.js';
import { navigate } from './route.js';
import { renderRank } from './rank.js';
import { renderWallet } from './wallet.js';

/**
 * The single place where model events become DOM.
 *
 * `api/sim.ts` never touches an element; it moves numbers and emits.
 * `api/live.ts` does the same against real WS/REST data — this file does not
 * change per adapter, it only reacts to more event types. `index.html:4037`
 */

let beats = 0;

export function startLoop(): void {
  on('tick', () => {
    beats++;
    must('#solpx').textContent = '$' + NATIVE_PRICE.sol.toFixed(2);
    const ethEl = document.getElementById('ethpx');
    if (ethEl) ethEl.textContent = '$' + NATIVE_PRICE.eth.toFixed(2);
    for (const c of COINS) paint(c);
    king();
    syncProfile();
    if (isStakeOpen()) syncStake();

    // Diamond hands: down 25% on anything still held. Checked on a slow beat
    // because it walks the whole book. `index.html:4079`
    if (beats % 10 === 0 && !USER.ach?.['diamond']) {
      for (const h of HOLD) {
        const c = bySym(h.sym);
        if (c && h.live && h.cost > 0 && (h.tok * price(c)) / h.cost - 1 <= -0.25) {
          unlock('diamond');
          break;
        }
      }
    }

    if (TV.c) {
      syncToken();
      drawTChart();
      if (TV.tab === 'trades') renderTab();
      // Someone else is always trading the coin you are looking at — sim
      // only. Live mode gets this from the real `token:{sym}` WS fill
      // instead (`api/live.ts`'s `onTokenEvent`). `plan step 67`
      if (beats % 2 === 0 && Math.random() > 0.35 && api.mode === 'sim') {
        pushTrade(TV.c, { buy: Math.random() > 0.42, sol: 0.05 + Math.random() * 6 });
      }
    }
  });

  on('lane', ({ sym, lane }) => {
    const c = bySym(sym);
    if (!c) return;
    landIn(c, lane as Lane);
    if (lane === 'grad') {
      const h = holdOf(c.sym);
      if (h && h.live && h.tok > 0) unlock('grad');
      toast(c.sym + ' GRADUATED ' + DOT + ' LIQUIDITY MIGRATED ' + DOT + ' LP BURNED', 'gold');
      addChat('GLOBAL', { sys: true, who: '', text: '$' + c.sym + ' GRADUATED ' + DOT + ' LP BURNED' }, true);
    }
    counts();
  });

  on('mint', ({ sym }) => {
    const c = bySym(sym);
    if (c) addCoin(c);
  });

  // The coin set changed shape — a net switch reloaded `COINS`, or the board
  // poll found tokens beyond the initial page. Rebuild the lanes; if the open
  // token page no longer has a backing coin (it belonged to the net we just
  // left), fall back to the board rather than showing a dead page.
  // `plan step 62`, `plan step 69`
  on('coins', () => {
    renderBoard();
    king();
    if (TV.c && !bySym(TV.c.sym)) navigate({ view: 'board' });
  });

  on('fill', ({ fill, animate }) => pushFill(fill, animate));
  on('tapeClear', () => clearTape());

  on('rank', () => renderRank(true));
  on('wallet', () => renderWallet());
  on('portfolio', () => syncProfile());
}
