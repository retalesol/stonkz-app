/**
 * One `prefers-reduced-motion` query for the whole app — the oracle's `RM`.
 *
 * Every animated surface consults it: debris bursts, `punchIn`, the tape punch
 * and jolt, the crate shake, the reveal, the rank-up overlay, money rain, the
 * launch-CTA wake and nudge, chat message entry and the FLIP lane moves.
 *
 * @see plan step 14
 */
const query = window.matchMedia('(prefers-reduced-motion: reduce)');

/** True when the user asked for reduced motion. Read it, do not cache it. */
export function reducedMotion(): boolean {
  return query.matches;
}

/** Subscribe to changes so long-lived loops can settle down mid-session. */
export function onMotionChange(fn: (reduced: boolean) => void): void {
  query.addEventListener('change', (e) => fn(e.matches));
}
