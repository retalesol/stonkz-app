import { AggregatorFeeDetectedError, NoRouteError } from './errors.js';
import type {
  AggregatorClient,
  AggregatorQuote,
  AggregatorQuoteRequest,
  FetchLike,
} from './aggregator.js';

/**
 * Uniswap Trading API shapes, trimmed to the fields this router reads.
 * `POST /v1/quote` then `POST /v1/swap` — confirmed live for chain id 4663 in
 * docs/robinhood-chain.md §3.2. Every RH quote must set
 * `tokenInChainId`/`tokenOutChainId: 4663`.
 *
 * **Native ETH sentinel address is unverified.** This client uses
 * `0x0000000000000000000000000000000000000000` for native ETH, following the
 * zero-address convention several Uniswap-adjacent tools use for "native
 * asset", but I did not find a Trading-API-specific confirmation of that
 * exact value in the sources docs/robinhood-chain.md cites. **Re-verify
 * against a live `/v1/quote` call before this client sees a real key** — see
 * `NATIVE_ETH_SENTINEL`'s doc comment.
 */
export const NATIVE_ETH_SENTINEL = '0x0000000000000000000000000000000000000000';

export interface UniswapQuoteRequestRaw {
  tokenInChainId: number;
  tokenOutChainId: number;
  tokenIn: string;
  tokenOut: string;
  amount: string;
  type: 'EXACT_INPUT' | 'EXACT_OUTPUT';
  swapper: string;
  slippageTolerance?: number;
  /**
   * Deliberately never sent. §3.2: "never populate `integratorFees`" — it
   * overrides Uniswap's own partner-fee service, and setting it (even to
   * zero) is a code path that could regress into taking a cut.
   */
  integratorFees?: never;
}

export interface UniswapQuoteResponseRaw {
  routing: string;
  quote: {
    chainId: number;
    swapper: string;
    input: { token: string; amount: string };
    output: { token: string; amount: string };
    /**
     * A service fee "always taken from the output token", attachable to the
     * API key server-side regardless of what the request body says (§3.2).
     * `assertNoUniswapPortion` below is what makes that promise enforceable
     * rather than aspirational.
     */
    portionBips?: number;
    portionAmount?: string;
    priceImpact?: string;
    quoteId?: string;
  };
}

export interface UniswapSwapResponseRaw {
  swap: {
    to: string;
    /** Calldata against the Universal Router — see the atomicity note on `UniswapClient`. */
    data: string;
    value: string;
    from: string;
  };
  requestId?: string;
}

/**
 * `swap()` is kept on the interface for pricing/calldata-reference purposes
 * only. docs/robinhood-chain.md §3.3 is explicit that this calldata cannot be
 * forwarded as-is for an atomic native-in trade — it targets the Universal
 * Router with the caller's own EOA as recipient, so composing it in front of
 * a curve instruction would land the base token in the user's wallet, not in
 * a contract that can then call the curve. `router/evm-tx.ts` uses `swap()`
 * only to build the *first, standalone* step of the documented non-atomic
 * sequence — see that file's header comment for the full explanation.
 */
export interface UniswapClient extends AggregatorClient {
  readonly venue: 'UNISWAP';
  swap(quote: UniswapQuoteResponseRaw): Promise<UniswapSwapResponseRaw>;
}

export interface HttpUniswapClientOptions {
  /** `https://trade-api.gateway.uniswap.org/v1` per §3.2. */
  baseUrl: string;
  /** Required in production — Trading API calls are key-gated. */
  apiKey?: string;
  chainId: number;
  /**
   * Chain-local WETH. Native ETH (`NATIVE_ETH_SENTINEL`) is rewritten to this
   * for `/v1/quote` — the Trading API prices WETH/ETH 1:1, and Stonkz wraps
   * locally on RH testnet where Universal Router `WRAP_ETH` targets the wrong
   * WETH. Optional: when unset, the zero-address sentinel is sent as-is.
   */
  wethAddress?: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

async function httpJson<T>(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { ...init, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text().catch(() => '')}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

export class HttpUniswapClient implements UniswapClient {
  readonly venue = 'UNISWAP' as const;
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly chainId: number;
  private readonly wethAddress: string | undefined;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  constructor(opts: HttpUniswapClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.apiKey = opts.apiKey;
    this.chainId = opts.chainId;
    this.wethAddress = opts.wethAddress?.toLowerCase();
    this.fetchImpl = opts.fetchImpl ?? ((u, i) => fetch(u, i));
    this.timeoutMs = opts.timeoutMs ?? 4000;
  }

  private headers(): Record<string, string> {
    return {
      'content-type': 'application/json',
      accept: 'application/json',
      ...(this.apiKey ? { 'x-api-key': this.apiKey } : {}),
      // Lets the Trading API accept the zero-address native-ETH sentinel when
      // we have not rewritten it to WETH (mainnet path with no weth pin).
      'x-erc20eth-enabled': 'true',
    };
  }

  /** Map native ETH sentinel → WETH for pricing; pass-through otherwise. */
  private tradeToken(mint: string): string {
    if (mint.toLowerCase() !== NATIVE_ETH_SENTINEL.toLowerCase()) return mint;
    return this.wethAddress ?? mint;
  }

  /** `swapper` matters even for a read-only quote — a router pins pool/protocol choices per address in some configs. */
  async quote(req: AggregatorQuoteRequest, swapper?: string): Promise<AggregatorQuote> {
    const body: UniswapQuoteRequestRaw = {
      tokenInChainId: this.chainId,
      tokenOutChainId: this.chainId,
      tokenIn: this.tradeToken(req.inMint),
      tokenOut: this.tradeToken(req.outMint),
      amount: req.inAmountAtoms.toString(),
      type: 'EXACT_INPUT',
      swapper: swapper ?? NATIVE_ETH_SENTINEL,
      // Trading API schema requires a number, not a stringified percent.
      slippageTolerance: req.slippagePct,
    };

    let raw: UniswapQuoteResponseRaw;
    try {
      raw = await httpJson<UniswapQuoteResponseRaw>(
        this.fetchImpl,
        `${this.baseUrl}/quote`,
        { method: 'POST', headers: this.headers(), body: JSON.stringify(body) },
        this.timeoutMs,
      );
    } catch (err) {
      throw new NoRouteError(req.inMint, req.outMint, err);
    }

    assertNoUniswapPortion(raw);
    const outAmount = BigInt(raw.quote.output.amount || '0');
    if (outAmount <= 0n) throw new NoRouteError(req.inMint, req.outMint);

    return {
      venue: 'UNISWAP',
      inMint: raw.quote.input.token,
      outMint: raw.quote.output.token,
      inAmountAtoms: BigInt(raw.quote.input.amount),
      outAmountAtoms: outAmount,
      priceImpactPct: Number.parseFloat(raw.quote.priceImpact ?? '0') || 0,
      raw,
    };
  }

  async swap(quote: UniswapQuoteResponseRaw): Promise<UniswapSwapResponseRaw> {
    return httpJson<UniswapSwapResponseRaw>(
      this.fetchImpl,
      `${this.baseUrl}/swap`,
      { method: 'POST', headers: this.headers(), body: JSON.stringify({ quote }) },
      this.timeoutMs,
    );
  }
}

/** Enforcement of docs/robinhood-chain.md §3.2's Uniswap-side fee trap. */
export function assertNoUniswapPortion(raw: UniswapQuoteResponseRaw): void {
  const bips = raw.quote.portionBips;
  if (bips !== undefined && bips !== null && Number(bips) !== 0) {
    throw new AggregatorFeeDetectedError(
      'UNISWAP',
      `portionBips=${bips} portionAmount=${raw.quote.portionAmount ?? '?'}`,
    );
  }
}
