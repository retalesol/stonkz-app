import type { AggregatorClient, AggregatorQuote, AggregatorQuoteRequest } from './aggregator.js';
import { NoRouteError } from './errors.js';
import type { UniswapClient, UniswapQuoteResponseRaw, UniswapSwapResponseRaw } from './uniswap.js';

/**
 * Prefer the Trading API (mainnet 4663, real pools). When it has no route —
 * RH testnet 46630 is not in the Trading API chain enum, missing API key,
 * empty pool set — fall through to the next client (on-chain V3 pool hop, or
 * oracle-priced ETH↔base for display-only quotes).
 */
export class ResilientUniswapClient implements UniswapClient {
  readonly venue = 'UNISWAP' as const;

  constructor(
    private readonly primary: UniswapClient,
    private readonly fallback: AggregatorClient,
  ) {}

  async quote(req: AggregatorQuoteRequest): Promise<AggregatorQuote> {
    try {
      return await this.primary.quote(req);
    } catch (err) {
      if (!(err instanceof NoRouteError)) throw err;
      try {
        return await this.fallback.quote(req);
      } catch {
        // Surface the original Trading-API failure (mint pair) when the
        // fallback also cannot price the hop — callers map mints → symbols.
        throw err;
      }
    }
  }

  async swap(quote: UniswapQuoteResponseRaw): Promise<UniswapSwapResponseRaw> {
    return this.primary.swap(quote);
  }
}
