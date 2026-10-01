import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { PublicKey } from '@solana/web3.js';
import type { Address } from 'viem';
import { and, eq, isNull, gt, lte, ne, sql } from 'drizzle-orm';
import {
  isEvm,
  isValidCurveFee,
  isValidSupply,
  isValidTicker,
  normalizeTicker,
  nativeUnit,
  MAJORS,
  MAX_TRADE_CAP,
  NET_INFO,
  stockBasesFor,
  type Net,
} from '@stonkz/shared';
import { evmLaunchpadAddress, evmRouterAddress } from '../chain/evm-net.js';
import { ZERO_EVM_ADDRESS } from '../env.js';
import { buyQuote, freshState, mcapBase, mcapUsd1e6 } from '@stonkz/curve-sim';
import { launchIntents, tokens } from '../db/schema.js';
import { requireAuth, limit } from '../app/middleware.js';
import { peekRateLimit, rateLimit, RATE_LIMITS, type RateLimitRule } from '../redis/ratelimit.js';
import type { AppEnv } from '../app/context.js';
import { RpcError, type SolanaTransactionStatusSource } from '../chain/types.js';
import { aggregatorFor, nativeAggregatorMint, nativeDecimalsFor } from '../router/compose.js';
import {
  BasePriceUnavailableError,
  basePriceFor,
  staticPricePolicy,
} from '../router/base-price.js';
import { deriveCurveColumns, type CurveStateColumns } from '../router/curve-state.js';
import { RouterError, SolanaTransactionTooLargeError } from '../router/errors.js';
import { moderateLaunch } from '../router/moderation.js';
import { gate } from '../admin/index.js';
import { toAtoms } from '../router/units.js';
import type { JupiterQuoteResponseRaw } from '../router/jupiter.js';
import {
  asSolanaBlockhashSource,
  asSolanaTransactionSource,
  type JupiterHop,
} from '../router/solana-tx.js';
import {
  composeSolanaLaunchTransaction,
  type ComposedSolanaLaunch,
  type SolanaLaunchComposition,
} from '../router/solana-launch-tx.js';
import { composeWithLookupTables } from '../router/solana-alt.js';
import {
  decodePythPriceUpdateV2,
  pinnedPythFeedId,
  pythPriceFeedAccount,
  pythTo1e6,
} from '../router/solana-idl.js';
import { asEvmTransactionSource } from '../router/evm-tx.js';
import { buildSolanaTokenMetadata } from '../router/solana-metadata.js';
import { uploadJsonToPinata } from '../social/pinata.js';
import {
  asSolanaAccountDataSource,
  asSolanaTransactionSimulator,
  mapLaunchFailure,
  readSolanaBaseOracle,
  type PreflightRefusal,
  type SolanaBaseOracle,
} from '../router/launch-preflight.js';
import { findLaunchCooldown } from './token-resolve.js';
import {
  prepareEvmLaunch,
  stockPricerFor,
  isDirectLaunchCall,
  verifyEvmLaunchReceipt,
  type EvmConfirmedDevBuy,
} from './launch-evm.js';
import {
  EVM_MAX_NAME_CHARS,
  MAX_DESCR_CHARS,
  MAX_URI_BYTES,
  SOLANA_MAX_NAME_BYTES,
  checkTelegram,
  checkUri,
  checkWebsite,
  checkXHandle,
  imageUrlFromUri,
  sanitizeDescr,
  sanitizeName,
  utf8Length,
} from './launch-validate.js';

const SOLANA_TOKEN_DECIMALS = 6;
const EVM_TOKEN_DECIMALS = 18;

/**
 * How long past its prepare TTL an intent can still be *confirmed*. The TTL
 * only reserves the ticker against other wallets; the on-chain transaction
 * is what `/launch/confirm` verifies, and a slow wallet prompt plus the
 * client's own confirm polling routinely outlives a 2-minute TTL — which
 * used to strand a token that really launched with a 410.
 */
export const LAUNCH_CONFIRM_GRACE_MS = 60 * 60 * 1000;

/**
 * Jupiter route shapes for a launch's dev buy, tried in order (`maxAccounts`
 * is Jupiter's own quote parameter). The route shares one v0 transaction with
 * `create_token`, whose per-launch accounts cannot come from any lookup
 * table; a small route (typically a single pool, one Jupiter table) keeps a
 * launch with a pinned metadata URI under 1232 bytes — see
 * `solana-launch-tx.test.ts`'s size report.
 */
interface LaunchJupiterRoute {
  maxAccounts: number;
  onlyDirectRoutes?: boolean;
}
const LAUNCH_JUPITER_ROUTES: readonly LaunchJupiterRoute[] = [
  { maxAccounts: 24 },
  // Retry shape when the first route still overflows: one pool, which
  // usually also means one Jupiter lookup table instead of two or three.
  { maxAccounts: 16, onlyDirectRoutes: true },
];

/** Dev-buy `minOut` tolerance when the client sends none (percent). */
const DEFAULT_DEV_BUY_SLIPPAGE_PCT = 1;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SOLANA_SIG_RE = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;
const EVM_TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const USD_STABLES = new Set(['USDC', 'USDT', 'USDG']);

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
  /** Dev-buy slippage tolerance, percent (Solana only). */
  slip?: unknown;
  /** Socials — `x`/`web`/`tg` are the web draft's own names. */
  x?: unknown;
  xHandle?: unknown;
  web?: unknown;
  website?: unknown;
  tg?: unknown;
  telegram?: unknown;
}

function isAllowedBaseSymbol(net: Net, symbol: string): boolean {
  const upper = symbol.toUpperCase();
  if (MAJORS[net].some(([sym]) => sym === upper)) return true;
  // Config-driven per net (`STOCK_BASES`): SOL xStocks, RH stocks, Base later.
  return stockBasesFor(net).some(([sym]) => sym === upper);
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function walletLaunchRule(env: {
  launchRateLimitPerWallet: number;
  launchRateLimitWindowSeconds: number;
}): RateLimitRule {
  return {
    bucket: 'launch_wallet',
    limit: env.launchRateLimitPerWallet,
    windowSeconds: env.launchRateLimitWindowSeconds,
  };
}

function refuse(c: Context<AppEnv>, r: PreflightRefusal): Response {
  if (r.retryAfter !== undefined) c.header('Retry-After', String(r.retryAfter));
  return c.json(
    {
      error: r.error,
      detail: r.detail,
      ...(r.retryAfter !== undefined ? { retryAfter: r.retryAfter } : {}),
    },
    r.status,
  );
}

function chainUnavailable(c: Context<AppEnv>, net: Net): Response {
  return refuse(c, {
    status: 503,
    error: 'chain_unavailable',
    detail: `the ${NET_INFO[net]?.name ?? net} RPC is not responding, try again shortly`,
    retryAfter: 5,
  });
}

/**
 * Per-wallet launch quota, counted in **confirmed launches**. `/launch/prepare`
 * only peeks at it; `/launch/confirm` spends it once a launch is verified
 * on-chain. A prepare refused by validation, a preflight, a server error — or
 * simply abandoned in the wallet — costs nothing (a cancelled MetaMask prompt
 * or a transient 500 once locked testers out for an hour).
 */
const walletLaunchQuota: MiddlewareHandler<AppEnv> = async (c, next) => {
  const deps = c.get('deps');
  const user = c.get('user');
  if (!user) return c.json({ error: 'unauthorized' }, 401);
  const rule = walletLaunchRule(deps.admin.settings.launchRateLimit());
  const verdict = await peekRateLimit(
    deps.redis,
    rule,
    `w:${user.net}:${user.wallet}`,
    Math.floor(deps.now() / 1000),
  );
  if (!verdict.ok) {
    c.header('Retry-After', String(verdict.resetSeconds));
    return c.json(
      {
        error: 'rate_limited',
        detail: `launch limit: ${rule.limit} per ${Math.round(rule.windowSeconds / 60)} minutes`,
        retryAfter: verdict.resetSeconds,
      },
      429,
    );
  }
  await next();
  return undefined;
};

/**
 * `POST /launch/prepare` + `POST /launch/confirm` — plan steps 90–91.
 *
 * `/launch/prepare` validates everything the plan lists, derives the curve
 * with the same `@stonkz/curve-sim` the chain settles against, builds the
 * unsigned create transaction (Solana: one atomic tx, optionally with a dev
 * buy; EVM: one `StonkzRouter` call carrying a Pyth price update and, on a
 * WETH curve, the dev buy — `launch-evm.ts`),
 * **simulates it as the creator** so a launch that can only revert is refused
 * with an actionable code before anyone signs, and records a
 * `launch_intents` row `/launch/confirm` reads back.
 *
 * `/launch/confirm` verifies the signed, submitted transaction actually
 * matches what was prepared — byte-for-byte on the compiled message
 * (Solana), or on EVM the router call's `CreateParams` (legacy launchpad
 * `createToken`: `to`+`data`), sent by this wallet and actually executed —
 * rather than trusting client-reported ticker/supply/fee after the fact, then
 * upserts the `tokens` row.
 *
 * **Dev buys are atomic on both chains**: on Solana the mint is a PDA of
 * creator+salt, known before signing, so `buy` follows `create_token` in the
 * same transaction. On EVM the token address (plain `CREATE`) is unknowable
 * before execution, so `StonkzRouter.createAndBuyWithEth` creates and buys in
 * one call. Only a non-WETH EVM base, or a router that predates atomic
 * launches, still leaves the dev buy to a separate `POST /trade/prepare`.
 */
export function launchRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // Launch bodies are a few hundred bytes of JSON; refuse anything
  // resembling an upload before it is buffered.
  const launchBodyLimit = bodyLimit({
    maxSize: 16 * 1024,
    onError: (c) => c.json({ error: 'too_large', detail: 'request body is too large' }, 413),
  });

  app.post(
    '/launch/prepare',
    requireAuth(),
    gate({ feature: 'launch', ban: 'launch' }),
    limit(RATE_LIMITS.launchIp),
    walletLaunchQuota,
    launchBodyLimit,
    async (c) => {
      const deps = c.get('deps');
      const user = c.get('user');
      if (!user) return c.json({ error: 'unauthorized' }, 401);
      const { net, wallet } = user;
      const unit = nativeUnit(net);

      // A net with no launchpad pinned in this environment (Arc today) is
      // refused before anything else, not after a price lookup or a cooldown.
      const launchpad = isEvm(net) ? (evmLaunchpadAddress(deps.env, net) as Address) : null;
      if (launchpad !== null && launchpad.toLowerCase() === ZERO_EVM_ADDRESS) {
        return c.json(
          {
            error: 'launchpad_not_configured',
            detail: `launching on ${NET_INFO[net]?.name ?? net} is not live yet`,
          },
          422,
        );
      }

      const body = (await c.req.json().catch(() => ({}))) as LaunchPrepareBody;
      const ticker = normalizeTicker(str(body.ticker));
      const name = sanitizeName(str(body.name));
      const descr = sanitizeDescr(str(body.descr));
      const supply = typeof body.supply === 'number' ? body.supply : Number.NaN;
      const feePct = typeof body.feePct === 'number' ? body.feePct : Number.NaN;
      const cashback = body.cashback === true;
      const baseSymbol = str(body.baseSymbol).trim().toUpperCase();
      const devBuyNative =
        typeof body.devBuyNative === 'number' && Number.isFinite(body.devBuyNative)
          ? body.devBuyNative
          : 0;
      const slipRaw = typeof body.slip === 'number' ? body.slip : Number.NaN;
      const devBuySlipPct = Number.isFinite(slipRaw)
        ? Math.min(50, Math.max(0.1, slipRaw))
        : DEFAULT_DEV_BUY_SLIPPAGE_PCT;

      if (!isValidTicker(ticker) || !name) {
        return c.json({ error: 'bad_request', detail: 'ticker and name are required' }, 400);
      }
      if (net === 'SOL' && utf8Length(name) > SOLANA_MAX_NAME_BYTES) {
        return c.json(
          {
            error: 'name_too_long',
            detail: `name must be at most ${SOLANA_MAX_NAME_BYTES} bytes on Solana (emoji and non-Latin letters count 2-4 each)`,
          },
          422,
        );
      }
      if (isEvm(net) && [...name].length > EVM_MAX_NAME_CHARS) {
        return c.json(
          {
            error: 'name_too_long',
            detail: `name must be at most ${EVM_MAX_NAME_CHARS} characters`,
          },
          422,
        );
      }
      if ([...descr].length > MAX_DESCR_CHARS) {
        return c.json(
          {
            error: 'descr_too_long',
            detail: `description must be at most ${MAX_DESCR_CHARS} characters`,
          },
          422,
        );
      }
      const uriCheck = checkUri(str(body.uri));
      if (!uriCheck.ok) return c.json({ error: 'invalid_uri', detail: uriCheck.detail }, 422);
      const uri = uriCheck.value;

      const xCheck = checkXHandle(str(body.xHandle ?? body.x));
      const webCheck = checkWebsite(str(body.website ?? body.web));
      const tgCheck = checkTelegram(str(body.telegram ?? body.tg));
      for (const check of [xCheck, webCheck, tgCheck]) {
        if (!check.ok) return c.json({ error: 'invalid_social', detail: check.detail }, 422);
      }
      const xHandle = xCheck.ok ? xCheck.value : null;
      const website = webCheck.ok ? webCheck.value : null;
      const telegram = tgCheck.ok ? tgCheck.value : null;

      if (!isValidSupply(supply)) {
        return c.json(
          { error: 'invalid_supply', detail: 'supply must be one of 1e6, 5e8, 1e9, 1e12' },
          422,
        );
      }
      if (!isValidCurveFee(feePct)) {
        return c.json(
          { error: 'invalid_fee', detail: 'fee must be between 1.0 and 5.0 percent' },
          422,
        );
      }
      if (devBuyNative < 0 || !Number.isFinite(devBuyNative)) {
        return c.json(
          { error: 'bad_request', detail: 'devBuyNative must be a non-negative number' },
          400,
        );
      }
      if (devBuyNative > MAX_TRADE_CAP[unit]) {
        return c.json(
          {
            error: 'dev_buy_too_large',
            detail: `dev buy must be at most ${MAX_TRADE_CAP[unit]} ${unit}`,
          },
          422,
        );
      }
      // Plan step 90: cashback only if the native-denominated dev buy is zero.
      if (cashback && devBuyNative > 0) {
        return c.json(
          {
            error: 'cashback_dev_buy_conflict',
            detail: 'cashback launches cannot also carry a dev buy',
          },
          422,
        );
      }

      const moderation = moderateLaunch(
        { name, ticker, descr },
        deps.admin.settings.moderationWords(),
      );
      if (!moderation.ok) {
        deps.logger.warn('launch rejected by moderation stub', {
          net,
          wallet,
          ticker,
          matched: moderation.matched.length,
        });
        return c.json(
          {
            error: 'moderation_rejected',
            detail: 'name, ticker or description failed the content filter',
          },
          422,
        );
      }

      if (!isAllowedBaseSymbol(net, baseSymbol)) {
        return c.json(
          {
            error: 'base_mint_not_allowed',
            detail: `${baseSymbol || 'that'} is not a recognised base asset on this net`,
          },
          400,
        );
      }
      let baseMintAddress = deps.baseMints.mintFor(net, baseSymbol);
      // `StonkzLaunchpad.createToken` prices and pairs an ERC-20: the 0x0
      // native marker reverts (`IERC20(0).decimals()`), and the router's
      // `buyWithEth`/`sellForEth` require the pair's base to be WETH. So a
      // native (ETH) launch is a WETH-based curve on-chain.
      if (isEvm(net) && baseMintAddress && baseMintAddress.toLowerCase() === ZERO_EVM_ADDRESS) {
        baseMintAddress = deps.baseMints.mintFor(net, 'WETH');
      }
      if (!baseMintAddress) {
        return c.json(
          {
            error: 'base_mint_not_allowed',
            detail: `${baseSymbol} has no configured mint address on this net yet`,
          },
          400,
        );
      }
      // EVM stock bases are priced live, from the inputs `StockPriceSource`
      // reads on-chain (fresh Pyth equity, else pool TWAP × ETH/USD) — 24/7.
      // In production the static USD tables are refused (`StaticPricePolicy`):
      // a base whose live source is down is 503 + retry, never a guessed dollar.
      const basePriceOpts = {
        staticPrices: staticPricePolicy(deps.env),
        logger: deps.logger,
        ...(isEvm(net) ? { stock: stockPricerFor(deps, net) } : {}),
      };
      let basePrice: Awaited<ReturnType<typeof basePriceFor>>;
      try {
        basePrice = await basePriceFor(net, baseSymbol, deps.oracle, basePriceOpts);
      } catch (err) {
        if (err instanceof BasePriceUnavailableError) {
          deps.logger.warn('launch/prepare: base price unavailable; refusing', {
            net,
            base: baseSymbol,
            reason: err.reason,
            err: err.message,
          });
          c.header('Retry-After', String(err.retryAfterSeconds));
          return c.json(
            {
              error: 'base_price_unavailable',
              detail: `no live USD price is available for ${baseSymbol} right now; retry shortly`,
              retryAfter: err.retryAfterSeconds,
            },
            503,
          );
        }
        deps.logger.warn('launch/prepare: base price lookup threw', {
          net,
          base: baseSymbol,
          err: err instanceof Error ? err.message : String(err),
        });
        basePrice = null;
      }
      if (basePrice?.source) {
        deps.logger.info('launch/prepare: stock base priced', {
          net,
          base: baseSymbol,
          source: basePrice.source,
          price1e6: basePrice.price1e6.toString(),
        });
      }
      if (!basePrice) {
        return c.json(
          {
            error: 'base_price_unavailable',
            detail: `no USD price is available for ${baseSymbol} right now`,
          },
          422,
        );
      }
      // Divergence guard: DefiLlama and the pool's on-chain TWAP (what the
      // contract prices off when Pyth equity is stale) must roughly agree, or
      // the curve the chain builds would not be the one priced here.
      const maxDivergenceBps = deps.env.stockPriceMaxDivergenceBps;
      if (
        maxDivergenceBps > 0 &&
        basePrice.divergenceBps != null &&
        basePrice.divergenceBps > maxDivergenceBps
      ) {
        deps.logger.warn('launch/prepare: stock price sources diverge; refusing', {
          net,
          base: baseSymbol,
          divergenceBps: basePrice.divergenceBps,
          maxDivergenceBps,
        });
        c.header('Retry-After', '60');
        return c.json(
          {
            error: 'stock_price_diverged',
            detail: 'the stock pool price looks off right now, try again shortly',
            retryAfter: 60,
          },
          503,
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

      // Housekeeping: drop intents for this ticker that are past even the
      // confirm grace — nothing can confirm them any more.
      await deps.db
        .delete(launchIntents)
        .where(
          and(
            eq(launchIntents.net, net),
            eq(launchIntents.ticker, ticker),
            isNull(launchIntents.consumedAt),
            lte(launchIntents.expiresAt, new Date(now - LAUNCH_CONFIRM_GRACE_MS)),
          ),
        );

      // Another wallet's live prepare reserves the ticker until its TTL. The
      // same wallet re-preparing (a cancelled MetaMask prompt) is allowed and
      // keeps its older intent: if that transaction did land after all, it
      // can still be confirmed.
      const [inFlight] = await deps.db
        .select({ id: launchIntents.id })
        .from(launchIntents)
        .where(
          and(
            eq(launchIntents.net, net),
            eq(launchIntents.ticker, ticker),
            ne(launchIntents.creator, wallet),
            isNull(launchIntents.consumedAt),
            gt(launchIntents.expiresAt, new Date(now)),
          ),
        )
        .limit(1);
      if (inFlight) {
        return c.json(
          {
            error: 'ticker_taken',
            detail: 'another wallet is launching this ticker right now; try again in 2 minutes',
            retryAfterMs: deps.env.launchIntentTtlSeconds * 1000,
          },
          409,
        );
      }

      const tokenDecimals = net === 'SOL' ? SOLANA_TOKEN_DECIMALS : EVM_TOKEN_DECIMALS;
      const supplyAtoms = BigInt(Math.round(supply)) * 10n ** BigInt(tokenDecimals);
      const derived = deriveCurveColumns(
        supplyAtoms,
        basePrice.price1e6,
        basePrice.baseDecimals,
        tokenDecimals,
        net,
      );
      if (!derived) {
        return c.json(
          {
            error: 'invalid_curve_params',
            detail: 'this supply/price combination cannot be represented on-chain',
          },
          422,
        );
      }

      const feeBps = Math.round(feePct * 100);
      const expiresAt = new Date(now + deps.env.launchIntentTtlSeconds * 1000);
      const intentValues = {
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
        xHandle,
        website,
        telegram,
        expiresAt,
      };

      /**
       * Runs a simulation; an execution failure becomes a refusal, a
       * transport failure is logged and waved through (never block every
       * launch on a flaky RPC — the chain still enforces everything).
       */
      const preflight = async (
        run: () => Promise<{ ok: true } | { ok: false; reason: string }>,
      ): Promise<PreflightRefusal | null> => {
        let result: { ok: true } | { ok: false; reason: string };
        try {
          result = await run();
        } catch (err) {
          deps.logger.warn('launch/prepare: preflight simulation unavailable; continuing', {
            net,
            err: err instanceof Error ? err.message : String(err),
          });
          return null;
        }
        if (result.ok) return null;
        const refusal = mapLaunchFailure(result.reason, unit);
        deps.logger.warn('launch/prepare: preflight refused', {
          net,
          wallet,
          ticker,
          code: refusal.error,
          reason: result.reason.slice(0, 500),
        });
        return refusal;
      };

      /**
       * Pins the Metaplex metadata JSON for a Solana launch and returns its
       * URL, or `null` (logged) when storage is unconfigured, failing, or the
       * URL would not fit the program's 200-byte `uri`.
       */
      const pinSolanaMetadata = async (): Promise<string | null> => {
        if (!deps.env.pinataJwt) {
          deps.logger.warn(
            'launch/prepare: PINATA_JWT unset; Solana uri falls back to the image URL',
            { net, ticker },
          );
          return null;
        }
        try {
          const pinned = await uploadJsonToPinata({
            jwt: deps.env.pinataJwt,
            gateway: deps.env.pinataGateway,
            name: `stonkz-metadata-${ticker}`,
            json: buildSolanaTokenMetadata({
              name,
              ticker,
              descr,
              image: imageUrlFromUri(uri, deps.env.pinataGateway),
              website,
              xHandle,
              telegram,
            }),
          });
          if (utf8Length(pinned.url) > MAX_URI_BYTES) {
            deps.logger.warn('launch/prepare: metadata URL exceeds the on-chain uri limit', {
              bytes: utf8Length(pinned.url),
            });
            return null;
          }
          return pinned.url;
        } catch (err) {
          deps.logger.warn('launch/prepare: metadata pin failed; uri falls back to the image URL', {
            net,
            ticker,
            err: err instanceof Error ? err.message : String(err),
            upstream: (err as { upstream?: string }).upstream,
          });
          return null;
        }
      };

      try {
        if (net === 'SOL') {
          const programId = new PublicKey(deps.env.solanaLaunchpadProgramId);
          const creator = new PublicKey(wallet);
          const baseMint = new PublicKey(baseMintAddress);

          const accounts = asSolanaAccountDataSource(deps.rpcs.SOL);

          // Pyth sync: when the program pins a Pyth feed to this base mint,
          // the launch opens with `sync_price_from_pyth` reading Pyth's
          // sponsored push-feed account, so `create_token` prices off a price
          // at most one Pyth heartbeat old (measured ~35 s devnet, ~55 s
          // mainnet) rather than whatever a keeper last pushed —
          // and works even if the BaseOracle was never pushed at all. The
          // account is read here to (a) bundle the sync only when it holds a
          // fully verified update for the pinned feed (a missing or foreign
          // account would make the sync revert a launch the stored price
          // could still carry) and (b) size the dev buy off it.
          const pythFeed = pinnedPythFeedId(baseMint);
          let pythPriceUpdate: PublicKey | undefined;
          let pythPrice: { price1e6: bigint; publishTime: number } | null = null;
          if (pythFeed) {
            const feedAccount = pythPriceFeedAccount(pythFeed);
            let bundle = true;
            if (accounts) {
              try {
                const b64 = await accounts.getAccountDataBase64(feedAccount.toBase58());
                const update = b64 ? decodePythPriceUpdateV2(Buffer.from(b64, 'base64')) : null;
                if (!update || !update.fullyVerified || !update.feedId.equals(pythFeed)) {
                  bundle = false;
                  deps.logger.warn('launch/prepare: Pyth feed account unusable; no price sync', {
                    baseSymbol,
                    account: feedAccount.toBase58(),
                    present: b64 !== null,
                  });
                } else {
                  const price1e6 =
                    update.price > 0n ? pythTo1e6(update.price, update.exponent) : null;
                  if (price1e6 !== null && price1e6 > 0n) {
                    pythPrice = { price1e6, publishTime: update.publishTime };
                  }
                }
              } catch (err) {
                // Transport failure: bundle anyway — the program verifies the
                // account itself, and the preflight simulation below reports
                // a sync that cannot run.
                deps.logger.warn('launch/prepare: Pyth feed read failed; bundling the sync', {
                  baseSymbol,
                  err: String(err),
                });
              }
            }
            if (bundle) pythPriceUpdate = feedAccount;
          }

          // Dev buy preview against the token's own *fresh* curve — nobody
          // else can trade it before this atomic transaction's `buy` runs. The
          // program derives that curve from its on-chain BaseOracle price,
          // not the API's off-chain one, so read the same account; any drift
          // left between prepare and landing is what the slippage covers.
          // With a bundled sync, that BaseOracle price is the Pyth update
          // whenever it is newer than what is stored (the program's own
          // rule), so the curve is priced off whichever of the two wins.
          let devBuyCurve: ReturnType<typeof deriveCurveColumns> = null;
          /** The curve without the sync — used if the sync has to be dropped for size. */
          let storedDevBuyCurve: ReturnType<typeof deriveCurveColumns> = null;
          if (devBuyNative > 0) {
            let onChain: SolanaBaseOracle | null = null;
            if (accounts) {
              onChain = await readSolanaBaseOracle(accounts, programId, baseMint).catch(
                (err: unknown) => {
                  deps.logger.warn(
                    'launch/prepare: BaseOracle read failed; using off-chain price',
                    {
                      baseSymbol,
                      err: String(err),
                    },
                  );
                  return null;
                },
              );
            }
            const curveAt = (price1e6: bigint | null) =>
              price1e6 !== null
                ? deriveCurveColumns(
                    supplyAtoms,
                    price1e6,
                    basePrice.baseDecimals,
                    tokenDecimals,
                    net,
                  )
                : derived;
            storedDevBuyCurve = curveAt(onChain?.price1e6 ?? null);
            devBuyCurve =
              pythPriceUpdate &&
              pythPrice &&
              (!onChain || pythPrice.publishTime > onChain.publishTime)
                ? curveAt(pythPrice.price1e6)
                : storedDevBuyCurve;
            if (!devBuyCurve) {
              return c.json(
                {
                  error: 'invalid_curve_params',
                  detail: 'this supply/price combination cannot be represented on-chain',
                },
                422,
              );
            }
          }

          // A Jupiter-routed dev buy is quoted, composed and size-checked per
          // route shape, narrowest last: a route that leaves the v0 message
          // over 1232 bytes is re-quoted once as a direct, smaller route.
          const routeShapes: readonly (LaunchJupiterRoute | null)[] =
            devBuyNative > 0 && aggregatorFor(net, baseSymbol) ? LAUNCH_JUPITER_ROUTES : [null];
          let blockhash: { blockhash: string; lastValidBlockHeight: number } | null = null;
          let onChainUri = uri;
          let metadataUri: string | null = null;
          let pinnedOnce = false;
          const mintSalt = BigInt(now);
          let composed: ComposedSolanaLaunch | null = null;
          for (let attempt = 0; composed === null; attempt++) {
            const route = routeShapes[attempt] ?? null;
            // Dev buy preview against the token's own *fresh* curve — nobody
            // else can trade it before this atomic transaction's `buy` runs.
            // `devBuyCurve` is priced the way the program will price it (the
            // BaseOracle after the bundled Pyth sync, if any); any drift left
            // between prepare and landing is what the slippage covers.
            let devBuyAtoms: bigint | null = null;
            let devBuyMinOutAtoms: bigint | null = null;
            let devBuyJupiterQuoteRaw: JupiterQuoteResponseRaw | null = null;
            if (devBuyCurve) {
              let baseAtoms: bigint;
              if (route) {
                const agg = await deps.jupiter.quote({
                  inMint: nativeAggregatorMint(net),
                  outMint: baseMintAddress,
                  inAmountAtoms: toAtoms(devBuyNative, nativeDecimalsFor(net)),
                  slippagePct: devBuySlipPct,
                  // The route shares one packet with create_token's 17 accounts.
                  maxAccounts: route.maxAccounts,
                  ...(route.onlyDirectRoutes ? { onlyDirectRoutes: true } : {}),
                });
                devBuyJupiterQuoteRaw = agg.raw as JupiterQuoteResponseRaw;
                // Spend only what the swap is guaranteed to deliver, or the
                // curve `buy` could ask for more base than landed in the ATA.
                let threshold = 0n;
                try {
                  threshold = BigInt(devBuyJupiterQuoteRaw.otherAmountThreshold || '0');
                } catch {
                  threshold = 0n;
                }
                baseAtoms = threshold > 0n ? threshold : agg.outAmountAtoms;
              } else {
                baseAtoms = toAtoms(devBuyNative, basePrice.baseDecimals);
              }
              const fill = buyQuote(freshState(devBuyCurve.params), feeBps, baseAtoms);
              if (!fill || fill.tokensOut <= 0n) {
                return c.json(
                  {
                    error: 'dev_buy_failed',
                    detail: 'the dev buy amount could not be filled against a fresh curve',
                  },
                  422,
                );
              }
              const slipBps = BigInt(Math.round(devBuySlipPct * 100));
              devBuyAtoms = baseAtoms;
              devBuyMinOutAtoms = (fill.tokensOut * (10_000n - slipBps)) / 10_000n;
            }

            if (!blockhash) {
              const blockhashSource = asSolanaBlockhashSource(deps.rpcs.SOL);
              if (!blockhashSource)
                throw new Error('launch/prepare: Solana RPC does not implement latestBlockhash()');
              blockhash = await blockhashSource.latestBlockhash();
            }

            let jupiterHop: JupiterHop | undefined;
            if (devBuyJupiterQuoteRaw) {
              jupiterHop = {
                response: await deps.jupiter.swapInstructions(devBuyJupiterQuoteRaw, wallet),
              };
            }

            // The on-chain `uri` feeds an immutable Metaplex metadata account,
            // which wallets and explorers read as metadata JSON, not as an
            // image. Pin that JSON and put its URL on-chain; the image stays
            // on the intent for the board. Storage missing or failing falls
            // back to the old behaviour (image on-chain) rather than blocking.
            if (!pinnedOnce) {
              pinnedOnce = true;
              const pinned = await pinSolanaMetadata();
              if (pinned) {
                onChainUri = pinned;
                metadataUri = pinned;
              }
            }

            const composition: SolanaLaunchComposition = {
              programId,
              creator,
              baseMint,
              createArgs: {
                name,
                ticker,
                uri: onChainUri,
                supply: BigInt(Math.round(supply)),
                feeBps,
                cashback,
                salt: mintSalt,
              },
              ...(pythPriceUpdate ? { pythPriceUpdate } : {}),
              ...(devBuyAtoms !== null && devBuyMinOutAtoms !== null
                ? {
                    devBuy: {
                      curveAmountIn: devBuyAtoms,
                      curveMinOut: devBuyMinOutAtoms,
                      ...(jupiterHop ? { jupiter: jupiterHop } : {}),
                    },
                  }
                : {}),
            };
            const hopBlockhash = blockhash;
            try {
              // A Jupiter hop compiles to a v0 message against Jupiter's
              // lookup tables plus the operator's; the plain path stays legacy.
              composed = await composeWithLookupTables(
                (lookupTables) =>
                  composeSolanaLaunchTransaction(
                    { ...composition, ...(lookupTables ? { lookupTables } : {}) },
                    hopBlockhash,
                  ),
                {
                  source: asSolanaAccountDataSource(deps.rpcs.SOL),
                  ...(jupiterHop
                    ? { jupiterAlts: jupiterHop.response.addressLookupTableAddresses ?? [] }
                    : {}),
                  stonkzAlts: deps.env.solanaLaunchAlts,
                  onMissing: (address) =>
                    deps.logger.warn('launch/prepare: address lookup table unavailable', {
                      address,
                    }),
                },
              );
            } catch (err) {
              if (
                err instanceof SolanaTransactionTooLargeError &&
                jupiterHop &&
                attempt + 1 < routeShapes.length
              ) {
                deps.logger.warn('launch/prepare: dev-buy route too large; re-quoting narrower', {
                  baseSymbol,
                  bytes: err.bytes,
                  lookupTables: jupiterHop.response.addressLookupTableAddresses?.length ?? 0,
                });
                continue;
              }
              if (
                err instanceof SolanaTransactionTooLargeError &&
                pythPriceUpdate &&
                (devBuyCurve === null || storedDevBuyCurve !== null)
              ) {
                // The sync is an optimisation, not a requirement: rather than
                // refuse a launch whose legacy form the sync's 49 bytes push
                // over the packet (no `SOLANA_LAUNCH_ALT` to fall back on),
                // compose it as before — priced off the stored BaseOracle —
                // and retry the same route shape.
                deps.logger.warn('launch/prepare: dropping the Pyth sync to fit one packet', {
                  baseSymbol,
                  bytes: err.bytes,
                });
                pythPriceUpdate = undefined;
                devBuyCurve = storedDevBuyCurve;
                attempt--;
                continue;
              }
              throw err;
            }
          }

          const simulator = asSolanaTransactionSimulator(deps.rpcs.SOL);
          if (simulator) {
            const refusal = await preflight(() => simulator.simulateTransaction(composed.base64));
            if (refusal) return refuse(c, refusal);
          }

          const [intent] = await deps.db
            .insert(launchIntents)
            .values({
              ...intentValues,
              predictedMint: composed.mint.toBase58(),
              mintSalt,
              metadataUri,
              unsignedPayload: composed.messageBase64,
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

        // EVM (Robinhood, Base). Arc was refused at the top. One transaction
        // through `StonkzRouter` with a Pyth update (and, on a WETH curve, the
        // dev buy) — or the legacy `createToken` — see `launch-evm.ts`.
        if (!isEvm(net)) return c.json({ error: 'bad_request', detail: 'unsupported net' }, 400);
        return await prepareEvmLaunch(c, {
          net,
          wallet,
          unit,
          launchpad: launchpad as Address,
          name,
          ticker,
          uri,
          supply,
          feeBps,
          cashback,
          baseSymbol,
          baseMintAddress,
          devBuyNative,
          devBuySlipPct,
          supplyAtoms,
          baseDecimals: basePrice.baseDecimals,
          basePrice1e6: basePrice.price1e6,
          basePriceFloor1e6: basePrice.floorPrice1e6,
          intentValues,
          expiresAt,
          now,
        });
      } catch (err) {
        if (err instanceof RouterError) return c.json(err.toResponse(), err.httpStatus);
        if (err instanceof RpcError) {
          deps.logger.warn('launch/prepare: RPC failure', { net, err: err.message });
          return chainUnavailable(c, net);
        }
        throw err;
      }
    },
  );

  app.post(
    '/launch/confirm',
    requireAuth(),
    limit(RATE_LIMITS.launchConfirm),
    launchBodyLimit,
    async (c) => {
      const deps = c.get('deps');
      const user = c.get('user');
      if (!user) return c.json({ error: 'unauthorized' }, 401);
      const { net, wallet } = user;

      const body = (await c.req.json().catch(() => ({}))) as {
        intentId?: unknown;
        signature?: unknown;
      };
      const intentId = str(body.intentId).trim();
      const rawSignature = str(body.signature).trim();
      // EVM hashes are case-insensitive hex: one canonical spelling, so a
      // re-cased hash cannot slip past the replay check below.
      const signature = isEvm(net) ? rawSignature.toLowerCase() : rawSignature;
      if (!intentId || !signature) {
        return c.json({ error: 'bad_request', detail: 'intentId and signature are required' }, 400);
      }
      // A non-uuid id would reach Postgres as a cast error (a 500); a
      // malformed signature would go straight to an RPC.
      if (!UUID_RE.test(intentId)) {
        return c.json({ error: 'bad_request', detail: 'intentId is not a launch intent id' }, 400);
      }
      if (!(isEvm(net) ? EVM_TX_HASH_RE : SOLANA_SIG_RE).test(signature)) {
        return c.json(
          {
            error: 'bad_request',
            detail: isEvm(net)
              ? 'signature must be a 0x-prefixed transaction hash'
              : 'signature must be a base58 transaction signature',
          },
          400,
        );
      }

      const [intent] = await deps.db
        .select()
        .from(launchIntents)
        .where(eq(launchIntents.id, intentId))
        .limit(1);
      if (!intent || intent.net !== net || intent.creator !== wallet) {
        return c.json(
          { error: 'not_found', detail: 'no launch intent with this id for this wallet' },
          404,
        );
      }

      // Double-submit / client retry after a lost response: the same
      // signature on an already-confirmed intent answers with the same result.
      if (intent.consumedAt) {
        if (intent.consumedTxSig === signature && intent.predictedMint) {
          const [row] = await deps.db
            .select({ sym: tokens.sym, mint: tokens.mint, mc: tokens.mc })
            .from(tokens)
            .where(and(eq(tokens.net, net), eq(tokens.mint, intent.predictedMint)))
            .limit(1);
          if (row) return c.json({ net, sym: row.sym, mint: row.mint, mc: row.mc, already: true });
        }
        return c.json(
          {
            error: 'already_confirmed',
            detail: 'this launch was already confirmed with another transaction',
          },
          409,
        );
      }
      const now = deps.now();
      if (intent.expiresAt.getTime() + LAUNCH_CONFIRM_GRACE_MS < now) {
        return c.json(
          {
            error: 'intent_expired',
            detail: 'this launch intent expired; prepare the launch again',
          },
          410,
        );
      }

      // One transaction launches one token: refuse to spend a signature that
      // already confirmed a different intent (EVM calldata for identical
      // params is identical, so this is reachable).
      const [reused] = await deps.db
        .select({ id: launchIntents.id })
        .from(launchIntents)
        .where(and(eq(launchIntents.net, net), eq(launchIntents.consumedTxSig, signature)))
        .limit(1);
      if (reused) {
        return c.json(
          {
            error: 'signature_already_used',
            detail: 'this transaction already confirmed another launch',
          },
          409,
        );
      }

      let mint: string;
      /** EVM router launch: the `AtomicBuy` that landed with it. */
      let evmDevBuy: EvmConfirmedDevBuy | null = null;
      let curveColumns: CurveStateColumns;
      /** Launch cap at the snapshot price (`tokens.mc`) and in base units (`tokens.mcBase`, the truth). */
      let mcValue: number;
      let mcBaseValue: number;

      try {
        if (net === 'SOL') {
          const statusSource = deps.rpcs.SOL as Partial<SolanaTransactionStatusSource>;
          let outcome: { messageBase64: string; failed: boolean } | null;
          if (typeof statusSource.getTransactionOutcome === 'function') {
            outcome = await statusSource.getTransactionOutcome(signature);
          } else {
            const txSource = asSolanaTransactionSource(deps.rpcs.SOL);
            if (!txSource)
              throw new Error('launch/confirm: Solana RPC cannot read transactions back');
            const msg = await txSource.getTransactionMessageBase64(signature);
            outcome = msg === null ? null : { messageBase64: msg, failed: false };
          }
          if (!outcome) {
            return c.json(
              {
                error: 'transaction_not_found',
                detail: 'the transaction is not confirmed yet; retry in a few seconds',
              },
              404,
            );
          }
          if (outcome.messageBase64 !== intent.unsignedPayload) {
            return c.json(
              {
                error: 'signature_mismatch',
                detail: 'the confirmed transaction does not match what was prepared',
              },
              409,
            );
          }
          // Landed but failed (stale oracle, dev-buy slippage, not enough SOL):
          // the mint PDA was never created, so there is nothing to register.
          if (outcome.failed) {
            return c.json(
              {
                error: 'transaction_failed',
                detail:
                  'the launch transaction failed on-chain and created nothing; prepare it again',
              },
              422,
            );
          }

          mint = intent.predictedMint!;
          const supplyAtoms =
            BigInt(Math.round(intent.supply)) * 10n ** BigInt(SOLANA_TOKEN_DECIMALS);
          // The program priced this curve off its BaseOracle; read the same
          // account so the DB mirror matches. Off-chain price is the fallback
          // until the indexer corrects it from chain state.
          const offChain = await basePriceFor(net, intent.baseSymbol, deps.oracle, {
            staticPrices: staticPricePolicy(deps.env),
            logger: deps.logger,
          }).catch(() => null);
          const accounts = asSolanaAccountDataSource(deps.rpcs.SOL);
          const onChain = accounts
            ? await readSolanaBaseOracle(
                accounts,
                new PublicKey(deps.env.solanaLaunchpadProgramId),
                new PublicKey(intent.baseMint),
              ).catch(() => null)
            : null;
          const price1e6 = onChain?.price1e6 ?? offChain?.price1e6 ?? null;
          const baseDecimals = offChain?.baseDecimals ?? onChain?.baseDecimals ?? 9;
          if (price1e6 === null) {
            return c.json(
              {
                error: 'base_price_unavailable',
                detail: 'base price source is unavailable; retry shortly',
              },
              503,
            );
          }
          const derived = deriveCurveColumns(
            supplyAtoms,
            price1e6,
            baseDecimals,
            SOLANA_TOKEN_DECIMALS,
          );
          if (!derived) return c.json({ error: 'invalid_curve_params' }, 422);
          curveColumns = derived.columns;
          const mcapBaseAtoms = mcapBase(derived.state, supplyAtoms);
          mcValue = Number(mcapUsd1e6(mcapBaseAtoms, price1e6, baseDecimals)) / 1e6;
          mcBaseValue = Number(mcapBaseAtoms) / 10 ** baseDecimals;
        } else {
          if (!isEvm(net)) return c.json({ error: 'bad_request', detail: 'unsupported net' }, 400);
          const launchpadAddr = evmLaunchpadAddress(deps.env, net);
          const txSource = asEvmTransactionSource(deps.rpcs[net]);
          if (!txSource)
            throw new Error('launch/confirm: EVM RPC does not implement getTransactionReceipt()');
          const receipt = await txSource.getTransactionReceipt(signature);
          if (!receipt) {
            return c.json(
              {
                error: 'transaction_not_found',
                detail: 'the transaction is not confirmed yet; retry in a few seconds',
              },
              404,
            );
          }
          if (receipt.status !== 'success') {
            return c.json(
              {
                error: 'transaction_reverted',
                detail: 'the launch transaction reverted on-chain and created nothing',
              },
              422,
            );
          }
          // Calldata is reproducible by anyone once an intent expires, so the
          // sender is what binds the confirmation to this wallet.
          //
          // A *relayed* send (EIP-7702 smart account, sponsored/bundled tx)
          // has a relayer as `from` by construction; there the launchpad's
          // `TokenCreated.creator` is the binding, checked in
          // `verifyEvmLaunchReceipt`. A direct call to the launchpad or the
          // router from another wallet is still refused here.
          const direct = isDirectLaunchCall(receipt, {
            launchpad: launchpadAddr,
            router: evmRouterAddress(deps.env, net),
          });
          if (direct && (!receipt.from || receipt.from.toLowerCase() !== wallet.toLowerCase())) {
            return c.json(
              {
                error: 'tx_sender_mismatch',
                detail: 'the confirmed transaction was not sent by this wallet',
              },
              403,
            );
          }
          // `to` the launchpad (legacy `createToken`, exact calldata) or the
          // configured router (atomic launch, `CreateParams` = the intent);
          // `TokenCreated` must name this wallet (`launch-evm.ts`).
          const verified = verifyEvmLaunchReceipt(receipt, {
            wallet,
            launchpad: launchpadAddr,
            router: evmRouterAddress(deps.env, net),
            intent,
          });
          if (!verified.ok) {
            return c.json({ error: verified.error, detail: verified.detail }, verified.status);
          }
          const decoded = verified.created;
          evmDevBuy = verified.devBuy;
          if (evmDevBuy) {
            deps.logger.info('launch/confirm: atomic dev buy landed with the launch', {
              net,
              token: decoded.token,
              ethInWei: evmDevBuy.ethInWei,
              tokensOutAtoms: evmDevBuy.tokensOutAtoms,
            });
          }

          const baseDecimals =
            (
              await basePriceFor(net, intent.baseSymbol, deps.oracle, {
                staticPrices: staticPricePolicy(deps.env),
                logger: deps.logger,
              }).catch(() => null)
            )?.baseDecimals ?? (USD_STABLES.has(intent.baseSymbol.toUpperCase()) ? 6 : 18);
          mint = decoded.token;
          curveColumns = {
            tokenDecimals: EVM_TOKEN_DECIMALS,
            baseDecimals,
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
          mcValue =
            Number((mcapBaseAtoms * decoded.basePrice1e6) / 10n ** BigInt(baseDecimals)) / 1e6;
          mcBaseValue = Number(mcapBaseAtoms) / 10 ** baseDecimals;
        }
      } catch (err) {
        if (err instanceof RpcError) {
          deps.logger.warn('launch/confirm: RPC failure', { net, err: err.message });
          return chainUnavailable(c, net);
        }
        throw err;
      }

      const imageUrl = imageUrlFromUri(intent.uri, deps.env.pinataGateway);
      const consumed = await deps.db.transaction(async (tx) => {
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
            mcBase: mcBaseValue,
            lastMcBase: mcBaseValue,
            lane: 'new',
            seed: Math.floor(now % 2_147_483_647),
            launchedAt: new Date(now),
            ...(imageUrl ? { imageUrl } : {}),
            xHandle: intent.xHandle,
            website: intent.website,
            telegram: intent.telegram,
            ...curveColumns,
          })
          // The indexer may have registered this mint from `TokenCreated`
          // first, with placeholder metadata (`name = sym` on EVM, whose event
          // carries no name; `descr = ''` everywhere, since no chain carries a
          // description, image or socials). Fill the off-chain fields from the
          // verified intent — but only while the row still holds that
          // placeholder (or the same on-chain name), only on a row this creator
          // launched, and never the chain-derived curve/supply/fee columns.
          .onConflictDoUpdate({
            target: [tokens.net, tokens.mint],
            set: {
              name: sql`excluded.name`,
              descr: sql`excluded.descr`,
              imageUrl: sql`coalesce(excluded.image_url, ${tokens.imageUrl})`,
              xHandle: sql`coalesce(${tokens.xHandle}, excluded.x_handle)`,
              website: sql`coalesce(${tokens.website}, excluded.website)`,
              telegram: sql`coalesce(${tokens.telegram}, excluded.telegram)`,
              updatedAt: new Date(now),
            },
            setWhere: sql`lower(${tokens.creator}) = lower(${wallet})
            and ${tokens.descr} = ''
            and (${tokens.name} = ${tokens.sym} or ${tokens.name} = excluded.name)`,
          });

        return tx
          .update(launchIntents)
          .set({ consumedAt: new Date(now), consumedTxSig: signature, predictedMint: mint })
          .where(and(eq(launchIntents.id, intent.id), isNull(launchIntents.consumedAt)))
          .returning({ id: launchIntents.id });
      });
      // A concurrent confirm of the same intent already counted and announced it.
      if (consumed.length === 0) {
        return c.json({ net, sym: intent.ticker, mint, mc: mcValue, already: true });
      }

      // Only a verified on-chain launch spends the per-wallet quota. Never a
      // refusal here: the token already exists, it must still be registered.
      await rateLimit(
        deps.redis,
        walletLaunchRule(deps.admin.settings.launchRateLimit()),
        `w:${net}:${wallet}`,
        Math.floor(now / 1000),
      );

      // Put the coin on the live board now rather than after the indexer's
      // finality lag. Same shape as `apps/indexer` `onTokenCreated`; the web
      // board skips a coin it already holds (sym + mint), so the indexer's
      // later copy of this event is harmless.
      await deps.publisher
        .board({
          type: 'token_created',
          net,
          sym: intent.ticker,
          payload: { mint, name: intent.name, creator: wallet, mc: mcValue, lane: 'new' },
        })
        .catch((err: unknown) =>
          deps.logger.warn('launch/confirm: board publish failed', { net, mint, err: String(err) }),
        );

      return c.json({
        net,
        sym: intent.ticker,
        mint,
        mc: mcValue,
        ...(evmDevBuy ? { devBuy: evmDevBuy } : {}),
      });
    },
  );

  return app;
}
