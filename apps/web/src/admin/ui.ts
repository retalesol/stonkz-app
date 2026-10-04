import { ALL_NETS, type Net } from '@stonkz/shared';
import { html, render, type Html } from '../lib/html.js';
import { must } from '../lib/dom.js';
import { ApiError } from './api.js';

/**
 * Small UI kit for the console: escaping templates (re-using the terminal's
 * `html` tag, so `no-raw-innerhtml` holds here too), toasts, a modal with a
 * typed-confirmation variant for destructive actions, and formatters.
 */
export { html, render, raw, attr, type Html } from '../lib/html.js';
export { $, $$, must, clear } from '../lib/dom.js';

/* ------------------------------------------------------------- formatters */

export function short(addr: string | null | undefined, n = 6): string {
  if (!addr) return '—';
  return addr.length <= n * 2 + 2 ? addr : `${addr.slice(0, n)}…${addr.slice(-4)}`;
}

export function when(ms: number | null | undefined): string {
  if (!ms) return '—';
  const d = new Date(ms);
  return d.toISOString().replace('T', ' ').slice(0, 19) + 'Z';
}

export function ago(ms: number | null | undefined, now = Date.now()): string {
  if (!ms) return '—';
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function num(v: number | null | undefined, digits = 2): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  if (Math.abs(v) >= 1e9) return (v / 1e9).toFixed(2) + 'B';
  if (Math.abs(v) >= 1e6) return (v / 1e6).toFixed(2) + 'M';
  if (Math.abs(v) >= 1e3) return (v / 1e3).toFixed(1) + 'K';
  return Number.isInteger(v) ? String(v) : v.toFixed(digits);
}

export function usd(v: number | null | undefined): string {
  return v === null || v === undefined ? '—' : '$' + num(v);
}

export function netTag(net: string | null | undefined): Html {
  return net
    ? html`<span class="tag net-${net}">${net}</span>`
    : html`<span class="tag">ALL</span>`;
}

export function onOff(v: boolean, on = 'on', off = 'off'): Html {
  return v ? html`<span class="tag on">${on}</span>` : html`<span class="tag off">${off}</span>`;
}

export function errText(err: unknown): string {
  if (err instanceof ApiError) return `${err.code}: ${err.detail}`;
  if (err instanceof Error) return err.message;
  return String(err);
}

/* ------------------------------------------------------------------ toasts */

export function toast(msg: string, kind: 'amber' | 'red' | 'green' = 'amber'): void {
  const box = must('#admToasts');
  const el = document.createElement('div');
  el.className = `toast ${kind === 'amber' ? '' : kind}`.trim();
  el.textContent = msg;
  box.appendChild(el);
  window.setTimeout(() => el.remove(), kind === 'red' ? 7000 : 3500);
}

/* ------------------------------------------------------------------ dialog */

let closeCurrent: (() => void) | null = null;

export function closeDialog(): void {
  closeCurrent?.();
}

export function isDialogOpen(): boolean {
  return closeCurrent !== null;
}

/**
 * Opens a modal. `body(close)` renders into it; the returned promise resolves
 * when it is closed (with whatever the body handed to `done`).
 */
export function dialog<T>(
  title: string,
  body: (done: (value: T | undefined) => void) => Html,
  opts: { sub?: string } = {},
): Promise<T | undefined> {
  return new Promise((resolve) => {
    const scrim = must('#admScrim');
    const box = must('#admDialog');
    const finish = (value: T | undefined): void => {
      scrim.hidden = true;
      render(box, html``);
      closeCurrent = null;
      // eslint-disable-next-line @typescript-eslint/no-use-before-define -- referenced inside a function that runs after module init
      scrim.removeEventListener('click', onScrim);
      resolve(value);
    };
    const onScrim = (e: Event): void => {
      if (e.target === scrim) finish(undefined);
    };
    closeCurrent = () => finish(undefined);
    render(
      box,
      html`<div class="pnl-hd">
          <span>${title}</span>
          ${opts.sub ? html`<span class="sub">${opts.sub}</span>` : ''}
          <span class="grow"></span>
          <button type="button" class="btn ghost sm" data-close aria-label="Close">✕</button>
        </div>
        <div class="pnl-bd">${body(finish)}</div>`,
    );
    box.querySelector('[data-close]')?.addEventListener('click', () => finish(undefined));
    scrim.addEventListener('click', onScrim);
    scrim.hidden = false;
    (box.querySelector('input,textarea,select,button.go') as HTMLElement | null)?.focus();
  });
}

/**
 * Destructive-action gate: the operator must type `phrase` exactly. Resolves
 * true only then. The phrase is what the API also demands in `confirm`.
 */
export async function confirmTyped(
  title: string,
  phrase: string,
  detail: Html | string,
  opts: { danger?: boolean } = {},
): Promise<boolean> {
  const out = await dialog<boolean>(title, (done) => {
    const id = `cf${Math.random().toString(36).slice(2, 8)}`;
    queueMicrotask(() => {
      const input = document.getElementById(id) as HTMLInputElement | null;
      const btn = document.querySelector<HTMLButtonElement>(`[data-confirm="${id}"]`);
      if (!input || !btn) return;
      const sync = (): void => {
        btn.disabled = input.value.trim() !== phrase;
      };
      input.addEventListener('input', sync);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !btn.disabled) done(true);
      });
      btn.addEventListener('click', () => done(true));
      sync();
    });
    return html`<div class="${opts.danger ? 'errbox' : 'warnbox'}">${detail}</div>
      <label
        ><span class="lbl">Type <b>${phrase}</b> to confirm</span>
        <input id="${id}" class="fld" autocomplete="off" spellcheck="false" placeholder="${phrase}"
      /></label>
      <div class="btns">
        <button type="button" class="btn ghost" data-close>Cancel</button>
        <span class="grow"></span>
        <button
          type="button"
          class="btn ${opts.danger ? 'danger' : 'go'}"
          data-confirm="${id}"
          disabled
        >
          Confirm
        </button>
      </div>`;
  });
  return out === true;
}

/** Simple prompt dialog for a reason / value. */
export async function promptText(
  title: string,
  label: string,
  opts: { placeholder?: string; multiline?: boolean; initial?: string; required?: boolean } = {},
): Promise<string | undefined> {
  const out = await dialog<string>(title, (done) => {
    const id = `pt${Math.random().toString(36).slice(2, 8)}`;
    queueMicrotask(() => {
      const input = document.getElementById(id) as HTMLInputElement | null;
      const btn = document.querySelector<HTMLButtonElement>(`[data-ok="${id}"]`);
      if (!input || !btn) return;
      const sync = (): void => {
        btn.disabled = (opts.required ?? true) && input.value.trim() === '';
      };
      input.addEventListener('input', sync);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !opts.multiline && !btn.disabled) done(input.value.trim());
      });
      btn.addEventListener('click', () => done(input.value.trim()));
      sync();
    });
    return html`<label
        ><span class="lbl">${label}</span>
        ${
          opts.multiline
            ? html`<textarea id="${id}" class="fld" placeholder="${opts.placeholder ?? ''}">
${opts.initial ?? ''}</textarea>`
            : html`<input
                id="${id}"
                class="fld"
                autocomplete="off"
                placeholder="${opts.placeholder ?? ''}"
                value="${opts.initial ?? ''}"
              />`
        }
      </label>
      <div class="btns">
        <button type="button" class="btn ghost" data-close>Cancel</button>
        <span class="grow"></span>
        <button type="button" class="btn go" data-ok="${id}">OK</button>
      </div>`;
  });
  return out;
}

/* ------------------------------------------------------------------ pieces */

export function panel(title: string, body: Html, sub?: string, actions?: Html): Html {
  return html`<section class="pnl">
    <div class="pnl-hd">
      <span>${title}</span>${sub ? html`<span class="sub">${sub}</span>` : ''}<span
        class="grow"
      ></span
      >${actions ?? ''}
    </div>
    <div class="pnl-bd">${body}</div>
  </section>`;
}

export function stat(label: string, value: string, sub?: string, cls = ''): Html {
  return html`<div class="stat">
    <span class="lbl">${label}</span
    ><span class="v ${cls}">${value}</span>${sub ? html`<span class="s">${sub}</span>` : ''}
  </div>`;
}

export function table(
  headers: (string | { label: string; num?: boolean })[],
  rows: Html[],
  empty = 'NOTHING HERE',
): Html {
  if (rows.length === 0) return html`<div class="empty">${empty}</div>`;
  return html`<div class="twrap">
    <table class="t">
      <thead>
        <tr>
          ${headers.map((h) => (typeof h === 'string' ? html`<th>${h}</th>` : html`<th class="${h.num ? 'n' : ''}">${h.label}</th>`))}
        </tr>
      </thead>
      <tbody>
        ${rows}
      </tbody>
    </table>
  </div>`;
}

export function netSelect(id: string, value: Net | 'ALL' = 'ALL', allowAll = true): Html {
  return html`<select id="${id}" class="fld dark">
    ${allowAll ? html`<option value="ALL" ${value === 'ALL' ? 'selected' : ''}>ALL NETS</option>` : ''}
    ${ALL_NETS.map((n) => html`<option value="${n}" ${value === n ? 'selected' : ''}>${n}</option>`)}
  </select>`;
}

/** Runs an async action from a button, showing busy state and toasting errors. */
export async function busy(btn: HTMLElement | null, fn: () => Promise<void>): Promise<void> {
  btn?.setAttribute('aria-busy', 'true');
  try {
    await fn();
  } catch (err) {
    toast(errText(err), 'red');
  } finally {
    btn?.removeAttribute('aria-busy');
  }
}

export function jsonBlock(v: unknown): Html {
  return html`<pre class="code">${typeof v === 'string' ? v : JSON.stringify(v, null, 2)}</pre>`;
}

export function downloadText(filename: string, text: string, type = 'text/plain'): void {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function val(sel: string, root: ParentNode = document): string {
  return (
    (
      root.querySelector(sel) as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | null
    )?.value.trim() ?? ''
  );
}

export function checked(sel: string, root: ParentNode = document): boolean {
  return (root.querySelector(sel) as HTMLInputElement | null)?.checked ?? false;
}
