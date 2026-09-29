import type { Context } from 'hono';
import type { Address } from 'viem';
import { type EvmNet, type NativeUnit } from '@stonkz/shared';
import type { AppEnv } from '../app/context.js';
import { evmRouterAddress } from '../chain/evm-net.js';
import type { EvmTransactionReceipt } from '../chain/types.js';
import { launchIntents } from '../db/schema.js';
import { ZERO_EVM_ADDRESS } from '../env.js';
import {
  decodeTokenCreated,
  encodeCreateTokenCall,
  type DecodedTokenCreated,
} from '../router/evm-launch.js';
import {
  asEthCallSource,
  decodeAtomicBuy,
  hermesClientFor,
  isRouterLaunchPayload,
  planRouterLaunch,
  readRouterLaunchSupport,
  routerLaunchMatchesIntent,
  runEvmLaunchPreflight,
  toRpcQuantity,
  type CreateParams,
  type DecodedAtomicBuy,
} from '../router/evm-pyth.js';
import { asEvmCallSimulator, type PreflightRefusal } from '../router/launch-preflight.js';
import { toAtoms } from '../router/units.js';

/**
 * `/launch/prepare` and `/launch/confirm`, EVM half (Robinhood, Base). Kept
 * out of `routes/launch.ts` so the two chains' launch paths can change
 * independently; `launch.ts` does the shared validation, cooldown and intent
 * bookkeeping and hands over here.
 *
 * **Atomic path** (the router answers `pyth()`): one transaction to
 * `StonkzRouter` — `createAndBuyWithEth` for a WETH curve with a dev buy,
 * `createWithPriceUpdate` otherwise — carrying a Hermes price update, so the
 * creator's dev buy is the curve's first fill and the launch prices off a
 * seconds-old oracle read (`router/evm-pyth.ts`).
 *
 * **Legacy path** (no router configured, or the configured one predates
 * atomic launches): `launchpad.createToken` alone, as before; a dev buy is a
 * separate `/trade/prepare` once `/launch/confirm` has the token address.
 */

const EVM_TOKEN_DECIMALS = 18;

type IntentValues = Omit<typeof launchIntents.$inferInsert, 'predictedMint' | 'unsignedPayload'>;

export interface EvmLaunchPrepareInput {
  net: EvmNet;
  wallet: string;
  unit: NativeUnit;
  launchpad: Address;
  name: string;
  ticker: string;
  uri: string;
  supply: number;
  feeBps: number;
  cashback: boolean;
  baseSymbol: string;
  baseMintAddress: string;
  devBuyNative: number;
  devBuySlipPct: number;
  supplyAtoms: bigint;
  baseDecimals: number;
  basePrice1e6: bigint;
  intentValues: IntentValues;
  expiresAt: Date;
  now: number;
}

const NON_ATOMIC_DEV_BUY_NOTE =
  'This launch cannot carry the dev buy in the same transaction (the base is not WETH, or the router ' +
  'predates atomic launches). Call POST /trade/prepare with side=buy for the token /launch/confirm returns.';

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

export async function prepareEvmLaunch(
  c: Context<AppEnv>,
  a: EvmLaunchPrepareInput,
): Promise<Response> {
  const deps = c.get('deps');
  const rpc = deps.rpcs[a.net];
  const params: CreateParams = {
    name: a.name,
    ticker: a.ticker,
    uri: a.uri,
    supply: BigInt(Math.round(a.supply)),
    baseToken: a.baseMintAddress as Address,
    feeBps: a.feeBps,
    cashback: a.cashback,
  };
  const log = { net: a.net, wallet: a.wallet, ticker: a.ticker };
  const simulator = asEvmCallSimulator(rpc);

  const caller = asEthCallSource(rpc);
  const router = evmRouterAddress(deps.env, a.net);
  const support = caller
    ? await readRouterLaunchSupport(caller, router, a.now)
    : ({ supported: false } as const);

  if (caller && support.supported) {
    const weth = deps.baseMints.mintFor(a.net, 'WETH');
    const isWethBase = !!weth && weth.toLowerCase() === a.baseMintAddress.toLowerCase();
    const planned = await planRouterLaunch({
      net: a.net,
      caller,
      router: router as Address,
      pyth: support.pyth,
      hermes: hermesClientFor(deps.env, deps.logger),
      params,
      baseSymbol: a.baseSymbol,
      isWethBase,
      devBuyWei: a.devBuyNative > 0 ? toAtoms(a.devBuyNative, 18) : 0n,
      supplyAtoms: a.supplyAtoms,
      baseDecimals: a.baseDecimals,
      tokenDecimals: EVM_TOKEN_DECIMALS,
      fallbackPrice1e6: a.basePrice1e6,
      slipBps: BigInt(Math.round(a.devBuySlipPct * 100)),
      nowMs: a.now,
      logger: deps.logger,
    });
    if (!planned.ok)
      return c.json({ error: planned.error, detail: planned.detail }, planned.status);
    const plan = planned.plan;

    if (simulator) {
      const refusal = await runEvmLaunchPreflight({
        simulator,
        tx: { from: a.wallet, to: plan.to, data: plan.data, value: toRpcQuantity(plan.value) },
        unit: a.unit,
        logger: deps.logger,
        log: { ...log, fn: plan.fn, priceUpdate: plan.priceUpdate !== null },
      });
      if (refusal) return refuse(c, refusal);
    }

    const [intent] = await deps.db
      .insert(launchIntents)
      .values({ ...a.intentValues, predictedMint: null, unsignedPayload: plan.data })
      .returning({ id: launchIntents.id });

    return c.json({
      net: a.net,
      intentId: intent!.id,
      ticker: a.ticker,
      predictedMint: null,
      to: plan.to,
      data: plan.data,
      /** Decimal wei: the Pyth update fee plus any dev buy. */
      value: plan.value.toString(),
      devBuy:
        a.devBuyNative > 0
          ? plan.devBuy
            ? {
                native: a.devBuyNative,
                atomic: true,
                minTokenOut: plan.devBuy.minTokenOut.toString(),
              }
            : { native: a.devBuyNative, atomic: false, note: NON_ATOMIC_DEV_BUY_NOTE }
          : null,
      priceUpdate: plan.priceUpdate
        ? { publishTime: plan.priceUpdate.publishTime, fee: plan.updateFee.toString() }
        : null,
      expiresAt: a.expiresAt.getTime(),
    });
  }

  // Legacy: `launchpad.createToken`, the dev buy a second transaction.
  const to = a.launchpad;
  const data = encodeCreateTokenCall(params);
  if (simulator) {
    const refusal = await runEvmLaunchPreflight({
      simulator,
      tx: { from: a.wallet, to, data },
      unit: a.unit,
      logger: deps.logger,
      log,
    });
    if (refusal) return refuse(c, refusal);
  }

  const [intent] = await deps.db
    .insert(launchIntents)
    .values({ ...a.intentValues, predictedMint: null, unsignedPayload: data })
    .returning({ id: launchIntents.id });

  return c.json({
    net: a.net,
    intentId: intent!.id,
    ticker: a.ticker,
    predictedMint: null,
    to,
    data,
    value: '0x0',
    devBuy:
      a.devBuyNative > 0
        ? { native: a.devBuyNative, atomic: false, note: NON_ATOMIC_DEV_BUY_NOTE }
        : null,
    expiresAt: a.expiresAt.getTime(),
  });
}

/* ------------------------------------------------------------------ confirm */

export interface EvmConfirmedDevBuy {
  /** Wei the curve buy was funded with (`msg.value` net of the Pyth fee), decimal. */
  ethInWei: string;
  /** Token atoms delivered to the creator, decimal. */
  tokensOutAtoms: string;
  native: number;
  tokens: number;
}

export type EvmLaunchReceiptCheck =
  | { ok: true; created: DecodedTokenCreated; devBuy: EvmConfirmedDevBuy | null }
  | { ok: false; status: 409 | 422; error: string; detail: string };

/**
 * `/launch/confirm`'s EVM verification after status and sender are checked:
 *
 * - `to` the launchpad: the legacy `createToken` — calldata byte-for-byte
 *   the prepared payload.
 * - `to` the configured router: a router launch whose function and
 *   `CreateParams` match the intent (`routerLaunchMatchesIntent`; the price
 *   update, value and deadline may differ).
 *
 * Either way the launchpad's `TokenCreated` must name this wallet as creator.
 * A router launch's `AtomicBuy` (trader = wallet, token = the new coin) is the
 * dev buy that landed with it.
 */
export function verifyEvmLaunchReceipt(
  receipt: EvmTransactionReceipt,
  a: {
    wallet: string;
    launchpad: string;
    router: string;
    intent: {
      unsignedPayload: string;
      name: string;
      ticker: string;
      uri: string;
      supply: number;
      baseMint: string;
      feeBps: number;
      cashback: boolean;
    };
  },
): EvmLaunchReceiptCheck {
  const to = receipt.to?.toLowerCase() ?? '';
  const viaLaunchpad =
    to === a.launchpad.toLowerCase() &&
    receipt.input.toLowerCase() === a.intent.unsignedPayload.toLowerCase();
  const viaRouter =
    !viaLaunchpad &&
    to !== '' &&
    to !== ZERO_EVM_ADDRESS &&
    to === a.router.toLowerCase() &&
    isRouterLaunchPayload(a.intent.unsignedPayload) &&
    routerLaunchMatchesIntent(receipt.input, a.intent.unsignedPayload, a.intent);
  if (!viaLaunchpad && !viaRouter) {
    return {
      ok: false,
      status: 409,
      error: 'signature_mismatch',
      detail: 'the confirmed transaction does not match what was prepared',
    };
  }
  const created = decodeTokenCreated(receipt.logs, a.launchpad as Address);
  if (!created || created.creator.toLowerCase() !== a.wallet.toLowerCase()) {
    return {
      ok: false,
      status: 422,
      error: 'token_created_event_missing',
      detail: 'the transaction did not emit a TokenCreated event for this wallet',
    };
  }
  let devBuy: EvmConfirmedDevBuy | null = null;
  if (viaRouter) {
    const buy: DecodedAtomicBuy | null = decodeAtomicBuy(
      receipt.logs,
      a.router,
      a.wallet,
      created.token,
    );
    if (buy && buy.tokensOut > 0n) {
      devBuy = {
        ethInWei: buy.ethIn.toString(),
        tokensOutAtoms: buy.tokensOut.toString(),
        native: Number(buy.ethIn) / 1e18,
        tokens: Number(buy.tokensOut) / 10 ** EVM_TOKEN_DECIMALS,
      };
    }
  }
  return { ok: true, created, devBuy };
}
