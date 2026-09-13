/**
 * Terminal-style boot splash (#bootSplash in index.html).
 *
 * Markup + critical CSS live in `index.html` so the splash paints before the
 * module graph. This module only dismisses it once the shell is ready.
 */

const MIN_MS = 700;

let shownAt = 0;

/** Call as early as possible so the minimum display window starts now. */
export function markSplashShown(): void {
  shownAt = performance.now();
}

/** Fade out and remove the splash after boot (respecting a short minimum). */
export async function dismissSplash(): Promise<void> {
  const el = document.getElementById('bootSplash');
  if (!el) return;

  const elapsed = performance.now() - (shownAt || performance.now());
  const wait = Math.max(0, MIN_MS - elapsed);
  if (wait > 0) await new Promise((r) => window.setTimeout(r, wait));

  el.classList.add('boot-done');
  el.setAttribute('aria-busy', 'false');

  await new Promise<void>((resolve) => {
    const done = (): void => {
      el.remove();
      resolve();
    };
    el.addEventListener('transitionend', done, { once: true });
    window.setTimeout(done, 500);
  });
}
