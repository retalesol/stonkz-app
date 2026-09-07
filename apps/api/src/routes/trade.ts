import { Hono } from 'hono';
import { PublicKey } from '@solana/web3.js';
import type { Address } from 'viem';
import { and, eq } from 'drizzle-orm';
import { nativeUnit } from '@stonkz/shared';
import { settings, tokens } from '../db/schema.js';
import { requireAuth, limit } from '../app/middleware.js';
import { RATE_LIMITS } from '../redis/ratelimit.js';
import type { AppEnv } from '../app/context.js';
import { composeCurveTrade } from '../router/compose.js';
import { CapExceededError, InsufficientNativeError, RouterError, SlippageExceededError } from '../router/errors.js';
import type { JupiterQuoteResponseRaw } from '../router/jupiter.js';
import type { UniswapQuoteResponseRaw } from '../router/uniswap.js';
import { asSolanaBlockhashSource, composeSolanaTradeTransaction } from '../router/solana-tx.js';
import { buildEvmTradePlan } from '../router/evm-tx.js';
import type { TokenRow } from './serialise.js';

/** `settings` table's own column defaults (`db/schema.ts`) — what an authenticated wallet gets before it has ever saved a preference. */
const DEFAULT_SETTINGS = {
  slip: 1.5,
  prio: 0.0005,
  mev: 'SHIELD' as const,
  mevTip: 0.001,
  cap: 5,
  defBuy: 0.5,
  confirm: true,
};

interface TradePrepareBody {
  sym?: unknown;
  side?: unknown;
  amount?: unknown;
}

/**
 * `POST /trade/prepare` — plan steps 83–85.
 *
 * Loads the same `composeCurveTrade` the just-viewed `/quote` used (so a
 * prepare can never silently reprice), applies the caller's own `Settings`
 * (slippage sizes `minOut`; `cap` + `prio`/`mevTip` gate whether this even
 * reaches signing), and then composes the actual on-chain payload:
 *
 * - **Solana**: one atomic `Transaction` — Jupiter's swap instruction(s), if
 *   any, followed by (buy) or preceded by (sell) the launchpad's own `buy`/
 *   `sell` instruction. `router/solana-tx.ts` has the detail.
 * - **Robinhood Chain**: an explicitly non-atomic, ordered `EvmStep[]` —
 *   there is no periphery router in `programs/evm` to make this one
 *   transaction (`docs/rh-trade-atomicity-gap.md`, `router/evm-tx.ts`).
 */
export function tradeRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.post('/trade/prepare', requireAuth(), limit(RATE_LIMITS.trade), async (c) => {
    const deps = c.get('deps');
    const user = c.get('user');
    if (!user) return c.json({ error: 'unauthorized' }, 401);
    const { net, wallet } = user;

    const body = (await c.req.json().catch(() => ({}))) as TradePrepareBody;
    const sym = typeof body.sym === 'string' ? body.sym.toUpperCase() : '';
    const side = body.side === 'sell' ? 'sell' : body.side === 'buy' ? 'buy' : null;
    const amount = typeof body.amount === 'number' ? body.amount : Number.NaN;

    if (!sym || !side || !Number.isFinite(amount) || amount <= 0) {
      return c.json({ error: 'bad_request', detail: 'sym, side (buy|sell) and a positive amount are required' }, 400);
    }

    const [row] = await deps.db
      .select()
      .from(tokens)
      .where(and(eq(tokens.net, net), eq(tokens.sym, sym)))
      .limit(1);
    if (!row) return c.json({ error: 'not_found' }, 404);

    if (row.graduatedAt !== null) {
      return c.json(
        {
          error: 'graduated_not_supported',
          detail: 'this token has graduated to the DEX pool; /trade/prepare only serves the curve',
        },
        422,
      );
    }
    if (row.curveK === '0' || !row.mint) {
      return c.json(
        { error: 'not_tradeable', detail: 'this token has no on-chain launch yet (no curve state / mint on record)' },
        422,
      );
    }

    const [settingsRow] = await deps.db
      .select()
      .from(settings)
      .where(and(eq(settings.net, net), eq(settings.wallet, wallet)))
      .limit(1);
    const s = settingsRow ?? DEFAULT_SETTINGS;
    const now = deps.now();

    // Plan step 85: abort before signing if the composed cost exceeds the
    // user's cap. Only meaningful on a buy — a sell's "cost" is gas alone,
    // which `prio`/`mevTip` already represent, and native flows *in*, not out.
    if (side === 'buy') {
      const mevCost = s.mev === 'OFF' ? 0 : s.mevTip;
      const totalNative = amount + s.prio + mevCost;
      if (totalNative > s.cap) {
        const err = new CapExceededError(totalNative, s.cap);
        return c.json(err.toResponse(), err.httpStatus);
      }

      const balance = await deps.rpcs[net].nativeBalance(wallet).catch(() => null);
      if (balance !== null && balance < totalNative) {
        const err = new InsufficientNativeError(totalNative, balance);
        return c.json(err.toResponse(), err.httpStatus);
      }
    }

    const aggregatorVenue = row.baseSymbol.toUpperCase();
    const usdPrice = await deps.oracle.nativeUsd(nativeUnit(net)).catch(() => null);
    const aggregator =
      net === 'SOL'
        ? aggregatorVenue === 'SOL' || aggregatorVenue === 'WSOL'
          ? null
          : deps.jupiter
        : aggregatorVenue === 'ETH' || aggregatorVenue === 'WETH'
          ? null
          : deps.uniswap;

    let trade;
    try {
      trade = await composeCurveTrade({
        net,
        side,
        amount,
        row: row as TokenRow,
        usdPrice,
        now,
        aggregator,
        slippagePct: s.slip,
      });
    } catch (err) {
      if (err instanceof RouterError) return c.json(err.toResponse(), err.httpStatus);
      throw err;
    }

    // A composed quote's own `minOut` guards fill quality on-chain; a
    // `minOut` of zero would accept any fill, which is only ever correct at
    // (near-)100% slippage tolerance — surfaced here as the same structured
    // error a stale/adversarial quote would trigger downstream.
    if (trade.curveMinOutAtoms <= 0n && s.slip < 100) {
      const err = new SlippageExceededError(trade.quote.amountOut, 0);
      return c.json(err.toResponse(), err.httpStatus);
    }

    try {
      if (net === 'SOL') {
        const blockhashSource = asSolanaBlockhashSource(deps.rpcs.SOL);
        if (!blockhashSource) throw new Error('trade/prepare: Solana RPC does not implement latestBlockhash()');
        const blockhash = await blockhashSource.latestBlockhash();

        const programId = new PublicKey(deps.env.solanaLaunchpadProgramId);
        const mint = new PublicKey(row.mint);
        const baseMint = new PublicKey(row.baseMint);
        const trader = new PublicKey(wallet);

        const jupiter = trade.aggregatorQuote
          ? { response: await deps.jupiter.swapInstructions(trade.aggregatorQuote.raw as JupiterQuoteResponseRaw, wallet) }
          : undefined;

        const composed = composeSolanaTradeTransaction(
          {
            side,
            programId,
            trader,
            mint,
            baseMint,
            curveAmountIn: trade.curveAmountInAtoms,
            curveMinOut: trade.curveMinOutAtoms,
            ...(jupiter ? { jupiter } : {}),
          },
          blockhash,
        );

        return c.json({
          net,
          atomic: true,
          transaction: composed.base64,
          lastValidBlockHeight: composed.lastValidBlockHeight,
          quote: trade.quote,
          expiresAt: now + 30_000,
        });
      }

      // Robinhood Chain.
      const launchpad = deps.env.rhLaunchpadAddress as Address;
      const uniswap = trade.aggregatorQuote
        ? { client: deps.uniswap, quote: trade.aggregatorQuote.raw as UniswapQuoteResponseRaw }
        : null;
      const plan = await buildEvmTradePlan({
        trader: wallet as Address,
        launchpad,
        token: row.mint as Address,
        baseToken: row.baseMint as Address,
        uniswap,
        amountBaseOrToken: trade.curveAmountInAtoms,
        minOut: trade.curveMinOutAtoms,
        side,
      });

      return c.json({
        net,
        atomic: plan.atomic,
        steps: plan.steps,
        warning: plan.warning,
        quote: trade.quote,
        expiresAt: now + 30_000,
      });
    } catch (err) {
      if (err instanceof RouterError) return c.json(err.toResponse(), err.httpStatus);
      throw err;
    }
  });

  return app;
}
