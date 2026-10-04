import { Hono } from 'hono';
import { PublicKey, VersionedTransaction } from '@solana/web3.js';
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
import { gate } from '../admin/index.js';
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
import { assertUnderMaxBuyNative } from '../router/max-buy.js';
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
import { composeWithLookupTables } from '../router/solana-alt.js';
import { MIN_JITO_TIP_LAMPORTS, lamportsFromSol } from '../router/solana-fees.js';
import type { MevRoute } from '../router/solana-broadcast.js';
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
import { requireNetDeployed } from './health.js';
import { confirmTradeFills } from './trade-provisional.js';

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

  // Admin panel: per-net trading flag + per-wallet trade ban (`admin/moderation-gate.ts`).
  const tradeGate = gate({ feature: 'trading', ban: 'trade' });
  app.post('/trade/prepare', requireAuth(), tradeGate, limit(RATE_LIMITS.trade), async (c) => {
    const deps = c.get('deps');
    const user = c.get('user');
    if (!user) return c.json({ error: 'unauthorized' }, 401);
    const { net, wallet } = user;
    const gate = requireNetDeployed(c, deps.env, net);
    if (gate) return gate;

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

    // The net's live launchpad parameters: the router's per-buy cap and the
    // cashback window the fee is quoted with. Cached 60 s; defaults on a miss.
    const params = await deps.params.get(net);

    // A buy's `amount` *is* the native leg, so a capped net (Arc: real funds,
    // 25 USD) can refuse before touching the DB or an RPC. Sells are checked
    // again below once the curve has priced the native proceeds. The EVM
    // router also enforces `maxBuyNative` on `msg.value`; refusing here turns
    // a guaranteed revert into a readable 400.
    if (side === 'buy') {
      try {
        assertUnderMaxTradeUsd(
          net,
          amount,
          await deps.oracle.nativeUsd(nativeUnit(net)).catch(() => null),
        );
        if (isEvm(net)) assertUnderMaxBuyNative(net, params, toAtoms(amount, 18));
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

    // Whether the MEV setting can do anything on this deployment. A Jito tip
    // only buys protection when the signed transaction goes to the block
    // engine (`POST /trade/broadcast`), so with no `JITO_BLOCK_ENGINE_URL` the
    // tip is not written at all rather than paid for nothing; `RELAY` needs
    // no tip, only `SOLANA_PRIVATE_RPC_URL`. Jito also refuses tips under
    // 1000 lamports, so a positive tip is floored there.
    const mevRoute: MevRoute =
      net === 'SOL' && s.mev !== 'OFF' ? deps.solanaBroadcaster.routeFor(s.mev) : 'none';
    const tipSol =
      mevRoute === 'jito' && s.mevTip > 0
        ? Math.max(s.mevTip, MIN_JITO_TIP_LAMPORTS / 1e9)
        : mevRoute === 'jito'
          ? s.mevTip
          : 0;
    const tipOn = mevRoute === 'jito' && lamportsFromSol(tipSol) > 0;

    // Plan step 85: abort before signing if the composed cost exceeds the
    // user's cap. Only meaningful on a buy — a sell's "cost" is gas alone,
    // which `prio`/`mevTip` already represent, and native flows *in*, not out.
    if (side === 'buy') {
      // Solana priority + MEV tip are real native outflows. On RH they are
      // UI-only (ETH gas is separate) — do not fold them into the cap or the
      // pre-sign balance check.
      const prioCost = net === 'SOL' ? s.prio : 0;
      const mevCost = tipOn ? tipSol : 0;
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
        params,
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

        const composition = {
          side,
          programId,
          trader,
          mint,
          baseMint,
          curveAmountIn: trade.curveAmountInAtoms,
          curveMinOut: trade.curveMinOutAtoms,
          prioSol: s.prio,
          mevOn: tipOn,
          mevTipSol: tipSol,
          ...(jupiter ? { jupiter } : {}),
        } as const;
        // Jupiter routes compile to v0 against Jupiter's lookup tables plus
        // the operator's; the direct pair stays legacy.
        const composed = await composeWithLookupTables(
          (lookupTables) =>
            composeSolanaTradeTransaction(
              { ...composition, ...(lookupTables ? { lookupTables } : {}) },
              blockhash,
            ),
          {
            source: asSolanaAccountSource(deps.rpcs.SOL),
            ...(jupiter ? { jupiterAlts: jupiter.response.addressLookupTableAddresses ?? [] } : {}),
            stonkzAlts: deps.env.solanaLaunchAlts,
            onMissing: (address) =>
              deps.logger.warn('trade/prepare: address lookup table unavailable', { address }),
          },
        );

        return c.json({
          net,
          atomic: true,
          transaction: composed.base64,
          lastValidBlockHeight: composed.lastValidBlockHeight,
          quote: trade.quote,
          expiresAt: now + 30_000,
          // The settings as they were actually written into the bytes above,
          // so the ticket confirms real numbers, not the modal's intent.
          fees: {
            slipPct: s.slip,
            computeUnitLimit: composed.fees.computeUnitLimit,
            computeUnitPriceMicroLamports: composed.fees.computeUnitPriceMicroLamports,
            maxPriorityLamports: composed.fees.maxPriorityLamports,
            tipLamports: composed.fees.tipLamports,
            tipAccount: composed.fees.tipAccount,
            mevMode: s.mev,
            mevRoute,
          },
        });
      }

      // EVM chains (Robinhood, Base, Arc). `StonkzRouter` wraps the gas token
      // into its canonical wrapped form for the pair; on Arc that is wrapped
      // USDC, whose address is not pinned yet, so `weth` is null there and the
      // router-missing branch below refuses the prepare (nothing is deployed
      // on Arc either way).
      const isDirectPair = trade.aggregatorQuote === null;
      const weth = deps.baseMints.mintFor(net, 'WETH');
      // A native-ETH base is WETH on-chain (`StonkzLaunchpad` has no 0x0
      // base, and `buyWithEth`/`sellForEth` require `base == weth`). A row
      // that still carries the 0x0 native marker must route as WETH, not as
      // an ERC-20 at the zero address.
      const pairBaseMint =
        weth && synced.baseMint.toLowerCase() === ZERO_EVM_ADDRESS ? weth : synced.baseMint;
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
            pairBaseMint,
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
        const baseMint = pairBaseMint as Address;
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
   * `POST /trade/broadcast` — the MEV-protected send for a Solana trade.
   *
   * The web signs a prepared transaction *without* sending
   * (`solana:signTransaction`) when MEV mode is `SHIELD`/`RELAY` and posts the
   * signed bytes here; `router/solana-broadcast.ts` routes them to the Jito
   * block engine or the private RPC and falls back to the ordinary RPC,
   * reporting which one it was. Only the caller's own transaction is relayed:
   * the fee payer must be the authenticated wallet and the payer signature
   * must be present, so this is not an open relay.
   */
  app.post('/trade/broadcast', requireAuth(), limit(RATE_LIMITS.trade), async (c) => {
    const deps = c.get('deps');
    const user = c.get('user');
    if (!user) return c.json({ error: 'unauthorized' }, 401);
    if (user.net !== 'SOL') {
      return c.json({ error: 'bad_request', detail: 'broadcast is Solana-only' }, 400);
    }
    const solGate = requireNetDeployed(c, deps.env, user.net);
    if (solGate) return solGate;
    const body = (await c.req.json().catch(() => ({}))) as {
      transaction?: unknown;
      mev?: unknown;
    };
    const mevRaw = typeof body.mev === 'string' ? body.mev.toUpperCase() : '';
    if (mevRaw !== 'SHIELD' && mevRaw !== 'RELAY') {
      return c.json({ error: 'bad_request', detail: 'mev must be SHIELD or RELAY' }, 400);
    }
    const raw = typeof body.transaction === 'string' ? body.transaction : '';
    let tx: VersionedTransaction;
    try {
      const bytes = Buffer.from(raw, 'base64');
      if (bytes.length === 0 || bytes.length > 1232) throw new Error('size');
      tx = VersionedTransaction.deserialize(bytes);
    } catch {
      return c.json(
        { error: 'bad_transaction', detail: 'transaction must be a base64 signed transaction' },
        400,
      );
    }
    const payer = tx.message.staticAccountKeys[0]?.toBase58();
    const sig = tx.signatures[0];
    const signed = !!sig && sig.some((b) => b !== 0);
    if (payer !== user.wallet || !signed) {
      return c.json(
        { error: 'bad_transaction', detail: 'fee payer must be the signed-in wallet, and signed' },
        400,
      );
    }
    try {
      const out = await deps.solanaBroadcaster.send(raw, mevRaw);
      return c.json(out);
    } catch (err) {
      if (err instanceof RouterError) return c.json(err.toResponse(), err.httpStatus);
      throw err;
    }
  });

  /**
   * `POST /trade/confirm` — after the wallet confirms, the fast path.
   *
   * 1. Reads the transaction back at one confirmation (EVM receipt / Solana
   *    `confirmed`), decodes the launchpad's `Trade`s — emitters checked
   *    strictly — and, once per transaction, publishes them to
   *    `token:{sym}` + `tape` as **provisional** fills with the post-fill cap
   *    (`routes/trade-provisional.ts`). Other viewers see the trade within a
   *    block; the indexer's authoritative fill (same `fid`) supersedes it.
   * 2. Re-reads curve reserves from chain so the next sell quote does not
   *    depend on the indexer catching up.
   *
   * The response carries the decoded fills so the trader's own page swaps its
   * optimistic row for exact numbers without waiting for the socket.
   * `pending: true` means the API's node has not seen the transaction yet;
   * the client retries.
   */
  app.post('/trade/confirm', requireAuth(), limit(RATE_LIMITS.trade), async (c) => {
    const deps = c.get('deps');
    const user = c.get('user');
    if (!user) return c.json({ error: 'unauthorized' }, 401);
    const { net } = user;
    const gate = requireNetDeployed(c, deps.env, net);
    if (gate) return gate;
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
    // The proof goes straight to an RPC and gates a resync write; only a
    // transaction id shape gets that far.
    const proofOk = isEvm(net)
      ? /^0x[0-9a-fA-F]{64}$/.test(proof)
      : /^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(proof);
    if (!proofOk) {
      return c.json(
        { error: 'bad_proof', detail: 'signature|txHash is not a transaction id' },
        400,
      );
    }

    const mintBody =
      typeof (body as { mint?: unknown }).mint === 'string'
        ? (body as { mint: string }).mint.trim()
        : undefined;
    const resolved = await resolveTokenRow(deps.db, net, { mint: mintBody, sym });
    if (!resolved) return c.json({ error: 'not_found' }, 404);

    // Provisional fills are display-only; an RPC hiccup here must not cost
    // the trader the reserve resync below, so it degrades to "pending".
    const outcome = await confirmTradeFills(deps, net, proof).catch((err: unknown) => {
      deps.logger.warn('trade/confirm: provisional decode failed', {
        net,
        sym,
        err: err instanceof Error ? err.message : String(err),
      });
      return { kind: 'pending' as const };
    });
    if (outcome.kind === 'reverted') {
      return c.json({ error: 'tx_reverted', detail: 'transaction reverted on chain' }, 422);
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
      pending: outcome.kind === 'pending',
      fills: outcome.kind === 'ok' ? outcome.fills : [],
      provisional: outcome.kind === 'ok' && outcome.published,
      final: outcome.kind === 'ok' && outcome.final,
    });
  });

  return app;
}
