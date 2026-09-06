import './styles/tokens.css';
import './styles/shell.css';

import { CRATES, GRAD, RANKS, rankOf, usd } from '@stonkz/shared';

/**
 * Phase 0.A boot.
 *
 * The shell markup lives in index.html and matches the oracle's element order
 * and ids. This file only proves the entry compiles, the tokens load and the
 * shared math resolves. Phase 0.C/0.D port the styles, views and modules; do
 * not grow this file into the app.
 */

const SHELL_IDS = [
  'fx',
  'homeBtn',
  'q',
  'rankBtn',
  'connectBtn',
  'tape',
  'boardView',
  'lane-new',
  'lane-soon',
  'lane-grad',
  'tokenView',
  'rewardsView',
  'profileView',
  'chatTab',
  'drawer',
  'newScrim',
  'setScrim',
  'wizScrim',
  'editScrim',
  'stakeScrim',
  'claimScrim',
  'toasts',
  'rankup',
] as const;

function boot(): void {
  const missing = SHELL_IDS.filter((id) => !document.getElementById(id));
  if (missing.length) {
    throw new Error(`Shell is missing required elements: ${missing.join(', ')}`);
  }

  const grad = document.getElementById('gradCap');
  if (grad) grad.textContent = usd(GRAD);

  const rank = rankOf(0);
  const lv = document.getElementById('rk-lv');
  const name = document.getElementById('rk-name');
  if (lv) lv.textContent = `LV ${rank.i + 1}`;
  if (name) name.textContent = rank.name;

  const note = document.getElementById('bootNote');
  if (note) {
    note.innerHTML =
      '<b>SHELL ONLINE</b> &middot; PHASE 0.A SKELETON &middot; ' +
      `${RANKS.length} RANKS &middot; ${CRATES.length} CRATE TIERS &middot; ` +
      `GRADUATION ${usd(GRAD)} &middot; VIEWS AND STYLES LAND IN PHASE 0.C/0.D`;
  }

  document.documentElement.dataset['booted'] = 'true';
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
