/**
 * The shape every aggregator hop is reduced to once its own response has been
 * parsed and the zero-fee assertion (docs/robinhood-chain.md §3.2, plan step
 * 84) has passed. `compose.ts` never touches a Jupiter or Uniswap response
 * shape directly — only this.
 */
export interface AggregatorQuote {
  venue: 'JUPITER' | 'UNISWAP';
  inMint: string;
  outMint: string;
  inAmountAtoms: bigint;
  outAmountAtoms: bigint;
  /** What the venue itself reports, purely descriptive — never Stonkz's fee. */
  priceImpactPct: number;
  /** Opaque per-venue payload `trade/prepare` needs to build the actual instructions/calldata. */
  raw: unknown;
}

export interface AggregatorQuoteRequest {
  inMint: string;
  outMint: string;
  inAmountAtoms: bigint;
  /** Percent, e.g. `1` = 1%. Only used to size `otherAmountThreshold`/`minOut` on the venue's own leg. */
  slippagePct: number;
}

/**
 * One native<->base hop. `Jupiter*` and `Uniswap*` implementations both speak
 * this so `compose.ts` and `trade.ts` are chain-agnostic above this line.
 */
export interface AggregatorClient {
  readonly venue: 'JUPITER' | 'UNISWAP';
  quote(req: AggregatorQuoteRequest): Promise<AggregatorQuote>;
}

/** Injected so tests never touch the network and prod can swap in a pooled agent. Mirrors `chain/types.ts`. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
