import { type Lane, price } from '@stonkz/shared';
import { toast } from '../fx/toast.js';
import { must } from '../lib/dom.js';
import { DOT } from '../lib/fmt.js';
import { on } from '../lib/bus.js';
import { NATIVE_PRICE } from '../state/wallet.js';
import { COINS, bySym, pushTrade } from '../state/coins.js';
import { HOLD, holdOf } from '../state/holdings.js';
import { USER, unlock } from '../state/user.js';
import { addCoin, counts, king, landIn, paint } from '../views/board.js';
import { addChat } from '../views/chat.js';
import { TV, drawTChart, syncToken } from '../views/token.js';
import { syncProfile } from '../views/profile.js';
import { isStakeOpen, syncStake } from '../modals/stake.js';
import { renderRank } from './rank.js';
import { renderWallet } from './wallet.js';

/**
 * The single place where model events become DOM.
 *
 * `api/sim.ts` never touches an element; it moves numbers and emits. Phase 1.C
 * points the same handlers at the `board` and `user:{addr}` WS channels and
 * this file does not change. `index.html:4037`
 */

let beats = 0;

export function startLoop(): void {
  on('tick', () => {
    beats++;
    must('#solpx').textContent = '$' + NATIVE_PRICE.usd.toFixed(2);
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
      // Someone else is always trading the coin you are looking at.
      if (beats % 2 === 0 && Math.random() > 0.35) {
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

  on('rank', () => renderRank(true));
  on('wallet', () => renderWallet());
  on('portfolio', () => syncProfile());
}
