import { Hono } from 'hono';
import { PublicKey, Transaction } from '@solana/web3.js';
import { NATIVE_MINT } from '@solana/spl-token';
import { getAddress, type Address } from 'viem';
import { isEvm, type EvmNet, type Net } from '@stonkz/shared';
import { limit, requireAuth } from '../app/middleware.js';
import type { AppDeps, AppEnv } from '../app/context.js';
import { RATE_LIMITS } from '../redis/ratelimit.js';
import { evmChainId } from '../chain/evm-net.js';
import {
  atomsToNative,
  type ReferralOnchainPosition,
  type ReferralPayoutMode,
} from '../game/referrals.js';
import { solClusterTag } from '../game/referral-signer.js';
import { asEvmTransactionSource } from '../router/evm-tx.js';
import {
  decodeReferralClaimedLogs as decodeEvmClaims,
  encodeReferralClaimAsEthCall,
  encodeReferralClaimCall,
} from '../router/evm-referral.js';
import {
  buildClaimReferralInstructions,
  decodeReferralClaimedLogs as decodeSolClaims,
  referralPdas,
} from '../router/solana-referral.js';
import { asSolanaBlockhashSource } from '../router/solana-tx.js';
import type { SolanaTransactionLogs } from '../chain/types.js';

const ZERO = '0x0000000000000000000000000000000000000000';
/** How long one wallet's prepare holds the per-wallet lock. */
const PREPARE_LOCK_SECONDS = 20;

/**
 * Where a net's self-serve referral claims settle, or `null` when the net
 * keeps the operator-batch request flow (no signer key, no vault deployed,
 * no asset pinned).
 */
export type ReferralClaimConfig =
  | {
      kind: 'sol';
      asset: string;
      symbol: string;
      decimals: number;
      vault: string;
      programId: PublicKey;
      clusterTag: Buffer;
    }
  | {
      kind: 'evm';
      net: EvmNet;
      asset: Address;
      symbol: string;
      decimals: number;
      vault: Address;
      chainId: number;
    };

export function referralClaimConfig(deps: AppDeps, net: Net): ReferralClaimConfig | null {
  const { env, referralSigner } = deps;
  if (net === 'SOL') {
    if (!referralSigner.solPublicKey || !env.solanaLaunchpadProgramId) return null;
    let programId: PublicKey;
    try {
      programId = new PublicKey(env.solanaLaunchpadProgramId);
    } catch {
      return null;
    }
    const vault = referralPdas(programId, NATIVE_MINT, programId).vault;
    return {
      kind: 'sol',
      asset: NATIVE_MINT.toBase58(),
      symbol: 'SOL',
      decimals: 9,
      vault: vault.toBase58(),
      programId,
      clusterTag: solClusterTag(env.solanaCluster),
    };
  }
  if (!isEvm(net)) return null;
  const vault = env.referralVaultAddress[net];
  const asset = env.referralAsset[net];
  if (!referralSigner.evmAddress || !vault || vault.toLowerCase() === ZERO || !asset) return null;
  return {
    kind: 'evm',
    net,
    asset: getAddress(asset.address),
    symbol: asset.symbol,
    decimals: asset.decimals,
    vault: getAddress(vault),
    chainId: evmChainId(env, net),
  };
}

function positionJson(cfg: ReferralClaimConfig, p: ReferralOnchainPosition) {
  return {
    asset: cfg.asset,
    symbol: cfg.symbol,
    decimals: cfg.decimals,
    vault: cfg.vault,
    claimableNative: atomsToNative(p.claimableAtoms, cfg.decimals),
    claimableAtoms: p.claimableAtoms.toString(),
    pendingNative: p.pendingNative,
    awaitingConfirmAtoms: p.awaitingConfirmAtoms.toString(),
    paidCumulativeAtoms: p.paidCumulativeAtoms.toString(),
    cumulativeAtoms: (p.signedCumulativeAtoms + p.pendingAtoms).toString(),
    outstandingIds: p.outstandingIds,
  };
}

/**
 * Referral code attach, earnings snapshot (per tier) and claims.
 *
 * `POST /referrals/claim { payout: 'stonkz' | 'native' }` is the original
 * claim: `stonkz` converts the pending commission to reward credits on the
 * spot; `native` books an operator-batch request (`cli/referral-payouts.ts`).
 *
 * The self-serve path (`docs/referral-payouts.md`) is three routes:
 *
 * - `GET /referrals/claimable` — per asset, what a fresh voucher would pay.
 * - `POST /referrals/claim/prepare` — drains pending into an immutable
 *   on-chain payout row, signs a voucher for the wallet's **cumulative**
 *   lifetime entitlement and returns the transaction to sign: `{to, data,
 *   value}` (plus `dataUnwrap` for `claimAsEth`) on the EVM nets, an unsigned
 *   transaction with the Ed25519 verification prepended on Solana. A
 *   per-wallet Redis lock keeps two prepares from interleaving.
 * - `POST /referrals/claim/confirm { signature }` — reads the receipt / logs,
 *   finds the vault's `ReferralClaimed` for this wallet and settles the open
 *   rows it covers (`method: 'onchain'`, `status: 'paid'`).
 *
 * A net with no signer key / vault / asset configured answers `claimable`
 * with `configured: false` and refuses prepare, so the web keeps the request
 * button there.
 */
export function referralRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get('/referrals', requireAuth(), limit(RATE_LIMITS.read), async (c) => {
    const deps = c.get('deps');
    const user = c.get('user');
    if (!user) return c.json({ error: 'unauthorized' }, 401);
    const snap = await deps.referrals.snapshot(user.net, user.wallet);
    return c.json({
      net: user.net,
      wallet: user.wallet,
      ...snap,
      onchainClaims: referralClaimConfig(deps, user.net) !== null,
    });
  });

  app.post('/referrals/attach', requireAuth(), limit(RATE_LIMITS.social), async (c) => {
    const deps = c.get('deps');
    const user = c.get('user');
    if (!user) return c.json({ error: 'unauthorized' }, 401);
    const body = (await c.req.json().catch(() => ({}))) as { code?: string };
    const code = String(body.code ?? '').trim();
    if (!code) return c.json({ error: 'invalid_code' }, 400);

    const result = await deps.referrals.attach(user.net, user.wallet, code);
    if (!result.ok) {
      const status =
        result.error === 'unknown_code' || result.error === 'invalid_code'
          ? 404
          : result.error === 'already_referred'
            ? 409
            : 400;
      return c.json({ error: result.error }, status);
    }
    return c.json({ ok: true, referrer: result.referrer });
  });

  /** Claim pending referral commission — as `$STONKZ` credits, or as a native payout request. */
  app.post('/referrals/claim', requireAuth(), limit(RATE_LIMITS.social), async (c) => {
    const deps = c.get('deps');
    const user = c.get('user');
    if (!user) return c.json({ error: 'unauthorized' }, 401);
    const body = (await c.req.json().catch(() => ({}))) as { payout?: unknown };
    if (body.payout !== undefined && body.payout !== 'native' && body.payout !== 'stonkz') {
      return c.json({ error: 'bad_request', detail: "payout must be 'stonkz' or 'native'" }, 400);
    }
    const payout: ReferralPayoutMode = body.payout === 'native' ? 'native' : 'stonkz';
    const result = await deps.referrals.claimFees(user.net, user.wallet, payout);
    return c.json({
      ok: true,
      mode: result.mode,
      claimedNative: result.claimedNative,
      stonkz: result.stonkz,
      stonkzTotal: result.stonkzTotal,
      payoutId: result.payoutId,
      tiers: result.tiers,
    });
  });

  /* ------------------------------------------------------ on-chain claims */

  app.get('/referrals/claimable', requireAuth(), limit(RATE_LIMITS.read), async (c) => {
    const deps = c.get('deps');
    const user = c.get('user');
    if (!user) return c.json({ error: 'unauthorized' }, 401);
    const cfg = referralClaimConfig(deps, user.net);
    if (!cfg) {
      return c.json({ net: user.net, wallet: user.wallet, configured: false, assets: [] });
    }
    const p = await deps.referrals.onchainPosition(user.net, user.wallet, cfg.asset, cfg.decimals);
    return c.json({
      net: user.net,
      wallet: user.wallet,
      configured: true,
      assets: [positionJson(cfg, p)],
    });
  });

  app.post('/referrals/claim/prepare', requireAuth(), limit(RATE_LIMITS.social), async (c) => {
    const deps = c.get('deps');
    const user = c.get('user');
    if (!user) return c.json({ error: 'unauthorized' }, 401);
    const { net, wallet } = user;
    const cfg = referralClaimConfig(deps, net);
    if (!cfg) return c.json({ error: 'not_configured' }, 409);
    const body = (await c.req.json().catch(() => ({}))) as { asset?: unknown };
    if (typeof body.asset === 'string' && body.asset.toLowerCase() !== cfg.asset.toLowerCase()) {
      return c.json({ error: 'bad_request', detail: 'unknown asset' }, 400);
    }

    const lockKey = `refclaim:${net}:${wallet}`;
    const locked = await deps.redis.set(lockKey, '1', {
      ttlSeconds: PREPARE_LOCK_SECONDS,
      ifNotExists: true,
    });
    if (!locked) return c.json({ error: 'claim_in_progress' }, 409);
    try {
      const p = await deps.referrals.prepareOnchainClaim(net, wallet, cfg.asset, cfg.decimals);
      if (p.claimableAtoms <= 0n || p.outstandingIds.length === 0) {
        return c.json({ error: 'nothing_to_claim' }, 422);
      }
      const cumulative = p.signedCumulativeAtoms;
      const deadline = Math.floor(deps.now() / 1000) + deps.env.referralClaimDeadlineSeconds;
      const newest = p.outstandingIds[p.outstandingIds.length - 1]!;
      const common = {
        net,
        asset: cfg.asset,
        symbol: cfg.symbol,
        decimals: cfg.decimals,
        vault: cfg.vault,
        cumulativeAtoms: cumulative.toString(),
        amountAtoms: p.claimableAtoms.toString(),
        amountNative: atomsToNative(p.claimableAtoms, cfg.decimals),
        deadline,
        payoutId: newest,
      };

      if (cfg.kind === 'sol') {
        const blockhashSource = asSolanaBlockhashSource(deps.rpcs.SOL);
        if (!blockhashSource) {
          throw new Error(
            'referrals/claim/prepare: Solana RPC does not implement latestBlockhash()',
          );
        }
        const recipient = new PublicKey(wallet);
        const { message, signature } = deps.referralSigner.signSol({
          clusterTag: cfg.clusterTag,
          vault: new PublicKey(cfg.vault),
          recipient,
          baseMint: NATIVE_MINT,
          cumulativeAmount: cumulative,
          deadline: BigInt(deadline),
        });
        const blockhash = await blockhashSource.latestBlockhash();
        const tx = new Transaction({
          feePayer: recipient,
          blockhash: blockhash.blockhash,
          lastValidBlockHeight: blockhash.lastValidBlockHeight,
        });
        for (const ix of buildClaimReferralInstructions({
          programId: cfg.programId,
          baseMint: NATIVE_MINT,
          recipient,
          cumulativeAmount: cumulative,
          deadline: BigInt(deadline),
          signer: deps.referralSigner.solPublicKey!,
          message,
          signature,
        })) {
          tx.add(ix);
        }
        await deps.referrals.recordVoucher(newest, {
          deadline,
          signature: signature.toString('base64'),
          vault: cfg.vault,
          // jsonb refuses NUL bytes: keep the word, not the 8-byte padding.
          clusterTag: cfg.clusterTag.toString('utf8').replace(/\0+$/, ''),
          issuedAt: deps.now(),
        });
        return c.json({
          ...common,
          signature: signature.toString('base64'),
          transaction: tx
            .serialize({ requireAllSignatures: false, verifySignatures: false })
            .toString('base64'),
          lastValidBlockHeight: blockhash.lastValidBlockHeight,
        });
      }

      const recipient = getAddress(wallet);
      const signature = await deps.referralSigner.signEvm({
        chainId: cfg.chainId,
        vault: cfg.vault,
        recipient,
        asset: cfg.asset,
        cumulativeAmount: cumulative,
        deadline: BigInt(deadline),
      });
      await deps.referrals.recordVoucher(newest, {
        deadline,
        signature,
        vault: cfg.vault,
        chainId: cfg.chainId,
        issuedAt: deps.now(),
      });
      const args = {
        recipient,
        asset: cfg.asset,
        cumulativeAmount: cumulative,
        deadline: BigInt(deadline),
        signature,
      };
      return c.json({
        ...common,
        chainId: cfg.chainId,
        signature,
        to: cfg.vault,
        data: encodeReferralClaimCall(args),
        /** `claimAsEth`: the same voucher paid out as ETH. Only the recipient may send it. */
        dataUnwrap: encodeReferralClaimAsEthCall(args),
        value: '0',
      });
    } finally {
      await deps.redis.del(lockKey);
    }
  });

  app.post('/referrals/claim/confirm', requireAuth(), limit(RATE_LIMITS.social), async (c) => {
    const deps = c.get('deps');
    const user = c.get('user');
    if (!user) return c.json({ error: 'unauthorized' }, 401);
    const { net, wallet } = user;
    const cfg = referralClaimConfig(deps, net);
    if (!cfg) return c.json({ error: 'not_configured' }, 409);
    const body = (await c.req.json().catch(() => ({}))) as { signature?: unknown };
    const sig = typeof body.signature === 'string' ? body.signature.trim() : '';
    if (!sig) return c.json({ error: 'bad_request', detail: 'signature is required' }, 400);

    let paid: { amount: bigint; cumulative: bigint } | null = null;
    if (cfg.kind === 'sol') {
      const rpc = deps.rpcs.SOL as Partial<{
        getTransactionLogs(s: string): Promise<SolanaTransactionLogs | null>;
      }>;
      if (typeof rpc.getTransactionLogs !== 'function') {
        throw new Error(
          'referrals/claim/confirm: Solana RPC does not implement getTransactionLogs()',
        );
      }
      const logs = await rpc.getTransactionLogs(sig);
      if (!logs) return c.json({ error: 'not_confirmed' }, 404);
      if (logs.failed) return c.json({ error: 'tx_failed' }, 422);
      const events = decodeSolClaims(logs.logMessages, cfg.programId.toBase58());
      const mine = events.filter(
        (e) => e.recipient === wallet && e.baseMint === cfg.asset && e.vault === cfg.vault,
      );
      if (mine.length > 0) {
        paid = {
          amount: mine.reduce((s, e) => s + e.amount, 0n),
          cumulative: mine.reduce((m, e) => (e.cumulativeAmount > m ? e.cumulativeAmount : m), 0n),
        };
      }
    } else {
      const txSource = asEvmTransactionSource(deps.rpcs[cfg.net]);
      if (!txSource) {
        throw new Error(
          'referrals/claim/confirm: EVM RPC does not implement getTransactionReceipt()',
        );
      }
      const receipt = await txSource.getTransactionReceipt(sig);
      if (!receipt) return c.json({ error: 'not_confirmed' }, 404);
      if (receipt.status !== 'success') return c.json({ error: 'tx_failed' }, 422);
      const events = decodeEvmClaims(receipt.logs, cfg.vault).filter(
        (e) =>
          e.recipient.toLowerCase() === wallet.toLowerCase() &&
          e.asset.toLowerCase() === cfg.asset.toLowerCase(),
      );
      if (events.length > 0) {
        paid = {
          amount: events.reduce((s, e) => s + e.amount, 0n),
          cumulative: events.reduce(
            (m, e) => (e.cumulativeAmount > m ? e.cumulativeAmount : m),
            0n,
          ),
        };
      }
    }
    if (!paid) return c.json({ error: 'no_claim_in_tx' }, 422);

    const settled = await deps.referrals.confirmOnchainClaim(
      net,
      wallet,
      cfg.asset,
      sig,
      paid.cumulative,
    );
    return c.json({
      ok: true,
      net,
      asset: cfg.asset,
      paidAtoms: paid.amount.toString(),
      paidNative: atomsToNative(paid.amount, cfg.decimals),
      cumulativeAtoms: paid.cumulative.toString(),
      settled,
    });
  });

  return app;
}
