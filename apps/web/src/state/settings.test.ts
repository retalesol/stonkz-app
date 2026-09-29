import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Settings persistence and the payload `/trade/prepare` receives, without a
 * DOM: `localStorage` is a Map here, and the connected net is a mutable
 * mock so the per-unit cap logic can be exercised across a "wallet switch".
 */

let unit: 'SOL' | 'ETH' | 'USDC' = 'SOL';
vi.mock('./wallet.js', () => ({ nativeUnit: () => unit }));

const store = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  },
});

const mod = await import('./settings.js');
const {
  DEFAULTS,
  SET,
  applySettings,
  capFor,
  evmGasPreset,
  loadSettings,
  resetSettings,
  sanitizeSettings,
  saveSettings,
  settingsPayload,
  settingsSummary,
} = mod;

beforeEach(() => {
  store.clear();
  unit = 'SOL';
  Object.assign(SET, DEFAULTS);
  delete SET.capUnit;
});

describe('sanitizeSettings', () => {
  it('clamps every numeric field to the modal’s bounds and drops garbage', () => {
    expect(
      sanitizeSettings({
        slip: 500,
        prio: -1,
        mevTip: 'abc',
        defBuy: 0,
        mev: 'yolo',
        evmGas: 'fast',
        confirm: 'yes',
        cap: NaN,
      } as unknown as Record<string, unknown>),
    ).toEqual({ slip: 50, prio: 0, defBuy: 0.01, evmGas: 'FAST' });
    expect(sanitizeSettings({ slip: '1.5', mev: 'off', confirm: false })).toEqual({
      slip: 1.5,
      mev: 'OFF',
      confirm: false,
    });
  });

  it('bounds the cap by the unit it is tagged with', () => {
    expect(sanitizeSettings({ cap: 9_000, capUnit: 'USDC' })).toEqual({
      cap: 9_000,
      capUnit: 'USDC',
    });
    expect(sanitizeSettings({ cap: 9_000, capUnit: 'SOL' })).toEqual({ cap: 50, capUnit: 'SOL' });
  });
});

describe('persistence', () => {
  it('survives a reload: save, wipe memory, load', () => {
    applySettings({
      slip: 1,
      prio: 0.004,
      mev: 'RELAY',
      mevTip: 0.002,
      evmGas: 'TURBO',
      confirm: false,
    });
    SET.cap = 3;
    SET.capUnit = 'SOL';
    saveSettings();
    Object.assign(SET, DEFAULTS);
    delete SET.capUnit;
    expect(SET.slip).toBe(DEFAULTS.slip);
    loadSettings();
    expect(SET).toMatchObject({
      slip: 1,
      prio: 0.004,
      mev: 'RELAY',
      mevTip: 0.002,
      evmGas: 'TURBO',
      confirm: false,
      cap: 3,
      capUnit: 'SOL',
    });
  });

  it('ignores a corrupt or hostile blob instead of applying it', () => {
    store.set('stonkz.settings.v1', '{not json');
    loadSettings();
    expect(SET.slip).toBe(DEFAULTS.slip);
    store.set('stonkz.settings.v1', JSON.stringify({ slip: 999, prio: 'x', mev: 'EVIL' }));
    loadSettings();
    expect(SET.slip).toBe(50);
    expect(SET.prio).toBe(DEFAULTS.prio);
    expect(SET.mev).toBe('SHIELD');
  });

  it('reset restores defaults with the cap in the connected unit', () => {
    unit = 'USDC';
    applySettings({ slip: 9, cap: 100, capUnit: 'USDC', evmGas: 'FAST' });
    resetSettings();
    expect(SET.slip).toBe(DEFAULTS.slip);
    expect(SET.cap).toBe(5_000);
    expect(SET.capUnit).toBe('USDC');
    expect(evmGasPreset()).toBe('NORMAL');
    expect(JSON.parse(store.get('stonkz.settings.v1')!)).toMatchObject({
      cap: 5_000,
      capUnit: 'USDC',
    });
  });
});

describe('per-net cap and the prepare payload', () => {
  it('a cap set on Solana does not travel to Arc as USDC', () => {
    applySettings({ cap: 2, capUnit: 'SOL' });
    expect(capFor('SOL')).toBe(2);
    expect(capFor('USDC')).toBe(5_000);
    expect(capFor('ETH')).toBe(5);
  });

  it('a server row applied with the net’s unit is read back in that unit after a wallet switch', () => {
    // Device last saved on Solana, then an Arc wallet's row (2,000 USDC) is applied.
    applySettings({ cap: 2, capUnit: 'SOL' });
    unit = 'USDC';
    applySettings({ cap: 2_000, capUnit: 'USDC' });
    expect(capFor()).toBe(2_000);
    expect(settingsPayload()).toMatchObject({ cap: 2_000, capUnit: 'USDC' });
  });

  it('sends exactly the API-facing fields, never the device-local gas preset', () => {
    applySettings({
      slip: 1.5,
      prio: 0.0005,
      mev: 'OFF',
      mevTip: 0.001,
      defBuy: 0.25,
      evmGas: 'TURBO',
    });
    const p = settingsPayload();
    expect(p).toEqual({
      slip: 1.5,
      prio: 0.0005,
      mev: 'OFF',
      mevTip: 0.001,
      cap: 5,
      capUnit: 'SOL',
      defBuy: 0.25,
      confirm: true,
    });
    expect('evmGas' in p).toBe(false);
  });

  it('summarises only the settings that apply on the order’s chain', () => {
    applySettings({ slip: 2, prio: 0.001, mev: 'SHIELD', mevTip: 0.0005, evmGas: 'FAST' });
    expect(settingsSummary('SOL')).toBe('SLIP 2% · PRIO 0.001 SOL · MEV SHIELD TIP 0.0005 SOL');
    expect(settingsSummary('BASE')).toBe('SLIP 2% · GAS FAST');
    applySettings({ mev: 'OFF' });
    expect(settingsSummary('SOL')).toBe('SLIP 2% · PRIO 0.001 SOL · MEV OFF');
  });
});
