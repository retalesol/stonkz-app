import { must } from '../lib/dom.js';

export type ToastKind = 'gold' | 'ach' | 'red';

/**
 * Bottom-centre toast. The newest three stack; older ones are dropped rather
 * than queued, so a burst of fills never buries the UI. `index.html:3697`
 */
export function toast(msg: string, kind?: ToastKind): void {
  const box = must('#toasts');
  const t = document.createElement('div');
  t.className = 'toast' + (kind ? ' ' + kind : '');
  // textContent, never innerHTML: toast copy interpolates coin names.
  t.textContent = msg;
  box.appendChild(t);
  while (box.children.length > 3) box.removeChild(box.firstChild as ChildNode);
  setTimeout(() => t.classList.add('bye'), 2400);
  setTimeout(() => {
    if (t.parentNode) t.parentNode.removeChild(t);
  }, 2800);
}
