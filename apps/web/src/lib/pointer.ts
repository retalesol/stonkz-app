/**
 * Does this device have a real hover?
 *
 * The oracle was built mouse-first: the tape freezes a print and opens a chart
 * card on `mouseover`, and the token chart draws a crosshair on `mousemove`.
 * A touch browser synthesises both from a tap, so on a phone the tape would
 * flash a hover card and then navigate — two things happening for one finger.
 * Every hover-only affordance asks this first; the tap-to-open path is the
 * same `click` listener either way.
 *
 * @see plan step 37
 */
const query = window.matchMedia('(hover: hover) and (pointer: fine)');

export function canHover(): boolean {
  return query.matches;
}
