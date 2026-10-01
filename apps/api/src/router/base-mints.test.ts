import { afterEach, describe, expect, it } from 'vitest';
import {
  EVM_BASE_MINTS,
  createBaseMintRegistry,
  evmBaseMintTable,
  parseBaseMintOverrides,
} from './base-mints.js';

const saved = { RH: process.env['RH_CHAIN_ID'], BASE: process.env['BASE_CHAIN_ID'] };
afterEach(() => {
  if (saved.RH === undefined) delete process.env['RH_CHAIN_ID'];
  else process.env['RH_CHAIN_ID'] = saved.RH;
  if (saved.BASE === undefined) delete process.env['BASE_CHAIN_ID'];
  else process.env['BASE_CHAIN_ID'] = saved.BASE;
});

describe('base mints are keyed by chain id', () => {
  it('defaults to the testnets and lists stock tokens only on RH 46630', () => {
    delete process.env['RH_CHAIN_ID'];
    delete process.env['BASE_CHAIN_ID'];
    const r = createBaseMintRegistry();
    expect(r.mintFor('RH', 'WETH')).toBe('0x7943e237c7F95DA44E0301572D358911207852Fa');
    expect(r.mintFor('RH', 'TSLA')).toMatch(/^0x/);
    expect(r.mintFor('BASE', 'USDC')).toBe('0x036CbD53842c5426634e7929541eC2318f3dCF7e');
  });

  it('resolves the mainnet pins for 4663 / 8453 and never a testnet address', () => {
    const r = createBaseMintRegistry({ rhChainId: 4663, baseChainId: 8453 });
    expect(r.mintFor('RH', 'WETH')).toBe('0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73');
    expect(r.mintFor('RH', 'USDG')).toBe('0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168');
    expect(r.mintFor('RH', 'ETH')).toBe('0x0000000000000000000000000000000000000000');
    // No stock bases in v1 mainnet scope.
    expect(r.mintFor('RH', 'TSLA')).toBeNull();
    expect(r.symbolFor('RH', '0x7943e237c7F95DA44E0301572D358911207852Fa')).toBeNull();
    expect(r.mintFor('BASE', 'WETH')).toBe('0x4200000000000000000000000000000000000006');
    expect(r.mintFor('BASE', 'USDC')).toBe('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
    expect(r.symbolFor('BASE', '0x036cbd53842c5426634e7929541ec2318f3dcf7e')).toBeNull();
    expect(r.symbolFor('BASE', '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913')).toBe('USDC');
  });

  it('reads the chain ids from the environment when not passed', () => {
    process.env['RH_CHAIN_ID'] = '4663';
    process.env['BASE_CHAIN_ID'] = '8453';
    const r = createBaseMintRegistry();
    expect(r.mintFor('RH', 'USDG')).toBe('0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168');
    expect(r.mintFor('BASE', 'USDC')).toBe('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
  });

  it('fails closed on a chain id with no table unless WETH is overridden', () => {
    expect(() => createBaseMintRegistry({ rhChainId: 1234 })).toThrow(/BASE_MINT_OVERRIDES_RH/);
    expect(() => evmBaseMintTable('BASE', 999)).toThrow(/BASE_MINT_OVERRIDES_BASE/);
    const r = createBaseMintRegistry({
      rhChainId: 1234,
      RH: parseBaseMintOverrides('WETH:0x00000000000000000000000000000000000000aa'),
    });
    expect(r.mintFor('RH', 'WETH')).toBe('0x00000000000000000000000000000000000000aa');
    expect(r.mintFor('RH', 'ETH')).toBe('0x0000000000000000000000000000000000000000');
    expect(r.mintFor('RH', 'USDG')).toBeNull();
  });

  it('lets overrides win on a pinned chain', () => {
    const r = createBaseMintRegistry({
      rhChainId: 4663,
      RH: parseBaseMintOverrides('usdg:0x00000000000000000000000000000000000000bb'),
    });
    expect(r.mintFor('RH', 'USDG')).toBe('0x00000000000000000000000000000000000000bb');
  });

  it('pins agree with the Solidity config libraries', () => {
    expect(
      Object.keys(EVM_BASE_MINTS)
        .map(Number)
        .sort((a, b) => a - b),
    ).toEqual([4663, 8453, 46630, 84532]);
    for (const table of Object.values(EVM_BASE_MINTS)) {
      for (const addr of Object.values(table)) expect(addr).toMatch(/^0x[0-9a-fA-F]{40}$/);
    }
  });
});
