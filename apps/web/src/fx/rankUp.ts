import { RANKS } from '@stonkz/shared';
import { $, restartAnimation } from '../lib/dom.js';
import { html, render } from '../lib/html.js';
import { burst } from './debris.js';

/**
 * The full-screen rank-up ceremony. From Phase 3 this plays on a WS `rank_up`
 * event rather than a local XP comparison; the ceremony itself does not change.
 * `index.html:2200`
 */
export function rankUp(i: number): void {
  const o = $('#rankup');
  if (!o) return;
  const rank = RANKS[i];
  if (!rank) return;
  render(
    o,
    html`<div class="ru-box">
      <div class="ru-k">RANK UP</div>
      <div class="ru-n">${rank[0]}</div>
      <div class="ru-s">LEVEL ${i + 1} OF ${RANKS.length}</div>
    </div>`,
  );
  restartAnimation(o, 'show');
  setTimeout(() => o.classList.remove('show'), 2400);
  const cx = window.innerWidth / 2;
  const cy = window.innerHeight / 2;
  burst(cx - 60, cy - 50, 100, { n: 44, gold: true, spread: 2.2 });
  burst(cx + 60, cy - 50, 100, { n: 44, gold: true, spread: 2.2 });
}
