/**
 * Focus containment for the six scrims and the chat drawer.
 *
 * Each dialog already carries `role="dialog"` and `aria-modal="true"` in the
 * static shell. This adds the two behaviours the attributes only promise:
 * Tab cannot leave the dialog while it is open, and closing returns focus to
 * whatever opened it.
 *
 * @see plan step 33
 */

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type=hidden])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export interface FocusTrap {
  /** Re-read the dialog's focusables after a `sync*()` rebuild. */
  refresh(): void;
  /** Restore focus to the opener and stop containing Tab. */
  release(): void;
}

function focusable(root: ParentNode): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => el.offsetParent !== null || el === document.activeElement,
  );
}

/**
 * @param container the scrim or drawer that is now modal
 * @param opener    element focus returns to on release; defaults to whatever
 *                  had focus when the trap was installed
 */
export function trapFocus(container: HTMLElement, opener?: HTMLElement | null): FocusTrap {
  const restoreTo = opener ?? (document.activeElement as HTMLElement | null);
  let items = focusable(container);

  function onKeydown(e: KeyboardEvent): void {
    if (e.key !== 'Tab') return;
    items = focusable(container);
    if (!items.length) {
      e.preventDefault();
      return;
    }
    const first = items[0] as HTMLElement;
    const last = items[items.length - 1] as HTMLElement;
    const active = document.activeElement;
    if (!container.contains(active)) {
      e.preventDefault();
      first.focus();
      return;
    }
    if (e.shiftKey && active === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  }

  document.addEventListener('keydown', onKeydown, true);

  // Land on the first control rather than the close button so keyboard users
  // start where the mouse would.
  const target = items.find((el) => !el.classList.contains('x')) ?? items[0];
  if (target) {
    // Wait a frame: the scrim is display:none until the `open` class paints.
    requestAnimationFrame(() => {
      if (container.isConnected) target.focus();
    });
  }

  return {
    refresh(): void {
      items = focusable(container);
    },
    release(): void {
      document.removeEventListener('keydown', onKeydown, true);
      if (restoreTo && restoreTo.isConnected) restoreTo.focus();
    },
  };
}
