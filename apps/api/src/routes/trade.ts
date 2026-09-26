import { Hono } from 'hono';
import { PublicKey } from '@solana/web3.js';
import { decodeAbiParameters, type Address, type Hex } from 'viem';
import { and, eq } from 'drizzle-orm';
import {
  DEFAULT_TRADE_CAP,
  MAX_TRADE_CAP,
  isEvm,
  nativeUnit,
  type NativeUnit,
} from '@stonkz/shared';
import { settings } from '../db/schema.js';
import { requireAuth, limit } from '../app/middleware.js';
import { RATE_LIMITS } from '../redis/ratelimit.js';
import type { AppEnv } from '../app/context.js';
import { composeCurveTrade } from '../router/compose.js';
import {
  CapExceededError,
  InsufficientNativeError,
  NoRouteError,
  RhAtomicRouterRequiredError,
  RouterError,
  SlippageExceededError,
} from '../router/errors.js';
import { assertUnderMaxTradeUsd } from '../router/max-trade.js';
import { isOracleHopRaw } from '../router/oracle-hop.js';
import { isV3PoolHopRaw } from '../router/v3-pool-hop.js';
import {
  syncCurveReserves,
  type EthCaller,
  type SolanaAccountSource,
} from '../router/curve-sync.js';
import { toAtoms } from '../router/units.js';
import { asErc20BalanceSource } from '../chain/types.js';
import { SolanaRpc } from '../chain/solana.js';
import type { JupiterQuoteResponseRaw } from '../router/jupiter.js';
import { asSolanaBlockhashSource, composeSolanaTradeTransaction } from '../router/solana-tx.js';
import { ZERO_EVM_ADDRESS } from '../env.js';
import {
  evmChainId as evmChainIdFor,
  evmLaunchpadAddress,
  evmRouterAddress,
  evmV3FeeTierOverrides,
} from '../chain/evm-net.js';
import {
  buildAtomicBuyCall,
  buildAtomicSellCall,
  buildSellPermitTypedData,
  stonkzRouterDecision,
  type PermitInput,
} from '../router/evm-router.js';
import type { TokenRow } from './serialise.js';
import { resolveTokenRow } from './token-resolve.js';

function asEthCaller(rpc: unknown): EthCaller | undefined {
  const candidate = rpc as Partial<EthCaller>;
  return typeof candidate.ethCall === 'function' ? (candidate as EthCaller) : undefined;
}

/**
 * EIP-712 domain `name` must match `StonkzToken`'s constructor `_name`
 * (`keccak256(bytes(_name))`), not the ticker indexed into `tokens.name`
 * (TokenCreated only carries the symbol). Fall back to the DB name if the
 * RPC read fails so prepare still returns a payload.
 */
async function eip712TokenName(
  eth: EthCaller | undefined,
  token: Address,
  fallback: string,
): Promise<string> {
  if (!eth) return fallback;
  try {
    const raw = await eth.ethCall(token, '0x06fdde03');
    if (!raw || raw === '0x') return fallback;
    const [name] = decodeAbiParameters([{ type: 'string' }], raw as Hex);
    return name.trim() || fallback;
  } catch {
    return fallback;
  }
}

function asSolanaAccountSource(rpc: unknown): SolanaAccountSource | undefined {
  if (rpc instanceof SolanaRpc) return rpc;
  const candidate = rpc as Partial<SolanaAccountSource>;
  return typeof candidate.getAccountDataBase64 === 'function'
    ? (candidate as SolanaAccountSource)
    : undefined;
}

/** `settings` table defaults — aligned with web `DEFAULTS` so UI and prepare agree. */
const DEFAULT_SETTINGS: {
  slip: number;
  prio: number;
  mev: 'SHIELD' | 'RELAY' | 'OFF';
  mevTip: number;
  cap: number;
  defBuy: number;
  confirm: boolean;
} = {
  slip: 2.5,
  prio: 0.0012,
  mev: 'SHIELD',
  mevTip: 0.0009,
  cap: 5,
  defBuy: 0.5,
  confirm: true,
};

interface TradePrepareBody {
  sym?: unknown;
  mint?: unknown;
  side?: unknown;
  amount?: unknown;
  /** Optional override — prefers the connected client's current SET.slip. */
  slip?: unknown;
  prio?: unknown;
  mev?: unknown;
  mevTip?: unknown;
  cap?: unknown;
  /**
   * RH sells only: a pre-signed EIP-2612 permit over `StonkzRouter`, so the
   * atomic call needs no prior `approve` transaction. Optional — omitted
   * means the standing-allowance branch (`PermitData.deadline == 0`), which
   * requires `wallet` to have already approved the router on this token.
   * Nothing in this repo signs one yet (`apps/web`'s trade-box wiring, Phase
   * 2.C, has not landed); this field exists so that work can add it without
   * a new endpoint. See `evm-router.ts`'s `buildSellPermitTypedData`.
   */
  permit?: unknown;
}

function clampNum(raw: unknown, min: number, max: number, fallback: number): number {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number.parseFloat(raw) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function mergePrepareSettings(
  row: {
    slip: number;
    prio: number;
    mev: string;
    mevTip: number;
    cap: number;
    defBuy: number;
    confirm: boolean;
  },
  body: TradePrepareBody,
  unit: NativeUnit,
  /** False when the wallet has no settings row yet, so the unit default applies. */
  stored = true,
): typeof DEFAULT_SETTINGS {
  const mevRaw = typeof body.mev === 'string' ? body.mev.toUpperCase() : row.mev.toUpperCase();
  const mev: 'SHIELD' | 'RELAY' | 'OFF' =
    mevRaw === 'OFF' || mevRaw === 'RELAY' || mevRaw === 'SHIELD' ? mevRaw : 'SHIELD';
  return {
    slip: clampNum(body.slip, 0.1, 50, row.slip),
    prio: clampNum(body.prio, 0, 1, row.prio),
    mev,
    mevTip: clampNum(body.mevTip, 0, 1, row.mevTip),
    cap: clampNum(body.cap, 0.001, MAX_TRADE_CAP[unit], stored ? row.cap : DEFAULT_TRADE_CAP[unit]),
    defBuy: row.defBuy,
    confirm: row.confirm,
  };
}

function parsePermit(raw: unknown): PermitInput | null {
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as Record<string, unknown>;
  if (
    typeof p['value'] !== 'string' ||
    typeof p['deadline'] !== 'number' ||
    typeof p['v'] !== 'number' ||
    typeof p['r'] !== 'string' ||
    typeof p['s'] !== 'string'
  ) {
    return null;
  }
  return {
    value: p['value'],
    deadline: p['deadline'],
    v: p['v'],
    r: p['r'] as `0x${string}`,
    s: p['s'] as `0x${string}`,
  };
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
 * - **Robinhood Chain**: one atomic `StonkzRouter` call (`atomic: true`).
 *   Missing router address or an unpinned aggregator fee tier fails closed
 *   with `rh_router_required` — there is no multi-signature `EvmStep[]`
 *   fallback (`docs/rh-trade-atomicity-gap.md`).
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
    const mintBody = typeof body.mint === 'string' ? body.mint.trim() : undefined;
    const side = body.side === 'sell' ? 'sell' : body.side === 'buy' ? 'buy' : null;
    const amount = typeof body.amount === 'number' ? body.amount : Number.NaN;

    if (!sym || !side || !Number.isFinite(amount) || amount <= 0) {
      return c.json(
        { error: 'bad_request', detail: 'sym, side (buy|sell) and a positive amount are required' },
        400,
      );
    }

    // A buy's `amount` *is* the native leg, so a capped net (Arc: real funds,
    // 25 USD) can refuse before touching the DB or an RPC. Sells are checked
    // again below once the curve has priced the native proceeds.
    if (side === 'buy') {
      try {
        assertUnderMaxTradeUsd(
          net,
          amount,
          await deps.oracle.nativeUsd(nativeUnit(net)).catch(() => null),
        );
      } catch (err) {
        if (err instanceof RouterError) return c.json(err.toResponse(), err.httpStatus);
        throw err;
      }
    }

    const row = await resolveTokenRow(deps.db, net, { mint: mintBody, sym });
    if (!row) return c.json({ error: 'not_found' }, 404);

    const synced = await syncCurveReserves({
      db: deps.db,
      row: row as TokenRow,
      ...(isEvm(net)
        ? {
            evm: {
              eth: asEthCaller(deps.rpcs[net]),
              launchpad: evmLaunchpadAddress(deps.env, net),
            },
          }
        : {}),
      sol: {
        rpc: asSolanaAccountSource(deps.rpcs.SOL),
        programId: deps.env.solanaLaunchpadProgramId,
      },
    });

    if (synced.graduatedAt !== null) {
      return c.json(
        {
          error: 'graduated_not_supported',
          detail: 'this token has graduated to the DEX pool; /trade/prepare only serves the curve',
        },
        422,
      );
    }
    if (synced.curveK === '0' || !synced.mint) {
      return c.json(
        {
          error: 'not_tradeable',
          detail: 'this token has no on-chain launch yet (no curve state / mint on record)',
        },
        422,
      );
    }

    const [settingsRow] = await deps.db
      .select()
      .from(settings)
      .where(and(eq(settings.net, net), eq(settings.wallet, wallet)))
      .limit(1);
    const s = mergePrepareSettings(
      settingsRow ?? DEFAULT_SETTINGS,
      body,
      nativeUnit(net),
      !!settingsRow,
    );
    const now = deps.now();

    // Plan step 85: abort before signing if the composed cost exceeds the
    // user's cap. Only meaningful on a buy — a sell's "cost" is gas alone,
    // which `prio`/`mevTip` already represent, and native flows *in*, not out.
    if (side === 'buy') {
      // Solana priority + MEV tip are real native outflows. On RH they are
      // UI-only (ETH gas is separate) — do not fold them into the cap or the
      // pre-sign balance check.
      const prioCost = net === 'SOL' ? s.prio : 0;
      const mevCost = net === 'SOL' && s.mev !== 'OFF' ? s.mevTip : 0;
      const totalNative = amount + prioCost + mevCost;
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

    const aggregatorVenue = synced.baseSymbol.toUpperCase();
    const usdPrice = await deps.oracle.nativeUsd(nativeUnit(net)).catch(() => null);
    const aggregator =
      net === 'SOL'
        ? aggregatorVenue === 'SOL' || aggregatorVenue === 'WSOL'
          ? null
          : deps.jupiter
        : aggregatorVenue === 'ETH' || aggregatorVenue === 'WETH'
          ? null
          : deps.uniswap;

    // Max-sell clamp: the client stores holdings as float, so `String(tok)` →
    // `toAtoms` can round *above* the on-chain ERC-20 balance and the token
    // reverts with `"balance"`. Prefer the wallet's exact atoms when smaller.
    let amountAtoms: bigint | undefined;
    if (side === 'sell' && isEvm(net) && synced.mint) {
      const erc20 = asErc20BalanceSource(deps.rpcs[net]);
      if (erc20) {
        try {
          const bal = await erc20.erc20BalanceAtoms(synced.mint, wallet);
          const want = toAtoms(amount, synced.tokenDecimals);
          amountAtoms = want > bal ? bal : want;
        } catch {
          // RPC blip — fall through to the float amount; the chain still
          // enforces the real balance.
        }
      }
    }

    let trade;
    try {
      trade = await composeCurveTrade({
        net,
        side,
        amount,
        ...(amountAtoms !== undefined ? { amountAtoms } : {}),
        row: synced,
        usdPrice,
        now,
        aggregator,
        slippagePct: s.slip,
      });
    } catch (err) {
      if (err instanceof RouterError) return c.json(err.toResponse(), err.httpStatus);
      throw err;
    }

    // Sell side of the per-net USD cap: `quote.amountOut` is the native the
    // trader receives, which is the number the cap is about.
    if (side === 'sell') {
      try {
        assertUnderMaxTradeUsd(net, trade.quote.amountOut, usdPrice);
      } catch (err) {
        if (err instanceof RouterError) return c.json(err.toResponse(), err.httpStatus);
        throw err;
      }
    }

    // Oracle-priced hops make `/quote` honest when the Trading API / pool is
    // unavailable, but they are not executable — refuse prepare rather than
    // hand the wallet a `buyViaAggregator` leg that cannot settle.
    if (trade.aggregatorQuote && isOracleHopRaw(trade.aggregatorQuote.raw)) {
      const err = new NoRouteError(
        nativeUnit(net),
        synced.baseSymbol,
        new Error(
          `no on-chain Uniswap pool for ETH \u2192 ${synced.baseSymbol} on this network; ` +
            'seed a WETH/' +
            synced.baseSymbol +
            ' pool (and pin RH_V3_FEE_TIER_OVERRIDES) before trading',
        ),
      );
      return c.json(err.toResponse(), err.httpStatus);
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
        if (!blockhashSource)
          throw new Error('trade/prepare: Solana RPC does not implement latestBlockhash()');
        const blockhash = await blockhashSource.latestBlockhash();

        const programId = new PublicKey(deps.env.solanaLaunchpadProgramId);
        const mint = new PublicKey(synced.mint);
        const baseMint = new PublicKey(synced.baseMint);
        const trader = new PublicKey(wallet);

        const jupiter = trade.aggregatorQuote
          ? {
              response: await deps.jupiter.swapInstructions(
                trade.aggregatorQuote.raw as JupiterQuoteResponseRaw,
                wallet,
              ),
            }
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
            prioSol: s.prio,
            mevOn: s.mev !== 'OFF',
            mevTipSol: s.mevTip,
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

      // EVM chains (Robinhood, Base, Arc). `StonkzRouter` wraps the gas token
      // into its canonical wrapped form for the pair; on Arc that is wrapped
      // USDC, whose address is not pinned yet, so `weth` is null there and the
      // router-missing branch below refuses the prepare (nothing is deployed
      // on Arc either way).
      const isDirectPair = trade.aggregatorQuote === null;
      const weth = deps.baseMints.mintFor(net, 'WETH');
      const routerAddr = evmRouterAddress(deps.env, net);
      const feeOverrides = evmV3FeeTierOverrides(deps.env, net);
      const evmChainId = evmChainIdFor(deps.env, net);
      const quotedFee =
        trade.aggregatorQuote && isV3PoolHopRaw(trade.aggregatorQuote.raw)
          ? trade.aggregatorQuote.raw.fee
          : null;
      const route = weth
        ? stonkzRouterDecision(
            net,
            routerAddr,
            isDirectPair,
            synced.baseMint,
            synced.baseSymbol,
            feeOverrides,
            quotedFee,
          )
        : null;

      if (route) {
        // Atomic path: one call into `StonkzRouter`, built from commands this
        // module encodes itself (never the Trading API's own `/v1/swap`
        // calldata — see `router/universal-router.ts`'s header for why).
        const deadlineUnixSeconds = Math.floor(now / 1000) + 300;
        const routerAddress = routerAddr as Address;
        const token = synced.mint as Address;
        const baseMint = synced.baseMint as Address;
        const wethAddress = weth as Address;

        if (side === 'buy') {
          const call = buildAtomicBuyCall({
            routerAddress,
            token,
            weth: wethAddress,
            baseMint,
            route,
            ethInAtoms: trade.nativeInAtoms ?? trade.curveAmountInAtoms,
            quotedBaseOutAtoms: trade.aggregatorQuote?.outAmountAtoms ?? trade.curveAmountInAtoms,
            minTokenOutAtoms: trade.curveMinOutAtoms,
            userSlippagePct: s.slip,
            deadlineUnixSeconds,
          });
          return c.json({
            net,
            atomic: true,
            to: call.to,
            data: call.data,
            value: call.value,
            quote: trade.quote,
            expiresAt: now + 30_000,
          });
        }

        // Sell. `curveNetBaseOutAtoms`/`curveMinBaseOutAtoms` are always
        // populated on this branch — `composeCurveTrade`'s sell path sets
        // them unconditionally (see that field's doc comment).
        const netBaseOutAtoms = trade.curveNetBaseOutAtoms as bigint;
        const minBaseOutAtoms = trade.curveMinBaseOutAtoms as bigint;
        const permit = parsePermit(body.permit);
        const call = buildAtomicSellCall({
          routerAddress,
          token,
          weth: wethAddress,
          baseMint,
          route,
          amountTokenAtoms: trade.curveAmountInAtoms,
          netBaseOutAtoms,
          quotedEthOutAtoms: trade.aggregatorQuote?.outAmountAtoms ?? netBaseOutAtoms,
          minBaseOutAtoms,
          minEthOutAtoms: trade.curveMinOutAtoms,
          userSlippagePct: s.slip,
          deadlineUnixSeconds,
          permit,
        });
        const permitTypedData = permit
          ? null
          : buildSellPermitTypedData({
              tokenAddress: token,
              tokenName: await eip712TokenName(asEthCaller(deps.rpcs[net]), token, synced.name),
              chainId: evmChainId,
              routerAddress,
              owner: wallet as Address,
              valueAtoms: trade.curveAmountInAtoms,
              deadlineUnixSeconds,
            });
        return c.json({
          net,
          atomic: true,
          to: call.to,
          data: call.data,
          value: call.value,
          quote: trade.quote,
          expiresAt: now + 30_000,
          ...(permitTypedData
            ? {
                permitTypedData,
                note:
                  'no permit was supplied, so this call takes the standing-allowance branch: ' +
                  'wallet must already have approved `to` (the router) to spend this token, or the ' +
                  'transaction reverts. Sign permitTypedData and resend as body.permit to skip that ' +
                  'prior approval.',
              }
            : {}),
        });
      }

      // Atomic-only: never emit a multi-signature EvmStep[] plan.
      const routerMissing = !routerAddr || routerAddr.toLowerCase() === ZERO_EVM_ADDRESS;
      throw new RhAtomicRouterRequiredError(
        routerMissing
          ? `${net}_ROUTER_ADDRESS is not configured; non-atomic EVM trades are disabled`
          : `no atomic StonkzRouter route for base ${synced.baseSymbol}; pin ${net}_V3_FEE_TIER_OVERRIDES for this asset`,
      );
    } catch (err) {
      if (err instanceof RouterError) return c.json(err.toResponse(), err.httpStatus);
      throw err;
    }
  });

  /**
   * `POST /trade/confirm` — after the wallet broadcasts, re-read curve reserves
   * from chain so the next sell quote does not depend on the indexer catching up.
   */
  app.post('/trade/confirm', requireAuth(), limit(RATE_LIMITS.trade), async (c) => {
    const deps = c.get('deps');
    const user = c.get('user');
    if (!user) return c.json({ error: 'unauthorized' }, 401);
    const { net } = user;
    const body = (await c.req.json().catch(() => ({}))) as {
      sym?: unknown;
      signature?: unknown;
      txHash?: unknown;
    };
    const sym = typeof body.sym === 'string' ? body.sym.toUpperCase() : '';
    const proof =
      typeof body.signature === 'string'
        ? body.signature
        : typeof body.txHash === 'string'
          ? body.txHash
          : '';
    if (!sym || !proof) {
      return c.json({ error: 'bad_request', detail: 'sym and signature|txHash are required' }, 400);
    }

    const mintBody =
      typeof (body as { mint?: unknown }).mint === 'string'
        ? (body as { mint: string }).mint.trim()
        : undefined;
    const resolved = await resolveTokenRow(deps.db, net, { mint: mintBody, sym });
    if (!resolved) return c.json({ error: 'not_found' }, 404);

    // Best-effort proof check: confirm the tx exists / succeeded. We still
    // sync reserves from chain even if the indexer never sees the fill.
    if (isEvm(net)) {
      const rpc = deps.rpcs[net] as {
        getTransactionReceipt?: (h: string) => Promise<{ status: string } | null>;
      };
      if (typeof rpc.getTransactionReceipt === 'function') {
        const receipt = await rpc.getTransactionReceipt(proof).catch(() => null);
        if (receipt && receipt.status === 'reverted') {
          return c.json({ error: 'tx_reverted', detail: 'transaction reverted on chain' }, 422);
        }
      }
    } else {
      const rpc = deps.rpcs.SOL as {
        getTransactionMessageBase64?: (s: string) => Promise<string | null>;
      };
      if (typeof rpc.getTransactionMessageBase64 === 'function') {
        const msg = await rpc.getTransactionMessageBase64(proof).catch(() => null);
        if (msg === null) {
          // Not yet confirmed — still attempt sync; client may retry.
        }
      }
    }

    const synced = await syncCurveReserves({
      db: deps.db,
      row: resolved as TokenRow,
      ...(isEvm(net)
        ? {
            evm: {
              eth: asEthCaller(deps.rpcs[net]),
              launchpad: evmLaunchpadAddress(deps.env, net),
            },
          }
        : {}),
      sol: {
        rpc: asSolanaAccountSource(deps.rpcs.SOL),
        programId: deps.env.solanaLaunchpadProgramId,
      },
    });

    return c.json({
      ok: true,
      net,
      sym,
      curveRealBase: synced.curveRealBase,
      curveRealToken: synced.curveRealToken,
      mc: synced.mc ?? resolved.mc,
    });
  });

  return app;
}
