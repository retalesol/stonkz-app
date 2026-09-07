import type { Net } from '@stonkz/shared';
import { paintNetMarks } from '../canvas/netmark.js';
import { must } from '../lib/dom.js';

/**
 * The network dropdown that fronts CONNECT WALLET.
 *
 * Both Solana and Robinhood are selectable from day one — the sim fakes the
 * signature, Phase 1.B makes it real per chain. It is a menu rather than a
 * dialog, so it takes no focus trap; the escape stack closes it after the six
 * scrims and before the wallet menu. `index.html:2482`
 */

export function netOpen(v: boolean): void {
  must('#netMenu').hidden = !v;
  must('#connectBtn').setAttribute('aria-expanded', v ? 'true' : 'false');
  if (v) paintNetMarks();
}

export function isNetOpen(): boolean {
  return !must('#netMenu').hidden;
}

export function initNetPicker(onPick: (net: Net) => void): void {
  must('#connectBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    netOpen(!isNetOpen());
  });
  must('#netMenu').addEventListener('click', (e) => {
    const b = (e.target as Element | null)?.closest<HTMLElement>('[data-net]');
    if (b) onPick(b.dataset['net'] as Net);
  });
}
