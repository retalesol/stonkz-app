import { Hono } from 'hono';
import { PublicKey, Transaction } from '@solana/web3.js';
import type { Address } from 'viem';
import { and, eq } from 'drizzle-orm';
import { LOCKS } from '@stonkz/shared';
import { stakePositions, tokens } from '../db/schema.js';
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
import { toAtoms } from '../router/units.js';
import { ZERO_EVM_ADDRESS } from '../env.js';

/**
 * Per-memecoin staking prepare endpoints.
 *
 * Builds the same unsigned payloads as `/trade/prepare` and
 * `/fees/claim/prepare`. Settlement requires a deployed launchpad (§3 of
 * `docs/real-vs-simulated.md`) — until then, wallets will reject or the
 * chain will fail the broadcast, which is the honest failure mode.
 *
 * - `POST /stake/prepare` — `{ sym, amount, days }`
 * - `POST /stake/unstake/prepare` — `{ sym, amount }`
 * - `POST /stake/claim/prepare` — `{ sym }`
 * - `GET /stake/:sym` — own position from the indexer table (empty until
 *   chain events land)
 */

const ZERO = ZERO_EVM_ADDRESS.toLowerCase();

function lockDaysOk(days: number): boolean {
  return LOCKS.some((l) => l[0] === days);
}

export function stakeRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get('/stake/:sym', requireAuth(), limit(RATE_LIMITS.read), async (c) => {
    const deps = c.get('deps');
    const user = c.get('user');
    if (!user) return c.json({ error: 'unauthorized' }, 401);
    const sym = c.req.param('sym').toUpperCase();

    const [row] = await deps.db
      .select()
      .from(stakePositions)
      .where(
        and(
          eq(stakePositions.net, user.net),
          eq(stakePositions.sym, sym),
          eq(stakePositions.wallet, user.wallet),
        ),
      )
      .limit(1);

    if (!row) {
      return c.json({
        net: user.net,
        sym,
        amt: 0,
        mult: 1,
        days: 0,
        until: 0,
        rewTok: 0,
        rewSol: 0,
      });
    }

    return c.json({
      net: user.net,
      sym,
      amt: row.amount,
      mult: row.mult,
      days: row.lockDays,
      until: row.untilMs,
      rewTok: row.rewardTokens,
      rewSol: row.rewardNative,
    });
  });

  app.post('/stake/prepare', requireAuth(), limit(RATE_LIMITS.stake), async (c) => {
    const deps = c.get('deps');
    const user = c.get('user');
    if (!user) return c.json({ error: 'unauthorized' }, 401);
    const { net, wallet } = user;

    const body = (await c.req.json().catch(() => ({}))) as {
      sym?: unknown;
      amount?: unknown;
      days?: unknown;
    };
    const sym = typeof body.sym === 'string' ? body.sym.toUpperCase() : '';
    const amount = typeof body.amount === 'number' ? body.amount : Number(body.amount);
    const days = typeof body.days === 'number' ? body.days : Number(body.days ?? 0);
    if (!sym) return c.json({ error: 'bad_request', detail: 'sym is required' }, 400);
    if (!Number.isFinite(amount) || amount <= 0) {
      return c.json({ error: 'bad_request', detail: 'amount must be a positive number' }, 400);
    }
    if (!lockDaysOk(days)) {
      return c.json({ error: 'bad_request', detail: 'invalid lock term' }, 400);
    }

    const [row] = await deps.db
      .select()
      .from(tokens)
      .where(and(eq(tokens.net, net), eq(tokens.sym, sym)))
      .limit(1);
    if (!row || !row.mint) return c.json({ error: 'not_found' }, 404);

    if (net === 'SOL') {
      const blockhashSource = asSolanaBlockhashSource(deps.rpcs.SOL);
      if (!blockhashSource) throw new Error('stake/prepare: Solana RPC does not implement latestBlockhash()');
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
        transaction: tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64'),
        lastValidBlockHeight: blockhash.lastValidBlockHeight,
      });
    }

    if (deps.env.rhLaunchpadAddress.toLowerCase() === ZERO) {
      return c.json(
        {
          error: 'programs_not_deployed',
          detail: 'Robinhood launchpad address is unset — staking awaits contract deployment',
        },
        503,
      );
    }

    const atoms = toAtoms(amount, row.tokenDecimals);
    const data = encodeStakeCall(row.mint as Address, atoms, days);
    return c.json({
      net,
      sym,
      action: 'stake',
      amount,
      days,
      to: deps.env.rhLaunchpadAddress,
      data,
      value: '0',
    });
  });

  app.post('/stake/unstake/prepare', requireAuth(), limit(RATE_LIMITS.stake), async (c) => {
    const deps = c.get('deps');
    const user = c.get('user');
    if (!user) return c.json({ error: 'unauthorized' }, 401);
    const { net, wallet } = user;

    const body = (await c.req.json().catch(() => ({}))) as { sym?: unknown; amount?: unknown };
    const sym = typeof body.sym === 'string' ? body.sym.toUpperCase() : '';
    const amount = typeof body.amount === 'number' ? body.amount : Number(body.amount);
    if (!sym) return c.json({ error: 'bad_request', detail: 'sym is required' }, 400);
    if (!Number.isFinite(amount) || amount <= 0) {
      return c.json({ error: 'bad_request', detail: 'amount must be a positive number' }, 400);
    }

    const [row] = await deps.db
      .select()
      .from(tokens)
      .where(and(eq(tokens.net, net), eq(tokens.sym, sym)))
      .limit(1);
    if (!row || !row.mint) return c.json({ error: 'not_found' }, 404);

    if (net === 'SOL') {
      const blockhashSource = asSolanaBlockhashSource(deps.rpcs.SOL);
      if (!blockhashSource) throw new Error('stake/unstake/prepare: Solana RPC missing latestBlockhash()');
      const blockhash = await blockhashSource.latestBlockhash();
      const programId = new PublicKey(deps.env.solanaLaunchpadProgramId);
      const mint = new PublicKey(row.mint);
      const owner = new PublicKey(wallet);
      const atoms = toAtoms(amount, row.tokenDecimals);
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
        transaction: tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64'),
        lastValidBlockHeight: blockhash.lastValidBlockHeight,
      });
    }

    if (deps.env.rhLaunchpadAddress.toLowerCase() === ZERO) {
      return c.json(
        {
          error: 'programs_not_deployed',
          detail: 'Robinhood launchpad address is unset — staking awaits contract deployment',
        },
        503,
      );
    }

    const atoms = toAtoms(amount, row.tokenDecimals);
    return c.json({
      net,
      sym,
      action: 'unstake',
      amount,
      to: deps.env.rhLaunchpadAddress,
      data: encodeUnstakeCall(row.mint as Address, atoms),
      value: '0',
    });
  });

  app.post('/stake/claim/prepare', requireAuth(), limit(RATE_LIMITS.stake), async (c) => {
    const deps = c.get('deps');
    const user = c.get('user');
    if (!user) return c.json({ error: 'unauthorized' }, 401);
    const { net, wallet } = user;

    const body = (await c.req.json().catch(() => ({}))) as { sym?: unknown };
    const sym = typeof body.sym === 'string' ? body.sym.toUpperCase() : '';
    if (!sym) return c.json({ error: 'bad_request', detail: 'sym is required' }, 400);

    const [row] = await deps.db
      .select()
      .from(tokens)
      .where(and(eq(tokens.net, net), eq(tokens.sym, sym)))
      .limit(1);
    if (!row || !row.mint) return c.json({ error: 'not_found' }, 404);

    if (net === 'SOL') {
      const blockhashSource = asSolanaBlockhashSource(deps.rpcs.SOL);
      if (!blockhashSource) throw new Error('stake/claim/prepare: Solana RPC missing latestBlockhash()');
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
        transaction: tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64'),
        lastValidBlockHeight: blockhash.lastValidBlockHeight,
      });
    }

    if (deps.env.rhLaunchpadAddress.toLowerCase() === ZERO) {
      return c.json(
        {
          error: 'programs_not_deployed',
          detail: 'Robinhood launchpad address is unset — staking awaits contract deployment',
        },
        503,
      );
    }

    return c.json({
      net,
      sym,
      action: 'claim',
      to: deps.env.rhLaunchpadAddress,
      data: encodeClaimStakeCall(row.mint as Address),
      value: '0',
    });
  });

  return app;
}
