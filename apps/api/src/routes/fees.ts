import { Hono } from 'hono';
import { PublicKey, Transaction } from '@solana/web3.js';
import type { Address } from 'viem';
import { and, eq, gt, or } from 'drizzle-orm';
import { nativeUnit } from '@stonkz/shared';
import { creatorVaults } from '../db/schema.js';
import { requireAuth, limit } from '../app/middleware.js';
import { RATE_LIMITS } from '../redis/ratelimit.js';
import type { AppEnv } from '../app/context.js';
import { buildClaimCreatorFeesInstruction } from '../router/solana-instructions.js';
import { asSolanaBlockhashSource } from '../router/solana-tx.js';
import { encodeClaimCreatorFeesCall } from '../router/evm-launch.js';
import { resolveTokenRow } from './token-resolve.js';

/**
 * `GET /fees` + `POST /fees/claim/prepare` — plan step 92, creator vault
 * only. `creator_vaults` (Phase 1's schema) already separates the creator's
 * claimable balance from `treasuries` (`protocol` / `stonkz_ops`); neither
 * route here ever reads or writes `treasuries` — that boundary lives at the
 * query level, not just in the contracts (`StonkzLaunchpad.claimCreatorFees`
 * has the identical separation: `docs`/`ASSUMPTIONS.md` and the Solidity
 * source both note it drains the creator ledger only).
 */
export function feesRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get('/fees', requireAuth(), limit(RATE_LIMITS.fees), async (c) => {
    const deps = c.get('deps');
    const user = c.get('user');
    if (!user) return c.json({ error: 'unauthorized' }, 401);
    const { net, wallet } = user;

    const rows = await deps.db
      .select()
      .from(creatorVaults)
      .where(
        and(
          eq(creatorVaults.net, net),
          eq(creatorVaults.creator, wallet),
          or(gt(creatorVaults.unclaimedNative, 0), gt(creatorVaults.unclaimedTokens, 0)),
        ),
      );

    return c.json({
      net,
      nativeUnit: nativeUnit(net),
      vaults: rows.map((r) => ({
        sym: r.sym,
        mint: r.mint,
        unclaimedNative: r.unclaimedNative,
        unclaimedTokens: r.unclaimedTokens,
        stakerPoolNative: r.stakerPoolNative,
        lifetimeNative: r.lifetimeNative,
        claimedNative: r.claimedNative,
      })),
    });
  });

  app.post('/fees/claim/prepare', requireAuth(), limit(RATE_LIMITS.fees), async (c) => {
    const deps = c.get('deps');
    const user = c.get('user');
    if (!user) return c.json({ error: 'unauthorized' }, 401);
    const { net, wallet } = user;

    const body = (await c.req.json().catch(() => ({}))) as { sym?: unknown; mint?: unknown };
    const sym = typeof body.sym === 'string' ? body.sym.toUpperCase() : '';
    const mintBody = typeof body.mint === 'string' ? body.mint.trim() : undefined;
    if (!sym) return c.json({ error: 'bad_request', detail: 'sym is required' }, 400);

    const row = await resolveTokenRow(deps.db, net, { mint: mintBody, sym });
    if (!row || !row.mint) return c.json({ error: 'not_found' }, 404);

    const [vault] = await deps.db
      .select()
      .from(creatorVaults)
      .where(and(eq(creatorVaults.net, net), eq(creatorVaults.mint, row.mint), eq(creatorVaults.creator, wallet)))
      .limit(1);
    if (!vault || (vault.unclaimedNative <= 0 && vault.unclaimedTokens <= 0)) {
      return c.json({ error: 'nothing_to_claim' }, 422);
    }

    if (net === 'SOL') {
      const blockhashSource = asSolanaBlockhashSource(deps.rpcs.SOL);
      if (!blockhashSource) throw new Error('fees/claim/prepare: Solana RPC does not implement latestBlockhash()');
      const blockhash = await blockhashSource.latestBlockhash();

      const programId = new PublicKey(deps.env.solanaLaunchpadProgramId);
      const mint = new PublicKey(row.mint);
      const baseMint = new PublicKey(row.baseMint);
      const creator = new PublicKey(wallet);

      const ix = buildClaimCreatorFeesInstruction({ programId, mint, baseMint, creator });
      const tx = new Transaction({
        feePayer: creator,
        blockhash: blockhash.blockhash,
        lastValidBlockHeight: blockhash.lastValidBlockHeight,
      }).add(ix);

      return c.json({
        net,
        sym,
        mint: row.mint,
        transaction: tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64'),
        lastValidBlockHeight: blockhash.lastValidBlockHeight,
      });
    }

    const data = encodeClaimCreatorFeesCall(row.mint as Address);
    return c.json({ net, sym, mint: row.mint, to: deps.env.rhLaunchpadAddress, data, value: '0' });
  });

  return app;
}
