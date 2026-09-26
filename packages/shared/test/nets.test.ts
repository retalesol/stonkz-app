import { describe, expect, it } from 'vitest';
import { ALL_NETS, type Net } from '../src/types.js';
import { EVM_NETS, NET_INFO, fmtNative, isEvmNet, netInfo } from '../src/nets.js';
import { allNets, inferNetFromAddress, minTip, nativeUnit, parseNet } from '../src/validate.js';
import { MIN_TIP_USDC } from '../src/constants.js';

describe('NET_INFO', () => {
  it('has one entry per net, keyed by itself', () => {
    for (const net of ALL_NETS) expect(NET_INFO[net].k).toBe(net);
    expect(allNets()).toEqual(ALL_NETS);
  });

  it('splits the nets by kind', () => {
    expect(isEvmNet('SOL')).toBe(false);
    expect(EVM_NETS).toEqual(['BASE', 'ARC', 'RH']);
    expect(isEvmNet('nope' as Net)).toBe(false);
  });

  it('falls back to Solana for a net it does not know', () => {
    expect(netInfo('nope' as Net)).toBe(NET_INFO.SOL);
    expect(netInfo('ARC')).toBe(NET_INFO.ARC);
    expect(nativeUnit('nope' as Net)).toBe('SOL');
    expect(parseNet('nope')).toBeNull();
    expect(parseNet(undefined)).toBeNull();
  });

  it('formats a native amount at the width that chain reads', () => {
    expect(fmtNative('RH', 0.123456)).toBe('0.1235');
    expect(fmtNative('SOL', 1.005)).toBe('1.00');
    expect(fmtNative('ARC', 24.999)).toBe('25.00');
    expect(fmtNative('nope' as Net, 1)).toBe('1.00');
  });

  it('caps Arc, prices its gas in USDC and floors its tip accordingly', () => {
    expect(NET_INFO.ARC.unit).toBe('USDC');
    expect(NET_INFO.ARC.maxTradeUsd).toBe(25);
    expect(NET_INFO.ARC.nativeDecimals).toBe(18);
    expect(NET_INFO.ARC.displayDecimals).toBe(2);
    expect(minTip('USDC')).toBe(MIN_TIP_USDC);
    expect(inferNetFromAddress('0x' + 'a'.repeat(40), 'ARC')).toBe('ARC');
  });
});
