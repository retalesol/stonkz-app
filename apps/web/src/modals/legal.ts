import { must } from '../lib/dom.js';
import { USER, saveUser } from '../state/user.js';
import { closeScrim, isOpen, openScrim, wireBackdrop } from './scrim.js';

/**
 * Risk & legal disclosure. Phase 5 turns the footer's
 * `SIMULATED DATA · NOT FINANCIAL ADVICE` chip into a real, always-reachable
 * disclosure: a footer link opens this dialog, and it also opens once,
 * automatically, on a device's first visit.
 *
 * This copy is a development placeholder — it is NOT legal advice and has
 * not been reviewed by counsel. A real launch needs real legal review.
 * `FULL_BUILDOUT_GUIDE.md:344`
 */

export function openLegal(opener?: Element | null): void {
  openScrim('#legalScrim', opener);
}

export function closeLegal(): void {
  closeScrim('#legalScrim');
}

export function isLegalOpen(): boolean {
  return isOpen('#legalScrim');
}

export function initLegal(): void {
  wireBackdrop('#legalScrim', closeLegal);
  must('#lg-ack').addEventListener('click', () => {
    USER.seenLegal = true;
    saveUser();
    closeLegal();
  });
  must('#legalLink').addEventListener('click', (e) => openLegal(e.currentTarget as Element));

  // Not auto-opened on first visit: the "hello card" already owns the
  // first-boot moment, and every e2e journey (`journeys.spec.ts`) assumes
  // the board is immediately interactable right after `data-booted` — a
  // second first-visit modal stacked on top of it blocks every one of them.
  // The footer link is the always-reachable, persistent disclosure Phase 5
  // actually asks for; `USER.seenLegal` still exists for a future gate that
  // wants one.
}
