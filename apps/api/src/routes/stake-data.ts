import { and, eq, gt, sql } from 'drizzle-orm';
import {
  FEE_SPLIT,
  chainLockMult,
  isEvm,
  nativeUnit,
  stakerBucketShare,
  type EvmNet,
  type Net,
  type StakePoolSummary,
} from '@stonkz/shared';
import type { AppDeps } from '../app/context.js';
import { evmLaunchpadAddress } from '../chain/evm-net.js';
import {
  readEvmStakePool,
  readEvmStakePosition,
  readSolStakePool,
  readSolStakePosition,
  type StakePoolAtoms,
  type StakePositionAtoms,
} from '../chain/stake-reads.js';
import { creatorVaults, stakePositions } from '../db/schema.js';
import type { EthCaller, SolanaAccountSource } from '../router/curve-sync.js';
import type { TokenRow } from './serialise.js';

/**
 * The stake read model behind `GET /stake/:sym`, `GET /stake/:sym/chain`,
 * `GET /tokens/:sym/staking` and the Fees tab.
 *
 * Two sources, deliberately kept apart:
 *
 * - **Indexer** (`stake_positions`, `creator_vaults`) — cheap, and the default.
 *   It trails the chain by the indexer's confirmation depth (12 blocks on EVM).
 * - **Chain** (`positionInfo` / `pendingStakeRewards` / `coins` on EVM, the
 *   `StakePosition` and `Curve` accounts on Solana) — the truth right after a
 *   user's own transaction confirms, and the only place pending rewards live:
 *   the indexer never accrues them (they are an accumulator, not events).
 */

/** Wire shape of a position. Token amounts are whole tokens. */
export interface StakePositionView {
  net: Net;
  sym: string;
  mint?: string;
  amt: number;
  /** On-chain weight multiplier: 0 for FLEX, 1.1 .. 8 for locks. */
  mult: number;
  days: number;
  /** Epoch ms the lock ends. */
  until: number;
  /** Pool weight, whole-token units. */
  weight: number;
  /** Pending rewards paid in the token (cashback-window fills). */
  rewTok: number;
  /** Pending rewards in the native unit — exact for a native-wrapped base, else 0. */
  rewSol: number;
  /** Pending rewards in the curve's base asset. */
  rewBase: number;
  baseSym: string;
  /** `false` for FLEX: parked, earns nothing. */
  eligible: boolean;
  source: 'chain' | 'indexer';
  /** Exact staked atoms, chain reads only — lets an "unstake all" match the chain to the atom. */
  amtAtoms?: string;
}

function asEthCaller(rpc: unknown): EthCaller | undefined {
  const c = rpc as Partial<EthCaller> | undefined;
  return c && typeof c.ethCall === 'function' ? (c as EthCaller) : undefined;
}

function asAccountSource(rpc: unknown): SolanaAccountSource | undefined {
  const c = rpc as Partial<SolanaAccountSource> | undefined;
  return c && typeof c.getAccountDataBase64 === 'function' ? (c as SolanaAccountSource) : undefined;
}

/** Atoms to whole units, splitting integer and fraction so 6182e18 reads back as exactly 6182. */
function whole(atoms: bigint, decimals: number): number {
  const scale = 10n ** BigInt(decimals);
  return Number(atoms / scale) + Number(atoms % scale) / Number(scale);
}

function atomsOf(text: string | null | undefined): bigint {
  try {
    return BigInt(text || '0');
  } catch {
    return 0n;
  }
}

/** Is the curve's base the chain's own native asset (or its wrapper)? */
function baseIsNative(net: Net, baseSymbol: string): boolean {
  return baseSymbol.toUpperCase().replace(/^W/, '') === nativeUnit(net);
}

/** Circulating supply the programs weigh stake against, from the token row. */
export function circulatingOf(token: TokenRow): number {
  const forSale = atomsOf(token.curveTokensForSale);
  const real = atomsOf(token.curveRealToken);
  if (forSale <= 0n) return 0;
  return whole(forSale > real ? forSale - real : 0n, token.tokenDecimals);
}

export function emptyPosition(net: Net, sym: string, token: TokenRow | null): StakePositionView {
  return {
    net,
    sym,
    ...(token?.mint ? { mint: token.mint } : {}),
    amt: 0,
    mult: 0,
    days: 0,
    until: 0,
    weight: 0,
    rewTok: 0,
    rewSol: 0,
    rewBase: 0,
    baseSym: token?.baseSymbol ?? nativeUnit(net),
    eligible: false,
    source: 'indexer',
  };
}

/** The indexer's view of one wallet's position. */
export async function positionFromDb(
  deps: AppDeps,
  net: Net,
  token: TokenRow,
  wallet: string,
): Promise<StakePositionView> {
  const [row] = await deps.db
    .select()
    .from(stakePositions)
    .where(
      and(
        eq(stakePositions.net, net),
        eq(stakePositions.mint, token.mint),
        // Auth sessions store checksummed EVM wallets; match either casing.
        net === 'SOL'
          ? eq(stakePositions.wallet, wallet)
          : sql`lower(${stakePositions.wallet}) = ${wallet.toLowerCase()}`,
      ),
    )
    .limit(1);
  if (!row) return emptyPosition(net, token.sym, token);
  const mult = chainLockMult(row.lockDays);
  return {
    net,
    sym: token.sym,
    mint: token.mint,
    amt: row.amount,
    mult,
    days: row.lockDays,
    until: row.untilMs,
    weight: row.amount * mult,
    rewTok: row.rewardTokens,
    rewSol: row.rewardNative,
    rewBase: baseIsNative(net, token.baseSymbol) ? row.rewardNative : 0,
    baseSym: token.baseSymbol,
    eligible: row.lockDays > 0,
    source: 'indexer',
  };
}

function viewFromAtoms(net: Net, token: TokenRow, pos: StakePositionAtoms): StakePositionView {
  const amt = whole(pos.amount, token.tokenDecimals);
  const rewBase = whole(pos.pendingBase, token.baseDecimals);
  return {
    net,
    sym: token.sym,
    mint: token.mint,
    amt,
    mult: chainLockMult(pos.lockDays),
    days: pos.lockDays,
    until: pos.lockUntil * 1000,
    weight: whole(pos.weight, token.tokenDecimals),
    rewTok: whole(pos.pendingToken, token.tokenDecimals),
    rewSol: baseIsNative(net, token.baseSymbol) ? rewBase : 0,
    rewBase,
    baseSym: token.baseSymbol,
    eligible: pos.lockDays > 0,
    source: 'chain',
    amtAtoms: pos.amount.toString(),
  };
}

/** A live on-chain read of one wallet's position, or `null` when the chain cannot answer. */
export async function positionFromChain(
  deps: AppDeps,
  net: Net,
  token: TokenRow,
  wallet: string,
): Promise<StakePositionView | null> {
  if (net === 'SOL') {
    const rpc = asAccountSource(deps.rpcs.SOL);
    if (!rpc || !deps.env.solanaLaunchpadProgramId) return null;
    const pos = await readSolStakePosition(
      rpc,
      deps.env.solanaLaunchpadProgramId,
      token.mint,
      token.baseMint,
      wallet,
    );
    return pos ? viewFromAtoms(net, token, pos) : null;
  }
  if (!isEvm(net)) return null;
  const eth = asEthCaller(deps.rpcs[net]);
  if (!eth) return null;
  const pos = await readEvmStakePosition(
    eth,
    evmLaunchpadAddress(deps.env, net as EvmNet),
    token.mint,
    wallet,
  );
  return pos ? viewFromAtoms(net, token, pos) : null;
}

/* -------------------------------------------------------------------- pool */

interface DbPool {
  eligibleStaked: number;
  flexStaked: number;
  totalWeight: number;
  stakers: number;
  newestMs: number;
}

async function poolFromDb(deps: AppDeps, net: Net, mint: string): Promise<DbPool> {
  const rows = await deps.db
    .select({
      lockDays: stakePositions.lockDays,
      stakers: sql<number>`count(*)`,
      amount: sql<number>`coalesce(sum(${stakePositions.amount}), 0)`,
      newest: sql<Date | string | null>`max(${stakePositions.updatedAt})`,
    })
    .from(stakePositions)
    .where(
      and(eq(stakePositions.net, net), eq(stakePositions.mint, mint), gt(stakePositions.amount, 0)),
    )
    .groupBy(stakePositions.lockDays);
  const out: DbPool = { eligibleStaked: 0, flexStaked: 0, totalWeight: 0, stakers: 0, newestMs: 0 };
  for (const r of rows) {
    const amount = Number(r.amount);
    if (r.lockDays > 0) out.eligibleStaked += amount;
    else out.flexStaked += amount;
    out.totalWeight += amount * chainLockMult(r.lockDays);
    out.stakers += Number(r.stakers);
    const newest = r.newest ? new Date(r.newest).getTime() : 0;
    if (newest > out.newestMs) out.newestMs = newest;
  }
  return out;
}

async function poolFromChain(
  deps: AppDeps,
  net: Net,
  token: TokenRow,
): Promise<StakePoolAtoms | null> {
  if (net === 'SOL') {
    const rpc = asAccountSource(deps.rpcs.SOL);
    if (!rpc || !deps.env.solanaLaunchpadProgramId) return null;
    return readSolStakePool(rpc, deps.env.solanaLaunchpadProgramId, token.mint, token.baseMint);
  }
  if (!isEvm(net)) return null;
  const eth = asEthCaller(deps.rpcs[net]);
  if (!eth) return null;
  return readEvmStakePool(eth, evmLaunchpadAddress(deps.env, net as EvmNet), token.mint);
}

/** How long a pool summary is served from memory. */
export const STAKE_POOL_TTL_MS = 15_000;
/**
 * A pool whose newest indexed change is younger than this is "fresh": the
 * indexer may still be behind the chain for it, so totals are read on chain.
 */
export const STAKE_POOL_FRESH_MS = 120_000;
/** Relative drift between indexer and chain totals worth a warning. */
const DRIFT = 1e-6;

const poolCache = new WeakMap<AppDeps, Map<string, { at: number; value: StakePoolSummary }>>();

function cacheFor(deps: AppDeps): Map<string, { at: number; value: StakePoolSummary }> {
  let map = poolCache.get(deps);
  if (!map) {
    map = new Map();
    poolCache.set(deps, map);
  }
  return map;
}

/** Drop a coin's cached pool — after the caller's own stake tx confirmed. */
export function invalidateStakePool(deps: AppDeps, net: Net, mint: string): void {
  cacheFor(deps).delete(`${net}:${mint}`);
}

function drifted(a: number, b: number): boolean {
  return Math.abs(a - b) > DRIFT * Math.max(1, Math.abs(a), Math.abs(b));
}

/**
 * Pool totals for one coin: indexer sums first; an on-chain `coins()` /
 * `Curve` read when the pool is fresh (no indexed stake yet, or indexed stake
 * changed within `STAKE_POOL_FRESH_MS`). When both exist and disagree the
 * chain wins and the drift is logged — that is the reconciliation read.
 */
export async function stakePoolSummary(
  deps: AppDeps,
  net: Net,
  token: TokenRow,
): Promise<StakePoolSummary> {
  const key = `${net}:${token.mint}`;
  const cache = cacheFor(deps);
  const now = deps.now();
  const hit = cache.get(key);
  if (hit && now - hit.at < STAKE_POOL_TTL_MS) return hit.value;

  const db = await poolFromDb(deps, net, token.mint);
  const [vault] = await deps.db
    .select({ stakerPoolNative: creatorVaults.stakerPoolNative })
    .from(creatorVaults)
    .where(and(eq(creatorVaults.net, net), eq(creatorVaults.mint, token.mint)))
    .limit(1);

  let eligibleStaked = db.eligibleStaked;
  let flexStaked = db.flexStaked;
  let totalWeight = db.totalWeight;
  let stakers = db.stakers;
  let circulating = circulatingOf(token);
  let source: StakePoolSummary['source'] = 'indexer';
  let lifetimeBase: number | undefined;
  let lifetimeTokens: number | undefined;

  const fresh = db.stakers === 0 || now - db.newestMs < STAKE_POOL_FRESH_MS;
  if (fresh) {
    const chain = await poolFromChain(deps, net, token);
    if (chain) {
      const dec = token.tokenDecimals;
      const cEligible = whole(chain.eligibleStaked, dec);
      const cFlex = whole(chain.flexStaked, dec);
      const cWeight = whole(chain.totalWeight, dec);
      if (db.stakers > 0 && (drifted(cEligible, eligibleStaked) || drifted(cFlex, flexStaked))) {
        deps.logger.warn('stake pool drift: indexer totals disagree with chain', {
          net,
          mint: token.mint,
          indexer: { eligibleStaked, flexStaked },
          chain: { eligibleStaked: cEligible, flexStaked: cFlex },
        });
      }
      eligibleStaked = cEligible;
      flexStaked = cFlex;
      totalWeight = cWeight;
      // The chain has no staker count; a non-empty pool has at least one.
      if (stakers === 0 && cEligible + cFlex > 0) stakers = 1;
      if (chain.tokensForSale > 0n) {
        circulating = whole(
          chain.tokensForSale > chain.realToken ? chain.tokensForSale - chain.realToken : 0n,
          dec,
        );
      }
      lifetimeBase = whole(chain.stakerAccruedBase, token.baseDecimals);
      lifetimeTokens = whole(chain.stakerAccruedToken, dec);
      source = 'chain';
    }
  }

  const totalStaked = eligibleStaked + flexStaked;
  const bucketShare = stakerBucketShare(eligibleStaked, circulating);
  const value: StakePoolSummary = {
    totalStaked,
    eligibleStaked,
    flexStaked,
    totalWeight,
    stakers,
    circulating,
    stakedFrac: circulating > 0 ? Math.min(1, totalStaked / circulating) : 0,
    bucketShare,
    feeShare: bucketShare * FEE_SPLIT.creatorBucket,
    lifetimeNative: vault?.stakerPoolNative ?? 0,
    baseSym: token.baseSymbol,
    ...(lifetimeBase !== undefined ? { lifetimeBase } : {}),
    ...(lifetimeTokens !== undefined ? { lifetimeTokens } : {}),
    source,
  };
  cache.set(key, { at: now, value });
  return value;
}
