import bs58 from 'bs58';

/**
 * A cursor over Borsh-encoded bytes, covering exactly the primitives the
 * launchpad's `#[event]` structs use.
 *
 * Written by hand rather than pulled from `@coral-xyz/anchor`: the only
 * checked-in description of these events is `programs/solana/.../events.rs`
 * (the IDL under `target/` is a build artifact the repo excludes), so a
 * schema-driven coder would have nothing to load anyway. The layouts live
 * beside the decoder in `solana-events.ts` and are pinned by tests against
 * bytes produced from those same Rust struct definitions.
 *
 * Every read is bounds-checked. A truncated log line must fail loudly and get
 * dead-lettered, never silently decode as zeros.
 */
export class BorshReader {
  private offset = 0;

  constructor(private readonly buf: Buffer) {}

  get consumed(): number {
    return this.offset;
  }

  get remaining(): number {
    return this.buf.length - this.offset;
  }

  private take(n: number): Buffer {
    if (this.offset + n > this.buf.length) {
      throw new BorshError(
        `out of bounds: need ${n} byte(s) at ${this.offset} of ${this.buf.length}`,
      );
    }
    const slice = this.buf.subarray(this.offset, this.offset + n);
    this.offset += n;
    return slice;
  }

  u8(): number {
    return this.take(1)[0] as number;
  }

  bool(): boolean {
    const byte = this.u8();
    if (byte !== 0 && byte !== 1) throw new BorshError(`bool must be 0 or 1, got ${byte}`);
    return byte === 1;
  }

  u16(): number {
    return this.take(2).readUInt16LE(0);
  }

  u32(): number {
    return this.take(4).readUInt32LE(0);
  }

  u64(): bigint {
    return this.take(8).readBigUInt64LE(0);
  }

  i64(): bigint {
    return this.take(8).readBigInt64LE(0);
  }

  u128(): bigint {
    const lo = this.take(8).readBigUInt64LE(0);
    const hi = this.take(8).readBigUInt64LE(0);
    return (hi << 64n) | lo;
  }

  /** 32 raw bytes, returned base58-encoded — the form every read table stores. */
  pubkey(): string {
    return bs58.encode(this.take(32));
  }

  /** Borsh string: `u32` byte length, then UTF-8. */
  string(): string {
    const len = this.u32();
    // A ticker is at most a handful of bytes; anything huge means the layout
    // drifted and we are reading a length out of the middle of a number.
    if (len > 1_000_000) throw new BorshError(`string length ${len} is implausible`);
    return this.take(len).toString('utf8');
  }

  /** Rejects trailing bytes, which mean the layout and the emitted struct disagree. */
  assertExhausted(context: string): void {
    if (this.remaining !== 0) {
      throw new BorshError(`${context}: ${this.remaining} trailing byte(s) after decode`);
    }
  }
}

export class BorshError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BorshError';
  }
}
