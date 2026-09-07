import { describe, expect, it } from 'vitest';
import { decodeAbiParameters, getAddress, type Hex } from 'viem';
import {
  ADDRESS_THIS,
  CONTRACT_BALANCE,
  MSG_SENDER,
  buildBuyAggregatorLeg,
  buildSellAggregatorLeg,
  buildUnwrapOnlyLeg,
  buildWrapOnlyLeg,
  encodeV3Path,
} from './universal-router.js';

const WETH = getAddress(`0x${'dead'.padStart(40, '0')}`);
const BASE = getAddress(`0x${'beef1234'.padStart(40, '0')}`);
const FEE_TIER = 3000;

function decodeV3SwapInput(input: Hex): { recipient: string; amountIn: bigint; amountOutMinimum: bigint; path: Hex; payerIsUser: boolean } {
  const [recipient, amountIn, amountOutMinimum, path, payerIsUser] = decodeAbiParameters(
    [{ type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bytes' }, { type: 'bool' }],
    input,
  );
  return {
    recipient: recipient as string,
    amountIn: amountIn as bigint,
    amountOutMinimum: amountOutMinimum as bigint,
    path: path as Hex,
    payerIsUser: payerIsUser as boolean,
  };
}

function decodeWrapUnwrapInput(input: Hex): { recipient: string; amount: bigint } {
  const [recipient, amount] = decodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], input);
  return { recipient: recipient as string, amount: amount as bigint };
}

describe('universal-router: recipient sentinels', () => {
  // The one thing StonkzRouter's own doc comment (and the atomicity-gap
  // history in evm-tx.ts) calls out as the load-bearing mistake to never
  // repeat: MSG_SENDER, not ADDRESS_THIS, on any command whose output must
  // land back in StonkzRouter itself.
  it('MSG_SENDER and ADDRESS_THIS are the real Universal Router sentinel addresses, and are distinct', () => {
    expect(MSG_SENDER).toBe('0x0000000000000000000000000000000000000001');
    expect(ADDRESS_THIS).toBe('0x0000000000000000000000000000000000000002');
    expect(MSG_SENDER).not.toBe(ADDRESS_THIS);
  });

  it('direct-pair buy (WRAP_ETH only) sends the wrapped WETH to MSG_SENDER, never ADDRESS_THIS', () => {
    const leg = buildWrapOnlyLeg();
    expect(leg.commands).toBe('0x0b');
    expect(leg.inputs).toHaveLength(1);
    const decoded = decodeWrapUnwrapInput(leg.inputs[0] as Hex);
    expect(decoded.recipient.toLowerCase()).toBe(MSG_SENDER.toLowerCase());
    expect(decoded.amount).toBe(CONTRACT_BALANCE);
  });

  it('direct-pair sell (UNWRAP_WETH only) sends the unwrapped ETH to MSG_SENDER', () => {
    const leg = buildUnwrapOnlyLeg();
    expect(leg.commands).toBe('0x0c');
    const decoded = decodeWrapUnwrapInput(leg.inputs[0] as Hex);
    expect(decoded.recipient.toLowerCase()).toBe(MSG_SENDER.toLowerCase());
    expect(decoded.amount).toBe(0n);
  });

  it('aggregator buy leg: WRAP_ETH parks WETH at ADDRESS_THIS (intermediate hop), the swap delivers to MSG_SENDER', () => {
    const leg = buildBuyAggregatorLeg(WETH, BASE, FEE_TIER);
    expect(leg.commands).toBe('0x0b00'); // WRAP_ETH then V3_SWAP_EXACT_IN
    expect(leg.inputs).toHaveLength(2);

    const wrap = decodeWrapUnwrapInput(leg.inputs[0] as Hex);
    expect(wrap.recipient.toLowerCase()).toBe(ADDRESS_THIS.toLowerCase());
    expect(wrap.amount).toBe(CONTRACT_BALANCE);

    const swap = decodeV3SwapInput(leg.inputs[1] as Hex);
    expect(swap.recipient.toLowerCase()).toBe(MSG_SENDER.toLowerCase());
    expect(swap.recipient.toLowerCase()).not.toBe(ADDRESS_THIS.toLowerCase());
    expect(swap.payerIsUser).toBe(false);
    expect(swap.path).toBe(encodeV3Path(WETH, FEE_TIER, BASE));
  });

  it('aggregator sell leg: the swap parks WETH at ADDRESS_THIS with payerIsUser=false, UNWRAP_WETH delivers to MSG_SENDER', () => {
    const leg = buildSellAggregatorLeg(BASE, WETH, FEE_TIER);
    expect(leg.commands).toBe('0x000c'); // V3_SWAP_EXACT_IN then UNWRAP_WETH
    expect(leg.inputs).toHaveLength(2);

    const swap = decodeV3SwapInput(leg.inputs[0] as Hex);
    expect(swap.recipient.toLowerCase()).toBe(ADDRESS_THIS.toLowerCase());
    // The router just transferred the curve's base proceeds to the Universal
    // Router itself, so the swap must spend from that balance, not pull from
    // whoever signed the outer transaction.
    expect(swap.payerIsUser).toBe(false);
    expect(swap.path).toBe(encodeV3Path(BASE, FEE_TIER, WETH));

    const unwrap = decodeWrapUnwrapInput(leg.inputs[1] as Hex);
    expect(unwrap.recipient.toLowerCase()).toBe(MSG_SENDER.toLowerCase());
  });

  it('a swap recipient of the trader\u2019s own EOA (the Trading API\u2019s own calldata shape) is never produced by this module', () => {
    const buyLeg = buildBuyAggregatorLeg(WETH, BASE, FEE_TIER);
    const sellLeg = buildSellAggregatorLeg(BASE, WETH, FEE_TIER);
    for (const leg of [buyLeg, sellLeg]) {
      for (const input of leg.inputs) {
        // Every input this module builds is either the (address, uint256)
        // wrap/unwrap shape or the 5-field swap shape; in both, the first
        // field is the recipient, and it is always one of the two sentinels.
        const [recipient] = decodeAbiParameters([{ type: 'address' }], input as Hex);
        const r = (recipient as string).toLowerCase();
        expect([MSG_SENDER.toLowerCase(), ADDRESS_THIS.toLowerCase()]).toContain(r);
      }
    }
  });
});

describe('universal-router: v3 path encoding', () => {
  it('packs (tokenIn, fee, tokenOut) as 20/3/20 bytes', () => {
    const path = encodeV3Path(WETH, 3000, BASE);
    // 0x + 20 bytes + 3 bytes + 20 bytes = 2 + 40 + 6 + 40 = 88 hex chars.
    expect(path.length).toBe(88);
    expect(path.toLowerCase()).toContain(WETH.slice(2).toLowerCase());
    expect(path.toLowerCase()).toContain(BASE.slice(2).toLowerCase());
  });
});
