import { decodeFunctionResult, encodeFunctionData, getAddress, type Address, type Hex } from 'viem';
import { isEvm, type EvmNet, type Net } from '@stonkz/shared';
import type { AppDeps } from '../app/context.js';
import type { EthCaller } from '../router/curve-sync.js';
import type { TokenRow } from '../routes/serialise.js';
import { evmLaunchpadAddress } from './evm-net.js';

/**
 * Post-graduation pool fees on EVM — `programs/evm/src/FeeLocker.sol`.
 *
 * A coin graduated by `UniswapV3Migrator` has its raise + escrow locked as a
 * full-range v3 position owned by the immutable `FeeLocker`. Anyone may call
 * `claimFees(token)`; the fees flow into the launchpad's ledgers by the curve
 * split. The token page shows what is uncollected and offers the call.
 *
 * Nothing here is configured by hand: the locker is discovered from the
 * chain (`launchpad.migrator()` → `migrator.locker()`), so a coin graduated
 * by the earlier v2 migrator (no `locker()`, LP burned) simply reports no
 * pool fees. All reads return `null` on any failure — the page degrades to
 * the plain "graduated" note rather than erroring.
 */

const LAUNCHPAD_MIGRATOR_ABI = [
  {
    type: 'function',
    name: 'migrator',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
] as const;

const MIGRATOR_LOCKER_ABI = [
  {
    type: 'function',
    name: 'locker',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
] as const;

export const FEE_LOCKER_ABI = [
  {
    type: 'function',
    name: 'lockOf',
    stateMutability: 'view',
    inputs: [{ name: 'token', type: 'address' }],
    outputs: [
      {
        name: '',
        type: 'tuple',
        components: [
          { name: 'pool', type: 'address' },
          { name: 'baseToken', type: 'address' },
          { name: 'tickLower', type: 'int24' },
          { name: 'tickUpper', type: 'int24' },
          { name: 'tokenIs0', type: 'bool' },
          { name: 'liquidity', type: 'uint128' },
        ],
      },
    ],
  },
  {
    type: 'function',
    name: 'pendingFees',
    stateMutability: 'view',
    inputs: [{ name: 'token', type: 'address' }],
    outputs: [
      { name: 'baseAmount', type: 'uint256' },
      { name: 'tokenAmount', type: 'uint256' },
    ],
  },
  {
    type: 'function',
    name: 'claimFees',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'token', type: 'address' }],
    outputs: [
      { name: 'baseAmount', type: 'uint256' },
      { name: 'tokenAmount', type: 'uint256' },
    ],
  },
] as const;

const ZERO = '0x0000000000000000000000000000000000000000';

export interface PoolFeesAtoms {
  locker: string;
  pool: string;
  liquidity: bigint;
  pendingBase: bigint;
  pendingTokens: bigint;
}

function asEthCaller(rpc: unknown): EthCaller | undefined {
  const c = rpc as Partial<EthCaller> | undefined;
  return c && typeof c.ethCall === 'function' ? (c as EthCaller) : undefined;
}

/** A call that returns nothing (no code, or a revert) reads as `null`. */
async function call(eth: EthCaller, to: string, data: Hex): Promise<Hex | null> {
  try {
    const out = await eth.ethCall(to, data);
    return out && out !== '0x' ? (out as Hex) : null;
  } catch {
    return null;
  }
}

/** The launchpad's fee locker, if its current migrator has one. */
export async function readFeeLocker(eth: EthCaller, launchpad: string): Promise<string | null> {
  const m = await call(
    eth,
    launchpad,
    encodeFunctionData({ abi: LAUNCHPAD_MIGRATOR_ABI, functionName: 'migrator' }),
  );
  if (!m) return null;
  const migrator = decodeFunctionResult({
    abi: LAUNCHPAD_MIGRATOR_ABI,
    functionName: 'migrator',
    data: m,
  });
  if (!migrator || migrator === ZERO) return null;
  const l = await call(
    eth,
    migrator,
    encodeFunctionData({ abi: MIGRATOR_LOCKER_ABI, functionName: 'locker' }),
  );
  if (!l) return null;
  const locker = decodeFunctionResult({
    abi: MIGRATOR_LOCKER_ABI,
    functionName: 'locker',
    data: l,
  });
  return locker && locker !== ZERO ? getAddress(locker) : null;
}

/** The locked position and its uncollected fees, or `null` when there is none. */
export async function readPoolFees(
  eth: EthCaller,
  launchpad: string,
  token: string,
): Promise<PoolFeesAtoms | null> {
  const locker = await readFeeLocker(eth, launchpad);
  if (!locker) return null;
  const lockData = await call(
    eth,
    locker,
    encodeFunctionData({ abi: FEE_LOCKER_ABI, functionName: 'lockOf', args: [token as Address] }),
  );
  if (!lockData) return null;
  const lock = decodeFunctionResult({
    abi: FEE_LOCKER_ABI,
    functionName: 'lockOf',
    data: lockData,
  });
  if (!lock || lock.pool === ZERO) return null;
  const pending = await call(
    eth,
    locker,
    encodeFunctionData({
      abi: FEE_LOCKER_ABI,
      functionName: 'pendingFees',
      args: [token as Address],
    }),
  );
  if (!pending) return null;
  const [pendingBase, pendingTokens] = decodeFunctionResult({
    abi: FEE_LOCKER_ABI,
    functionName: 'pendingFees',
    data: pending,
  });
  return {
    locker,
    pool: getAddress(lock.pool),
    liquidity: lock.liquidity,
    pendingBase,
    pendingTokens,
  };
}

export function encodeClaimPoolFeesCall(token: string): Hex {
  return encodeFunctionData({
    abi: FEE_LOCKER_ABI,
    functionName: 'claimFees',
    args: [token as Address],
  });
}

/** Atoms to whole units without losing the fraction. */
function whole(atoms: bigint, decimals: number): number {
  const scale = 10n ** BigInt(decimals);
  return Number(atoms / scale) + Number(atoms % scale) / Number(scale);
}

/** What the token page shows for a v3-graduated coin. */
export interface PoolFeesView {
  locker: string;
  pool: string;
  pendingBase: number;
  baseSym: string;
  pendingTokens: number;
}

export async function poolFeesView(
  deps: AppDeps,
  net: Net,
  row: TokenRow,
): Promise<PoolFeesView | null> {
  if (!isEvm(net) || !row.mint || row.graduatedAt === null || !row.poolAddress) return null;
  const eth = asEthCaller(deps.rpcs[net]);
  if (!eth) return null;
  const fees = await readPoolFees(eth, evmLaunchpadAddress(deps.env, net as EvmNet), row.mint);
  if (!fees) return null;
  return {
    locker: fees.locker,
    pool: fees.pool,
    pendingBase: whole(fees.pendingBase, row.baseDecimals),
    baseSym: row.baseSymbol,
    pendingTokens: whole(fees.pendingTokens, row.tokenDecimals),
  };
}

/** `GET /tokens/:sym`'s `poolFees` extra: present only for a v3-graduated coin. */
export async function poolFeesExtra(
  deps: AppDeps,
  net: Net,
  row: TokenRow,
): Promise<Record<string, unknown>> {
  const view = await poolFeesView(deps, net, row);
  return view ? { poolFees: view } : {};
}
