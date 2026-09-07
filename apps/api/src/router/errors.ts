/**
 * Structured router failures. Plan step 87: "if Jupiter/Uniswap returns no
 * route, toast `red` ... do not silently take a different input mint" — so
 * every one of these carries a stable `code` the frontend can switch on to
 * pick a toast, plus a human `detail` for the console/log line, and nothing
 * here ever suggests a fallback mint or route.
 */
export abstract class RouterError extends Error {
  abstract readonly code: string;
  abstract readonly httpStatus: 400 | 422 | 502;

  toResponse(): { error: string; detail: string } {
    return { error: this.code, detail: this.message };
  }
}

/** No aggregator route at all, or the aggregator's own quote came back empty. */
export class NoRouteError extends RouterError {
  readonly code = 'no_route';
  readonly httpStatus = 422;

  constructor(
    readonly fromSymbol: string,
    readonly toSymbol: string,
    cause?: unknown,
  ) {
    super(`no route ${fromSymbol} \u2192 ${toSymbol}`, { cause });
    this.name = 'NoRouteError';
  }
}

/**
 * An aggregator response attached a fee Stonkz never asked for and has
 * promised never to take on hop 1 (docs/robinhood-chain.md §3.2's "fee trap").
 * Failing loudly here is the enforcement of that promise, not a nicety.
 */
export class AggregatorFeeDetectedError extends RouterError {
  readonly code = 'aggregator_fee_detected';
  readonly httpStatus = 502;

  constructor(venue: string, detail: string) {
    super(`${venue} attached a fee Stonkz did not request: ${detail}`);
    this.name = 'AggregatorFeeDetectedError';
  }
}

/** The composed quote's total cost exceeds `Settings.cap` (plan step 85). */
export class CapExceededError extends RouterError {
  readonly code = 'cap_exceeded';
  readonly httpStatus = 422;

  constructor(
    readonly totalNative: number,
    readonly capNative: number,
  ) {
    super(`composed cost ${totalNative} exceeds cap ${capNative}`);
    this.name = 'CapExceededError';
  }
}

/** The trader's native balance cannot cover hop 1 plus fees. */
export class InsufficientNativeError extends RouterError {
  readonly code = 'insufficient_native';
  readonly httpStatus = 422;

  constructor(
    readonly requiredNative: number,
    readonly availableNative: number,
  ) {
    super(`requires ${requiredNative}, available ${availableNative}`);
    this.name = 'InsufficientNativeError';
  }
}

/** The composed fill would clear less than the caller's `minOut`. */
export class SlippageExceededError extends RouterError {
  readonly code = 'slippage_exceeded';
  readonly httpStatus = 422;

  constructor(
    readonly expectedOut: number,
    readonly minOut: number,
  ) {
    super(`expected out ${expectedOut} below min out ${minOut}`);
    this.name = 'SlippageExceededError';
  }
}

/** The base mint named is not on the launch allow-list for this net. */
export class BaseMintNotAllowedError extends RouterError {
  readonly code = 'base_mint_not_allowed';
  readonly httpStatus = 400;

  constructor(symbolOrMint: string) {
    super(`${symbolOrMint} is not an allowed base mint on this net`);
    this.name = 'BaseMintNotAllowedError';
  }
}
