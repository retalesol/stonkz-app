import { PublicKey } from '@solana/web3.js';
import { decodeFunctionResult, encodeFunctionData, parseAbi, type Hex } from 'viem';
import {
  ALL_NETS,
  DEFAULT_CURVE_PARAMS,
  isEvmNet,
  paramsFromWord,
  validateCurveParams,
  type CurveParams,
  type EvmNet,
  type Net,
} from '@stonkz/shared';
import { decodeSolanaParams, solanaParamsPda } from '../admin/chain-ops.js';
import type { ApiEnv } from '../env.js';
import { ZERO_EVM_ADDRESS } from '../env.js';
import { evmLaunchpadAddress, evmRouterAddress } from './evm-net.js';
import type { ChainRpcs, SolanaAccountDataSource } from './types.js';

/**
 * The launchpad's runtime-configurable parameters, read from chain and cached
 * per net for {@link DEFAULT_PARAMS_TTL_MS}.
 *
 * - EVM: `StonkzLaunchpad.paramsWord()` (one packed `uint256`, `0` = nothing
 *   set → contract defaults) plus `StonkzRouter.maxBuyNative()`. Until the
 *   parameterised implementation is live behind the proxy the selector is
 *   unknown and the call reverts (or a fake answers `0x`); the contract
 *   defaults apply, flagged `source: 'default'`.
 * - Solana: the `params` PDA (`[b"params"]`, decoded by `admin/chain-ops.ts`).
 *   A missing account is the program's own "nothing set yet" — defaults,
 *   `source: 'default'`.
 *
 * A transport failure after a successful read serves the last good value
 * (stale rather than wrong), never the defaults over a known override. The
 * reader is in-memory only — one instance per API process is fine: a stale
 * minute after an admin `setParams` is the accepted trade-off, and the admin
 * route invalidates on `chain/submitted` so the operator's own panel refreshes.
 */
export const DEFAULT_PARAMS_TTL_MS = 60_000;

export const LAUNCHPAD_PARAMS_ABI = parseAbi(['function paramsWord() view returns (uint256)']);
export const ROUTER_CONFIG_ABI = parseAbi(['function maxBuyNative() view returns (uint256)']);

export type ParamsSource = 'chain' | 'default';

export interface LiveCurveParams extends CurveParams {
  net: Net;
  /** `chain` when the record was read from the launchpad; `default` for every fallback (revert, RPC down, not deployed). */
  source: ParamsSource;
  /** Whether the chain holds an explicit record (EVM: non-zero word; Solana: the PDA exists). */
  set: boolean;
  /** Whether the values equal {@link DEFAULT_CURVE_PARAMS} (ignoring `maxBuyNative`). */
  matchesDefaults: boolean;
  /** Epoch ms of the read this came from. */
  readAt: number;
  /** Why the defaults are in use, when they are. */
  error: string | null;
}

export interface EthCallSource {
  ethCall(to: string, data: string): Promise<string>;
}

export type ParamsTarget =
  | {
      kind: 'evm';
      eth: EthCallSource | null;
      launchpad: string;
      /** `StonkzRouter`, which holds `maxBuyNative()`; `null` when none is configured. */
      router: string | null;
    }
  | { kind: 'sol'; reader: SolanaAccountDataSource | null; programId: string }
  | null;

export interface CurveParamsReaderOptions {
  /** Where to read `net`'s parameters; `null` when the net is not deployed here. */
  target: (net: Net) => ParamsTarget;
  now?: () => number;
  ttlMs?: number;
  onError?: (net: Net, err: unknown) => void;
}

/* ---------------------------------------------------------------- decoders */

/** `paramsWord()` return data → the packed word. */
export function decodeParamsWord(raw: string): bigint {
  return decodeFunctionResult({
    abi: LAUNCHPAD_PARAMS_ABI,
    functionName: 'paramsWord',
    data: raw as Hex,
  }) as bigint;
}

const COMPARE_KEYS = [
  'feeProtocolBps',
  'feeOpsBps',
  'feeBurnBps',
  'minFeeBps',
  'maxFeeBps',
  'cbStartFeeBps',
  'cbWindowSecs',
  'gradUsd',
  'maxSupply',
] as const;

export function matchesDefaultParams(p: CurveParams): boolean {
  return COMPARE_KEYS.every((k) => p[k] === DEFAULT_CURVE_PARAMS[k]);
}

function defaults(net: Net, readAt: number, error: string | null): LiveCurveParams {
  return {
    ...DEFAULT_CURVE_PARAMS,
    net,
    source: 'default',
    set: false,
    matchesDefaults: true,
    readAt,
    error,
  };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/* ------------------------------------------------------------------ reader */

export class CurveParamsReader {
  private readonly cache = new Map<Net, { value: LiveCurveParams; expiresAt: number }>();
  private readonly inflight = new Map<Net, Promise<LiveCurveParams>>();
  private readonly now: () => number;
  private readonly ttlMs: number;

  constructor(private readonly opts: CurveParamsReaderOptions) {
    this.now = opts.now ?? Date.now;
    this.ttlMs = opts.ttlMs ?? DEFAULT_PARAMS_TTL_MS;
  }

  /** The live record for `net` — cached, deduplicated, never throws. */
  async get(net: Net): Promise<LiveCurveParams> {
    const hit = this.cache.get(net);
    if (hit && hit.expiresAt > this.now()) return hit.value;
    const pending = this.inflight.get(net);
    if (pending) return pending;
    const p = this.read(net, hit?.value ?? null).finally(() => this.inflight.delete(net));
    this.inflight.set(net, p);
    return p;
  }

  /** Every net at once — what list endpoints and `/platform/status` use. */
  async all(): Promise<Record<Net, LiveCurveParams>> {
    const entries = await Promise.all(
      ALL_NETS.map(async (net) => [net, await this.get(net)] as const),
    );
    return Object.fromEntries(entries) as Record<Net, LiveCurveParams>;
  }

  /** Drop the cache (after an admin `setParams` lands, or in tests). */
  invalidate(net?: Net): void {
    if (net) this.cache.delete(net);
    else this.cache.clear();
  }

  private async read(net: Net, last: LiveCurveParams | null): Promise<LiveCurveParams> {
    const readAt = this.now();
    let value: LiveCurveParams;
    try {
      value = await this.readUncached(net, readAt);
    } catch (err) {
      this.opts.onError?.(net, err);
      // A transport failure keeps the last good read rather than reverting a
      // known override to the defaults.
      value =
        last && last.source === 'chain'
          ? { ...last, error: `stale: ${message(err)}` }
          : defaults(net, readAt, `rpc: ${message(err)}`);
    }
    this.cache.set(net, { value, expiresAt: readAt + this.ttlMs });
    return value;
  }

  private async readUncached(net: Net, readAt: number): Promise<LiveCurveParams> {
    const target = this.opts.target(net);
    if (!target) return defaults(net, readAt, 'not deployed on this environment');
    if (target.kind === 'evm') return this.readEvm(net, target, readAt);
    return this.readSolana(net, target, readAt);
  }

  private async readEvm(
    net: Net,
    t: { eth: EthCallSource | null; launchpad: string; router: string | null },
    readAt: number,
  ): Promise<LiveCurveParams> {
    const eth = t.eth;
    if (!eth) return defaults(net, readAt, 'RPC cannot eth_call');
    // Both calls go out together; a *transport* failure on either propagates
    // (caught by `read`), while a revert / empty answer is a decode failure
    // handled per field below.
    const swallowRevert = (err: unknown): string => {
      if (isRevert(err)) return '0x';
      throw err;
    };
    const [wordRaw, maxBuyRaw] = await Promise.all([
      eth
        .ethCall(
          t.launchpad,
          encodeFunctionData({ abi: LAUNCHPAD_PARAMS_ABI, functionName: 'paramsWord' }),
        )
        .catch(swallowRevert),
      t.router
        ? eth
            .ethCall(
              t.router,
              encodeFunctionData({ abi: ROUTER_CONFIG_ABI, functionName: 'maxBuyNative' }),
            )
            .catch(swallowRevert)
        : Promise.resolve('0x'),
    ]);
    let maxBuyNative = DEFAULT_CURVE_PARAMS.maxBuyNative;
    try {
      maxBuyNative = String(
        decodeFunctionResult({
          abi: ROUTER_CONFIG_ABI,
          functionName: 'maxBuyNative',
          data: maxBuyRaw as Hex,
        }) as bigint,
      );
    } catch {
      // No router, or one without the cap view: uncapped.
    }
    let word: bigint;
    try {
      word = decodeParamsWord(wordRaw);
    } catch {
      return {
        ...defaults(net, readAt, 'paramsWord() reverted: implementation predates params'),
        maxBuyNative,
      };
    }
    const value: CurveParams = { ...paramsFromWord(word), maxBuyNative };
    // A contract that answers the selector with something else (a fallback
    // function, a test double keyed on "any selector") must not poison the
    // fee math: anything the contract itself would refuse in `setParams` is
    // not a record, so the defaults apply.
    const invalid = validateCurveParams(value);
    if (invalid.length > 0) {
      return {
        ...defaults(net, readAt, `paramsWord() returned an invalid record: ${invalid[0]}`),
        maxBuyNative,
      };
    }
    return {
      ...value,
      net,
      source: 'chain',
      set: word !== 0n,
      matchesDefaults: matchesDefaultParams(value),
      readAt,
      error: null,
    };
  }

  private async readSolana(
    net: Net,
    t: { reader: SolanaAccountDataSource | null; programId: string },
    readAt: number,
  ): Promise<LiveCurveParams> {
    if (!t.reader) return defaults(net, readAt, 'RPC cannot read accounts');
    const pda = solanaParamsPda(new PublicKey(t.programId));
    const raw = await t.reader.getAccountDataBase64(pda.toBase58());
    let decoded: ReturnType<typeof decodeSolanaParams>;
    try {
      decoded = decodeSolanaParams(raw);
    } catch (err) {
      return defaults(net, readAt, `params PDA undecodable: ${message(err)}`);
    }
    if (!decoded.initialised) return defaults(net, readAt, 'params PDA not found (never set)');
    // The program has no maxSupply / maxBuyNative fields; those stay at the defaults.
    const value: CurveParams = {
      feeProtocolBps: decoded.feeProtocolBps,
      feeOpsBps: decoded.feeOpsBps,
      feeBurnBps: decoded.feeBurnBps,
      minFeeBps: decoded.minFeeBps,
      maxFeeBps: decoded.maxFeeBps,
      cbStartFeeBps: decoded.cbStartFeeBps,
      cbWindowSecs: decoded.cbWindowSecs,
      gradUsd: Number(BigInt(decoded.gradMcapUsd1e6)) / 1e6,
      maxSupply: DEFAULT_CURVE_PARAMS.maxSupply,
      maxBuyNative: DEFAULT_CURVE_PARAMS.maxBuyNative,
    };
    return {
      ...value,
      net,
      source: 'chain',
      set: true,
      matchesDefaults: matchesDefaultParams(value),
      readAt,
      error: null,
    };
  }
}

/**
 * A node reports an `eth_call` revert as a JSON-RPC error (code 3, -32000,
 * -32015 …, "execution reverted"); that is "selector unknown", not an outage.
 */
function isRevert(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  if (code === 3 || code === -32000 || code === -32015) return true;
  return /revert|invalid opcode|out of gas/i.test(message(err));
}

/* ------------------------------------------------------------------ wiring */

/** Resolve each net's read target from the env and RPC set, as `app/deps.ts` does. */
export function curveParamsTargets(env: ApiEnv, rpcs: ChainRpcs): (net: Net) => ParamsTarget {
  const ethOf = (rpc: unknown): EthCallSource | null => {
    const c = rpc as Partial<EthCallSource>;
    return typeof c.ethCall === 'function' ? (c as EthCallSource) : null;
  };
  const solOf = (rpc: unknown): SolanaAccountDataSource | null => {
    const c = rpc as Partial<SolanaAccountDataSource>;
    return typeof c.getAccountDataBase64 === 'function' ? (c as SolanaAccountDataSource) : null;
  };
  return (net) => {
    if (isEvmNet(net)) {
      const launchpad = evmLaunchpadAddress(env, net as EvmNet);
      if (!launchpad || launchpad.toLowerCase() === ZERO_EVM_ADDRESS) return null;
      const router = evmRouterAddress(env, net as EvmNet);
      return {
        kind: 'evm',
        eth: ethOf(rpcs[net]),
        launchpad,
        router: !router || router.toLowerCase() === ZERO_EVM_ADDRESS ? null : router,
      };
    }
    return { kind: 'sol', reader: solOf(rpcs.SOL), programId: env.solanaLaunchpadProgramId };
  };
}

/** Strip the reader's bookkeeping to the shared record. */
export function toCurveParams(p: LiveCurveParams): CurveParams {
  return {
    feeProtocolBps: p.feeProtocolBps,
    feeOpsBps: p.feeOpsBps,
    feeBurnBps: p.feeBurnBps,
    minFeeBps: p.minFeeBps,
    maxFeeBps: p.maxFeeBps,
    cbStartFeeBps: p.cbStartFeeBps,
    cbWindowSecs: p.cbWindowSecs,
    gradUsd: p.gradUsd,
    maxSupply: p.maxSupply,
    maxBuyNative: p.maxBuyNative,
  };
}
