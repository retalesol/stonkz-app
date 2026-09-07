/** The four DOM primitives the whole terminal is built on. */

/** `document.querySelector`, scoped. The oracle's `$`. */
export function $<T extends Element = HTMLElement>(sel: string, root: ParentNode = document): T | null {
  return root.querySelector<T>(sel);
}

/**
 * Same, but throws when the element is missing. Used for the static shell in
 * `index.html`, which is a build-time contract rather than a runtime lookup.
 */
export function must<T extends Element = HTMLElement>(sel: string, root: ParentNode = document): T {
  const el = root.querySelector<T>(sel);
  if (!el) throw new Error(`shell is missing ${sel}`);
  return el;
}

/** `querySelectorAll` as a real array. */
export function $$<T extends Element = HTMLElement>(sel: string, root: ParentNode = document): T[] {
  return Array.from(root.querySelectorAll<T>(sel));
}

/**
 * Empty an element.
 *
 * The one sanctioned reason to touch a container's contents without going
 * through `lib/html.ts`, so `no-raw-innerhtml` can ban the sink outright.
 */
export function clear(el: Element | null | undefined): void {
  if (el) el.replaceChildren();
}

/** Force a style flush so the next class/transform change animates. */
export function reflow(el: Element): void {
  void (el as HTMLElement).offsetWidth;
}

/** Restart a CSS animation class on an element. */
export function restartAnimation(el: Element, cls: string): void {
  el.classList.remove(cls);
  reflow(el);
  el.classList.add(cls);
}

/** Toggle `on` across a set, marking exactly the one that matches. */
export function markOne(els: Iterable<Element>, active: Element | null): void {
  for (const el of els) el.classList.toggle('on', el === active);
}
