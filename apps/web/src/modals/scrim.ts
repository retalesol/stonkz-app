import { $, must } from '../lib/dom.js';
import { type FocusTrap, trapFocus } from '../lib/focus-trap.js';

/**
 * One open/close path for all six dialogs.
 *
 * The oracle toggled `.open` and `body.overflow` by hand in six places and
 * shipped `aria-modal="true"` without the behaviour it promises. This adds the
 * two halves that were missing — Tab cannot leave an open dialog, and closing
 * returns focus to whatever opened it — and keeps the escape stack honest by
 * making "is this scrim open" a single question.
 *
 * @see plan step 33
 */

export type ScrimId =
  | '#newScrim'
  | '#setScrim'
  | '#wizScrim'
  | '#editScrim'
  | '#stakeScrim'
  | '#claimScrim'
  | '#txScrim'
  | '#legalScrim';

const traps = new Map<ScrimId, FocusTrap>();

export function isOpen(id: ScrimId): boolean {
  return must(id).classList.contains('open');
}

export function anyOpen(): boolean {
  return (
    [
      '#stakeScrim',
      '#wizScrim',
      '#claimScrim',
      '#setScrim',
      '#newScrim',
      '#editScrim',
      '#txScrim',
      '#legalScrim',
    ] as ScrimId[]
  ).some(isOpen);
}

export function openScrim(id: ScrimId, opener?: Element | null): void {
  const el = must(id);
  if (el.classList.contains('open')) {
    traps.get(id)?.refresh();
    return;
  }
  el.classList.add('open');
  document.body.style.overflow = 'hidden';
  traps.set(id, trapFocus(el, opener));
}

export function closeScrim(id: ScrimId): void {
  const el = must(id);
  if (!el.classList.contains('open')) return;
  el.classList.remove('open');
  // Another dialog may still be up — only release the scroll lock when none is.
  if (!anyOpen()) document.body.style.overflow = '';
  const t = traps.get(id);
  if (t) {
    t.release();
    traps.delete(id);
  }
}

/** Re-read focusables after a dialog rebuilds its body. */
export function refreshScrim(id: ScrimId): void {
  traps.get(id)?.refresh();
}

/** Close on a click landing on the backdrop itself, never on the window. */
export function wireBackdrop(id: ScrimId, close: () => void): void {
  const el = must(id);
  el.addEventListener('mousedown', (e) => {
    if (e.target === el) close();
  });
  $('.x', el)?.addEventListener('click', close);
}
