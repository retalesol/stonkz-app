import { Hono } from 'hono';
import { PublicKey } from '@solana/web3.js';
import type { Address } from 'viem';
import { and, eq, gt, isNull, lte } from 'drizzle-orm';
import { isValidCurveFee, isValidSupply, isValidTicker, normalizeTicker, MAJORS, STOCKS, RH_STOCKS } from '@stonkz/shared';
import { buyQuote, freshState, mcapBase, mcapUsd1e6 } from '@stonkz/curve-sim';
import { launchIntents, tokens } from '../db/schema.js';
import { requireAuth, limit } from '../app/middleware.js';
import { rateLimit, RATE_LIMITS, type RateLimitRule } from '../redis/ratelimit.js';
import type { AppEnv } from '../app/context.js';
import { aggregatorFor, nativeAggregatorMint, nativeDecimalsFor } from '../router/compose.js';
import { basePriceFor } from '../router/base-price.js';
import { deriveCurveColumns, type CurveStateColumns } from '../router/curve-state.js';
import { moderateLaunch } from '../router/moderation.js';
import { toAtoms } from '../router/units.js';
import type { JupiterQuoteResponseRaw } from '../router/jupiter.js';
import { asSolanaBlockhashSource, asSolanaTransactionSource, type JupiterHop } from '../router/solana-tx.js';
import { composeSolanaLaunchTransaction } from '../router/solana-launch-tx.js';
import { asEvmTransactionSource } from '../router/evm-tx.js';
import { encodeCreateTokenCall, decodeTokenCreated } from '../router/evm-launch.js';
import { findLaunchCooldown } from './token-resolve.js';

const SOLANA_TOKEN_DECIMALS = 6;
const EVM_TOKEN_DECIMALS = 18;

interface LaunchPrepareBody {
  ticker?: unknown;
  name?: unknown;
  descr?: unknown;
  uri?: unknown;
  supply?: unknown;
  feePct?: unknown;
  cashback?: unknown;
  baseSymbol?: unknown;
  devBuyNative?: unknown;
}

function isAllowedBaseSymbol(net: 'SOL' | 'RH', symbol: string): boolean {
  const upper = symbol.toUpperCase();
  if (MAJORS[net].some(([sym]) => sym === upper)) return true;
  if (net === 'SOL' && STOCKS.some(([sym]) => sym === upper)) return true;
  if (net === 'RH' && RH_STOCKS.some(([sym]) => sym === upper)) return true;
  return false;
}

async function walletLaunchRateLimit(
  deps: { redis: Parameters<typeof rateLimit>[0]; env: { launchRateLimitPerWallet: number; launchRateLimitWindowSeconds: number }; now: () => number },
  net: string,
  wallet: string,
): Promise<{ ok: boolean; resetSeconds: number }> {
  const rule: RateLimitRule = {
    bucket: 'launch_wallet',
    limit: deps.env.launchRateLimitPerWallet,
    windowSeconds: deps.env.launchRateLimitWindowSeconds,
  };
  const verdict = await rateLimit(deps.redis, rule, `w:${net}:${wallet}`, Math.floor(deps.now() / 1000));
  return { ok: verdict.ok, resetSeconds: verdict.resetSeconds };
}

/**
 * `POST /launch/prepare` + `POST /launch/confirm` — plan steps 90–91.
 *
 * `/launch/prepare` validates everything the plan lists, derives the curve
 * with the same `@stonkz/curve-sim` the chain settles against, builds the
 * unsigned create transaction (Solana: one atomic tx, optionally with a dev
 * buy; Robinhood: `createToken` calldata alone — see the dev-buy note below),
 * and records a `launch_intents` row `/launch/confirm` reads back.
 *
 * `/launch/confirm` verifies the signed, submitted transaction actually
 * matches what was prepared — byte-for-byte on the compiled message
 * (Solana) or `to`+`data` (Robinhood) — rather than trusting client-reported
 * ticker/supply/fee after the fact, then upserts the `tokens` row.
 *
 * **Dev-buy atomicity asymmetry, by chain, not by choice**: on Solana the
 * mint is a PDA of creator+salt, known before signing, so `buy` can follow
 * `create_token` in the same transaction. On Robinhood, `StonkzToken` is
 * deployed with plain `CREATE` — the address is unknowable until the
 * transaction executes — so a dev buy there is necessarily a *second*,
 * separate `POST /trade/prepare` call made after `/launch/confirm` returns
 * the real token address. This is not the `docs/rh-trade-atomicity-gap.md`
 * problem (no periphery router would fix *this* one — the address is
 * fundamentally unknown pre-execution), so it is documented here instead.
 */
export function launchRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.post('/launch/prepare', requireAuth(), limit(RATE_LIMITS.launchIp), async (c) => {
    const deps = c.get('deps');
    const user = c.get('user');
    if (!user) return c.json({ error: 'unauthorized' }, 401);
    const { net, wallet } = user;

    const walletVerdict = await walletLaunchRateLimit(deps, net, wallet);
    if (!walletVerdict.ok) {
      c.header('Retry-After', String(walletVerdict.resetSeconds));
      return c.json({ error: 'rate_limited', retryAfter: walletVerdict.resetSeconds }, 429);
    }

    const body = (await c.req.json().catch(() => ({}))) as LaunchPrepareBody;
    const ticker = normalizeTicker(typeof body.ticker === 'string' ? body.ticker : '');
    const name = typeof body.name === 'string' ? body.name.trim().slice(0, 64) : '';
    const descr = typeof body.descr === 'string' ? body.descr.trim().slice(0, 500) : '';
    const uri = typeof body.uri === 'string' ? body.uri.trim().slice(0, 200) : '';
    const supply = typeof body.supply === 'number' ? body.supply : Number.NaN;
    const feePct = typeof body.feePct === 'number' ? body.feePct : Number.NaN;
    const cashback = body.cashback === true;
    const baseSymbol = typeof body.baseSymbol === 'string' ? body.baseSymbol.toUpperCase() : '';
    const devBuyNative = typeof body.devBuyNative === 'number' && Number.isFinite(body.devBuyNative) ? body.devBuyNative : 0;

    if (!isValidTicker(ticker) || !name) {
      return c.json({ error: 'bad_request', detail: 'ticker and name are required' }, 400);
    }
    if (!isValidSupply(supply)) {
      return c.json({ error: 'invalid_supply', detail: 'supply must be one of 1e6, 5e8, 1e9, 1e12' }, 422);
    }
    if (!isValidCurveFee(feePct)) {
      return c.json({ error: 'invalid_fee', detail: 'fee must be between 1.0 and 5.0 percent' }, 422);
    }
    if (devBuyNative < 0 || !Number.isFinite(devBuyNative)) {
      return c.json({ error: 'bad_request', detail: 'devBuyNative must be a non-negative number' }, 400);
    }
    // Plan step 90: cashback only if the native-denominated dev buy is zero.
    if (cashback && devBuyNative > 0) {
      return c.json(
        { error: 'cashback_dev_buy_conflict', detail: 'cashback launches cannot also carry a dev buy' },
        422,
      );
    }

    const moderation = moderateLaunch({ name, ticker, descr });
    if (!moderation.ok) {
      deps.logger.warn('launch rejected by moderation stub', { net, wallet, ticker, matched: moderation.matched.length });
      return c.json({ error: 'moderation_rejected', detail: 'name, ticker or description failed the content filter' }, 422);
    }

    if (!isAllowedBaseSymbol(net, baseSymbol)) {
      return c.json({ error: 'base_mint_not_allowed', detail: `${baseSymbol} is not a recognised base asset on this net` }, 400);
    }
    const baseMintAddress = deps.baseMints.mintFor(net, baseSymbol);
    if (!baseMintAddress) {
      return c.json(
        { error: 'base_mint_not_allowed', detail: `${baseSymbol} has no configured mint address on this net yet` },
        400,
      );
    }
    const basePrice = await basePriceFor(net, baseSymbol, deps.oracle);
    if (!basePrice) {
      return c.json(
        {
          error: 'base_price_unavailable',
          detail: `no price source is wired up for ${baseSymbol} in this phase — see router/base-price.ts`,
        },
        422,
      );
    }

    // Soft cooldown: same ticker or display name on this net within 5 minutes.
    // Permanent uniqueness lives on mint (chain + tokens PK), not ticker.
    const now = deps.now();
    const cooldown = await findLaunchCooldown(deps.db, net, ticker, name, now);
    if (cooldown) {
      return c.json(
        {
          error: 'name_or_ticker_cooldown',
          detail: `a token with this ${cooldown.kind} launched less than 5 minutes ago`,
          retryAfterMs: cooldown.retryAfterMs,
        },
        409,
      );
    }

    // Drop expired prepares, then let the same wallet replace its own
    // unconsumed intent for this ticker (a cancelled MetaMask confirm used to
    // leave a 409 "already in flight" until TTL). Another wallet still 409s.
    await deps.db
      .delete(launchIntents)
      .where(and(eq(launchIntents.net, net), eq(launchIntents.ticker, ticker), isNull(launchIntents.consumedAt), lte(launchIntents.expiresAt, new Date(now))));

    const [inFlight] = await deps.db
      .select({ id: launchIntents.id, creator: launchIntents.creator })
      .from(launchIntents)
      .where(
        and(
          eq(launchIntents.net, net),
          eq(launchIntents.ticker, ticker),
          isNull(launchIntents.consumedAt),
          gt(launchIntents.expiresAt, new Date(now)),
        ),
      )
      .limit(1);
    if (inFlight) {
      if (inFlight.creator.toLowerCase() === wallet.toLowerCase()) {
        await deps.db.delete(launchIntents).where(eq(launchIntents.id, inFlight.id));
      } else {
        return c.json({ error: 'ticker_taken', detail: 'a prepare for this ticker is already in flight' }, 409);
      }
    }

    const tokenDecimals = net === 'SOL' ? SOLANA_TOKEN_DECIMALS : EVM_TOKEN_DECIMALS;
    const supplyAtoms = BigInt(Math.round(supply)) * 10n ** BigInt(tokenDecimals);
    const derived = deriveCurveColumns(supplyAtoms, basePrice.price1e6, basePrice.baseDecimals, tokenDecimals);
    if (!derived) {
      return c.json(
        { error: 'invalid_curve_params', detail: 'this supply/price combination cannot be represented on-chain' },
        422,
      );
    }

    const feeBps = Math.round(feePct * 100);
    const expiresAt = new Date(now + deps.env.launchIntentTtlSeconds * 1000);

    // Dev buy preview, against the token's own *fresh* curve — nobody else
    // can have traded it yet, so this is exact, not an approximation, as long
    // as it lands in the same atomic transaction (Solana only — see the
    // header comment for why Robinhood cannot).
    let devBuyAtoms: bigint | null = null;
    let devBuyMinOutAtoms: bigint | null = null;
    let devBuyJupiterQuoteRaw: JupiterQuoteResponseRaw | null = null;
    if (devBuyNative > 0 && net === 'SOL') {
      const aggVenue = aggregatorFor(net, baseSymbol);
      let baseAtoms: bigint;
      if (aggVenue) {
        const nativeAtoms = toAtoms(devBuyNative, nativeDecimalsFor(net));
        const agg = await deps.jupiter.quote({
          inMint: nativeAggregatorMint(net),
          outMint: baseMintAddress,
          inAmountAtoms: nativeAtoms,
          slippagePct: 0,
        });
        baseAtoms = agg.outAmountAtoms;
        devBuyJupiterQuoteRaw = agg.raw as JupiterQuoteResponseRaw;
      } else {
        baseAtoms = toAtoms(devBuyNative, basePrice.baseDecimals);
      }
      const fill = buyQuote(freshState(derived.params), feeBps, baseAtoms);
      if (!fill) {
        return c.json({ error: 'dev_buy_failed', detail: 'the dev buy amount could not be filled against a fresh curve' }, 422);
      }
      devBuyAtoms = baseAtoms;
      devBuyMinOutAtoms = fill.tokensOut;
    }

    if (net === 'SOL') {
      const blockhashSource = asSolanaBlockhashSource(deps.rpcs.SOL);
      if (!blockhashSource) throw new Error('launch/prepare: Solana RPC does not implement latestBlockhash()');
      const blockhash = await blockhashSource.latestBlockhash();

      const programId = new PublicKey(deps.env.solanaLaunchpadProgramId);
      const creator = new PublicKey(wallet);
      const baseMint = new PublicKey(baseMintAddress);

      let jupiterHop: JupiterHop | undefined;
      if (devBuyJupiterQuoteRaw) {
        jupiterHop = { response: await deps.jupiter.swapInstructions(devBuyJupiterQuoteRaw, wallet) };
      }

      const mintSalt = BigInt(now);
      const createArgs = {
        name,
        ticker,
        uri,
        supply: BigInt(Math.round(supply)),
        feeBps,
        cashback,
        salt: mintSalt,
      };
      const composed = composeSolanaLaunchTransaction(
        {
          programId,
          creator,
          baseMint,
          createArgs,
          ...(devBuyAtoms !== null && devBuyMinOutAtoms !== null
            ? { devBuy: { curveAmountIn: devBuyAtoms, curveMinOut: devBuyMinOutAtoms, ...(jupiterHop ? { jupiter: jupiterHop } : {}) } }
            : {}),
        },
        blockhash,
      );

      const [intent] = await deps.db
        .insert(launchIntents)
        .values({
          net,
          ticker,
          creator: wallet,
          name,
          descr,
          uri,
          supply,
          feeBps,
          cashback,
          baseSymbol,
          baseMint: baseMintAddress,
          devBuyNative,
          predictedMint: composed.mint.toBase58(),
          mintSalt,
          unsignedPayload: composed.messageBase64,
          expiresAt,
        })
        .returning({ id: launchIntents.id });

      return c.json({
        net,
        intentId: intent!.id,
        ticker,
        predictedMint: composed.mint.toBase58(),
        transaction: composed.base64,
        lastValidBlockHeight: composed.lastValidBlockHeight,
        devBuy: devBuyNative > 0 ? { native: devBuyNative, atomic: true } : null,
        expiresAt: expiresAt.getTime(),
      });
    }

    // Robinhood Chain.
    const launchpad = deps.env.rhLaunchpadAddress as Address;
    const data = encodeCreateTokenCall({
      name,
      ticker,
      uri,
      supply: BigInt(Math.round(supply)),
      baseToken: baseMintAddress as Address,
      feeBps,
      cashback,
    });

    const [intent] = await deps.db
      .insert(launchIntents)
      .values({
        net,
        ticker,
        creator: wallet,
        name,
        descr,
        uri,
        supply,
        feeBps,
        cashback,
        baseSymbol,
        baseMint: baseMintAddress,
        devBuyNative,
        predictedMint: null,
        unsignedPayload: data,
        expiresAt,
      })
      .returning({ id: launchIntents.id });

    return c.json({
      net,
      intentId: intent!.id,
      ticker,
      predictedMint: null,
      to: launchpad,
      data,
      value: '0x0',
      devBuy:
        devBuyNative > 0
          ? {
              native: devBuyNative,
              atomic: false,
              note:
                'Robinhood token addresses are only known once /launch/confirm decodes the on-chain TokenCreated event ' +
                '(CREATE, not CREATE2). Call POST /trade/prepare with side=buy for the returned token after confirming.',
            }
          : null,
      expiresAt: expiresAt.getTime(),
    });
  });

  app.post('/launch/confirm', requireAuth(), async (c) => {
    const deps = c.get('deps');
    const user = c.get('user');
    if (!user) return c.json({ error: 'unauthorized' }, 401);
    const { net, wallet } = user;

    const body = (await c.req.json().catch(() => ({}))) as { intentId?: unknown; signature?: unknown };
    const intentId = typeof body.intentId === 'string' ? body.intentId : '';
    const signature = typeof body.signature === 'string' ? body.signature : '';
    if (!intentId || !signature) {
      return c.json({ error: 'bad_request', detail: 'intentId and signature are required' }, 400);
    }

    const [intent] = await deps.db.select().from(launchIntents).where(eq(launchIntents.id, intentId)).limit(1);
    if (!intent || intent.net !== net || intent.creator !== wallet) return c.json({ error: 'not_found' }, 404);
    if (intent.consumedAt) return c.json({ error: 'already_confirmed' }, 409);
    const now = deps.now();
    if (intent.expiresAt.getTime() < now) return c.json({ error: 'intent_expired' }, 410);

    const basePrice = await basePriceFor(net, intent.baseSymbol, deps.oracle);
    if (!basePrice) {
      return c.json({ error: 'base_price_unavailable', detail: 'base price source no longer available' }, 422);
    }

    let mint: string;
    let curveColumns: CurveStateColumns;
    let mcValue: number;

    if (net === 'SOL') {
      const txSource = asSolanaTransactionSource(deps.rpcs.SOL);
      if (!txSource) throw new Error('launch/confirm: Solana RPC does not implement getTransactionMessageBase64()');
      const onChainMessage = await txSource.getTransactionMessageBase64(signature);
      if (!onChainMessage) return c.json({ error: 'transaction_not_found' }, 404);
      if (onChainMessage !== intent.unsignedPayload) {
        return c.json({ error: 'signature_mismatch', detail: 'the confirmed transaction does not match what was prepared' }, 409);
      }

      mint = intent.predictedMint!;
      const supplyAtoms = BigInt(Math.round(intent.supply)) * 10n ** BigInt(SOLANA_TOKEN_DECIMALS);
      // Refetched, not the price `/launch/prepare` saw — this phase does not
      // yet decode the program's own `TokenCreated` event/log to read back
      // the exact on-chain price, unlike the Robinhood branch below, which
      // can and does. A documented, flagged gap (see the phase report): if
      // the oracle moved between prepare and confirm, this DB curve is a
      // close approximation of the real one, not a byte-exact mirror of it,
      // until the (out-of-scope) indexer corrects it from chain state.
      const derived = deriveCurveColumns(supplyAtoms, basePrice.price1e6, basePrice.baseDecimals, SOLANA_TOKEN_DECIMALS);
      if (!derived) return c.json({ error: 'invalid_curve_params' }, 422);
      curveColumns = derived.columns;
      const mcapBaseAtoms = mcapBase(derived.state, supplyAtoms);
      mcValue = Number(mcapUsd1e6(mcapBaseAtoms, basePrice.price1e6, basePrice.baseDecimals)) / 1e6;
    } else {
      const txSource = asEvmTransactionSource(deps.rpcs.RH);
      if (!txSource) throw new Error('launch/confirm: EVM RPC does not implement getTransactionReceipt()');
      const receipt = await txSource.getTransactionReceipt(signature);
      if (!receipt) return c.json({ error: 'transaction_not_found' }, 404);
      if (receipt.status !== 'success') return c.json({ error: 'transaction_reverted' }, 422);
      if (
        !receipt.to ||
        receipt.to.toLowerCase() !== deps.env.rhLaunchpadAddress.toLowerCase() ||
        receipt.input.toLowerCase() !== intent.unsignedPayload.toLowerCase()
      ) {
        return c.json({ error: 'signature_mismatch', detail: 'the confirmed transaction does not match what was prepared' }, 409);
      }
      const decoded = decodeTokenCreated(receipt.logs, deps.env.rhLaunchpadAddress as Address);
      if (!decoded) return c.json({ error: 'token_created_event_missing' }, 422);

      mint = decoded.token;
      curveColumns = {
        tokenDecimals: EVM_TOKEN_DECIMALS,
        baseDecimals: basePrice.baseDecimals,
        basePriceUsd1e6: decoded.basePrice1e6.toString(),
        curveTokensForSale: decoded.tokensForSale.toString(),
        curveVirtualBase0: decoded.virtualBase.toString(),
        curveVirtualToken0: decoded.virtualToken.toString(),
        curveK: (decoded.virtualBase * decoded.virtualToken).toString(),
        curveRealBase: '0',
        curveRealToken: decoded.tokensForSale.toString(),
        curveGradMcapBase: decoded.gradMcapBase.toString(),
      };
      const mcapBaseAtoms = (decoded.virtualBase * decoded.supply) / decoded.virtualToken;
      mcValue = Number((mcapBaseAtoms * decoded.basePrice1e6) / 10n ** BigInt(basePrice.baseDecimals)) / 1e6;
    }

    await deps.db.transaction(async (tx) => {
      await tx
        .insert(tokens)
        .values({
          net,
          sym: intent.ticker,
          name: intent.name,
          descr: intent.descr,
          creator: wallet,
          mint,
          baseSymbol: intent.baseSymbol,
          baseMint: intent.baseMint,
          supply: intent.supply,
          feeBps: intent.feeBps,
          cashback: intent.cashback,
          cbStartMs: intent.cashback ? now : null,
          mc: mcValue,
          lastMc: mcValue,
          lane: 'new',
          seed: Math.floor(now % 2_147_483_647),
          launchedAt: new Date(now),
          ...(intent.uri && /^https?:\/\//i.test(intent.uri) ? { imageUrl: intent.uri } : {}),
          ...curveColumns,
        })
        .onConflictDoNothing({ target: [tokens.net, tokens.mint] });

      await tx
        .update(launchIntents)
        .set({ consumedAt: new Date(now), consumedTxSig: signature })
        .where(eq(launchIntents.id, intent.id));
    });

    return c.json({ net, sym: intent.ticker, mint, mc: mcValue });
  });

  return app;
}
