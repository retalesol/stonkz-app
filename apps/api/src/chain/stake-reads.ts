import { createHash } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import { decodeFunctionResult, encodeFunctionData, type Address, type Hex } from 'viem';
import { derivePdas, deriveStakePositionPda } from '../router/solana-idl.js';
import {
  CURVE_ACCOUNT_DISC,
  type EthCaller,
  type SolanaAccountSource,
} from '../router/curve-sync.js';

/**
 * On-chain staking reads — the source of truth the stake dialog shows right
 * after a stake / unstake / claim confirms, before the indexer (12 blocks
 * behind on EVM) has caught up.
 *
 * Everything here returns **atoms** (`bigint`) and never throws: a failed or
 * malformed read is `null`, and the caller falls back to the indexer's table.
 */

/** `StonkzLaunchpad.Position` plus `pendingStakeRewards` — both programs' shape. */
export interface StakePositionAtoms {
  amount: bigint;
  weight: bigint;
  lockDays: number;
  /** Unix seconds. FLEX sets this to the stake's own block time. */
  lockUntil: number;
  /** Claimable now: settled `unclaimed*` plus whatever the accumulator owes since. */
  pendingBase: bigint;
  pendingToken: bigint;
}

/** The stake-pool slice of a coin record. */
export interface StakePoolAtoms {
  eligibleStaked: bigint;
  flexStaked: bigint;
  totalWeight: bigint;
  stakerAccruedBase: bigint;
  stakerAccruedToken: bigint;
  tokensForSale: bigint;
  realToken: bigint;
}

const ZERO = '0x0000000000000000000000000000000000000000';

export const STAKE_VIEW_ABI = [
  {
    type: 'function',
    name: 'positionInfo',
    stateMutability: 'view',
    inputs: [
      { name: 'token', type: 'address' },
      { name: 'owner', type: 'address' },
    ],
    outputs: [
      {
        name: '',
        type: 'tuple',
        components: [
          { name: 'amount', type: 'uint256' },
          { name: 'weight', type: 'uint256' },
          { name: 'baseDebt', type: 'uint256' },
          { name: 'tokenDebt', type: 'uint256' },
          { name: 'unclaimedBase', type: 'uint256' },
          { name: 'unclaimedToken', type: 'uint256' },
          { name: 'lockUntil', type: 'uint64' },
          { name: 'lockDays', type: 'uint16' },
        ],
      },
    ],
  },
  {
    type: 'function',
    name: 'pendingStakeRewards',
    stateMutability: 'view',
    inputs: [
      { name: 'token', type: 'address' },
      { name: 'owner', type: 'address' },
    ],
    outputs: [
      { name: 'base', type: 'uint256' },
      { name: 'tokens', type: 'uint256' },
    ],
  },
] as const;

/**
 * Word offsets into `coins(token)` / `coinInfo(token)`, a flat tuple of value
 * types (see `router/curve-sync.ts`'s `COINS_ABI`). Read positionally rather
 * than through a full ABI so a field appended to the struct later
 * (`burnAccrued` already was) cannot break the decode.
 */
export const COINS_WORD = {
  realToken: 15,
  tokensForSale: 17,
  eligibleStaked: 28,
  flexStaked: 29,
  totalWeight: 30,
  stakerAccruedBase: 35,
  stakerAccruedToken: 36,
} as const;

const COINS_CALL_ABI = [
  {
    type: 'function',
    name: 'coins',
    stateMutability: 'view',
    inputs: [{ name: 'token', type: 'address' }],
    outputs: [],
  },
] as const;

function isEvmAddress(v: string): v is Address {
  return /^0x[0-9a-fA-F]{40}$/.test(v);
}

function usable(launchpad: string): boolean {
  return isEvmAddress(launchpad) && launchpad.toLowerCase() !== ZERO;
}

export async function readEvmStakePosition(
  eth: EthCaller,
  launchpad: string,
  token: string,
  owner: string,
): Promise<StakePositionAtoms | null> {
  if (!usable(launchpad) || !isEvmAddress(token) || !isEvmAddress(owner)) return null;
  try {
    const [posRaw, pendingRaw] = await Promise.all([
      eth.ethCall(
        launchpad,
        encodeFunctionData({
          abi: STAKE_VIEW_ABI,
          functionName: 'positionInfo',
          args: [token, owner],
        }),
      ),
      eth.ethCall(
        launchpad,
        encodeFunctionData({
          abi: STAKE_VIEW_ABI,
          functionName: 'pendingStakeRewards',
          args: [token, owner],
        }),
      ),
    ]);
    if (!posRaw || posRaw === '0x') return null;
    const pos = decodeFunctionResult({
      abi: STAKE_VIEW_ABI,
      functionName: 'positionInfo',
      data: posRaw as Hex,
    });
    let pendingBase = pos.unclaimedBase;
    let pendingToken = pos.unclaimedToken;
    if (pendingRaw && pendingRaw !== '0x') {
      const [base, tokens] = decodeFunctionResult({
        abi: STAKE_VIEW_ABI,
        functionName: 'pendingStakeRewards',
        data: pendingRaw as Hex,
      });
      pendingBase = base;
      pendingToken = tokens;
    }
    return {
      amount: pos.amount,
      weight: pos.weight,
      lockDays: Number(pos.lockDays),
      lockUntil: Number(pos.lockUntil),
      pendingBase,
      pendingToken,
    };
  } catch {
    return null;
  }
}

export function parseCoinsStakePool(raw: string): StakePoolAtoms | null {
  const hex = (raw.startsWith('0x') ? raw.slice(2) : raw).toLowerCase();
  if (hex.length < (COINS_WORD.stakerAccruedToken + 1) * 64) return null;
  const word = (i: number): bigint => BigInt(`0x${hex.slice(i * 64, i * 64 + 64)}`);
  // Word 0 is the token address; zero means the launchpad does not know it.
  if (word(0) === 0n) return null;
  return {
    eligibleStaked: word(COINS_WORD.eligibleStaked),
    flexStaked: word(COINS_WORD.flexStaked),
    totalWeight: word(COINS_WORD.totalWeight),
    stakerAccruedBase: word(COINS_WORD.stakerAccruedBase),
    stakerAccruedToken: word(COINS_WORD.stakerAccruedToken),
    tokensForSale: word(COINS_WORD.tokensForSale),
    realToken: word(COINS_WORD.realToken),
  };
}

export async function readEvmStakePool(
  eth: EthCaller,
  launchpad: string,
  token: string,
): Promise<StakePoolAtoms | null> {
  if (!usable(launchpad) || !isEvmAddress(token)) return null;
  try {
    const raw = await eth.ethCall(
      launchpad,
      encodeFunctionData({ abi: COINS_CALL_ABI, functionName: 'coins', args: [token] }),
    );
    return parseCoinsStakePool(raw);
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ Solana */

/** Anchor `account:StakePosition` discriminator. */
export const STAKE_POSITION_ACCOUNT_DISC = createHash('sha256')
  .update('account:StakePosition')
  .digest()
  .subarray(0, 8);

/** Solana's `ACC_PRECISION` (the EVM mirror uses 1e36). */
const SOL_ACC_PRECISION = 1_000_000_000_000_000_000n;

function u128(buf: Buffer, o: number): bigint {
  return buf.readBigUInt64LE(o) + (buf.readBigUInt64LE(o + 8) << 64n);
}

export interface SolStakePositionAccount {
  amount: bigint;
  lockDays: number;
  weight: bigint;
  lockUntil: number;
  baseDebt: bigint;
  tokenDebt: bigint;
  unclaimedBase: bigint;
  unclaimedToken: bigint;
}

/** `state.rs` `StakePosition`: bump, curve, owner, amount, lock_days, weight, lock_until, debts, unclaimed. */
export function decodeSolStakePosition(data: Buffer): SolStakePositionAccount | null {
  const size = 8 + 1 + 32 + 32 + 8 + 2 + 16 + 8 + 16 + 16 + 8 + 8;
  if (data.length < size) return null;
  if (!data.subarray(0, 8).equals(STAKE_POSITION_ACCOUNT_DISC)) return null;
  let o = 8 + 1 + 32 + 32;
  const amount = data.readBigUInt64LE(o);
  o += 8;
  const lockDays = data.readUInt16LE(o);
  o += 2;
  const weight = u128(data, o);
  o += 16;
  const lockUntil = Number(data.readBigInt64LE(o));
  o += 8;
  const baseDebt = u128(data, o);
  o += 16;
  const tokenDebt = u128(data, o);
  o += 16;
  const unclaimedBase = data.readBigUInt64LE(o);
  o += 8;
  const unclaimedToken = data.readBigUInt64LE(o);
  return {
    amount,
    lockDays,
    weight,
    lockUntil,
    baseDebt,
    tokenDebt,
    unclaimedBase,
    unclaimedToken,
  };
}

export interface SolCurveStakePool extends StakePoolAtoms {
  accBasePerWeight: bigint;
  accTokenPerWeight: bigint;
}

/**
 * The stake-pool tail of `state.rs`'s `Curve`. Walks the whole layout because
 * the ticker is a variable-length string and `graduation_reason` an `Option`.
 */
export function decodeSolCurveStakePool(data: Buffer): SolCurveStakePool | null {
  try {
    if (!data.subarray(0, 8).equals(CURVE_ACCOUNT_DISC)) return null;
    let o = 8 + 1 + 32 * 3;
    const tickerLen = data.readUInt32LE(o);
    if (tickerLen > 64) return null;
    o += 4 + tickerLen;
    o += 8; // supply
    o += 1 + 1 + 2 + 1 + 8; // decimals, base_decimals, fee_bps, cashback, cb_start
    o += 16 + 16; // virtual_base, virtual_token
    o += 8; // real_base
    const realToken = data.readBigUInt64LE(o);
    o += 8;
    o += 16 + 16 + 16; // k, init_virtual_base, init_virtual_token
    const tokensForSale = data.readBigUInt64LE(o);
    o += 8;
    o += 8; // lp_reserve
    o += 16; // grad_mcap_base
    o += 8; // creation_base_price_1e6
    o += 1 + 1; // complete, graduated
    const reasonTag = data.readUInt8(o);
    o += reasonTag === 1 ? 2 : 1;
    o += 8; // graduated_at
    o += 1; // migrated
    o += 32; // dex_pool
    o += 8; // dex_position_meta
    o += 8 * 5; // protocol, ops, creator bucket, creator claimable base/token
    const eligibleStaked = data.readBigUInt64LE(o);
    o += 8;
    const flexStaked = data.readBigUInt64LE(o);
    o += 8;
    const totalWeight = u128(data, o);
    o += 16;
    const accBasePerWeight = u128(data, o);
    o += 16;
    const accTokenPerWeight = u128(data, o);
    o += 16;
    o += 8 + 8; // pool dust
    const stakerAccruedBase = data.readBigUInt64LE(o);
    o += 8;
    const stakerAccruedToken = data.readBigUInt64LE(o);
    return {
      eligibleStaked,
      flexStaked,
      totalWeight,
      accBasePerWeight,
      accTokenPerWeight,
      stakerAccruedBase,
      stakerAccruedToken,
      tokensForSale,
      realToken,
    };
  } catch {
    return null;
  }
}

function solPending(weight: bigint, acc: bigint, debt: bigint): bigint {
  return weight > 0n && acc > debt ? (weight * (acc - debt)) / SOL_ACC_PRECISION : 0n;
}

export async function readSolStakePool(
  rpc: SolanaAccountSource,
  programId: string,
  mint: string,
  baseMint: string,
): Promise<SolCurveStakePool | null> {
  try {
    const pdas = derivePdas(new PublicKey(programId), new PublicKey(mint), new PublicKey(baseMint));
    const b64 = await rpc.getAccountDataBase64(pdas.curve.toBase58());
    if (!b64) return null;
    return decodeSolCurveStakePool(Buffer.from(b64, 'base64'));
  } catch {
    return null;
  }
}

export async function readSolStakePosition(
  rpc: SolanaAccountSource,
  programId: string,
  mint: string,
  baseMint: string,
  owner: string,
): Promise<StakePositionAtoms | null> {
  try {
    const program = new PublicKey(programId);
    const [pda] = deriveStakePositionPda(program, new PublicKey(mint), new PublicKey(owner));
    const b64 = await rpc.getAccountDataBase64(pda.toBase58());
    // No account = never staked (or fully closed): an honest empty position.
    if (!b64) {
      return {
        amount: 0n,
        weight: 0n,
        lockDays: 0,
        lockUntil: 0,
        pendingBase: 0n,
        pendingToken: 0n,
      };
    }
    const pos = decodeSolStakePosition(Buffer.from(b64, 'base64'));
    if (!pos) return null;
    const pool = await readSolStakePool(rpc, programId, mint, baseMint);
    return {
      amount: pos.amount,
      weight: pos.weight,
      lockDays: pos.lockDays,
      lockUntil: pos.lockUntil,
      pendingBase:
        pos.unclaimedBase +
        (pool ? solPending(pos.weight, pool.accBasePerWeight, pos.baseDebt) : 0n),
      pendingToken:
        pos.unclaimedToken +
        (pool ? solPending(pos.weight, pool.accTokenPerWeight, pos.tokenDebt) : 0n),
    };
  } catch {
    return null;
  }
}
