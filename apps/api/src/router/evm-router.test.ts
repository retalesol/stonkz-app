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

  it('is null on Solana regardless of config \u2014 StonkzRouter is an RH-only contract', () => {
    expect(stonkzRouterDecision('SOL', ROUTER, true, WETH, 'WETH', {})).toBeNull();
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

function decodeLeg(data: Hex, fn: 'buyViaAggregator' | 'sellViaAggregator') {
  const decoded = decodeFunctionData({ abi: STONKZ_ROUTER_ABI, data });
  expect(decoded.functionName).toBe(fn);
  return decoded.args;
}

describe('buildAtomicBuyCall', () => {
  it('direct pair: encodes buyViaAggregator with a wrap-only leg, msg.value = ethIn, maxSlippageBps = 0', () => {
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

    const args = decodeLeg(call.data, 'buyViaAggregator');
    const [token, leg, minTokenOut] = args as unknown as [
      string,
      { commands: Hex; inputs: readonly Hex[]; quotedOut: bigint; maxSlippageBps: bigint; amountIn: bigint },
      bigint,
      bigint,
    ];
    expect(token.toLowerCase()).toBe(TOKEN.toLowerCase());
    expect(leg.commands).toBe('0x0b');
    expect(leg.maxSlippageBps).toBe(0n); // exact 1:1 wrap \u2014 no market risk to tolerate
    expect(leg.amountIn).toBe(0n); // ignored on the buy path per the contract's own doc comment
    expect(minTokenOut).toBe(1n);
  });

  it('aggregator hop: encodes a wrap+swap leg and clamps the caller\u2019s slippage to the contract\u2019s MAX_SLIPPAGE_BPS ceiling', () => {
    const call = buildAtomicBuyCall({
      routerAddress: ROUTER,
      token: TOKEN,
      weth: WETH,
      baseMint: USDC,
      route: { mode: 'aggregator', feeTier: 3000 },
      ethInAtoms: 10n ** 18n,
      quotedBaseOutAtoms: 4200n * 10n ** 6n,
      minTokenOutAtoms: 1n,
      userSlippagePct: 50, // a wide Settings.slip that would exceed the contract's own cap unclamped
      deadlineUnixSeconds: 2_000_000_000,
    });
    const args = decodeLeg(call.data, 'buyViaAggregator');
    const [, leg] = args as unknown as [string, { commands: Hex; maxSlippageBps: bigint; quotedOut: bigint }];
    expect(leg.commands).toBe('0x0b00');
    expect(leg.maxSlippageBps).toBe(BigInt(ROUTER_MAX_SLIPPAGE_BPS));
    expect(leg.quotedOut).toBe(4200n * 10n ** 6n);
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

  it('with no permit supplied, encodes PermitData.deadline = 0 (the standing-allowance branch)', () => {
    const call = buildAtomicSellCall({ ...baseParams, permit: null });
    expect(call.value).toBe('0');
    const args = decodeLeg(call.data, 'sellViaAggregator');
    const [, amountToken, permitData, minBaseOut, leg, minEthOut] = args as unknown as [
      string,
      bigint,
      { value: bigint; deadline: bigint; v: number; r: Hex; s: Hex },
      bigint,
      { commands: Hex; amountIn: bigint; quotedOut: bigint },
      bigint,
    ];
    expect(amountToken).toBe(1000n);
    expect(permitData.deadline).toBe(0n);
    expect(permitData.value).toBe(0n);
    expect(permitData.v).toBe(0);
    expect(minBaseOut).toBe(490n);
    expect(minEthOut).toBe(490n);
    expect(leg.commands).toBe('0x0c');
    expect(leg.amountIn).toBe(500n); // AggregatorLeg.amountIn = curveNetBaseOutAtoms, not the floor
  });

  it('with a permit supplied, embeds it verbatim in PermitData', () => {
    const permit = {
      value: '1000',
      deadline: 1_999_999_000,
      v: 27,
      r: `0x${'11'.repeat(32)}` as Hex,
      s: `0x${'22'.repeat(32)}` as Hex,
    };
    const call = buildAtomicSellCall({ ...baseParams, permit });
    const args = decodeLeg(call.data, 'sellViaAggregator');
    const [, , permitData] = args as unknown as [
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

  it('aggregator hop: leg.amountIn is the curve\u2019s expected proceeds even though the swap operates on ADDRESS_THIS\u2019s balance', () => {
    const call = buildAtomicSellCall({
      ...baseParams,
      baseMint: USDC,
      route: { mode: 'aggregator', feeTier: 500 },
      netBaseOutAtoms: 4200n,
      quotedEthOutAtoms: 1n * 10n ** 15n,
      permit: null,
    });
    const args = decodeLeg(call.data, 'sellViaAggregator');
    const [, , , , leg] = args as unknown as [
      string,
      bigint,
      unknown,
      bigint,
      { commands: Hex; amountIn: bigint; quotedOut: bigint },
    ];
    expect(leg.commands).toBe('0x000c');
    expect(leg.amountIn).toBe(4200n);
    expect(leg.quotedOut).toBe(1n * 10n ** 15n);
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
