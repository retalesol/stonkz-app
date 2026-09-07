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

  // First-visit gate: every device sees the disclosure at least once before
  // it can be dismissed for good. Later visits reach it only via the footer
  // link, matching the "hello card" pattern already used for onboarding.
  if (!USER.seenLegal) openLegal();
}
