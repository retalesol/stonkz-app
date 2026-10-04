import { Hono } from 'hono';
import { PublicKey, Transaction } from '@solana/web3.js';
import type { Address } from 'viem';
import { encodeFunctionData } from 'viem';
import { LOCKS, isEvm, type EvmNet } from '@stonkz/shared';
import { requireAuth, limit } from '../app/middleware.js';
import { RATE_LIMITS } from '../redis/ratelimit.js';
import type { AppEnv } from '../app/context.js';
import {
  buildClaimStakeInstruction,
  buildStakeInstruction,
  buildUnstakeInstruction,
} from '../router/solana-instructions.js';
import { asSolanaBlockhashSource } from '../router/solana-tx.js';
import { encodeClaimStakeCall, encodeStakeCall, encodeUnstakeCall } from '../router/evm-launch.js';
import { ERC20_ABI } from '../router/evm-abi.js';
import { toAtoms } from '../router/units.js';
import { ZERO_EVM_ADDRESS } from '../env.js';
import { evmLaunchpadAddress } from '../chain/evm-net.js';
import { resolveTokenRow } from './token-resolve.js';
import { requireNetDeployed } from './health.js';
import {
  emptyPosition,
  invalidateStakePool,
  positionFromChain,
  positionFromDb,
} from './stake-data.js';

/**
 * Per-memecoin staking prepare endpoints.
 *
 * Builds the same unsigned payloads as `/trade/prepare` and
 * `/fees/claim/prepare`. Settlement requires a deployed launchpad (§3 of
 * `docs/real-vs-simulated.md`) — until then, wallets will reject or the
 * chain will fail the broadcast, which is the honest failure mode.
 *
 * - `POST /stake/prepare` — `{ sym, mint?, amount, days }`
 * - `POST /stake/unstake/prepare` — `{ sym, mint?, amount }`
 * - `POST /stake/claim/prepare` — `{ sym, mint? }`
 * - `GET /stake/:sym` — own position from the indexer table (empty until
 *   chain events land); optional `?mint=`
 * - `GET /stake/:sym/chain` — own position read on chain, for right after a
 *   stake / unstake / claim confirms; optional `?mint=`
 *
 * Unstake and claim prepares also pre-check the position on chain when the
 * RPC can answer, so a still-locked unstake or an empty claim is a readable
 * 422 instead of a wallet prompt that can only revert.
 */

const ZERO = ZERO_EVM_ADDRESS.toLowerCase();

function lockDaysOk(days: number): boolean {
  return LOCKS.some((l) => l[0] === days);
}

export function stakeRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  /**
   * Own position from the indexer's table — cheap, and what every background
   * refresh uses. Trails the chain by the indexer's confirmation depth, and
   * never carries pending rewards (see `stake-data.ts`).
   */
  app.get('/stake/:sym', requireAuth(), limit(RATE_LIMITS.read), async (c) => {
    const deps = c.get('deps');
    const user = c.get('user');
    if (!user) return c.json({ error: 'unauthorized' }, 401);
    const sym = c.req.param('sym').toUpperCase();
    const mintQ = c.req.query('mint')?.trim();
    const token = await resolveTokenRow(deps.db, user.net, { mint: mintQ, sym });
    if (!token?.mint) return c.json(emptyPosition(user.net, sym, null));
    return c.json(await positionFromDb(deps, user.net, token, user.wallet));
  });

  /**
   * Own position read straight off the chain (`positionInfo` +
   * `pendingStakeRewards` on EVM, the `StakePosition` account on Solana) —
   * what the stake dialog asks for when it opens and right after the wallet's
   * own stake / unstake / claim confirms. Authenticated (it only ever reads
   * the caller's wallet) and on its own, tighter limit because each call
   * costs RPC reads. Falls back to the indexer row when the chain read fails.
   */
  app.get('/stake/:sym/chain', requireAuth(), limit(RATE_LIMITS.stakeChain), async (c) => {
    const deps = c.get('deps');
    const user = c.get('user');
    if (!user) return c.json({ error: 'unauthorized' }, 401);
    const sym = c.req.param('sym').toUpperCase();
    const mintQ = c.req.query('mint')?.trim();
    const token = await resolveTokenRow(deps.db, user.net, { mint: mintQ, sym });
    if (!token?.mint) return c.json(emptyPosition(user.net, sym, null));
    const chain = await positionFromChain(deps, user.net, token, user.wallet);
    if (chain) {
      // The caller just changed the pool; the next summary should not be a cached one.
      invalidateStakePool(deps, user.net, token.mint);
      return c.json(chain);
    }
    return c.json(await positionFromDb(deps, user.net, token, user.wallet));
  });

  app.post('/stake/prepare', requireAuth(), limit(RATE_LIMITS.stake), async (c) => {
    const deps = c.get('deps');
    const user = c.get('user');
    if (!user) return c.json({ error: 'unauthorized' }, 401);
    const { net, wallet } = user;
    const gate = requireNetDeployed(c, deps.env, net);
    if (gate) return gate;

    const body = (await c.req.json().catch(() => ({}))) as {
      sym?: unknown;
      mint?: unknown;
      amount?: unknown;
      days?: unknown;
    };
    const sym = typeof body.sym === 'string' ? body.sym.toUpperCase() : '';
    const mintBody = typeof body.mint === 'string' ? body.mint.trim() : undefined;
    const amount = typeof body.amount === 'number' ? body.amount : Number(body.amount);
    const days = typeof body.days === 'number' ? body.days : Number(body.days ?? 0);
    if (!sym) return c.json({ error: 'bad_request', detail: 'sym is required' }, 400);
    if (!Number.isFinite(amount) || amount <= 0) {
      return c.json({ error: 'bad_request', detail: 'amount must be a positive number' }, 400);
    }
    if (!lockDaysOk(days)) {
      return c.json({ error: 'bad_request', detail: 'invalid lock term' }, 400);
    }

    const row = await resolveTokenRow(deps.db, net, { mint: mintBody, sym });
    if (!row || !row.mint) return c.json({ error: 'not_found' }, 404);

    if (net === 'SOL') {
      const blockhashSource = asSolanaBlockhashSource(deps.rpcs.SOL);
      if (!blockhashSource)
        throw new Error('stake/prepare: Solana RPC does not implement latestBlockhash()');
      const blockhash = await blockhashSource.latestBlockhash();
      const programId = new PublicKey(deps.env.solanaLaunchpadProgramId);
      const mint = new PublicKey(row.mint);
      const owner = new PublicKey(wallet);
      const atoms = toAtoms(amount, row.tokenDecimals);
      const ix = buildStakeInstruction({ programId, mint, owner }, atoms, days);
      const tx = new Transaction({
        feePayer: owner,
        blockhash: blockhash.blockhash,
        lastValidBlockHeight: blockhash.lastValidBlockHeight,
      }).add(ix);
      return c.json({
        net,
        sym,
        action: 'stake',
        amount,
        days,
        transaction: tx
          .serialize({ requireAllSignatures: false, verifySignatures: false })
          .toString('base64'),
        lastValidBlockHeight: blockhash.lastValidBlockHeight,
      });
    }

    if (!isEvm(net)) {
      return c.json({ error: 'bad_request', detail: 'unsupported net' }, 400);
    }

    const launchpad = evmLaunchpadAddress(deps.env, net as EvmNet);
    if (launchpad.toLowerCase() === ZERO) {
      return c.json(
        {
          error: 'programs_not_deployed',
          detail: `${net} launchpad address is unset — staking awaits contract deployment`,
        },
        503,
      );
    }

    const atoms = toAtoms(amount, row.tokenDecimals);
    const token = row.mint as Address;
    const approveData = encodeFunctionData({
      abi: ERC20_ABI,
      functionName: 'approve',
      args: [launchpad as Address, atoms],
    });
    const stakeData = encodeStakeCall(token, atoms, days);
    // Launchpad uses transferFrom — the wallet must approve first. Two txs
    // (approve → stake); same pattern as non-atomic trade sells.
    return c.json({
      net,
      sym,
      action: 'stake',
      amount,
      days,
      atomic: false,
      steps: [
        {
          to: token,
          data: approveData,
          value: '0',
          label: `Approve ${sym} for staking`,
        },
        {
          to: launchpad as Address,
          data: stakeData,
          value: '0',
          label: `Stake ${sym}`,
        },
      ],
      // Keep legacy single-call fields pointing at the stake itself so older
      // clients that ignore `steps` still build the right final call — they
      // will fail on allowance until they learn the two-step shape.
      to: launchpad as Address,
      data: stakeData,
      value: '0',
      warning: 'EVM stake needs an ERC-20 approve before stake (two signatures).',
    });
  });

  app.post('/stake/unstake/prepare', requireAuth(), limit(RATE_LIMITS.stake), async (c) => {
    const deps = c.get('deps');
    const user = c.get('user');
    if (!user) return c.json({ error: 'unauthorized' }, 401);
    const { net, wallet } = user;
    const gate = requireNetDeployed(c, deps.env, net);
    if (gate) return gate;

    const body = (await c.req.json().catch(() => ({}))) as {
      sym?: unknown;
      mint?: unknown;
      amount?: unknown;
    };
    const sym = typeof body.sym === 'string' ? body.sym.toUpperCase() : '';
    const mintBody = typeof body.mint === 'string' ? body.mint.trim() : undefined;
    const amount = typeof body.amount === 'number' ? body.amount : Number(body.amount);
    if (!sym) return c.json({ error: 'bad_request', detail: 'sym is required' }, 400);
    if (!Number.isFinite(amount) || amount <= 0) {
      return c.json({ error: 'bad_request', detail: 'amount must be a positive number' }, 400);
    }

    const row = await resolveTokenRow(deps.db, net, { mint: mintBody, sym });
    if (!row || !row.mint) return c.json({ error: 'not_found' }, 404);

    // Both programs refuse an unstake while the lock runs or past the
    // position; say so here rather than hand the wallet a call that reverts.
    let atoms = toAtoms(amount, row.tokenDecimals);
    const onChain = await positionFromChain(deps, net, row, wallet);
    if (onChain?.source === 'chain') {
      if (onChain.amt <= 0) {
        return c.json({ error: 'nothing_staked', detail: `no ${sym} staked` }, 422);
      }
      if (onChain.until > deps.now()) {
        return c.json(
          {
            error: 'still_locked',
            detail: `${sym} stake is locked until ${new Date(onChain.until).toISOString()}`,
            until: onChain.until,
          },
          422,
        );
      }
      const staked = BigInt(onChain.amtAtoms ?? '0');
      // "Unstake all" arrives as a float; within rounding it means the whole
      // position, to the atom — otherwise dust is stranded or the call reverts.
      if (Math.abs(amount - onChain.amt) <= onChain.amt * 1e-9) atoms = staked;
      else if (atoms > staked) {
        return c.json(
          { error: 'insufficient_stake', detail: `only ${onChain.amt} ${sym} staked` },
          422,
        );
      }
    }

    if (net === 'SOL') {
      const blockhashSource = asSolanaBlockhashSource(deps.rpcs.SOL);
      if (!blockhashSource)
        throw new Error('stake/unstake/prepare: Solana RPC missing latestBlockhash()');
      const blockhash = await blockhashSource.latestBlockhash();
      const programId = new PublicKey(deps.env.solanaLaunchpadProgramId);
      const mint = new PublicKey(row.mint);
      const owner = new PublicKey(wallet);
      const ix = buildUnstakeInstruction({ programId, mint, owner }, atoms);
      const tx = new Transaction({
        feePayer: owner,
        blockhash: blockhash.blockhash,
        lastValidBlockHeight: blockhash.lastValidBlockHeight,
      }).add(ix);
      return c.json({
        net,
        sym,
        action: 'unstake',
        amount,
        transaction: tx
          .serialize({ requireAllSignatures: false, verifySignatures: false })
          .toString('base64'),
        lastValidBlockHeight: blockhash.lastValidBlockHeight,
      });
    }

    if (!isEvm(net)) {
      return c.json({ error: 'bad_request', detail: 'unsupported net' }, 400);
    }

    const launchpad = evmLaunchpadAddress(deps.env, net as EvmNet);
    if (launchpad.toLowerCase() === ZERO) {
      return c.json(
        {
          error: 'programs_not_deployed',
          detail: `${net} launchpad address is unset — staking awaits contract deployment`,
        },
        503,
      );
    }

    return c.json({
      net,
      sym,
      action: 'unstake',
      amount,
      to: launchpad,
      data: encodeUnstakeCall(row.mint as Address, atoms),
      value: '0',
    });
  });

  app.post('/stake/claim/prepare', requireAuth(), limit(RATE_LIMITS.stake), async (c) => {
    const deps = c.get('deps');
    const user = c.get('user');
    if (!user) return c.json({ error: 'unauthorized' }, 401);
    const { net, wallet } = user;
    const gate = requireNetDeployed(c, deps.env, net);
    if (gate) return gate;

    const body = (await c.req.json().catch(() => ({}))) as { sym?: unknown; mint?: unknown };
    const sym = typeof body.sym === 'string' ? body.sym.toUpperCase() : '';
    const mintBody = typeof body.mint === 'string' ? body.mint.trim() : undefined;
    if (!sym) return c.json({ error: 'bad_request', detail: 'sym is required' }, 400);

    const row = await resolveTokenRow(deps.db, net, { mint: mintBody, sym });
    if (!row || !row.mint) return c.json({ error: 'not_found' }, 404);

    // `claimStake` reverts with "nothing" on an empty claim; answer that here.
    const onChain = await positionFromChain(deps, net, row, wallet);
    if (onChain?.source === 'chain' && onChain.rewBase <= 0 && onChain.rewTok <= 0) {
      return c.json({ error: 'nothing_to_claim', detail: `no ${sym} staking rewards yet` }, 422);
    }

    if (net === 'SOL') {
      const blockhashSource = asSolanaBlockhashSource(deps.rpcs.SOL);
      if (!blockhashSource)
        throw new Error('stake/claim/prepare: Solana RPC missing latestBlockhash()');
      const blockhash = await blockhashSource.latestBlockhash();
      const programId = new PublicKey(deps.env.solanaLaunchpadProgramId);
      const mint = new PublicKey(row.mint);
      const baseMint = new PublicKey(row.baseMint);
      const owner = new PublicKey(wallet);
      const ix = buildClaimStakeInstruction({ programId, mint, baseMint, owner });
      const tx = new Transaction({
        feePayer: owner,
        blockhash: blockhash.blockhash,
        lastValidBlockHeight: blockhash.lastValidBlockHeight,
      }).add(ix);
      return c.json({
        net,
        sym,
        action: 'claim',
        transaction: tx
          .serialize({ requireAllSignatures: false, verifySignatures: false })
          .toString('base64'),
        lastValidBlockHeight: blockhash.lastValidBlockHeight,
      });
    }

    if (!isEvm(net)) {
      return c.json({ error: 'bad_request', detail: 'unsupported net' }, 400);
    }

    const launchpad = evmLaunchpadAddress(deps.env, net as EvmNet);
    if (launchpad.toLowerCase() === ZERO) {
      return c.json(
        {
          error: 'programs_not_deployed',
          detail: `${net} launchpad address is unset — staking awaits contract deployment`,
        },
        503,
      );
    }

    return c.json({
      net,
      sym,
      action: 'claim',
      to: launchpad,
      data: encodeClaimStakeCall(row.mint as Address),
      value: '0',
    });
  });

  return app;
}
