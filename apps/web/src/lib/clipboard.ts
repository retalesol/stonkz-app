/** Copy-to-clipboard with the oracle's textarea fallback. `index.html:2556` */

function fallbackCopy(text: string): boolean {
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    // Deprecated, but it is the only path left when the Clipboard API is
    // blocked by permissions policy or a non-secure origin.
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return !!ok;
  } catch {
    return false;
  }
}

export function copyText(text: string, done: (ok: boolean) => void): void {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        () => done(true),
        () => done(fallbackCopy(text)),
      );
      return;
    }
  } catch {
    /* fall through to the textarea */
  }
  done(fallbackCopy(text));
}

/** When the clipboard is blocked, hand the user a selection instead. */
export function selectText(el: Element): boolean {
  try {
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    if (!sel) return false;
    sel.removeAllRanges();
    sel.addRange(range);
    return true;
  } catch {
    return false;
  }
}
