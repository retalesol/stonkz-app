import { AggregatorFeeDetectedError, NoRouteError } from './errors.js';
import type {
  AggregatorClient,
  AggregatorQuote,
  AggregatorQuoteRequest,
  FetchLike,
} from './aggregator.js';

/**
 * Jupiter Swap API v6 shapes, trimmed to the fields this router reads.
 * https://station.jup.ag/docs/apis/swap-api — the public quote/swap-instructions
 * pair, no key required for `lite-api.jup.ag`; a paid plan swaps in a
 * different base URL and an `Authorization` header via `JUPITER_API_KEY`,
 * never a code change.
 */
export interface JupiterQuoteResponseRaw {
  inputMint: string;
  inAmount: string;
  outputMint: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: 'ExactIn' | 'ExactOut';
  slippageBps: number;
  priceImpactPct: string;
  /**
   * Only present when the request itself asked for a cut via `platformFeeBps`
   * — which this client never sends (see `HttpJupiterClient.quote`). Checked
   * anyway: a misconfigured deploy that starts passing `platformFeeBps` must
   * fail the assertion below, not silently start taking a cut.
   */
  platformFee: { amount: string; feeBps: number } | null;
  routePlan: unknown[];
  contextSlot?: number;
  timeTaken?: number;
}

export interface JupiterAccountMeta {
  pubkey: string;
  isSigner: boolean;
  isWritable: boolean;
}

export interface JupiterInstruction {
  programId: string;
  accounts: JupiterAccountMeta[];
  /** Base64. */
  data: string;
}

export interface JupiterSwapInstructionsResponse {
  tokenLedgerInstruction?: JupiterInstruction;
  computeBudgetInstructions: JupiterInstruction[];
  setupInstructions: JupiterInstruction[];
  swapInstruction: JupiterInstruction;
  cleanupInstruction?: JupiterInstruction;
  /** Versioned-transaction lookup tables the swap instruction indexes into. */
  addressLookupTableAddresses: string[];
}

export interface JupiterClient extends AggregatorClient {
  readonly venue: 'JUPITER';
  /** The account-and-data payload `router/solana-tx.ts` splices into the composed transaction. */
  swapInstructions(
    quote: JupiterQuoteResponseRaw,
    userPublicKey: string,
  ): Promise<JupiterSwapInstructionsResponse>;
}

export interface HttpJupiterClientOptions {
  /**
   * `https://lite-api.jup.ag/swap/v1` needs no key for moderate volume.
   * A paid plan moves to `https://api.jup.ag/swap/v1` with `apiKey` set —
   * env, never a code change. See `JUPITER_API_BASE_URL` / `JUPITER_API_KEY`
   * in `env.ts`.
   */
  baseUrl: string;
  apiKey?: string;
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

/**
 * Real HTTP client against Jupiter's public Swap API. No key is baked in —
 * `apiKey` is only ever read from `opts`/env, so a fresh checkout with no
 * secrets configured still gets a working (rate-limited) client.
 */
export class HttpJupiterClient implements JupiterClient {
  readonly venue = 'JUPITER' as const;
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  constructor(opts: HttpJupiterClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.apiKey = opts.apiKey;
    this.fetchImpl = opts.fetchImpl ?? ((u, i) => fetch(u, i));
    this.timeoutMs = opts.timeoutMs ?? 4000;
  }

  private headers(): Record<string, string> {
    return this.apiKey ? { 'x-api-key': this.apiKey } : {};
  }

  async quote(req: AggregatorQuoteRequest): Promise<AggregatorQuote> {
    const params = new URLSearchParams({
      inputMint: req.inMint,
      outputMint: req.outMint,
      amount: req.inAmountAtoms.toString(),
      slippageBps: String(Math.max(0, Math.round(req.slippagePct * 100))),
      onlyDirectRoutes: 'false',
      // Prefer the highest-liquidity multi-hop path Jupiter can build.
      // Never `platformFeeBps` — plan step 84 forbids Stonkz taking a cut on
      // this hop, and asking Jupiter for one is how that would happen.
    });

    let raw: JupiterQuoteResponseRaw;
    try {
      raw = await httpJson<JupiterQuoteResponseRaw>(
        this.fetchImpl,
        `${this.baseUrl}/quote?${params.toString()}`,
        { headers: this.headers() },
        this.timeoutMs,
      );
    } catch (err) {
      throw new NoRouteError(req.inMint, req.outMint, err);
    }

    assertNoJupiterPlatformFee(raw);
    if (!raw.outAmount || BigInt(raw.outAmount) <= 0n) {
      throw new NoRouteError(req.inMint, req.outMint);
    }

    return {
      venue: 'JUPITER',
      inMint: raw.inputMint,
      outMint: raw.outputMint,
      inAmountAtoms: BigInt(raw.inAmount),
      outAmountAtoms: BigInt(raw.outAmount),
      priceImpactPct: Number.parseFloat(raw.priceImpactPct) || 0,
      raw,
    };
  }

  async swapInstructions(
    quote: JupiterQuoteResponseRaw,
    userPublicKey: string,
  ): Promise<JupiterSwapInstructionsResponse> {
    return httpJson<JupiterSwapInstructionsResponse>(
      this.fetchImpl,
      `${this.baseUrl}/swap-instructions`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...this.headers() },
        body: JSON.stringify({
          quoteResponse: quote,
          userPublicKey,
          // The curve leg needs a real SPL account, not a lamport balance —
          // let Jupiter wrap/unwrap WSOL as part of its own instructions
          // rather than composing that ourselves.
          wrapAndUnwrapSol: true,
        }),
      },
      this.timeoutMs,
    );
  }
}

/** Enforcement of docs/robinhood-chain.md §3.2's Jupiter-side fee trap. */
export function assertNoJupiterPlatformFee(raw: JupiterQuoteResponseRaw): void {
  if (raw.platformFee && Number(raw.platformFee.feeBps) !== 0) {
    throw new AggregatorFeeDetectedError(
      'JUPITER',
      `platformFee.feeBps=${raw.platformFee.feeBps} amount=${raw.platformFee.amount}`,
    );
  }
}
