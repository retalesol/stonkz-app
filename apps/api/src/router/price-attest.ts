import {
  concatHex,
  encodeAbiParameters,
  encodeFunctionData,
  keccak256,
  parseAbi,
  toHex,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import type { Logger } from '../observability/logger.js';

/**
 * Signed stock-base price quotes ("attestations") for `StockPriceSourceV2`.
 *
 * At `/launch/prepare` the API prices a stock base from DefiLlama and signs
 * `(chainId, source, base, price1e6, publishTime)`. The launch transaction
 * carries the signed quote inside the router's `priceUpdate` array; the router
 * hands entries tagged `STKA` to the source's `postAttestation`, which checks
 * the signer, freshness and its own cross-checks (pool TWAP, last close, Pyth)
 * before using it. The key only signs messages: it holds no funds and pays no
 * gas, and the contract admin or pauser can disable it at any time.
 *
 * Byte format (must match `StockPriceSourceV2.postAttestation`):
 *   digest = keccak256(abi.encode("STONKZ_PRICE_V1", chainId, source, base, price1e6, publishTime))
 *   sig    = personal_sign(digest)                     // EIP-191, 65 bytes
 *   att    = abi.encode(bytes4 "STKA", base, uint64 price1e6, uint64 publishTime, bytes sig)
 */

export const ATTESTATION_MAGIC = toHex('STKA') as Hex;
export const ATTESTATION_DOMAIN = 'STONKZ_PRICE_V1';

export interface AttestationInput {
  chainId: number;
  source: Address;
  base: Address;
  price1e6: bigint;
  publishTime: number;
}

export function attestationDigest(a: AttestationInput): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: 'string' },
        { type: 'uint256' },
        { type: 'address' },
        { type: 'address' },
        { type: 'uint64' },
        { type: 'uint64' },
      ],
      [ATTESTATION_DOMAIN, BigInt(a.chainId), a.source, a.base, a.price1e6, BigInt(a.publishTime)],
    ),
  );
}

export async function signAttestation(
  account: PrivateKeyAccount,
  a: AttestationInput,
): Promise<Hex> {
  const signature = await account.signMessage({ message: { raw: attestationDigest(a) } });
  return encodeAbiParameters(
    [
      { type: 'bytes4' },
      { type: 'address' },
      { type: 'uint64' },
      { type: 'uint64' },
      { type: 'bytes' },
    ],
    [ATTESTATION_MAGIC, a.base, a.price1e6, BigInt(a.publishTime), signature],
  );
}

/** `null` when no attester key is configured (attestations are off). */
export function attesterFromKey(raw: string | undefined): PrivateKeyAccount | null {
  const key = raw?.trim();
  if (!key) return null;
  const hex = (key.startsWith('0x') ? key : `0x${key}`) as Hex;
  if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error('STOCK_PRICE_ATTESTER_KEY must be a 32-byte hex private key');
  }
  return privateKeyToAccount(hex);
}

const ROUTER_SINK_ABI = parseAbi(['function attestationSink() view returns (address)']);

export interface SinkCaller {
  ethCall(to: string, data: string): Promise<string>;
}

const sinkCache = new Map<string, { at: number; sink: Address | null }>();
const SINK_CACHE_MS = 60_000;

/**
 * The router's `attestationSink` (the `StockPriceSourceV2` it posts to), or
 * `null` for a router that predates attestations. Cached per router.
 */
export async function readAttestationSink(
  caller: SinkCaller,
  router: string,
  nowMs: number,
): Promise<Address | null> {
  const key = router.toLowerCase();
  const hit = sinkCache.get(key);
  if (hit && nowMs - hit.at < SINK_CACHE_MS) return hit.sink;
  let sink: Address | null = null;
  try {
    const raw = await caller.ethCall(
      router,
      encodeFunctionData({ abi: ROUTER_SINK_ABI, functionName: 'attestationSink' }),
    );
    if (raw && raw.length >= 66) {
      const addr = `0x${raw.slice(-40)}` as Address;
      sink = /^0x0{40}$/i.test(addr) ? null : addr;
    }
  } catch {
    sink = null;
  }
  sinkCache.set(key, { at: nowMs, sink });
  return sink;
}

export function resetAttestationSinkCache(): void {
  sinkCache.clear();
}

/**
 * The signed quote for one launch, or `[]` when attestations are off, the
 * router has no sink, or there is no DefiLlama price to attest. Never throws:
 * a missing attestation only means the chain falls back to its other legs.
 */
export async function stockAttestationsFor(opts: {
  attester: PrivateKeyAccount | null;
  caller: SinkCaller | null;
  router: string;
  chainId: number;
  base: Address;
  price1e6: bigint | null | undefined;
  nowMs: number;
  logger: Logger;
}): Promise<Hex[]> {
  if (!opts.attester || !opts.caller || !opts.price1e6 || opts.price1e6 <= 0n) return [];
  const sink = await readAttestationSink(opts.caller, opts.router, opts.nowMs);
  if (!sink) return [];
  try {
    const att = await signAttestation(opts.attester, {
      chainId: opts.chainId,
      source: sink,
      base: opts.base,
      price1e6: opts.price1e6,
      publishTime: Math.floor(opts.nowMs / 1000),
    });
    return [att];
  } catch (err) {
    opts.logger.warn('launch/prepare: could not sign the stock price attestation', {
      base: opts.base,
      err: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

/** Test/debug helper: the attestation's leading tag. */
export function isAttestation(entry: Hex): boolean {
  return entry.toLowerCase().startsWith(concatHex([ATTESTATION_MAGIC]).toLowerCase());
}
