import { describe, expect, it } from 'vitest';
import { decodeFunctionData, getAddress, type Hex } from 'viem';
import { ZERO_EVM_ADDRESS } from '../env.js';
import { STONKZ_ROUTER_ABI } from './evm-abi.js';
import {
  ROUTER_MAX_SLIPPAGE_BPS,
  buildAtomicBuyCall,
  buildAtomicSellCall,
  buildSellPermitTypedData,
  noPermit,
  pinnedV3FeeTierFor,
  stonkzRouterDecision,
} from './evm-router.js';

const ROUTER = getAddress(`0x${'baad00'.padStart(40, '0')}`);
const TOKEN = getAddress(`0x${'c01a2000'.padStart(40, '0')}`);
const WETH = getAddress(`0x${'dead'.padStart(40, '0')}`);
const USDC = getAddress(`0x${'beef1234'.padStart(40, '0')}`);
const WALLET = getAddress(`0x${'fee00fee'.padStart(40, '0')}`);

describe('stonkzRouterDecision', () => {
  it('is null when no StonkzRouter is configured (the zero-address placeholder)', () => {
    expect(stonkzRouterDecision('RH', ZERO_EVM_ADDRESS, true, WETH, 'WETH', {})).toBeNull();
    expect(stonkzRouterDecision('RH', '', true, WETH, 'WETH', {})).toBeNull();
  });

  it('is null on Solana regardless of config \u2014 StonkzRouter is EVM-only', () => {
    expect(stonkzRouterDecision('SOL', ROUTER, true, WETH, 'WETH', {})).toBeNull();
  });

  it('accepts BASE the same way as RH once a router is configured', () => {
    expect(stonkzRouterDecision('BASE', ROUTER, true, WETH, 'WETH', {})).toEqual({ mode: 'direct' });
  });

  it('takes the direct-pair mode with no fee-tier lookup needed once a router is configured', () => {
    const decision = stonkzRouterDecision('RH', ROUTER, true, WETH, 'WETH', {});
    expect(decision).toEqual({ mode: 'direct' });
  });

  it('requires an explicitly pinned v3 fee tier for an aggregator-hop base asset \u2014 never a guessed default', () => {
    expect(stonkzRouterDecision('RH', ROUTER, false, USDC, 'USDC', {})).toBeNull();
    const decision = stonkzRouterDecision('RH', ROUTER, false, USDC, 'USDC', { USDC: 3000 });
    expect(decision).toEqual({ mode: 'aggregator', feeTier: 3000 });
  });

  it('pinnedV3FeeTierFor looks up by symbol or by mint, both upper-cased to match env.ts\u2019s intMap', () => {
    expect(pinnedV3FeeTierFor(USDC, 'USDC', { USDC: 500 })).toBe(500);
    expect(pinnedV3FeeTierFor(USDC, 'USDC', { [USDC.toUpperCase()]: 10000 })).toBe(10000);
    expect(pinnedV3FeeTierFor(USDC, 'USDC', {})).toBeNull();
  });
});

describe('buildAtomicBuyCall', () => {
  it('direct pair: encodes buyWithEth (local wrap), msg.value = ethIn', () => {
    const call = buildAtomicBuyCall({
      routerAddress: ROUTER,
      token: TOKEN,
      weth: WETH,
      baseMint: WETH,
      route: { mode: 'direct' },
      ethInAtoms: 10n ** 18n,
      quotedBaseOutAtoms: 10n ** 18n,
      minTokenOutAtoms: 1n,
      userSlippagePct: 1.5,
      deadlineUnixSeconds: 2_000_000_000,
    });
    expect(call.atomic).toBe(true);
    expect(call.chain).toBe('RH');
    expect(call.to).toBe(ROUTER);
    expect(call.value).toBe((10n ** 18n).toString());

    const decoded = decodeFunctionData({ abi: STONKZ_ROUTER_ABI, data: call.data });
    expect(decoded.functionName).toBe('buyWithEth');
    const [token, minTokenOut] = decoded.args as unknown as [string, bigint, bigint];
    expect(token.toLowerCase()).toBe(TOKEN.toLowerCase());
    expect(minTokenOut).toBe(1n);
  });

  it('aggregator hop: encodes buyViaV3 with pinned fee and clamps slippage', () => {
    const call = buildAtomicBuyCall({
      routerAddress: ROUTER,
      token: TOKEN,
      weth: WETH,
      baseMint: USDC,
      route: { mode: 'aggregator', feeTier: 3000 },
      ethInAtoms: 10n ** 18n,
      quotedBaseOutAtoms: 4200n * 10n ** 6n,
      minTokenOutAtoms: 1n,
      userSlippagePct: 50,
      deadlineUnixSeconds: 2_000_000_000,
    });
    const decoded = decodeFunctionData({ abi: STONKZ_ROUTER_ABI, data: call.data });
    expect(decoded.functionName).toBe('buyViaV3');
    const [token, fee, quotedBaseOut, maxSlippageBps, minTokenOut] = decoded.args as unknown as [
      string,
      number,
      bigint,
      bigint,
      bigint,
      bigint,
    ];
    expect(token.toLowerCase()).toBe(TOKEN.toLowerCase());
    expect(fee).toBe(3000);
    expect(quotedBaseOut).toBe(4200n * 10n ** 6n);
    expect(maxSlippageBps).toBe(BigInt(ROUTER_MAX_SLIPPAGE_BPS));
    expect(minTokenOut).toBe(1n);
  });
});

describe('buildAtomicSellCall \u2014 permit vs standing-allowance branches', () => {
  const baseParams = {
    routerAddress: ROUTER,
    token: TOKEN,
    weth: WETH,
    baseMint: WETH,
    route: { mode: 'direct' as const },
    amountTokenAtoms: 1000n,
    netBaseOutAtoms: 500n,
    quotedEthOutAtoms: 500n,
    minBaseOutAtoms: 490n,
    minEthOutAtoms: 490n,
    userSlippagePct: 1,
    deadlineUnixSeconds: 2_000_000_000,
  };

  it('with no permit supplied, encodes sellForEth for a direct WETH pair (local unwrap)', () => {
    const call = buildAtomicSellCall({ ...baseParams, permit: null });
    expect(call.value).toBe('0');
    const decoded = decodeFunctionData({ abi: STONKZ_ROUTER_ABI, data: call.data });
    expect(decoded.functionName).toBe('sellForEth');
    const [token, amountToken, permitData, minBaseOut, minEthOut] = decoded.args as unknown as [
      string,
      bigint,
      { value: bigint; deadline: bigint; v: number },
      bigint,
      bigint,
      bigint,
    ];
    expect(token.toLowerCase()).toBe(TOKEN.toLowerCase());
    expect(amountToken).toBe(1000n);
    expect(permitData.deadline).toBe(0n);
    expect(permitData.value).toBe(0n);
    expect(permitData.v).toBe(0);
    expect(minBaseOut).toBe(490n);
    expect(minEthOut).toBe(490n);
  });

  it('with a permit supplied, embeds it verbatim in PermitData on sellForEth', () => {
    const permit = {
      value: '1000',
      deadline: 1_999_999_000,
      v: 27,
      r: `0x${'11'.repeat(32)}` as Hex,
      s: `0x${'22'.repeat(32)}` as Hex,
    };
    const call = buildAtomicSellCall({ ...baseParams, permit });
    const decoded = decodeFunctionData({ abi: STONKZ_ROUTER_ABI, data: call.data });
    expect(decoded.functionName).toBe('sellForEth');
    const [, , permitData] = decoded.args as unknown as [
      string,
      bigint,
      { value: bigint; deadline: bigint; v: number; r: Hex; s: Hex },
    ];
    expect(permitData.value).toBe(1000n);
    expect(permitData.deadline).toBe(1_999_999_000n);
    expect(permitData.v).toBe(27);
    expect(permitData.r.toLowerCase()).toBe(permit.r.toLowerCase());
    expect(permitData.s.toLowerCase()).toBe(permit.s.toLowerCase());
  });

  it('noPermit() matches Router.t.sol\u2019s own _noPermit() fixture shape', () => {
    const p = noPermit();
    expect(p.value).toBe(0n);
    expect(p.deadline).toBe(0n);
    expect(p.v).toBe(0);
    expect(p.r).toBe(`0x${'00'.repeat(32)}`);
    expect(p.s).toBe(`0x${'00'.repeat(32)}`);
  });

  it('aggregator hop: encodes sellViaV3 with curve proceeds as amountInBase', () => {
    const call = buildAtomicSellCall({
      ...baseParams,
      baseMint: USDC,
      route: { mode: 'aggregator', feeTier: 500 },
      netBaseOutAtoms: 4200n,
      quotedEthOutAtoms: 1n * 10n ** 15n,
      permit: null,
    });
    const decoded = decodeFunctionData({ abi: STONKZ_ROUTER_ABI, data: call.data });
    expect(decoded.functionName).toBe('sellViaV3');
    const [, , , , fee, quotedEthOut, , , amountInBase] = decoded.args as unknown as [
      string,
      bigint,
      unknown,
      bigint,
      number,
      bigint,
      bigint,
      bigint,
      bigint,
      bigint,
    ];
    expect(fee).toBe(500);
    expect(amountInBase).toBe(4200n);
    expect(quotedEthOut).toBe(1n * 10n ** 15n);
  });
});

describe('buildSellPermitTypedData', () => {
  it('uses the token\u2019s own name and version "1", matching StonkzToken.sol\u2019s EIP-712 domain exactly', () => {
    const typed = buildSellPermitTypedData({
      tokenAddress: TOKEN,
      tokenName: 'Atom Coin',
      chainId: 4663,
      routerAddress: ROUTER,
      owner: WALLET,
      valueAtoms: 5000n,
      deadlineUnixSeconds: 2_000_000_000,
    });
    expect(typed.domain).toEqual({ name: 'Atom Coin', version: '1', chainId: 4663, verifyingContract: TOKEN });
    expect(typed.primaryType).toBe('Permit');
    expect(typed.types.Permit.map((f) => f.name)).toEqual(['owner', 'spender', 'value', 'nonce', 'deadline']);
    expect(typed.message.owner).toBe(WALLET);
    expect(typed.message.spender).toBe(ROUTER);
    expect(typed.message.value).toBe('5000');
    expect(typed.message.nonce).toBeNull();
  });
});
