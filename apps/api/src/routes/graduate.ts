import { Hono } from 'hono';
import { PublicKey, Transaction } from '@solana/web3.js';
import { encodeFunctionData, type Address, type Hex } from 'viem';
import { isEvm, type EvmNet } from '@stonkz/shared';
import { requireAuth, limit } from '../app/middleware.js';
import { RATE_LIMITS } from '../redis/ratelimit.js';
import type { AppEnv } from '../app/context.js';
import { evmLaunchpadAddress, evmRouterAddress } from '../chain/evm-net.js';
import { LAUNCHPAD_ABI, STONKZ_ROUTER_ABI } from '../router/evm-abi.js';
import {
  asEthCallSource,
  hermesClientFor,
  hermesUpdateFor,
  pythFeedsForBase,
  readPythUpdateFee,
  readRouterLaunchSupport,
} from '../router/evm-pyth.js';
import {
  syncCurveReserves,
  type EthCaller,
  type SolanaAccountSource,
} from '../router/curve-sync.js';
import {
  buildGraduateInstruction,
  buildSyncPriceFromPythInstruction,
} from '../router/solana-instructions.js';
import {
  decodePythPriceUpdateV2,
  pinnedPythFeedId,
  pythPriceFeedAccount,
} from '../router/solana-idl.js';
import { asSolanaAccountDataSource } from '../router/launch-preflight.js';
import { asSolanaBlockhashSource } from '../router/solana-tx.js';
import { resolveTokenRow } from './token-resolve.js';
import { serialiseToken, type TokenRow } from './serialise.js';

/** The same duck-typed adapters `routes/trade.ts` keeps private. */
function asEthCaller(rpc: unknown): EthCaller | undefined {
  const candidate = rpc as Partial<EthCaller>;
  return typeof candidate.ethCall === 'function' ? (candidate as EthCaller) : undefined;
}

function asSolanaAccountSource(rpc: unknown): SolanaAccountSource | undefined {
  const candidate = rpc as Partial<SolanaAccountSource>;
  return typeof candidate.getAccountDataBase64 === 'function'
    ? (candidate as SolanaAccountSource)
    : undefined;
}

/**
 * `POST /tokens/:sym/graduate/prepare` — the "GRADUATE NOW" button.
 *
 * Graduation is permissionless on both programs, but nothing used to call it:
 * the curve can sit at the $69K line, or fully sold out, until an operator
 * runs a script. This prepares the call for whoever is looking at the token,
 * the same single-signature shape as `/fees/claim/prepare`:
 *
 * - **EVM, curve exhausted** (`realToken == 0`): `StonkzLaunchpad.graduate`
 *   directly. Consults no oracle, so it cannot be stale.
 * - **EVM, oracle trigger** (cap ≥ $69K with tokens left): the launchpad reads
 *   `PythPriceSource` with a ~120 s per-feed bound, so the transaction must
 *   carry a Hermes update. `StonkzRouter.graduateWithPriceUpdate` does both;
 *   the update fee is `value`. A router deployed before that function exists
 *   is reported as `router_upgrade_required` rather than handed to a wallet
 *   that would only fail to simulate.
 * - **Solana**: `graduate` with the `BaseOracle`, preceded by
 *   `sync_price_from_pyth` when a feed is pinned (as `/launch/prepare` does),
 *   so the oracle trigger reads a price seconds old. An exhausted curve gets
 *   the plain call without the oracle account.
 *
 * Refuses with `not_graduable` when neither trigger is met per the synced
 * curve, and `already_graduated` once the flag is set. The chain remains the
 * judge: the launchpad reverts "not graduable" / "stale oracle" if it disagrees.
 */
export function graduateRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.post('/tokens/:sym/graduate/prepare', requireAuth(), limit(RATE_LIMITS.fees), async (c) => {
    const deps = c.get('deps');
    const user = c.get('user');
    if (!user) return c.json({ error: 'unauthorized' }, 401);
    const { net, wallet } = user;

    const sym = c.req.param('sym').toUpperCase();
    const body = (await c.req.json().catch(() => ({}))) as { mint?: unknown };
    const mintBody = typeof body.mint === 'string' ? body.mint.trim() : undefined;

    const row = await resolveTokenRow(deps.db, net, { mint: mintBody, sym });
    if (!row || !row.mint) return c.json({ error: 'not_found' }, 404);
    if (row.graduatedAt !== null) return c.json({ error: 'already_graduated' }, 409);

    // Live reserves, so the decision is the chain's, not the last write-back's.
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
    const curveParams = await deps.params.get(net);
    const view = serialiseToken(synced as TokenRow, deps.now(), undefined, curveParams);
    if (view.graduatedAt !== null) return c.json({ error: 'already_graduated' }, 409);
    if (!view.graduationReady) {
      return c.json(
        {
          error: 'not_graduable',
          detail: `the curve is neither sold out nor at $${curveParams.gradUsd.toLocaleString('en-US')} market cap`,
          mc: view.mc,
          curveComplete: view.curveComplete,
        },
        422,
      );
    }
    const trigger = view.curveComplete ? 'exhausted' : 'oracle';

    if (net === 'SOL') {
      const blockhashSource = asSolanaBlockhashSource(deps.rpcs.SOL);
      if (!blockhashSource)
        throw new Error('graduate/prepare: Solana RPC does not implement latestBlockhash()');
      const blockhash = await blockhashSource.latestBlockhash();
      const programId = new PublicKey(deps.env.solanaLaunchpadProgramId);
      const mint = new PublicKey(row.mint);
      const baseMint = new PublicKey(row.baseMint);
      const caller = new PublicKey(wallet);

      const tx = new Transaction({
        feePayer: caller,
        blockhash: blockhash.blockhash,
        lastValidBlockHeight: blockhash.lastValidBlockHeight,
      });
      let pythSync = false;
      if (trigger === 'oracle') {
        // Bundle the Pyth sync only when the sponsored feed account holds a
        // verified update for the pinned feed — a missing account would
        // make the sync revert a graduation the stored price might carry.
        const feed = pinnedPythFeedId(baseMint);
        const accounts = asSolanaAccountDataSource(deps.rpcs.SOL);
        if (feed && accounts) {
          const feedAccount = pythPriceFeedAccount(feed);
          try {
            const b64 = await accounts.getAccountDataBase64(feedAccount.toBase58());
            const update = b64 ? decodePythPriceUpdateV2(Buffer.from(b64, 'base64')) : null;
            if (update && update.fullyVerified && update.feedId.equals(feed)) {
              tx.add(
                buildSyncPriceFromPythInstruction({
                  programId,
                  baseMint,
                  priceUpdate: feedAccount,
                  payer: caller,
                }),
              );
              pythSync = true;
            }
          } catch (err) {
            deps.logger.warn('graduate/prepare: Pyth feed read failed; no price sync', {
              sym,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }
      tx.add(
        buildGraduateInstruction({
          programId,
          mint,
          baseMint,
          caller,
          withOracle: trigger === 'oracle',
        }),
      );
      return c.json({
        net,
        sym,
        mint: row.mint,
        trigger,
        pythSync,
        transaction: tx
          .serialize({ requireAllSignatures: false, verifySignatures: false })
          .toString('base64'),
        lastValidBlockHeight: blockhash.lastValidBlockHeight,
      });
    }

    if (!isEvm(net)) return c.json({ error: 'bad_request', detail: 'unsupported net' }, 400);
    const evmNet = net as EvmNet;
    const token = row.mint as Address;

    if (trigger === 'exhausted') {
      return c.json({
        net,
        sym,
        mint: row.mint,
        trigger,
        to: evmLaunchpadAddress(deps.env, evmNet),
        data: encodeFunctionData({ abi: LAUNCHPAD_ABI, functionName: 'graduate', args: [token] }),
        value: '0',
        priceUpdate: null,
      });
    }

    // Oracle trigger: post a fresh price in the same transaction.
    const router = evmRouterAddress(deps.env, evmNet);
    const caller = asEthCallSource(deps.rpcs[evmNet]);
    if (!caller) throw new Error('graduate/prepare: EVM RPC does not implement ethCall()');
    const support = await readRouterLaunchSupport(caller, router, deps.now());
    if (!support.supported) {
      return c.json(
        {
          error: 'router_upgrade_required',
          detail:
            'the oracle-triggered graduation needs StonkzRouter.graduateWithPriceUpdate; the configured router predates it',
        },
        503,
      );
    }

    let updateData: Hex[] = [];
    let fee = 0n;
    let publishTime: number | null = null;
    const feeds = pythFeedsForBase(evmNet, row.baseSymbol);
    if (support.pyth && feeds.length > 0) {
      const hermes = hermesClientFor(deps.env, deps.logger);
      const update = hermes ? await hermesUpdateFor(hermes, feeds) : null;
      if (!update) {
        return c.json(
          { error: 'price_unavailable', detail: 'Hermes returned no update for the base feed' },
          503,
        );
      }
      updateData = update.updateData;
      publishTime = update.prices[0]?.publishTime ?? null;
      fee = await readPythUpdateFee(caller, support.pyth, updateData);
    }
    const deadline = BigInt(Math.floor(deps.now() / 1000) + 300);
    return c.json({
      net,
      sym,
      mint: row.mint,
      trigger,
      to: router,
      data: encodeFunctionData({
        abi: STONKZ_ROUTER_ABI,
        functionName: 'graduateWithPriceUpdate',
        args: [token, updateData, deadline],
      }),
      /** Decimal wei: the Pyth update fee (refunded above it). */
      value: fee.toString(),
      priceUpdate: publishTime === null ? null : { publishTime, fee: fee.toString() },
    });
  });

  return app;
}
