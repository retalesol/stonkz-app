/**
 * Launchpad tunables, as the contracts hold them.
 *
 * Both programs expose the same `Params` record (EVM `effectiveParams()`,
 * Solana the `params` PDA). The admin sets them on chain; the API reads them
 * (`apps/api/src/chain/params.ts`) and the web gets them from
 * `GET /platform/status`. Every fee / cashback / graduation helper in this
 * package takes one of these as an optional last argument and falls back to
 * {@link DEFAULT_CURVE_PARAMS}, which are exactly the values the contracts
 * apply when nothing was ever set — so the practice mode, an offline web and
 * an unreachable RPC all land on the numbers the chain itself defaults to.
 *
 * Bps fields are integers out of 10 000; `maxBuyNative` is a decimal string of
 * native atoms (wei) because it is a `uint256` and `0` means uncapped.
 */
export interface CurveParams {
  /** Platform revenue leg (the on-chain "protocol" vault). */
  feeProtocolBps: number;
  /** `$STONKZ` buyback leg (the on-chain "ops" vault). */
  feeOpsBps: number;
  /** RWA crate-fund leg (the on-chain "burn" vault). */
  feeBurnBps: number;
  /** Lowest creator-set curve fee a launch may choose. */
  minFeeBps: number;
  /** Highest creator-set curve fee a launch may choose. */
  maxFeeBps: number;
  /** The fee a cashback window opens at, decaying down to the creator's own fee. */
  cbStartFeeBps: number;
  /** Cashback window length, whole seconds. */
  cbWindowSecs: number;
  /** Graduation market cap, whole USD. */
  gradUsd: number;
  /** Largest whole-token supply a launch may pick. */
  maxSupply: number;
  /** Router cap on `msg.value` per buy, native atoms as a decimal string; `'0'` = uncapped. */
  maxBuyNative: string;
}

/** Contract defaults: 1500/1000/600/100/500/5000, 300 s, $69 000, 1e12, uncapped. */
export const DEFAULT_CURVE_PARAMS: Readonly<CurveParams> = Object.freeze({
  feeProtocolBps: 1500,
  feeOpsBps: 1000,
  feeBurnBps: 600,
  minFeeBps: 100,
  maxFeeBps: 500,
  cbStartFeeBps: 5000,
  cbWindowSecs: 300,
  gradUsd: 69_000,
  maxSupply: 1e12,
  maxBuyNative: '0',
});

/** Bps denominator shared by every ratio below. */
export const BPS = 10_000;

/** The four curve-fee legs as fractions summing to 1 (creator bucket is the remainder). */
export interface FeeSplitRatios {
  creatorBucket: number;
  protocol: number;
  buyback: number;
  rwa: number;
}

export function feeSplitOf(p: CurveParams = DEFAULT_CURVE_PARAMS): FeeSplitRatios {
  const protocol = p.feeProtocolBps / BPS;
  const buyback = p.feeOpsBps / BPS;
  const rwa = p.feeBurnBps / BPS;
  return { creatorBucket: Math.max(0, 1 - protocol - buyback - rwa), protocol, buyback, rwa };
}

/** Cashback window in milliseconds — what the UI's countdowns run on. */
export function cbWindowMs(p: CurveParams = DEFAULT_CURVE_PARAMS): number {
  return p.cbWindowSecs * 1000;
}

/** The fee a cashback window opens at, percent. */
export function cbStartFeePct(p: CurveParams = DEFAULT_CURVE_PARAMS): number {
  return p.cbStartFeeBps / 100;
}

/** Creator fee bounds, percent — the launch slider's range. */
export function feeBoundsPct(p: CurveParams = DEFAULT_CURVE_PARAMS): { min: number; max: number } {
  return { min: p.minFeeBps / 100, max: p.maxFeeBps / 100 };
}

/** Implied USD cap at mint: virtual reserves put it at a sixteenth of graduation. */
export function curveStartMc(p: CurveParams = DEFAULT_CURVE_PARAMS): number {
  return p.gradUsd / 16;
}

/**
 * The rules both programs enforce in `set_params` / `setParams`, so the admin
 * form and the API refuse the same inputs the chain would revert on. Returns
 * every violation, not just the first, for a form that can mark fields.
 */
export function validateCurveParams(p: CurveParams): string[] {
  const errors: string[] = [];
  const bps = (v: number): boolean => Number.isInteger(v) && v >= 0 && v <= BPS;
  for (const key of [
    'feeProtocolBps',
    'feeOpsBps',
    'feeBurnBps',
    'minFeeBps',
    'maxFeeBps',
    'cbStartFeeBps',
  ] as const) {
    if (!bps(p[key])) errors.push(`${key} must be an integer between 0 and ${BPS}`);
  }
  if (p.feeProtocolBps + p.feeOpsBps + p.feeBurnBps > BPS) {
    errors.push('protocol + ops + burn must be at most 10000 bps');
  }
  if (!(p.maxFeeBps > 0)) errors.push('maxFeeBps must be positive');
  if (!(p.minFeeBps <= p.maxFeeBps)) errors.push('minFeeBps must be at most maxFeeBps');
  if (!(p.maxFeeBps <= p.cbStartFeeBps)) errors.push('maxFeeBps must be at most cbStartFeeBps');
  if (!(Number.isInteger(p.cbWindowSecs) && p.cbWindowSecs > 0 && p.cbWindowSecs <= 0xffffffff)) {
    errors.push('cbWindowSecs must be a positive integer (uint32)');
  }
  if (!(Number.isFinite(p.gradUsd) && p.gradUsd > 0)) errors.push('gradUsd must be positive');
  if (!(Number.isFinite(p.maxSupply) && p.maxSupply > 0 && p.maxSupply <= 1e12)) {
    errors.push('maxSupply must be in (0, 1e12]');
  }
  if (!/^[0-9]+$/.test(p.maxBuyNative))
    errors.push('maxBuyNative must be a decimal integer string');
  return errors;
}

/** Fill in anything missing from a partial record with the defaults. */
export function withDefaultParams(p: Partial<CurveParams> | null | undefined): CurveParams {
  return { ...DEFAULT_CURVE_PARAMS, ...(p ?? {}) };
}

/* -------------------------------------------------------------------------- */
/* EVM packed word                                                            */
/* -------------------------------------------------------------------------- */

/**
 * `StonkzLaunchpad.paramsWord()` / `setParams(uint256)`: the record packed
 * into one `uint256`, low bits first —
 *
 * | bits    | field            |
 * | ------- | ---------------- |
 * | 0-15    | feeProtocolBps   |
 * | 16-31   | feeOpsBps        |
 * | 32-47   | feeBurnBps       |
 * | 48-63   | minFeeBps        |
 * | 64-79   | maxFeeBps        |
 * | 80-95   | cbStartFeeBps    |
 * | 96-127  | cbWindowSecs     |
 * | 128-191 | gradMcapUsd1e6   |
 * | 192-255 | maxSupply (whole) |
 *
 * A word of `0` on chain means "nothing set": the contract applies
 * {@link DEFAULT_CURVE_PARAMS}. `maxBuyNative` is not in the word — it lives
 * on the router (`StonkzRouter.maxBuyNative()`).
 */
export type ParamsWordFields = Omit<CurveParams, 'maxBuyNative'>;

const U16 = (1n << 16n) - 1n;
const U32 = (1n << 32n) - 1n;
const U64 = (1n << 64n) - 1n;
const U256 = (1n << 256n) - 1n;

function fit(v: number, max: bigint, what: string): bigint {
  const b = BigInt(Math.round(v));
  if (b < 0n || b > max) throw new RangeError(`${what} does not fit its field`);
  return b;
}

/** Pack the record into the launchpad's `uint256` word. Throws `RangeError` on an out-of-range field. */
export function packParamsWord(p: ParamsWordFields): bigint {
  if (!Number.isFinite(p.gradUsd) || !Number.isFinite(p.maxSupply)) {
    throw new RangeError('gradUsd and maxSupply must be finite');
  }
  return (
    fit(p.feeProtocolBps, U16, 'feeProtocolBps') |
    (fit(p.feeOpsBps, U16, 'feeOpsBps') << 16n) |
    (fit(p.feeBurnBps, U16, 'feeBurnBps') << 32n) |
    (fit(p.minFeeBps, U16, 'minFeeBps') << 48n) |
    (fit(p.maxFeeBps, U16, 'maxFeeBps') << 64n) |
    (fit(p.cbStartFeeBps, U16, 'cbStartFeeBps') << 80n) |
    (fit(p.cbWindowSecs, U32, 'cbWindowSecs') << 96n) |
    (fit(Math.round(p.gradUsd * 1e6), U64, 'gradMcapUsd1e6') << 128n) |
    (fit(p.maxSupply, U64, 'maxSupply') << 192n)
  );
}

/** Unpack a word into its fields. `0n` unpacks to all zeros — callers map that to the defaults. */
export function unpackParamsWord(word: bigint): ParamsWordFields {
  if (word < 0n || word > U256) throw new RangeError('params word must be a uint256');
  const u16 = (shift: bigint): number => Number((word >> shift) & U16);
  return {
    feeProtocolBps: u16(0n),
    feeOpsBps: u16(16n),
    feeBurnBps: u16(32n),
    minFeeBps: u16(48n),
    maxFeeBps: u16(64n),
    cbStartFeeBps: u16(80n),
    cbWindowSecs: Number((word >> 96n) & U32),
    gradUsd: Number((word >> 128n) & U64) / 1e6,
    maxSupply: Number((word >> 192n) & U64),
  };
}

/** `unpackParamsWord`, with `0n` read as the contract defaults. */
export function paramsFromWord(word: bigint): ParamsWordFields {
  if (word === 0n) {
    const { maxBuyNative: _omit, ...rest } = DEFAULT_CURVE_PARAMS;
    return rest;
  }
  return unpackParamsWord(word);
}

/** The defaults, packed — what an admin form shows as the word for an untouched contract. */
export const DEFAULT_PARAMS_WORD: bigint = packParamsWord(DEFAULT_CURVE_PARAMS);
