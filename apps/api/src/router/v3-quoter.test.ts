import { encodeAbiParameters } from 'viem';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  resetV3QuoterKinds,
  v3QuoteExactInputSingle,
  v3QuoterKind,
  type V3EthCaller,
} from './v3-pool-reads.js';

const QUOTER = '0x1111111111111111111111111111111111111111';
const WETH = '0x4200000000000000000000000000000000000006';
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
/** `quoteExactInputSingle((address,address,uint256,uint24,uint160))` */
const V2_SEL = '0xc6a5026a';
/** `quoteExactInputSingle(address,address,uint24,uint256)` */
const FLAT_SEL = '0xb3c64859';

const word = (n: bigint) => n.toString(16).padStart(64, '0');

function fake(answers: Record<string, string>): { eth: V3EthCaller; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    eth: {
      async ethCall(_to, data) {
        const sel = data.slice(0, 10).toLowerCase();
        calls.push(sel);
        const out = answers[sel];
        if (out === undefined) throw new Error(`execution reverted (${sel})`);
        return out;
      },
    },
  };
}

describe('v3QuoteExactInputSingle', () => {
  beforeEach(() => resetV3QuoterKinds());

  it('reads amountOut from a canonical QuoterV2 (four outputs) on the first call', async () => {
    const { eth, calls } = fake({
      [V2_SEL]: encodeAbiParameters(
        [{ type: 'uint256' }, { type: 'uint160' }, { type: 'uint32' }, { type: 'uint256' }],
        [2_682_722_843n, 4_104_576_055_382_452_437_557_583n, 1, 81_665n],
      ),
    });
    const out = await v3QuoteExactInputSingle(eth, QUOTER, WETH, USDC, 500, 10n ** 18n);
    expect(out).toBe(2_682_722_843n);
    expect(calls).toEqual([V2_SEL]);
    expect(v3QuoterKind(QUOTER)).toBe('v2');
  });

  it('falls back to the flat testnet quoter and remembers the kind', async () => {
    const { eth, calls } = fake({ [FLAT_SEL]: `0x${word(25n * 10n ** 6n)}` });
    expect(await v3QuoteExactInputSingle(eth, QUOTER, WETH, USDC, 3000, 10n ** 16n)).toBe(
      25_000_000n,
    );
    expect(calls).toEqual([V2_SEL, FLAT_SEL]);
    expect(v3QuoterKind(QUOTER)).toBe('flat');
    await v3QuoteExactInputSingle(eth, QUOTER, WETH, USDC, 3000, 10n ** 16n);
    expect(calls).toEqual([V2_SEL, FLAT_SEL, FLAT_SEL]);
  });

  it('throws when neither ABI answers, so callers fall back to slot0', async () => {
    const { eth } = fake({});
    await expect(v3QuoteExactInputSingle(eth, QUOTER, WETH, USDC, 500, 10n ** 18n)).rejects.toThrow(
      /reverted/,
    );
    expect(v3QuoterKind(QUOTER)).toBeUndefined();
  });

  it('rejects empty return data instead of decoding zero', async () => {
    const { eth } = fake({ [V2_SEL]: '0x', [FLAT_SEL]: '0x' });
    await expect(v3QuoteExactInputSingle(eth, QUOTER, WETH, USDC, 500, 10n ** 18n)).rejects.toThrow(
      /no data/,
    );
  });
});
