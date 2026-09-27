import { $, must } from '../lib/dom.js';
import { type FocusTrap, trapFocus } from '../lib/focus-trap.js';

/**
 * One open/close path for every dialog.
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
  | '#cropScrim'
  | '#setScrim'
  | '#wizScrim'
  | '#editScrim'
  | '#stakeScrim'
  | '#claimScrim'
  | '#txScrim'
  | '#walletScrim'
  | '#legalScrim';

const traps = new Map<ScrimId, FocusTrap>();

export function isOpen(id: ScrimId): boolean {
  return must(id).classList.contains('open');
}

const ALL_SCRIMS: readonly ScrimId[] = [
  '#cropScrim',
  '#stakeScrim',
  '#wizScrim',
  '#claimScrim',
  '#setScrim',
  '#newScrim',
  '#editScrim',
  '#txScrim',
  '#walletScrim',
  '#legalScrim',
];

export function anyOpen(): boolean {
  return ALL_SCRIMS.some(isOpen);
}

const wired = new Set<ScrimId>();

/**
 * The floor under every dialog: its × and its backdrop always close it, even
 * when the owning module forgot to `wireBackdrop` (the stake dialog shipped
 * that way). A module's own close handler, if wired, runs first and does its
 * cleanup; this one then finds the scrim already closed and does nothing.
 */
function ensureWired(id: ScrimId): void {
  if (wired.has(id)) return;
  wired.add(id);
  const el = must(id);
  el.addEventListener('mousedown', (e) => {
    if (e.target === el) closeScrim(id);
  });
  $('.win-hd .x', el)?.addEventListener('click', () => closeScrim(id));
}

/** Close every open dialog; the Escape fallback when no module claims the key. */
export function closeAll(): void {
  for (const id of ALL_SCRIMS) closeScrim(id);
}

export function openScrim(id: ScrimId, opener?: Element | null): void {
  const el = must(id);
  ensureWired(id);
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
