import type { Settings } from '@stonkz/shared';

/**
 * Transaction defaults, persisted in `stonkz.settings.v1`.
 *
 * These stay device-local through Phase 2 — they parameterise the composed
 * transaction (aggregator hop + curve hop + priority + MEV tip) but are never
 * authoritative for settlement. `index.html:2488`
 */

const KEY = 'stonkz.settings.v1';

export const DEFAULTS: Settings = {
  slip: 2.5,
  prio: 0.0012,
  mev: 'SHIELD',
  mevTip: 0.0009,
  cap: 0.02,
  defBuy: 0.5,
  confirm: true,
};

export const SET: Settings = { ...DEFAULTS };

export function loadSettings(): void {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return;
    const o = JSON.parse(raw) as Partial<Settings>;
    for (const k of Object.keys(SET) as Array<keyof Settings>) {
      const v = o[k];
      if (v !== undefined && v !== null) (SET as unknown as Record<string, unknown>)[k] = v;
    }
  } catch {
    /* a corrupt blob falls back to defaults */
  }
}

export function saveSettings(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(SET));
  } catch {
    /* private mode / quota — settings just stay in memory */
  }
}

export function resetSettings(): void {
  Object.assign(SET, DEFAULTS);
}
