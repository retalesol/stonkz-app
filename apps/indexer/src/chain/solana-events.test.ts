import { describe, expect, it } from 'vitest';
import { AnchorEventCoder, eventDiscriminator, programDataPayloads } from './anchor.js';
import { BorshError, BorshReader } from './borsh.js';
import { launchpadEventCoder, LAUNCHPAD_EVENT_LAYOUTS } from './solana-events.js';
import {
  CREATOR,
  DOGGO_MINT,
  TRADER,
  WSOL_MINT,
  emitCpiPayload,
  emitPayload,
  encodeCreatorFeesClaimed,
  encodeFeeAccrued,
  encodeGraduated,
  encodeLiquidityMigrated,
  encodeStakeClaimed,
  encodeStaked,
  encodeTokenCreated,
  encodeTrade,
  encodeTreasuryCredit,
  encodeTreasuryWithdrawn,
  encodeUnstaked,
  programDataLine,
} from '../test/solana-fixtures.js';

/**
 * Anchor's event discriminators, recorded once as literal bytes.
 *
 * The decoder derives these at runtime from `sha256("event:<Name>")`, so a
 * test that recomputed them would be tautological. Pinning the bytes is what
 * catches a *renamed* event in `events.rs`: the rename would change the
 * discriminator, real logs would stop matching, and the indexer would silently
 * ingest nothing. That failure mode is invisible without this table.
 */
const DISCRIMINATORS: Record<string, number[]> = {
  TokenCreated: [236, 19, 41, 255, 130, 78, 147, 172],
  Trade: [24, 254, 218, 152, 253, 43, 18, 81],
  FeeAccrued: [61, 83, 48, 144, 144, 50, 153, 45],
  TreasuryCredit: [162, 91, 194, 155, 235, 4, 184, 132],
  Graduated: [51, 241, 66, 50, 140, 245, 156, 192],
  LiquidityMigrated: [27, 161, 105, 19, 236, 128, 146, 13],
  CreatorFeesClaimed: [189, 178, 21, 181, 171, 179, 131, 1],
  Staked: [11, 146, 45, 205, 230, 58, 213, 240],
  Unstaked: [27, 179, 156, 215, 47, 71, 195, 7],
  StakeClaimed: [231, 124, 83, 169, 100, 57, 96, 131],
  TreasuryWithdrawn: [143, 181, 157, 169, 87, 155, 170, 46],
};

describe('anchor event discriminators', () => {
  it('matches the pinned bytes for every launchpad event', () => {
    for (const [name, bytes] of Object.entries(DISCRIMINATORS)) {
      expect([...eventDiscriminator(name)], name).toEqual(bytes);
    }
  });

  it('covers every event declared in events.rs, and nothing more', () => {
    expect(launchpadEventCoder.names().sort()).toEqual(Object.keys(DISCRIMINATORS).sort());
    expect(LAUNCHPAD_EVENT_LAYOUTS).toHaveLength(Object.keys(DISCRIMINATORS).length);
  });
});

const TOKEN_CREATED = {
  mint: DOGGO_MINT,
  baseMint: WSOL_MINT,
  creator: CREATOR,
  ticker: 'DOGGO',
  supply: 1_000_000_000_000_000n,
  feeBps: 250,
  cashback: true,
  cbStart: 1_757_000_000n,
  virtualBase: 21_495_327_102_804n,
  virtualToken: 1_066_666_666_666_666n,
  tokensForSale: 800_000_000_000_000n,
  lpReserve: 200_000_000_000_000n,
  gradMcapBase: 322_429_906_542_056n,
  basePrice1e6: 214_080_000n,
  ts: 1_757_000_000n,
} as const;

const TRADE = {
  mint: DOGGO_MINT,
  trader: TRADER,
  isBuy: true,
  baseAmount: 1_500_000_000n,
  tokenAmount: 73_100_000_000n,
  effFeeBps: 250,
  inCashback: false,
  feeTotal: 37_500_000n,
  feeProtocol: 7_500_000n,
  feeOps: 3_750_000n,
  feeCreatorBucket: 26_250_000n,
  feeStakers: 5_000_000n,
  feeCreator: 21_250_000n,
  cashbackTokens: 0n,
  virtualBase: 21_532_827_102_804n,
  virtualToken: 1_066_593_566_666_666n,
  realBase: 1_462_500_000n,
  realToken: 799_926_900_000_000n,
  circulating: 73_100_000_000n,
  ts: 1_757_000_100n,
} as const;

describe('launchpad event decoding', () => {
  it('round-trips every event through the encoder and the decoder', () => {
    const cases: [string, Buffer][] = [
      ['TokenCreated', encodeTokenCreated(TOKEN_CREATED)],
      ['Trade', encodeTrade(TRADE)],
      [
        'FeeAccrued',
        encodeFeeAccrued({
          mint: DOGGO_MINT,
          baseMint: WSOL_MINT,
          feeTotal: 37_500_000n,
          protocol: 7_500_000n,
          ops: 3_750_000n,
          creatorBucket: 26_250_000n,
          ts: 1n,
        }),
      ],
      [
        'TreasuryCredit',
        encodeTreasuryCredit({ baseMint: WSOL_MINT, protocolDelta: 7_500_000n, opsDelta: 3_750_000n, ts: 2n }),
      ],
      [
        'Graduated',
        encodeGraduated({
          mint: DOGGO_MINT,
          baseMint: WSOL_MINT,
          reason: 1,
          baseMigrated: 322_429_906_542_056n,
          tokensMigrated: 200_000_000_000_000n,
          tokensBurned: 0n,
          mcapBase: 4_836_448_598_130_840n,
          mcapUsd1e6: 69_000_000_000n,
          ts: 3n,
        }),
      ],
      [
        'LiquidityMigrated',
        encodeLiquidityMigrated({
          mint: DOGGO_MINT,
          baseMint: WSOL_MINT,
          pool: CREATOR,
          position: TRADER,
          baseDeposited: 1n,
          tokenDeposited: 2n,
          lockReleasePoint: 0xffff_ffff_ffff_ffffn,
          positionLocked: 1n,
          ts: 4n,
        }),
      ],
      [
        'CreatorFeesClaimed',
        encodeCreatorFeesClaimed({
          mint: DOGGO_MINT,
          creator: CREATOR,
          baseAmount: 420_000_000n,
          tokenAmount: 0n,
          ts: 5n,
        }),
      ],
      [
        'Staked',
        encodeStaked({
          mint: DOGGO_MINT,
          owner: TRADER,
          amount: 40_000_000_000_000n,
          lockDays: 30,
          weight: 60_000_000_000_000n,
          lockUntil: 1_759_592_000n,
          eligibleStaked: 40_000_000_000_000n,
          totalWeight: 60_000_000_000_000n,
          ts: 6n,
        }),
      ],
      [
        'Unstaked',
        encodeUnstaked({
          mint: DOGGO_MINT,
          owner: TRADER,
          amount: 1_000_000n,
          eligibleStaked: 0n,
          totalWeight: 0n,
          ts: 7n,
        }),
      ],
      [
        'StakeClaimed',
        encodeStakeClaimed({
          mint: DOGGO_MINT,
          owner: TRADER,
          baseAmount: 50_000_000n,
          tokenAmount: 0n,
          ts: 8n,
        }),
      ],
      [
        'TreasuryWithdrawn',
        encodeTreasuryWithdrawn({ baseMint: WSOL_MINT, which: 0, amount: 1n, destination: CREATOR, ts: 9n }),
      ],
    ];

    for (const [name, body] of cases) {
      const decoded = launchpadEventCoder.decode(emitPayload(name, body).toString('base64'));
      expect(decoded, name).not.toBeNull();
      expect(decoded?.name, name).toBe(name);
      expect(decoded?.data.kind, name).toBe(name);
    }
    expect(cases).toHaveLength(Object.keys(DISCRIMINATORS).length);
  });

  it('decodes every TokenCreated field, including u128 and the ticker string', () => {
    const decoded = launchpadEventCoder.decode(
      emitPayload('TokenCreated', encodeTokenCreated(TOKEN_CREATED)).toString('base64'),
    );
    expect(decoded?.data).toEqual({ kind: 'TokenCreated', ...TOKEN_CREATED });
  });

  it('decodes every Trade field, so the fee legs survive intact', () => {
    const decoded = launchpadEventCoder.decode(
      emitPayload('Trade', encodeTrade(TRADE)).toString('base64'),
    );
    expect(decoded?.data).toEqual({ kind: 'Trade', ...TRADE });
  });

  it('reads a u128 above 2^64, which a u64 field would silently truncate', () => {
    const big = (1n << 90n) + 12_345n;
    const decoded = launchpadEventCoder.decode(
      emitPayload('TokenCreated', encodeTokenCreated({ ...TOKEN_CREATED, virtualBase: big })).toString(
        'base64',
      ),
    );
    expect(decoded?.data.kind === 'TokenCreated' && decoded.data.virtualBase).toBe(big);
  });

  it('accepts the emit_cpi! framing as well as emit!', () => {
    const cpi = emitCpiPayload('Trade', encodeTrade(TRADE));
    const decoded = launchpadEventCoder.decodeBytes(cpi);
    expect(decoded?.name).toBe('Trade');
  });

  it('ignores a payload whose discriminator belongs to another program', () => {
    const foreign = Buffer.concat([eventDiscriminator('SomeOtherProgramEvent'), Buffer.alloc(64)]);
    expect(launchpadEventCoder.decodeBytes(foreign)).toBeNull();
    // Too short to even carry a discriminator.
    expect(launchpadEventCoder.decodeBytes(Buffer.alloc(4))).toBeNull();
  });

  it('rejects a truncated body instead of decoding it as zeros', () => {
    const body = encodeTrade(TRADE);
    const truncated = emitPayload('Trade', body.subarray(0, body.length - 9));
    expect(() => launchpadEventCoder.decodeBytes(truncated)).toThrow(BorshError);
  });

  it('rejects trailing bytes, which mean the layout drifted from events.rs', () => {
    const padded = Buffer.concat([emitPayload('Trade', encodeTrade(TRADE)), Buffer.from([0])]);
    expect(() => launchpadEventCoder.decodeBytes(padded)).toThrow(/trailing byte/);
  });

  it('pulls Program data payloads out of a real-shaped log block, in order', () => {
    const logs = [
      `Program ${DOGGO_MINT} invoke [1]`,
      'Program log: Instruction: Buy',
      programDataLine('Trade', encodeTrade(TRADE)),
      'Program log: something unrelated',
      programDataLine(
        'FeeAccrued',
        encodeFeeAccrued({
          mint: DOGGO_MINT,
          baseMint: WSOL_MINT,
          feeTotal: 37_500_000n,
          protocol: 7_500_000n,
          ops: 3_750_000n,
          creatorBucket: 26_250_000n,
          ts: 1n,
        }),
      ),
      'Program consumed 12345 of 200000 compute units',
    ];
    const payloads = programDataPayloads(logs);
    expect(payloads).toHaveLength(2);
    expect(payloads.map((p) => launchpadEventCoder.decode(p)?.name)).toEqual(['Trade', 'FeeAccrued']);
  });

  it('is not fooled by a log line that merely contains the words', () => {
    expect(programDataPayloads(['Program log: writing Program data: to disk'])).toEqual(['to disk']);
    // …which then fails the discriminator check rather than decoding.
    expect(launchpadEventCoder.decode('to disk')).toBeNull();
  });
});

describe('BorshReader', () => {
  it('bounds-checks every read', () => {
    const r = new BorshReader(Buffer.from([1, 2, 3]));
    expect(r.u16()).toBe(0x0201);
    expect(() => r.u64()).toThrow(BorshError);
  });

  it('refuses a bool that is not 0 or 1', () => {
    expect(() => new BorshReader(Buffer.from([2])).bool()).toThrow(/bool must be 0 or 1/);
  });

  it('refuses an implausible string length instead of allocating on it', () => {
    const buf = Buffer.alloc(4);
    buf.writeUInt32LE(0xffff_ffff, 0);
    expect(() => new BorshReader(buf).string()).toThrow(/implausible/);
  });

  it('an empty coder matches nothing', () => {
    expect(new AnchorEventCoder([]).decodeBytes(Buffer.alloc(16))).toBeNull();
  });
});
