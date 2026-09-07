import { reflow } from '../lib/dom.js';
import { reducedMotion } from '../lib/motion.js';
import { type BurstOptions, burst } from './debris.js';

export interface PunchOptions extends BurstOptions {
  /** Animation class. Defaults to the coin card's `punchin`. */
  cls?: string;
  /** Delay before the debris, ms. Default 120. */
  delay?: number;
}

/**
 * Slam an element in from the right and throw debris off its leading edge.
 * Used by new cards, lane moves and new tape prints. `index.html:1262`
 */
export function punchIn(el: HTMLElement, opt: PunchOptions = {}): void {
  if (reducedMotion()) return;
  const cls = opt.cls ?? 'punchin';
  el.classList.remove(cls);
  reflow(el);
  el.classList.add(cls);
  el.addEventListener('animationend', function done(ev) {
    if (ev.target !== el) return;
    // Release the animation fill so :hover works again.
    el.classList.remove(cls);
    el.removeEventListener('animationend', done);
  });
  setTimeout(() => {
    const r = el.getBoundingClientRect();
    burst(r.left, r.top + 2, Math.max(6, r.height - 4), opt);
  }, opt.delay ?? 120);
}
