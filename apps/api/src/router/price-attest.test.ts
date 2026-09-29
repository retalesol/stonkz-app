import { beforeEach, describe, expect, it } from 'vitest';
import {
  decodeAbiParameters,
  encodeAbiParameters,
  recoverMessageAddress,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createLogger } from '../observability/logger.js';
import {
  ATTESTATION_MAGIC,
  attestationDigest,
  attesterFromKey,
  isAttestation,
  readAttestationSink,
  resetAttestationSinkCache,
  signAttestation,
  stockAttestationsFor,
} from './price-attest.js';

// Anvil's first dev key: public, never funded anywhere real.
const KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;
const account = privateKeyToAccount(KEY);
const SOURCE = '0x00000000000000000000000000000000000057c5' as Address;
const ROUTER = '0x00000000000000000000000000000000000a0073' as Address;
const TSLA = '0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E' as Address;
const logger = createLogger('silent');

const input = {
  chainId: 46630,
  source: SOURCE,
  base: TSLA,
  price1e6: 358_400_000n,
  publishTime: 1_790_000_000,
};

function sinkCaller(sink: Address | null, opts: { revert?: boolean } = {}) {
  const calls: string[] = [];
  return {
    calls,
    ethCall: async (to: string) => {
      calls.push(to);
      if (opts.revert) throw new Error('execution reverted');
      return encodeAbiParameters(
        [{ type: 'address' }],
        [sink ?? '0x0000000000000000000000000000000000000000'],
      );
    },
  };
}

beforeEach(() => resetAttestationSinkCache());

describe('stock price attestations', () => {
  it('encodes STKA | base | price | time | sig, and the signature recovers to the attester', async () => {
    const att = await signAttestation(account, input);
    expect(isAttestation(att)).toBe(true);
    const [magic, base, price, time, sig] = decodeAbiParameters(
      [
        { type: 'bytes4' },
        { type: 'address' },
        { type: 'uint64' },
        { type: 'uint64' },
        { type: 'bytes' },
      ],
      att,
    );
    expect(magic).toBe(ATTESTATION_MAGIC);
    expect(base).toBe(TSLA);
    expect(price).toBe(358_400_000n);
    expect(time).toBe(1_790_000_000n);
    expect((sig as Hex).length).toBe(2 + 65 * 2);
    const signer = await recoverMessageAddress({
      message: { raw: attestationDigest(input) },
      signature: sig as Hex,
    });
    expect(signer).toBe(account.address);
  });

  it('binds the digest to chain, source, base, price and time', () => {
    const d = attestationDigest(input);
    expect(attestationDigest({ ...input, chainId: 4663 })).not.toBe(d);
    expect(attestationDigest({ ...input, source: TSLA })).not.toBe(d);
    expect(attestationDigest({ ...input, base: SOURCE })).not.toBe(d);
    expect(attestationDigest({ ...input, price1e6: input.price1e6 + 1n })).not.toBe(d);
    expect(attestationDigest({ ...input, publishTime: input.publishTime + 1 })).not.toBe(d);
  });

  it('parses the key with or without 0x and refuses a malformed one', () => {
    expect(attesterFromKey(undefined)).toBeNull();
    expect(attesterFromKey('  ')).toBeNull();
    expect(attesterFromKey(KEY.slice(2))?.address).toBe(account.address);
    expect(() => attesterFromKey('0x1234')).toThrow(/32-byte/);
  });

  it('reads and caches the router sink; a revert or zero sink means none', async () => {
    const live = sinkCaller(SOURCE);
    expect(await readAttestationSink(live, ROUTER, 0)).toBe(SOURCE);
    expect(await readAttestationSink(live, ROUTER, 1_000)).toBe(SOURCE);
    expect(live.calls).toHaveLength(1);
    resetAttestationSinkCache();
    expect(await readAttestationSink(sinkCaller(null), ROUTER, 0)).toBeNull();
    resetAttestationSinkCache();
    expect(await readAttestationSink(sinkCaller(SOURCE, { revert: true }), ROUTER, 0)).toBeNull();
  });

  it('signs with the sink as source and "now" as the publish time', async () => {
    const [att] = await stockAttestationsFor({
      attester: account,
      caller: sinkCaller(SOURCE),
      router: ROUTER,
      chainId: 46630,
      base: TSLA,
      price1e6: 358_400_000n,
      nowMs: 1_790_000_000_500,
      logger,
    });
    expect(att).toBe(await signAttestation(account, input));
  });

  it.each([
    ['no attester key', { attester: null }],
    ['no price', { price1e6: null }],
    ['a router without a sink', { caller: sinkCaller(null) }],
    ['no RPC', { caller: null }],
  ])('sends nothing with %s', async (_, over) => {
    const out = await stockAttestationsFor({
      attester: account,
      caller: sinkCaller(SOURCE),
      router: ROUTER,
      chainId: 46630,
      base: TSLA,
      price1e6: 358_400_000n,
      nowMs: 1_790_000_000_000,
      logger,
      ...over,
    });
    expect(out).toEqual([]);
  });

  it('matches the Solidity test vector byte for byte (StockAttestation.t.sol test_TypeScriptVector)', async () => {
    const v = {
      chainId: 46630,
      source: '0x1111111111111111111111111111111111111111' as Address,
      base: TSLA,
      price1e6: 251_230_000n,
      publishTime: 1_800_172_800,
    };
    const sig =
      '0x81a47902ff37aeb2818b40e0959b26189071d8e4d1222f182961b8f149e7885d1e99d2017d3022927502e686af78e42fbcc4a99e069b39537e98ebad5887aa011c' as Hex;
    const digest = attestationDigest(v);
    expect(digest).toBe('0x6f0df46fbead27ad246430c1e267fff6d04a9749f7c44c9ffe0afe40cb759695');
    expect(await recoverMessageAddress({ message: { raw: digest }, signature: sig })).toBe(
      '0x501D9b198010BC786D8b0DAc53ac700c8ACdc02d',
    );
    const att = encodeAbiParameters(
      [
        { type: 'bytes4' },
        { type: 'address' },
        { type: 'uint64' },
        { type: 'uint64' },
        { type: 'bytes' },
      ],
      [ATTESTATION_MAGIC, v.base, v.price1e6, BigInt(v.publishTime), sig],
    );
    expect(att).toBe(
      '0x53544b4100000000000000000000000000000000000000000000000000000000000000000000000000000000c9f9c86933092bbbfff3ccb4b105a4a94bf3bd4e000000000000000000000000000000000000000000000000000000000ef97730000000000000000000000000000000000000000000000000000000006b4c750000000000000000000000000000000000000000000000000000000000000000a0000000000000000000000000000000000000000000000000000000000000004181a47902ff37aeb2818b40e0959b26189071d8e4d1222f182961b8f149e7885d1e99d2017d3022927502e686af78e42fbcc4a99e069b39537e98ebad5887aa011c00000000000000000000000000000000000000000000000000000000000000',
    );
  });
});
