import type { MevMode } from '@stonkz/shared';
import { toast } from '../fx/toast.js';
import { $, $$, must } from '../lib/dom.js';
import { DOT } from '../lib/fmt.js';
import { attr, html, render } from '../lib/html.js';
import { DEFAULTS, SET, resetSettings, saveSettings } from '../state/settings.js';
import { nativeUnit } from '../state/wallet.js';
import { closeScrim, isOpen, openScrim, refreshScrim, wireBackdrop } from './scrim.js';

/**
 * Transaction defaults.
 *
 * Rendered rather than static so the amount units follow the connected chain —
 * the oracle hard-coded SOL in six places, which is wrong the moment you
 * connect Robinhood. `index.html:2622`
 */

function formHTML(): ReturnType<typeof html> {
  const unit = nativeUnit();
  return html`<div>
      <div class="set-row"><span class="k">SLIPPAGE TOLERANCE<small>MAX PRICE MOVE YOU ACCEPT</small></span>
        <span class="set-ctl"><input class="fld r" id="st-slip" value="${attr(SET.slip)}">
          ${[0.5, 1, 2.5, 5].map(
            (v) => html`<button type="button" class="chipm${SET.slip === v ? ' on' : ''}" data-slip="${attr(v)}">${v}%</button>`,
          )}</span></div>
      <div class="set-row"><span class="k">PRIORITY FEE<small>PAID TO LAND THE BLOCK</small></span>
        <span class="set-ctl"><input class="fld r" id="st-prio" value="${attr(SET.prio)}">
          ${(
            [
              [0.0005, 'LOW'],
              [0.0012, 'FAST'],
              [0.004, 'TURBO'],
            ] as Array<[number, string]>
          ).map(
            ([v, label]) =>
              html`<button type="button" class="chipm${SET.prio === v ? ' on' : ''}" data-prio="${attr(v)}">${label}</button>`,
          )}</span></div>
      <div class="set-row"><span class="k">MEV PROTECTION<small>SANDWICH DEFENCE</small></span>
        <span class="set-ctl">
          ${(
            [
              ['SHIELD', 'SHIELD'],
              ['RELAY', 'PRIVATE RELAY'],
              ['OFF', 'OFF'],
            ] as Array<[MevMode, string]>
          ).map(
            ([v, label]) =>
              html`<button type="button" class="chipm${SET.mev === v ? ' on' : ''}" data-mev="${v}">${label}</button>`,
          )}</span></div>
      <div class="set-row"><span class="k">MEV TIP<small>PAID TO THE BLOCK ENGINE</small></span>
        <span class="set-ctl"><input class="fld r" id="st-mev" value="${attr(SET.mevTip)}"> <span class="hint">${unit}</span></span></div>
      <div class="set-row"><span class="k">MAX FEE CAP<small>ABORT ABOVE THIS TOTAL</small></span>
        <span class="set-ctl"><input class="fld r" id="st-cap" value="${attr(SET.cap)}"> <span class="hint">${unit}</span></span></div>
      <div class="set-row"><span class="k">DEFAULT BUY<small>PREFILLED ON EVERY TICKET</small></span>
        <span class="set-ctl"><input class="fld r" id="st-buy" value="${attr(Number(SET.defBuy).toFixed(2))}"> <span class="hint">${unit}</span></span></div>
      <div class="set-row"><span class="k">CONFIRM BEFORE SEND<small>EXTRA CLICK ON EVERY ORDER</small></span>
        <span class="set-ctl">
          <button type="button" class="chipm${SET.confirm ? ' on' : ''}" data-cf="1">ON</button>
          <button type="button" class="chipm${SET.confirm ? '' : ' on'}" data-cf="0">OFF</button></span></div>
    </div>
    <p class="hint">SETTINGS APPLY TO EVERY QUOTE ON THIS DEVICE.</p>
    <div class="set-foot"><button type="submit" class="big">SAVE SETTINGS</button>
      <button type="button" class="chipm" id="st-reset" style="padding:8px 14px">RESET</button></div>`;
}

function fillSet(): void {
  render(must('#setForm'), formHTML());
  refreshScrim('#setScrim');
}

export function openSet(v: boolean, opener?: Element | null): void {
  if (v) {
    fillSet();
    openScrim('#setScrim', opener);
  } else {
    closeScrim('#setScrim');
  }
}

export function isSetOpen(): boolean {
  return isOpen('#setScrim');
}

/** Clamp a field, falling back to its default when it is not a number. `index.html:2653` */
function field(id: string, min: number, max: number, dflt: number): number {
  const v = parseFloat(($(id) as HTMLInputElement | null)?.value ?? '');
  return Math.max(min, Math.min(max, isNaN(v) ? dflt : v));
}

export function initSettings(onSaved: () => void): void {
  wireBackdrop('#setScrim', () => openSet(false));
  const form = must<HTMLFormElement>('#setForm');

  form.addEventListener('click', (e) => {
    const b = (e.target as Element | null)?.closest<HTMLElement>('.chipm');
    if (!b || b.id === 'st-reset') return;
    const mark = (attrName: string, val: string | number): void => {
      for (const x of $$('[' + attrName + ']', form)) x.classList.toggle('on', x.getAttribute(attrName) === String(val));
    };
    if (b.dataset['slip']) {
      SET.slip = Number(b.dataset['slip']);
      must<HTMLInputElement>('#st-slip').value = String(SET.slip);
      mark('data-slip', SET.slip);
    }
    if (b.dataset['prio']) {
      SET.prio = Number(b.dataset['prio']);
      must<HTMLInputElement>('#st-prio').value = String(SET.prio);
      mark('data-prio', SET.prio);
    }
    if (b.dataset['mev']) {
      SET.mev = b.dataset['mev'] as MevMode;
      mark('data-mev', SET.mev);
    }
    if (b.dataset['cf']) {
      SET.confirm = b.dataset['cf'] === '1';
      mark('data-cf', b.dataset['cf']);
    }
  });

  form.addEventListener('click', (e) => {
    if (!(e.target as Element | null)?.closest('#st-reset')) return;
    resetSettings();
    fillSet();
    toast('SETTINGS RESET TO DEFAULTS');
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    SET.slip = field('#st-slip', 0.1, 50, DEFAULTS.slip);
    SET.prio = field('#st-prio', 0, 1, DEFAULTS.prio);
    SET.mevTip = field('#st-mev', 0, 1, DEFAULTS.mevTip);
    SET.cap = field('#st-cap', 0.001, 5, DEFAULTS.cap);
    SET.defBuy = field('#st-buy', 0.01, 999, DEFAULTS.defBuy);
    saveSettings();
    openSet(false);
    toast('SETTINGS SAVED ' + DOT + ' SLIP ' + SET.slip + '% ' + DOT + ' PRIO ' + SET.prio + ' ' + nativeUnit());
    onSaved();
  });
}
