import type { MevMode, Settings } from '@stonkz/shared';

/**
 * Transaction defaults.
 *
 * Device-local cache in `stonkz.settings.v1`, synced to `PUT /me/settings`
 * when a live session is active so `/trade/prepare` uses the same slip /
 * priority / MEV tip the UI shows.
 */

const KEY = 'stonkz.settings.v1';

export const DEFAULTS: Settings = {
  slip: 2.5,
  prio: 0.0012,
  mev: 'SHIELD',
  mevTip: 0.0009,
  // Must cover defBuy + Solana prio/MEV tip — prepare rejects buys above this.
  // Aligns with API / DB default (5), not the oracle's legacy 0.02.
  cap: 5,
  defBuy: 0.5,
  confirm: true,
};

export const SET: Settings = { ...DEFAULTS };

export function loadSettings(): void {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return;
    const o = JSON.parse(raw) as Partial<Settings>;
    applySettings(o);
  } catch {
    /* a corrupt blob falls back to defaults */
  }
}

export function applySettings(o: Partial<Settings>): void {
  for (const k of Object.keys(SET) as Array<keyof Settings>) {
    const v = o[k];
    if (v !== undefined && v !== null) (SET as unknown as Record<string, unknown>)[k] = v;
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
  saveSettings();
}

/** Payload for prepare + PUT /me/settings. */
export function settingsPayload(): Settings {
  return {
    slip: SET.slip,
    prio: SET.prio,
    mev: SET.mev as MevMode,
    mevTip: SET.mevTip,
    cap: SET.cap,
    defBuy: SET.defBuy,
    confirm: SET.confirm,
  };
}
