import { and, eq } from 'drizzle-orm';
import { isEvm, type EvmNet, type Net, type TokenFees } from '@stonkz/shared';
import type { AppDeps } from '../app/context.js';
import { evmLaunchpadAddress } from '../chain/evm-net.js';
import { readEvmStakePool, readSolStakePool } from '../chain/stake-reads.js';
import { creatorVaults } from '../db/schema.js';
import type { EthCaller, SolanaAccountSource } from '../router/curve-sync.js';
import type { TokenRow } from './serialise.js';

/**
 * The creator's claimable ledger for one coin — the number the Fees tab's
 * CLAIM button shows and the number `/fees/claim/prepare` refuses on.
 *
 * Chain first: `coins(token).creatorClaimableBase/Token` on EVM, the `Curve`
 * account's `creator_claimable_*` on Solana. That is exactly what the claim
 * pays, to the atom, and it is current the moment a fill lands — the indexer
 * trails by its confirmation depth and, for a coin the indexer has not
 * caught up on, would say "nothing to claim" about money that is there.
 * Falls back to `creator_vaults` when the RPC cannot answer.
 */
export type CreatorClaimable = NonNullable<TokenFees['creator']>;

function asEthCaller(rpc: unknown): EthCaller | undefined {
  const c = rpc as Partial<EthCaller> | undefined;
  return c && typeof c.ethCall === 'function' ? (c as EthCaller) : undefined;
}

function asAccountSource(rpc: unknown): SolanaAccountSource | undefined {
  const c = rpc as Partial<SolanaAccountSource> | undefined;
  return c && typeof c.getAccountDataBase64 === 'function' ? (c as SolanaAccountSource) : undefined;
}

/** Atoms to whole units, splitting integer and fraction so 276e12 wei reads back exactly. */
function whole(atoms: bigint, decimals: number): number {
  const scale = 10n ** BigInt(decimals);
  return Number(atoms / scale) + Number(atoms % scale) / Number(scale);
}

/** The on-chain ledger, or `null` when the chain cannot answer. */
export async function creatorClaimableFromChain(
  deps: AppDeps,
  net: Net,
  token: TokenRow,
): Promise<{ creator: string; base: bigint; tokens: bigint } | null> {
  if (net === 'SOL') {
    const rpc = asAccountSource(deps.rpcs.SOL);
    if (!rpc || !deps.env.solanaLaunchpadProgramId) return null;
    const pool = await readSolStakePool(
      rpc,
      deps.env.solanaLaunchpadProgramId,
      token.mint,
      token.baseMint,
    );
    if (!pool || pool.creatorClaimableBase === undefined) return null;
    return {
      creator: pool.creator ?? token.creator,
      base: pool.creatorClaimableBase,
      tokens: pool.creatorClaimableToken ?? 0n,
    };
  }
  if (!isEvm(net)) return null;
  const eth = asEthCaller(deps.rpcs[net]);
  if (!eth) return null;
  const pool = await readEvmStakePool(
    eth,
    evmLaunchpadAddress(deps.env, net as EvmNet),
    token.mint,
  );
  if (!pool || pool.creatorClaimableBase === undefined) return null;
  return {
    creator: pool.creator ?? token.creator,
    base: pool.creatorClaimableBase,
    tokens: pool.creatorClaimableToken ?? 0n,
  };
}

/** Same wallet, either casing on EVM. */
export function sameWallet(net: Net, a: string, b: string): boolean {
  return net === 'SOL' ? a === b : a.toLowerCase() === b.toLowerCase();
}

/**
 * @param opts.chain Spend an RPC read on the program's ledger. The Fees tab
 * is public and polled, so callers pass `true` only when the answer matters
 * to the viewer — the creator looking at their own coin, or a claim prepare.
 */
export async function creatorClaimable(
  deps: AppDeps,
  net: Net,
  token: TokenRow,
  opts: { chain?: boolean } = {},
): Promise<CreatorClaimable> {
  const [vault] = await deps.db
    .select()
    .from(creatorVaults)
    .where(and(eq(creatorVaults.net, net), eq(creatorVaults.mint, token.mint)))
    .limit(1);
  const claimedNative = vault?.claimedNative ?? 0;
  const chain = opts.chain === false ? null : await creatorClaimableFromChain(deps, net, token);
  if (chain) {
    return {
      wallet: chain.creator,
      claimableBase: whole(chain.base, token.baseDecimals),
      baseSym: token.baseSymbol,
      claimableTokens: whole(chain.tokens, token.tokenDecimals),
      claimedNative,
      source: 'chain',
    };
  }
  return {
    wallet: vault?.creator ?? token.creator,
    claimableBase: vault?.unclaimedNative ?? 0,
    baseSym: token.baseSymbol,
    claimableTokens: vault?.unclaimedTokens ?? 0,
    claimedNative,
    source: 'indexer',
  };
}
