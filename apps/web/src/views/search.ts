import { curve, usd } from '@stonkz/shared';
import { api } from '../api/index.js';
import { navigate } from '../app/route.js';
import { toast } from '../fx/toast.js';
import { must } from '../lib/dom.js';
import { fmtCurve } from '../lib/fmt.js';
import { attr, html, render } from '../lib/html.js';
import type { SimCoin } from '../state/coins.js';
import { filterBoard, focusFirstCard, netPill } from './board.js';
import { rankMatches } from './board-state.js';

/**
 * The FIND box.
 *
 * Three things happen as you type: the board hides cards that do not match
 * (`filterBoard`, a local `display` flip on every keystroke), and after a
 * short pause `api.search()` — a local scan in sim, `GET /tokens?q=` live —
 * fills a suggestion list under the input with the chain pill beside each
 * hit, so two coins with one ticker on two chains are told apart before you
 * pick. Enter opens the best match (exact ticker, then prefix, name,
 * address); arrows walk the list, and ArrowDown out of an empty list walks
 * onto the board's cards. Everything rendered goes through the `html` tag,
 * so a coin named `<img onerror>` is text.
 */

const DEBOUNCE_MS = 220;
const MAX_ROWS = 8;

let input: HTMLInputElement;
let form: HTMLFormElement;
let list: HTMLElement;
let rows: SimCoin[] = [];
let active = -1;
/** Monotonic request id so a slow early reply cannot overwrite a fast later one. */
let seq = 0;
let timer = 0;

export function initSearch(): void {
  form = must<HTMLFormElement>('#searchform');
  input = must<HTMLInputElement>('#q');
  list = document.createElement('div');
  list.className = 'sres';
  list.id = 'sres';
  list.setAttribute('role', 'listbox');
  list.hidden = true;
  form.appendChild(list);
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-controls', 'sres');
  input.setAttribute('aria-expanded', 'false');

  input.addEventListener('input', () => {
    const v = input.value;
    filterBoard(v);
    schedule(v);
  });
  input.addEventListener('keydown', onKey);
  input.addEventListener('focus', () => {
    if (rows.length && input.value.trim()) show();
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    void submit(input.value.trim());
  });
  // A click on a row must not blur the input first, or the list closes
  // under the pointer.
  list.addEventListener('mousedown', (e) => e.preventDefault());
  list.addEventListener('click', (e) => {
    const row = (e.target as Element | null)?.closest<HTMLElement>('.sr[data-i]');
    if (!row) return;
    const c = rows[Number(row.dataset['i'])];
    if (c) pick(c);
  });
  document.addEventListener('pointerdown', (e) => {
    if (!form.contains(e.target as Node)) hide();
  });
}

function schedule(v: string): void {
  if (timer) {
    clearTimeout(timer);
    timer = 0;
  }
  const q = v.trim();
  if (!q) {
    rows = [];
    active = -1;
    hide();
    seq++;
    return;
  }
  timer = window.setTimeout(() => {
    timer = 0;
    void suggest(q);
  }, DEBOUNCE_MS);
}

async function suggest(q: string): Promise<void> {
  const my = ++seq;
  let matches: SimCoin[];
  try {
    matches = await api.search(q);
  } catch {
    if (my !== seq) return;
    rows = [];
    active = -1;
    renderList(q, 'SEARCH FAILED · CHECK YOUR CONNECTION');
    return;
  }
  if (my !== seq || input.value.trim() !== q) return;
  rows = rankMatches(matches, q).slice(0, MAX_ROWS);
  active = -1;
  renderList(q, null);
}

function renderList(q: string, error: string | null): void {
  if (error) {
    render(list, html`<p class="sr-empty err" role="option" aria-disabled="true">${error}</p>`);
  } else if (rows.length === 0) {
    render(
      list,
      html`<p class="sr-empty" role="option" aria-disabled="true">
        NO COIN MATCHES “${q.toUpperCase()}”
      </p>`,
    );
  } else {
    render(
      list,
      html`${rows.map(
        (c, i) =>
          html`<button
            type="button"
            class="sr${i === active ? ' on' : ''}"
            role="option"
            id="sr-${i}"
            data-i="${i}"
            aria-selected="${i === active ? 'true' : 'false'}"
          >
            ${netPill(c.net ?? 'SOL')}<b>${c.sym}</b
            ><span class="nm" title="${attr(c.name)}">${c.name}</span
            ><span class="mc">${usd(c.mc)}</span
            ><span class="cv">${c.lane === 'grad' ? 'GRADUATED' : fmtCurve(curve(c))}</span>
          </button>`,
      )}`,
    );
  }
  show();
}

function show(): void {
  list.hidden = false;
  input.setAttribute('aria-expanded', 'true');
}

function hide(): void {
  list.hidden = true;
  input.setAttribute('aria-expanded', 'false');
  input.removeAttribute('aria-activedescendant');
  active = -1;
}

function mark(): void {
  const items = Array.from(list.querySelectorAll<HTMLElement>('.sr'));
  items.forEach((el, i) => {
    el.classList.toggle('on', i === active);
    el.setAttribute('aria-selected', i === active ? 'true' : 'false');
  });
  const cur = items[active];
  if (cur) {
    input.setAttribute('aria-activedescendant', cur.id);
    cur.scrollIntoView({ block: 'nearest' });
  } else input.removeAttribute('aria-activedescendant');
}

function onKey(e: KeyboardEvent): void {
  const open = !list.hidden && rows.length > 0;
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    if (open) {
      active = Math.min(active + 1, rows.length - 1);
      mark();
    } else if (rows.length && input.value.trim()) {
      show();
      active = 0;
      mark();
    } else focusFirstCard();
    return;
  }
  if (e.key === 'ArrowUp') {
    if (!open) return;
    e.preventDefault();
    active = Math.max(active - 1, -1);
    mark();
    return;
  }
  if (e.key === 'Enter' && open && active >= 0) {
    // Cancelling the keydown also cancels the form's implicit submit.
    e.preventDefault();
    const c = rows[active];
    if (c) pick(c);
    return;
  }
  if (e.key === 'Escape' && !list.hidden) {
    // Ours to close; the shell's escape stack must not also unwind a view.
    e.preventDefault();
    e.stopPropagation();
    hide();
  }
}

function pick(c: SimCoin): void {
  hide();
  rows = [];
  seq++;
  input.value = '';
  filterBoard('');
  navigate({ view: 'token', sym: c.sym, ...(c.mint ? { mint: c.mint } : {}) });
}

/**
 * Enter with nothing highlighted: the best match opens, or a toast says why
 * not. Live search merges hits into `COINS`, so a symbol beyond the board's
 * first page can still open.
 */
async function submit(q: string): Promise<void> {
  if (!q) return;
  seq++;
  let matches: SimCoin[];
  try {
    matches = await api.search(q);
  } catch {
    toast('SEARCH FAILED', 'red');
    return;
  }
  const best = rankMatches(matches, q)[0];
  if (!best) {
    toast('NO COIN MATCHES ' + q.toUpperCase());
    rows = [];
    active = -1;
    renderList(q, null);
    return;
  }
  pick(best);
}
