import { describe, expect, it } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import { CURVE_ACCOUNT_DISC } from '../router/curve-sync.js';
import { derivePdas, deriveStakePositionPda } from '../router/solana-idl.js';
import {
  STAKE_POSITION_ACCOUNT_DISC,
  decodeSolCurveStakePool,
  decodeSolStakePosition,
  parseCoinsStakePool,
  readSolStakePosition,
} from './stake-reads.js';

/**
 * Byte-level decoders for the Solana stake accounts (`state.rs`) and the EVM
 * `coins()` tuple. Buffers are written field by field in declaration order,
 * the way Anchor's Borsh serialiser lays them out.
 */

class W {
  private parts: Buffer[] = [];
  bytes(b: Buffer): this {
    this.parts.push(b);
    return this;
  }
  u8(v: number): this {
    return this.bytes(Buffer.from([v]));
  }
  u16(v: number): this {
    const b = Buffer.alloc(2);
    b.writeUInt16LE(v);
    return this.bytes(b);
  }
  u32(v: number): this {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(v);
    return this.bytes(b);
  }
  u64(v: bigint): this {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(v);
    return this.bytes(b);
  }
  i64(v: bigint): this {
    const b = Buffer.alloc(8);
    b.writeBigInt64LE(v);
    return this.bytes(b);
  }
  u128(v: bigint): this {
    return this.u64(v & 0xffff_ffff_ffff_ffffn).u64(v >> 64n);
  }
  key(k: PublicKey): this {
    return this.bytes(k.toBuffer());
  }
  done(): Buffer {
    return Buffer.concat(this.parts);
  }
}

const PROGRAM = Keypair.generate().publicKey;
const MINT = Keypair.generate().publicKey;
const BASE = new PublicKey('So11111111111111111111111111111111111111112');
const OWNER = Keypair.generate().publicKey;
const ACC = 10n ** 18n;

function positionAccount(p: {
  amount: bigint;
  lockDays: number;
  weight: bigint;
  lockUntil: bigint;
  baseDebt?: bigint;
  unclaimedBase?: bigint;
}): Buffer {
  return new W()
    .bytes(STAKE_POSITION_ACCOUNT_DISC)
    .u8(254)
    .key(Keypair.generate().publicKey)
    .key(OWNER)
    .u64(p.amount)
    .u16(p.lockDays)
    .u128(p.weight)
    .i64(p.lockUntil)
    .u128(p.baseDebt ?? 0n)
    .u128(0n)
    .u64(p.unclaimedBase ?? 0n)
    .u64(0n)
    .done();
}

function curveAccount(p: {
  graduationReason: null | 0 | 1;
  eligibleStaked: bigint;
  flexStaked: bigint;
  totalWeight: bigint;
  accBase: bigint;
  stakerAccruedBase: bigint;
}): Buffer {
  const w = new W()
    .bytes(CURVE_ACCOUNT_DISC)
    .u8(255)
    .key(MINT)
    .key(BASE)
    .key(OWNER)
    .u32(7)
    .bytes(Buffer.from('MEMEMAN'))
    .u64(1_000_000_000_000_000n) // supply
    .u8(6)
    .u8(9)
    .u16(100)
    .u8(0)
    .i64(0n)
    .u128(30n * 10n ** 9n) // virtual_base
    .u128(1_073_000_000n * 10n ** 6n) // virtual_token
    .u64(10n ** 9n) // real_base
    .u64(700_000_000_000_000n) // real_token
    .u128(1n)
    .u128(1n)
    .u128(1n)
    .u64(800_000_000_000_000n) // tokens_for_sale
    .u64(200_000_000_000_000n) // lp_reserve
    .u128(1n)
    .u64(200_000_000n)
    .u8(0)
    .u8(p.graduationReason === null ? 0 : 1);
  if (p.graduationReason === null) w.u8(0);
  else w.u8(1).u8(p.graduationReason);
  return w
    .i64(0n)
    .u8(0)
    .key(Keypair.generate().publicKey)
    .u64(0n)
    .u64(1n)
    .u64(2n)
    .u64(3n)
    .u64(4n)
    .u64(5n)
    .u64(p.eligibleStaked)
    .u64(p.flexStaked)
    .u128(p.totalWeight)
    .u128(p.accBase)
    .u128(0n)
    .u64(0n)
    .u64(0n)
    .u64(p.stakerAccruedBase)
    .u64(0n)
    .done();
}

describe('Solana stake account decoders', () => {
  it('decodes a StakePosition', () => {
    const pos = decodeSolStakePosition(
      positionAccount({
        amount: 6_182_000_000n,
        lockDays: 0,
        weight: 0n,
        lockUntil: 1_790_000_000n,
      }),
    );
    expect(pos).toMatchObject({
      amount: 6_182_000_000n,
      lockDays: 0,
      weight: 0n,
      lockUntil: 1_790_000_000,
    });
  });

  it('rejects a foreign account', () => {
    const buf = positionAccount({ amount: 1n, lockDays: 0, weight: 0n, lockUntil: 0n });
    buf[0] ^= 0xff;
    expect(decodeSolStakePosition(buf)).toBeNull();
    expect(decodeSolStakePosition(Buffer.alloc(10))).toBeNull();
  });

  it.each([null, 0, 1] as const)('walks the Curve to the stake pool (graduation %s)', (reason) => {
    const pool = decodeSolCurveStakePool(
      curveAccount({
        graduationReason: reason,
        eligibleStaked: 1_000n,
        flexStaked: 6_182n,
        totalWeight: 1_500n,
        accBase: 7n,
        stakerAccruedBase: 99n,
      }),
    );
    expect(pool).toMatchObject({
      eligibleStaked: 1_000n,
      flexStaked: 6_182n,
      totalWeight: 1_500n,
      accBasePerWeight: 7n,
      stakerAccruedBase: 99n,
      tokensForSale: 800_000_000_000_000n,
      realToken: 700_000_000_000_000n,
    });
  });

  it('reads a position with its pending rewards off the accumulator', async () => {
    const [positionPda] = deriveStakePositionPda(PROGRAM, MINT, OWNER);
    const curvePda = derivePdas(PROGRAM, MINT, BASE).curve;
    const accounts = new Map<string, string>([
      [
        positionPda.toBase58(),
        positionAccount({
          amount: 1_000_000n,
          lockDays: 30,
          weight: 1_500_000n,
          lockUntil: 1_790_000_000n,
          baseDebt: 2n * ACC,
          unclaimedBase: 10n,
        }).toString('base64'),
      ],
      [
        curvePda.toBase58(),
        curveAccount({
          graduationReason: null,
          eligibleStaked: 1_000_000n,
          flexStaked: 0n,
          totalWeight: 1_500_000n,
          accBase: 3n * ACC,
          stakerAccruedBase: 0n,
        }).toString('base64'),
      ],
    ]);
    const rpc = { getAccountDataBase64: async (a: string) => accounts.get(a) ?? null };
    const pos = await readSolStakePosition(
      rpc,
      PROGRAM.toBase58(),
      MINT.toBase58(),
      BASE.toBase58(),
      OWNER.toBase58(),
    );
    // unclaimed 10 + weight 1.5e6 * (3 - 2) * ACC / ACC.
    expect(pos).toMatchObject({ amount: 1_000_000n, lockDays: 30, pendingBase: 1_500_010n });
  });

  it('reads no account as an empty position', async () => {
    const rpc = { getAccountDataBase64: async () => null };
    const pos = await readSolStakePosition(
      rpc,
      PROGRAM.toBase58(),
      MINT.toBase58(),
      BASE.toBase58(),
      OWNER.toBase58(),
    );
    expect(pos?.amount).toBe(0n);
  });
});

describe('parseCoinsStakePool', () => {
  it('refuses a short or unknown-token answer', () => {
    expect(parseCoinsStakePool('0x')).toBeNull();
    expect(parseCoinsStakePool('0x' + '0'.repeat(64 * 38))).toBeNull();
  });
});
