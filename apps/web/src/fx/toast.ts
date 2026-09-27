import { must } from '../lib/dom.js';
import { reducedMotion } from '../lib/motion.js';
import { WALLET } from '../state/wallet.js';

export type ToastKind = 'gold' | 'ach' | 'red';

/**
 * Mememan is the notification agent. `toast()` still works everywhere — it
 * just routes through him instead of bottom-centre boxes.
 */

const QUIET_KEY = 'stonkz.mememan.quiet.v1';
const MAX_BUBBLES = 8;

const ENDINGS = [
  'Send it!',
  'WAGMI!',
  'LFG!',
  'Number go up.',
  'Probably nothing.',
  'Apes together strong.',
  'Ser, this is a casino.',
  'Diamond hands only.',
  'Touch grass? Nah.',
  'Based.',
  'Cooked.',
  'Wen lambo?',
  'Have fun staying poor.',
  'Ngmi if you fade this.',
  'To the moon.',
  'Size in, ser.',
  'Full send.',
  'Cope and seethe.',
  'Anon is cooking.',
  'Chart looks sexy.',
];

interface Bubble {
  id: number;
  text: string;
  kind?: ToastKind | undefined;
  el: HTMLElement;
}

let seq = 0;
let quiet = false;
let expanded = false;
let greeted = false;
const bubbles: Bubble[] = [];

function loadQuiet(): boolean {
  try {
    return localStorage.getItem(QUIET_KEY) === '1';
  } catch {
    return false;
  }
}

function saveQuiet(v: boolean): void {
  try {
    localStorage.setItem(QUIET_KEY, v ? '1' : '0');
  } catch {
    /* private mode */
  }
}

function ending(): string {
  return ENDINGS[(Math.random() * ENDINGS.length) | 0] as string;
}

/** Append a degen closer on successes; leave errors blunt. */
function flavor(msg: string, kind?: ToastKind): string {
  if (kind === 'red') return msg;
  const trimmed = msg.replace(/\s+$/, '');
  if (/[!?.]$/.test(trimmed) && /(send it|wagmi|lfg|moon)/i.test(trimmed)) return trimmed;
  return trimmed.replace(/[.!…]?$/, '') + '. ' + ending();
}

function agent(): HTMLElement {
  return must('#mmAgent');
}

function bubbleBox(): HTMLElement {
  return must('#mmBubbles');
}

function syncAgentClass(): void {
  const el = agent();
  el.classList.toggle('quiet', quiet);
  el.classList.toggle('expanded', expanded);
  el.classList.toggle('has-bubbles', bubbles.length > 0);
  const badge = must('#mmBadge');
  if (quiet && bubbles.length) {
    badge.hidden = false;
    badge.textContent = bubbles.length > 9 ? '9+' : String(bubbles.length);
  } else {
    badge.hidden = true;
  }
  must('#mmBody').setAttribute('aria-pressed', quiet ? 'true' : 'false');
  must('#mmBody').title = quiet ? 'WAKE MEMEMAN' : 'QUIET MODE';
}

function layoutBubbles(): void {
  const n = bubbles.length;
  bubbles.forEach((b, i) => {
    const fromTop = n - 1 - i; // 0 = newest (front)
    b.el.style.setProperty('--i', String(fromTop));
    b.el.style.setProperty('--z', String(10 + fromTop));
    b.el.classList.toggle('front', fromTop === 0);
  });
  syncAgentClass();
}

function removeBubble(id: number): void {
  const idx = bubbles.findIndex((b) => b.id === id);
  if (idx < 0) return;
  const [b] = bubbles.splice(idx, 1);
  if (!b) return;
  b.el.classList.add('bye');
  setTimeout(() => b.el.remove(), reducedMotion() ? 0 : 280);
  layoutBubbles();
}

/** A bubble can carry one link (an explorer page for the fill it announces). */
export interface ToastAction {
  href: string;
  label: string;
}

function pushBubble(text: string, kind?: ToastKind, action?: ToastAction): void {
  const id = ++seq;
  const el = document.createElement('button');
  el.type = 'button';
  el.className = 'mm-bubble' + (kind ? ' ' + kind : '');
  el.setAttribute('aria-label', 'Notification');
  const spike = document.createElement('span');
  spike.className = 'mm-spike';
  spike.setAttribute('aria-hidden', 'true');
  const body = document.createElement('span');
  body.className = 'mm-bubble-txt';
  body.textContent = action ? text + ' \u00b7 ' + action.label + ' \u2197' : text;
  el.appendChild(body);
  el.appendChild(spike);
  if (action) {
    el.classList.add('mm-link');
    el.setAttribute('aria-label', text + '. ' + action.label);
  }
  el.addEventListener('click', (e) => {
    e.stopPropagation();
    if (action) {
      // A bubble with a link is the link: open it, leave the stack alone.
      window.open(action.href, '_blank', 'noopener');
      return;
    }
    // Clicking any bubble toggles the stack expand/collapse.
    expanded = !expanded;
    syncAgentClass();
  });
  bubbleBox().appendChild(el);
  bubbles.push({ id, text, kind, el });
  while (bubbles.length > MAX_BUBBLES) {
    const old = bubbles.shift();
    old?.el.remove();
  }
  layoutBubbles();

  // Auto-dismiss only when collapsed + not quiet; expanded stack stays until clicked away.
  if (!quiet && !expanded) {
    const ttl = kind === 'red' ? 5200 : 4200;
    setTimeout(() => {
      if (!expanded) removeBubble(id);
    }, ttl);
  }
}

/**
 * Bottom-right Mememan toast. Same call sites as before — he speaks them.
 */
export function toast(msg: string, kind?: ToastKind, action?: ToastAction): void {
  if (!document.getElementById('mmAgent')) {
    // Extremely early boot / tests — fall back to console so nothing throws.
    console.info('[toast]', msg);
    return;
  }
  pushBubble(flavor(msg, kind), kind, action);
  if (quiet) syncAgentClass();
}

export function initMememan(): void {
  quiet = loadQuiet();
  expanded = false;
  syncAgentClass();

  must('#mmBody').addEventListener('click', (e) => {
    e.stopPropagation();
    quiet = !quiet;
    if (!quiet) {
      // Waking him collapses the stack so the newest card is readable.
      expanded = false;
    }
    saveQuiet(quiet);
    syncAgentClass();
  });

  must('#mmBubbles').addEventListener('click', (e) => {
    if ((e.target as Element | null)?.closest('.mm-bubble')) return;
    expanded = !expanded;
    syncAgentClass();
  });

  if (!greeted) {
    greeted = true;
    setTimeout(() => {
      if (!WALLET.on) {
        toast('Connect a wallet to trade, launch, and chat');
      } else {
        toast('Mememan is watching the board');
      }
    }, 700);
  }
}
