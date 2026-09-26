import { esc } from '@stonkz/shared';

/**
 * The `esc()` invariant, made structural.
 *
 * Every template in the terminal is built with the `html` tag. Interpolations
 * are escaped by default, so forgetting `esc()` is no longer possible: the only
 * ways to inject markup are to return an `Html` from another template or to
 * call `raw()` explicitly, both of which are greppable and lint-visible.
 *
 * `no-raw-innerhtml` (eslint-local/) enforces the other half: nothing may be
 * assigned to `innerHTML`/`outerHTML` except an `Html`.
 *
 * @see plan step 35
 */
export class Html {
  constructor(readonly value: string) {}
  toString(): string {
    return this.value;
  }
}

/**
 * Mark a string as already-safe markup. Only for strings this codebase built —
 * never for anything that came from a user, an API or `localStorage`.
 */
export function raw(markup: string): Html {
  return new Html(markup);
}

/**
 * Attribute-context escape. `esc()` is the oracle's text-node escape and
 * deliberately leaves quotes alone; inside `foo="…"` that is an injection, so
 * attribute interpolations get the stricter version.
 */
export function attr(value: unknown): Html {
  return new Html(
    String(value).replace(/[<>&"']/g, (m) =>
      m === '<'
        ? '&lt;'
        : m === '>'
          ? '&gt;'
          : m === '&'
            ? '&amp;'
            : m === '"'
              ? '&quot;'
              : '&#39;',
    ),
  );
}

function part(v: unknown): string {
  if (v instanceof Html) return v.value;
  if (Array.isArray(v)) return v.map(part).join('');
  if (v === null || v === undefined || v === false || v === true) return '';
  if (typeof v === 'number') return String(v);
  return esc(v);
}

/** Escaping template tag. `html\`<b>${userText}</b>\``. */
export function html(strings: TemplateStringsArray, ...values: unknown[]): Html {
  let out = strings[0] as string;
  for (let i = 0; i < values.length; i++) out += part(values[i]) + (strings[i + 1] as string);
  return new Html(out);
}

/** The one sanctioned way to put markup into the document. */
export function render(el: Element | null | undefined, markup: Html): void {
  if (el) el.innerHTML = markup.value;
}

/** Replace an element with freshly built markup, as `outerHTML` used to. */
export function replaceWith(el: Element | null | undefined, markup: Html): void {
  if (el) el.outerHTML = markup.value;
}

/** Build a detached node from markup. */
export function node(markup: Html): Element {
  const box = document.createElement('div');
  box.innerHTML = markup.value;
  return box.firstElementChild as Element;
}

export { esc };
