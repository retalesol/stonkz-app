import {
  DEFAULT_TRADE_CAP,
  MAX_TRADE_CAP,
  isEvm,
  nativeUnit as unitFor,
  type EvmGasPreset,
  type MevMode,
  type NativeUnit,
  type Net,
  type Settings,
} from '@stonkz/shared';
import { nativeUnit } from './wallet.js';

/**
 * Transaction defaults.
 *
 * Device-local cache in `stonkz.settings.v1`, synced to `PUT /me/settings`
 * when a live session is active so `/trade/prepare` uses the same slip /
 * priority / MEV tip the UI shows. The server row is per (net, wallet); on
 * sign-in `api/live.ts` applies it over this cache, so a wallet switch shows
 * that wallet's own settings.
 *
 * Per-chain scope, as the modal labels it: `slip`, `defBuy`, `confirm` apply
 * everywhere; `prio`, `mev`, `mevTip` are Solana-only (the API ignores them
 * on EVM nets); `evmGas` is EVM-only and device-local; `cap` is tagged with
 * the unit it was set in (`capFor`).
 */

const KEY = 'stonkz.settings.v1';

/** Field bounds — the same numbers the modal clamps to and the API re-clamps. */
export const BOUNDS = {
  slip: { min: 0.1, max: 50 },
  prio: { min: 0, max: 1 },
  mevTip: { min: 0, max: 1 },
  defBuy: { min: 0.01, max: 999 },
  capMin: 0.001,
} as const;

const MEV_MODES: readonly MevMode[] = ['SHIELD', 'RELAY', 'OFF'];
const GAS_PRESETS: readonly EvmGasPreset[] = ['NORMAL', 'FAST', 'TURBO'];
const UNITS: readonly NativeUnit[] = ['SOL', 'ETH', 'USDC'];

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
  evmGas: 'NORMAL',
};

export const SET: Settings = { ...DEFAULTS };

function num(raw: unknown, min: number, max: number): number | undefined {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number.parseFloat(raw) : NaN;
  if (!Number.isFinite(n)) return undefined;
  return Math.max(min, Math.min(max, n));
}

function oneOf<T extends string>(raw: unknown, allowed: readonly T[]): T | undefined {
  if (typeof raw !== 'string') return undefined;
  const v = raw.toUpperCase() as T;
  return allowed.includes(v) ? v : undefined;
}

/**
 * Coerce an untrusted blob (localStorage, `/me`) into in-bounds settings.
 * Anything unparseable is dropped rather than applied, so a corrupt or
 * hand-edited cache can never put a 500% slippage or a NaN cap on a ticket.
 */
export function sanitizeSettings(
  o: Partial<Settings> | Record<string, unknown>,
): Partial<Settings> {
  const src = o as Record<string, unknown>;
  const out: Partial<Settings> = {};
  const slip = num(src['slip'], BOUNDS.slip.min, BOUNDS.slip.max);
  if (slip !== undefined) out.slip = slip;
  const prio = num(src['prio'], BOUNDS.prio.min, BOUNDS.prio.max);
  if (prio !== undefined) out.prio = prio;
  const mevTip = num(src['mevTip'], BOUNDS.mevTip.min, BOUNDS.mevTip.max);
  if (mevTip !== undefined) out.mevTip = mevTip;
  const defBuy = num(src['defBuy'], BOUNDS.defBuy.min, BOUNDS.defBuy.max);
  if (defBuy !== undefined) out.defBuy = defBuy;
  const mev = oneOf(src['mev'], MEV_MODES);
  if (mev !== undefined) out.mev = mev;
  const evmGas = oneOf(src['evmGas'], GAS_PRESETS);
  if (evmGas !== undefined) out.evmGas = evmGas;
  const capUnit = oneOf(src['capUnit'], UNITS);
  if (capUnit !== undefined) out.capUnit = capUnit;
  const cap = num(src['cap'], BOUNDS.capMin, MAX_TRADE_CAP[capUnit ?? SET.capUnit ?? 'SOL']);
  if (cap !== undefined) out.cap = cap;
  if (typeof src['confirm'] === 'boolean') out.confirm = src['confirm'];
  return out;
}

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
  const clean = sanitizeSettings(o);
  for (const k of Object.keys(clean) as Array<keyof Settings>) {
    const v = clean[k];
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

/** Back to defaults, including the cap in the connected net's own unit. */
export function resetSettings(unit: NativeUnit = nativeUnit()): void {
  Object.assign(SET, DEFAULTS);
  SET.cap = DEFAULT_TRADE_CAP[unit];
  SET.capUnit = unit;
  saveSettings();
}

/**
 * The cap in the unit the ticket is denominated in. A cap saved while on
 * Solana (5 SOL) must not travel to Arc as 5 USDC, so a unit mismatch falls
 * back to that unit's default until the user sets one there.
 */
export function capFor(unit: NativeUnit = nativeUnit()): number {
  return (SET.capUnit ?? 'SOL') === unit ? SET.cap : DEFAULT_TRADE_CAP[unit];
}

/** The EVM gas preset the wallet layer applies; `NORMAL` leaves fees to the wallet. */
export function evmGasPreset(): EvmGasPreset {
  return SET.evmGas ?? 'NORMAL';
}

/**
 * One line of the settings that will shape the next order on `net`, for the
 * confirm prompt: only the ones that apply on that chain, in its own unit.
 */
export function settingsSummary(net: Net): string {
  const parts = ['SLIP ' + SET.slip + '%'];
  if (isEvm(net)) {
    parts.push('GAS ' + evmGasPreset());
  } else {
    const u = unitFor(net);
    parts.push('PRIO ' + SET.prio + ' ' + u);
    parts.push(SET.mev === 'OFF' ? 'MEV OFF' : 'MEV ' + SET.mev + ' TIP ' + SET.mevTip + ' ' + u);
  }
  return parts.join(' · ');
}

/**
 * Payload for prepare + PUT /me/settings. `evmGas` is deliberately not
 * included: the API neither stores nor applies it (the wallet does).
 */
export function settingsPayload(): Settings {
  const unit = nativeUnit();
  return {
    slip: SET.slip,
    prio: SET.prio,
    mev: SET.mev as MevMode,
    mevTip: SET.mevTip,
    cap: capFor(unit),
    capUnit: unit,
    defBuy: SET.defBuy,
    confirm: SET.confirm,
  };
}
