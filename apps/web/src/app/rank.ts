import { ACH, CRATES, RANKS, num, rankOf } from '@stonkz/shared';
import { must, reflow } from '../lib/dom.js';
import { DOT, MID } from '../lib/fmt.js';
import { html, render } from '../lib/html.js';
import { reducedMotion } from '../lib/motion.js';
import { USER, achCount, readyCount, xpMult } from '../state/user.js';
import { updateStrip } from '../views/rewards.js';

/**
 * The header rank widget and its tooltip.
 *
 * The tooltip lists SP and Stonk Optionz separately: `$STONKZ` is a token, and
 * the oracle used its name for what was really a points balance.
 * `index.html:2120`
 */
export function renderRank(gained = false): void {
  const r = rankOf(USER.xp);
  must('#rk-lv').textContent = 'LV ' + (r.i + 1);
  must('#rk-name').textContent = r.name;
  must('#rk-fill').style.width = r.pct.toFixed(1) + '%';
  must('#rk-xp').textContent = num(USER.xp) + ' XP';
  const streak = USER.streak || 1;
  render(
    must('#rankTip'),
    html`<div class="hd">RANK ${r.i + 1} ${DOT} ${r.name}</div>
      <div class="row"><span>XP TO NEXT LEVEL</span><b>${r.next === null ? 'MAX RANK' : num(r.toNext) + ' XP'}</b></div>
      <div class="row"><span>NEXT RANK</span><b>${r.next === null ? MID : (RANKS[r.i + 1] as (typeof RANKS)[number])[0]}</b></div>
      <div class="row"><span>TOTAL XP EARNED</span><b>${num(USER.xp)} XP</b></div>
      <div class="row"><span>STONK POINTZ</span><b class="gd">${num(USER.sp ?? 0)}</b></div>
      <div class="row"><span>STONK OPTIONZ</span><b class="gd">${num(USER.optionz ?? 0)}</b></div>
      <div class="row"><span>CRATES READY</span><b class="up">${readyCount()} / ${CRATES.length}</b></div>
      <div class="row"><span>STREAK</span><b class="am">${streak} DAY${streak === 1 ? '' : 'S'} ${DOT} XP x${xpMult().toFixed(2)}</b></div>
      <div class="row"><span>ACHIEVEMENTS</span><b>${achCount()} / ${ACH.length}</b></div>
      <div class="cta">CLICK TO OPEN REWARDS ${DOT} XP ON EVERY TRADE</div>`,
  );
  const w = must('#rankBtn');
  if (gained && !reducedMotion()) {
    w.classList.remove('gain');
    reflow(w);
    w.classList.add('gain');
  }
  if (!must('#rewardsView').hidden) updateStrip();
}
