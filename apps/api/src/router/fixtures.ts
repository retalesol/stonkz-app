import type { AggregatorQuote, AggregatorQuoteRequest } from './aggregator.js';
import { AggregatorFeeDetectedError, NoRouteError } from './errors.js';
import type {
  JupiterClient,
  JupiterQuoteResponseRaw,
  JupiterSwapInstructionsResponse,
} from './jupiter.js';
import type { UniswapClient, UniswapQuoteResponseRaw, UniswapSwapResponseRaw } from './uniswap.js';

/**
 * No real Jupiter/Uniswap credentials exist in this environment (per the
 * task brief). These fakes stand in for `HttpJupiterClient`/`HttpUniswapClient`
 * in tests and in any local dev boot that has not configured a base URL —
 * see `deps.ts`. Both implement a simple constant-price model plus
 * configurable failure/fee-trap injection so the router's own guards
 * (`NoRouteError`, `AggregatorFeeDetectedError`) are exercised without a
 * network call.
 */

export interface FakePriceRoute {
  /** Output atoms per one input atom, before impact. */
  rate: number;
  /** Percent, purely descriptive. */
  impactPct?: number;
}

function routeKey(inMint: string, outMint: string): string {
  return `${inMint}\u2192${outMint}`;
}

export class FakeJupiterClient implements JupiterClient {
  readonly venue = 'JUPITER' as const;
  private readonly routes = new Map<string, FakePriceRoute>();
  private forcedPlatformFeeBps = 0;
  private failing = false;
  private noRouteFor: string | null = null;

  setRoute(inMint: string, outMint: string, route: FakePriceRoute): void {
    this.routes.set(routeKey(inMint, outMint), route);
  }

  /** Simulates the fee trap the real API is documented to sometimes attach. */
  forcePlatformFeeBps(bps: number): void {
    this.forcedPlatformFeeBps = bps;
  }

  setFailing(failing: boolean): void {
    this.failing = failing;
  }

  setNoRoute(inMint: string, outMint: string): void {
    this.noRouteFor = routeKey(inMint, outMint);
  }

  /** Clears every configured route/fee-trap/failure flag — tests call this between cases sharing one `TestApp`. */
  reset(): void {
    this.routes.clear();
    this.forcedPlatformFeeBps = 0;
    this.failing = false;
    this.noRouteFor = null;
  }

  async quote(req: AggregatorQuoteRequest): Promise<AggregatorQuote> {
    if (this.failing)
      throw new NoRouteError(req.inMint, req.outMint, new Error('simulated outage'));
    if (this.noRouteFor === routeKey(req.inMint, req.outMint)) {
      throw new NoRouteError(req.inMint, req.outMint);
    }
    const route = this.routes.get(routeKey(req.inMint, req.outMint));
    if (!route) throw new NoRouteError(req.inMint, req.outMint);

    if (this.forcedPlatformFeeBps !== 0) {
      throw new AggregatorFeeDetectedError(
        'JUPITER',
        `platformFee.feeBps=${this.forcedPlatformFeeBps} (fixture)`,
      );
    }

    const outAtoms = BigInt(Math.floor(Number(req.inAmountAtoms) * route.rate));
    return {
      venue: 'JUPITER',
      inMint: req.inMint,
      outMint: req.outMint,
      inAmountAtoms: req.inAmountAtoms,
      outAmountAtoms: outAtoms,
      priceImpactPct: route.impactPct ?? 0,
      raw: { fixture: true, inMint: req.inMint, outMint: req.outMint } satisfies Record<
        string,
        unknown
      >,
    };
  }

  async swapInstructions(): Promise<JupiterSwapInstructionsResponse> {
    // A single no-op-shaped placeholder instruction — real bytes never
    // matter in a test that only asserts the composed transaction's shape,
    // and no test in this phase submits a fixture-built transaction to a
    // live validator.
    const memo = {
      programId: 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',
      accounts: [],
      data: Buffer.from('jupiter-fixture-swap').toString('base64'),
    };
    return {
      computeBudgetInstructions: [],
      setupInstructions: [],
      swapInstruction: memo,
      addressLookupTableAddresses: [],
    };
  }
}

export class FakeUniswapClient implements UniswapClient {
  readonly venue = 'UNISWAP' as const;
  private readonly routes = new Map<string, FakePriceRoute>();
  private forcedPortionBips = 0;
  private failing = false;
  private noRouteFor: string | null = null;

  setRoute(inMint: string, outMint: string, route: FakePriceRoute): void {
    this.routes.set(routeKey(inMint, outMint), route);
  }

  forcePortionBips(bips: number): void {
    this.forcedPortionBips = bips;
  }

  setFailing(failing: boolean): void {
    this.failing = failing;
  }

  setNoRoute(inMint: string, outMint: string): void {
    this.noRouteFor = routeKey(inMint, outMint);
  }

  /** Clears every configured route/fee-trap/failure flag — tests call this between cases sharing one `TestApp`. */
  reset(): void {
    this.routes.clear();
    this.forcedPortionBips = 0;
    this.failing = false;
    this.noRouteFor = null;
  }

  async quote(req: AggregatorQuoteRequest): Promise<AggregatorQuote> {
    if (this.failing)
      throw new NoRouteError(req.inMint, req.outMint, new Error('simulated outage'));
    if (this.noRouteFor === routeKey(req.inMint, req.outMint)) {
      throw new NoRouteError(req.inMint, req.outMint);
    }
    const route = this.routes.get(routeKey(req.inMint, req.outMint));
    if (!route) throw new NoRouteError(req.inMint, req.outMint);

    if (this.forcedPortionBips !== 0) {
      throw new AggregatorFeeDetectedError(
        'UNISWAP',
        `portionBips=${this.forcedPortionBips} (fixture)`,
      );
    }

    const outAtoms = BigInt(Math.floor(Number(req.inAmountAtoms) * route.rate));
    return {
      venue: 'UNISWAP',
      inMint: req.inMint,
      outMint: req.outMint,
      inAmountAtoms: req.inAmountAtoms,
      outAmountAtoms: outAtoms,
      priceImpactPct: route.impactPct ?? 0,
      raw: {
        routing: 'CLASSIC',
        quote: {
          chainId: 4663,
          swapper: '0x0000000000000000000000000000000000000001',
          input: { token: req.inMint, amount: req.inAmountAtoms.toString() },
          output: { token: req.outMint, amount: outAtoms.toString() },
          portionBips: 0,
        },
      } satisfies UniswapQuoteResponseRaw,
    };
  }

  async swap(quote: UniswapQuoteResponseRaw): Promise<UniswapSwapResponseRaw> {
    return {
      swap: {
        to: '0x8876789976DECbFCbbbe364623c63652dB8C0904', // Universal Router, per docs/robinhood-chain.md row 21
        data: `0x${Buffer.from(`uniswap-fixture-swap:${quote.quote.input.token}->${quote.quote.output.token}`).toString('hex')}`,
        value:
          quote.quote.input.token === '0x0000000000000000000000000000000000000000'
            ? quote.quote.input.amount
            : '0',
        from: quote.quote.swapper,
      },
    };
  }
}

/** Fixture used by the Jupiter unit test to prove `quote()` rejects a smuggled fee. */
export function jupiterQuoteFixtureWithPlatformFee(): JupiterQuoteResponseRaw {
  return {
    inputMint: 'So11111111111111111111111111111111111111112',
    inAmount: '1000000000',
    outputMint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
    outAmount: '1000000',
    otherAmountThreshold: '990000',
    swapMode: 'ExactIn',
    slippageBps: 100,
    priceImpactPct: '0.01',
    platformFee: { amount: '1000', feeBps: 10 },
    routePlan: [],
  };
}
