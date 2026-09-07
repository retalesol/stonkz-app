/**
 * Float human-units <-> bigint atoms, at whatever decimal count applies.
 *
 * Every aggregator API and `@stonkz/curve-sim` speak atoms as `bigint`; every
 * request query string and every DB column that predates this phase (`amount`,
 * `mc`, `supply`, …) speaks whole/human units as `number`. This is the one
 * seam where the two meet, so it is the one place float precision is spent.
 *
 * `toFixed` rather than `Math.round(amount * 10 ** decimals)`: for decimals
 * beyond ~15 (SOL's 9 is fine, but ETH's 18 is not) `10 ** decimals` already
 * exceeds float's exact-integer range, so multiplying first and rounding
 * second silently corrupts the low digits. Formatting the float to a fixed
 * number of decimal *places* first and parsing the digits as text keeps the
 * arithmetic in `bigint` from the point decimal precision could matter.
 */
export function toAtoms(amount: number, decimals: number): bigint {
  if (!Number.isFinite(amount) || amount < 0) {
    throw new Error(`toAtoms: amount must be a non-negative finite number, got ${amount}`);
  }
  if (!Number.isInteger(decimals) || decimals < 0) {
    throw new Error(`toAtoms: decimals must be a non-negative integer, got ${decimals}`);
  }
  const fixed = amount.toFixed(decimals);
  const negIdx = fixed.indexOf('-');
  const clean = negIdx === -1 ? fixed : fixed.slice(negIdx + 1); // toFixed(0) never emits "-0.", guard anyway
  const [whole, frac = ''] = clean.split('.');
  const fracPadded = frac.padEnd(decimals, '0').slice(0, decimals);
  const wholePart = BigInt(whole || '0');
  const fracPart = decimals > 0 ? BigInt(fracPadded || '0') : 0n;
  return wholePart * 10n ** BigInt(decimals) + fracPart;
}

/** Inverse of {@link toAtoms}. Precision beyond float64 is intentionally lost. */
export function fromAtoms(atoms: bigint, decimals: number): number {
  if (!Number.isInteger(decimals) || decimals < 0) {
    throw new Error(`fromAtoms: decimals must be a non-negative integer, got ${decimals}`);
  }
  const neg = atoms < 0n;
  const abs = neg ? -atoms : atoms;
  const s = abs.toString().padStart(decimals + 1, '0');
  const whole = s.slice(0, s.length - decimals) || '0';
  const frac = decimals > 0 ? s.slice(s.length - decimals) : '';
  const n = Number.parseFloat(decimals > 0 ? `${whole}.${frac}` : whole);
  return neg ? -n : n;
}

/** Applies a slippage tolerance (percent, e.g. `1` = 1%) as a floor on an expected output. */
export function applySlippageFloor(expectedOutAtoms: bigint, slippagePct: number): bigint {
  if (!Number.isFinite(slippagePct) || slippagePct < 0) {
    throw new Error(`applySlippageFloor: slippagePct must be a non-negative finite number, got ${slippagePct}`);
  }
  // bps at 1/100 pct resolution, applied in bigint math so a huge atom count
  // (fully-staked curves reach ~1e31) never round-trips through a float.
  const bps = BigInt(Math.round(slippagePct * 100));
  const floor = (expectedOutAtoms * (10_000n - bps)) / 10_000n;
  return floor < 0n ? 0n : floor;
}
