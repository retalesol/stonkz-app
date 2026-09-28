import { PublicKey } from '@solana/web3.js';
import type { NativeUnit } from '@stonkz/shared';
import type {
  ChainRpc,
  EvmCallSimulator,
  SolanaAccountDataSource,
  SolanaTransactionSimulator,
} from '../chain/types.js';

/**
 * `/launch/prepare`'s pre-sign checks: simulate the exact transaction the
 * wallet is about to sign, and map a failure to a code the web client can
 * act on — so nobody pays gas for a launch that can only revert.
 *
 * A failing *RPC* (timeout, 5xx) is not a failing *launch*: the caller logs
 * it and lets the prepare through rather than blocking every launch on a
 * flaky endpoint. Only an execution failure the node actually reported is
 * turned into an error.
 */

export interface PreflightRefusal {
  status: 409 | 422 | 503;
  error: string;
  detail: string;
  retryAfter?: number;
}

/**
 * Revert strings (`StonkzLaunchpad.sol` / `CurveMath.sol`) and Anchor error
 * names (`programs/solana/.../errors.rs`) → a client-facing refusal. The raw
 * reason never leaves the server.
 */
export function mapLaunchFailure(reason: string, unit: NativeUnit): PreflightRefusal {
  const r = reason;
  // EVM `Error(string)` text, isolated so a one-word revert like "ticker"
  // or "fee" is matched exactly rather than anywhere in a log dump.
  const evm = /execution reverted:?\s*(.*)$/im.exec(r)?.[1]?.trim().replace(/^"|"$/g, '') ?? '';

  if (/stale oracle|OracleStale|oracle price is stale/i.test(r)) {
    return {
      status: 503,
      error: 'oracle_stale',
      detail: 'price feed is updating, try again in a minute',
      retryAfter: 60,
    };
  }
  if (
    /OracleConfidence|confidence band|OraclePrice|price must be positive/i.test(r) ||
    evm === 'price'
  ) {
    return {
      status: 503,
      error: 'oracle_unavailable',
      detail: 'the on-chain price for this base is unavailable right now, try again shortly',
      retryAfter: 60,
    };
  }
  if (/launch paused|LaunchPaused|Launching is paused/i.test(r)) {
    return {
      status: 503,
      error: 'launch_paused',
      detail: 'launches are paused right now',
      retryAfter: 300,
    };
  }
  if (evm === 'ticker' || /InvalidTicker/.test(r)) {
    return {
      status: 422,
      error: 'invalid_ticker',
      detail: 'ticker must be 1-10 characters A-Z or 0-9',
    };
  }
  if (evm === 'fee' || /FeeOutOfRange/.test(r)) {
    return { status: 422, error: 'invalid_fee', detail: 'fee must be between 1.0 and 5.0 percent' };
  }
  if (evm === 'supply' || /UnsupportedSupply/.test(r)) {
    return {
      status: 422,
      error: 'invalid_supply',
      detail: 'supply must be one of 1e6, 5e8, 1e9, 1e12',
    };
  }
  if (/MetadataTooLong/.test(r)) {
    return { status: 422, error: 'metadata_too_long', detail: 'name or image link is too long' };
  }
  if (evm === 'slippage' || /SlippageExceeded|below the caller's minimum/i.test(r)) {
    return {
      status: 409,
      error: 'dev_buy_slippage',
      detail: 'the dev buy price moved; prepare the launch again',
    };
  }
  if (
    /insufficient (funds|lamports|balance)|InsufficientFundsFor(Fee|Rent)|"AccountNotFound"|custom program error: 0x1\b/i.test(
      r,
    )
  ) {
    return {
      status: 422,
      error: 'insufficient_funds',
      detail: `not enough ${unit} in this wallet to pay for the launch`,
    };
  }
  if (/BaseMintMismatch|AccountNotInitialized|decimals\(\)|non-contract/i.test(r)) {
    return {
      status: 422,
      error: 'base_not_supported',
      detail: 'this base asset has no on-chain price feed on this network yet',
    };
  }
  return {
    status: 422,
    error: 'simulation_failed',
    detail: 'the launch transaction would fail on-chain; nothing was signed',
  };
}

export function asEvmCallSimulator(rpc: ChainRpc): EvmCallSimulator | undefined {
  const c = rpc as Partial<EvmCallSimulator>;
  return typeof c.simulateCall === 'function' ? (c as EvmCallSimulator) : undefined;
}

export function asSolanaTransactionSimulator(
  rpc: ChainRpc,
): SolanaTransactionSimulator | undefined {
  const c = rpc as Partial<SolanaTransactionSimulator>;
  return typeof c.simulateTransaction === 'function'
    ? (c as SolanaTransactionSimulator)
    : undefined;
}

export function asSolanaAccountDataSource(rpc: ChainRpc): SolanaAccountDataSource | undefined {
  const c = rpc as Partial<SolanaAccountDataSource>;
  return typeof c.getAccountDataBase64 === 'function' ? (c as SolanaAccountDataSource) : undefined;
}

/* ------------------------------------------------------ Solana BaseOracle */

export interface SolanaBaseOracle {
  price1e6: bigint;
  conf1e6: bigint;
  publishTime: number;
  baseDecimals: number;
}

/** `[b"oracle", base_mint]` under the launchpad program (`constants.rs` `SEED_ORACLE`). */
export function solanaOraclePda(programId: PublicKey, baseMint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('oracle'), baseMint.toBuffer()],
    programId,
  )[0];
}

/**
 * `state.rs` `BaseOracle` after the 8-byte Anchor discriminator:
 * `bump u8 | base_mint [32] | price_1e6 u64 | conf_1e6 u64 | publish_time i64 | base_decimals u8`.
 * `null` for a short buffer, a zero price, or a `base_mint` that is not the
 * one asked for.
 */
export function decodeSolanaBaseOracle(
  data: Buffer,
  baseMint?: PublicKey,
): SolanaBaseOracle | null {
  const LEN = 8 + 1 + 32 + 8 + 8 + 8 + 1;
  if (data.length < LEN) return null;
  let o = 8 + 1;
  const mint = data.subarray(o, o + 32);
  o += 32;
  if (baseMint && !mint.equals(baseMint.toBuffer())) return null;
  const price1e6 = data.readBigUInt64LE(o);
  o += 8;
  const conf1e6 = data.readBigUInt64LE(o);
  o += 8;
  const publishTime = Number(data.readBigInt64LE(o));
  o += 8;
  const baseDecimals = data.readUInt8(o);
  if (price1e6 <= 0n) return null;
  return { price1e6, conf1e6, publishTime, baseDecimals };
}

/** Reads the BaseOracle the program will price `create_token` with. `null` if absent/unreadable. */
export async function readSolanaBaseOracle(
  source: SolanaAccountDataSource,
  programId: PublicKey,
  baseMint: PublicKey,
): Promise<SolanaBaseOracle | null> {
  const b64 = await source.getAccountDataBase64(solanaOraclePda(programId, baseMint).toBase58());
  if (!b64) return null;
  return decodeSolanaBaseOracle(Buffer.from(b64, 'base64'), baseMint);
}

/** Test/fixture helper: the account bytes {@link decodeSolanaBaseOracle} reads. */
export function encodeSolanaBaseOracle(
  baseMint: PublicKey,
  o: { price1e6: bigint; conf1e6?: bigint; publishTime?: number; baseDecimals: number },
): Buffer {
  const buf = Buffer.alloc(8 + 1 + 32 + 8 + 8 + 8 + 1);
  let off = 8;
  buf.writeUInt8(255, off);
  off += 1;
  baseMint.toBuffer().copy(buf, off);
  off += 32;
  buf.writeBigUInt64LE(o.price1e6, off);
  off += 8;
  buf.writeBigUInt64LE(o.conf1e6 ?? 0n, off);
  off += 8;
  buf.writeBigInt64LE(BigInt(o.publishTime ?? 0), off);
  off += 8;
  buf.writeUInt8(o.baseDecimals, off);
  return buf;
}
