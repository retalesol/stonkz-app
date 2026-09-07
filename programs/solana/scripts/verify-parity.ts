/**
 * Holds `programs/curve-sim.ts` to the vectors generated from the Rust program.
 *
 * Run with `pnpm --dir programs/solana verify:parity`. Any divergence is a
 * quote that would not match the fill, so this is a build gate, not a report.
 */
import { existsSync, readFileSync } from 'fs';
import { dirname, join, resolve } from 'path';

import {
  applyBuy,
  applySell,
  buyQuote,
  deriveCurve,
  effFeeBps,
  freshState,
  mcapBase,
  mcapUsd1e6,
  sellQuote,
  splitCreatorBucket,
  splitFee,
  type CurveState,
} from '../../curve-sim';

/** Walk up until we find the vectors, so this works from source or from the
 *  throwaway CJS build the parity tsconfig emits. */
function findVectors(): string {
  let dir = __dirname;
  for (let i = 0; i < 8; i += 1) {
    const p = join(dir, 'parity-vectors.json');
    if (existsSync(p)) return p;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  throw new Error(
    'parity-vectors.json not found. Generate it with `cargo test -p launchpad --lib parity`.',
  );
}

const vectorsPath = resolve(findVectors());
const vectors = JSON.parse(readFileSync(vectorsPath, 'utf8')) as any;

let checks = 0;
const failures: string[] = [];

function eq(actual: bigint | number | boolean, expected: bigint | number | boolean, what: string) {
  checks += 1;
  if (String(actual) !== String(expected)) {
    failures.push(`${what}: rust says ${expected}, typescript says ${actual}`);
  }
}

/**
 * The vectors are stored as columns — one array per field — because Foundry's
 * JSON cheatcodes cannot walk an array of objects. Zip them back into rows,
 * which is the shape the checks below want.
 */
function rows(cols: Record<string, any[]>): Record<string, any>[] {
  const keys = Object.keys(cols);
  const n = cols[keys[0]].length;
  for (const k of keys) {
    if (cols[k].length !== n) throw new Error(`ragged parity column: ${k}`);
  }
  return Array.from({ length: n }, (_, i) =>
    Object.fromEntries(keys.map((k) => [k, cols[k][i]])),
  );
}

/* ------------------------------------------------------------------ fee split */

for (const row of rows(vectors.feeSplit)) {
  const s = splitFee(BigInt(row.fee));
  eq(s.protocol, BigInt(row.protocol), `splitFee(${row.fee}).protocol`);
  eq(s.stonkzOps, BigInt(row.ops), `splitFee(${row.fee}).ops`);
  eq(s.creatorBucket, BigInt(row.creatorBucket), `splitFee(${row.fee}).creatorBucket`);
  eq(
    s.protocol + s.stonkzOps + s.creatorBucket,
    BigInt(row.fee),
    `splitFee(${row.fee}) must reconstruct the fee`,
  );
}

/* --------------------------------------------------------------- bucket split */

for (const row of rows(vectors.creatorBucketSplit)) {
  const r = splitCreatorBucket(
    BigInt(row.bucket),
    BigInt(row.eligibleStaked),
    BigInt(row.circulating),
  );
  eq(r.creator, BigInt(row.creator), `bucket(${row.bucket}/${row.eligibleStaked}).creator`);
  eq(r.stakers, BigInt(row.stakers), `bucket(${row.bucket}/${row.eligibleStaked}).stakers`);
}

/* ------------------------------------------------------------------- cashback */

for (const row of rows(vectors.effFeeBps)) {
  const got = effFeeBps(row.baseBps, row.cashback, 0n, BigInt(row.elapsedSecs));
  eq(got, row.effBps, `effFeeBps(${row.baseBps}, t=${row.elapsedSecs}, cb=${row.cashback})`);
}

/* --------------------------------------------------------------------- curves */

for (const c of vectors.curves) {
  const label = `supply=${c.supply} dec=${c.baseDecimals}`;
  const p = deriveCurve(BigInt(c.supplyAtoms), BigInt(c.price1e6), c.baseDecimals);
  if (!p) {
    failures.push(`${label}: deriveCurve returned null, rust derived it`);
    continue;
  }
  eq(p.tokensForSale, BigInt(c.tokensForSale), `${label} tokensForSale`);
  eq(p.lpReserve, BigInt(c.lpReserve), `${label} lpReserve`);
  eq(p.virtualToken, BigInt(c.virtualToken), `${label} virtualToken`);
  eq(p.virtualBase, BigInt(c.virtualBase), `${label} virtualBase`);
  eq(p.k, BigInt(c.k), `${label} k`);
  eq(p.gradMcapBase, BigInt(c.gradMcapBase), `${label} gradMcapBase`);

  let st: CurveState = freshState(p);
  for (const [i, fill] of rows(c.fills).entries()) {
    // The vector records the state the fill was quoted against; if our state
    // has drifted, say so here rather than reporting a downstream mismatch.
    eq(st.virtualBase, BigInt(fill.virtualBase), `${label} fill ${i} state.virtualBase`);
    eq(st.virtualToken, BigInt(fill.virtualToken), `${label} fill ${i} state.virtualToken`);
    eq(st.realToken, BigInt(fill.realToken), `${label} fill ${i} state.realToken`);
    eq(st.realBase, BigInt(fill.realBase), `${label} fill ${i} state.realBase`);

    if (fill.side === 'buy') {
      const f = buyQuote(st, fill.feeBps, BigInt(fill.amountIn));
      if (!f) {
        failures.push(`${label} fill ${i}: buyQuote returned null`);
        break;
      }
      eq(f.grossBase, BigInt(fill.grossBase), `${label} fill ${i} grossBase`);
      eq(f.fee, BigInt(fill.fee), `${label} fill ${i} fee`);
      eq(f.netBase, BigInt(fill.netBase), `${label} fill ${i} netBase`);
      eq(f.tokensOut, BigInt(fill.tokensOut), `${label} fill ${i} tokensOut`);
      eq(f.curveComplete, fill.curveComplete, `${label} fill ${i} curveComplete`);
      const s = splitFee(f.fee);
      eq(s.protocol, BigInt(fill.protocol), `${label} fill ${i} protocol`);
      eq(s.stonkzOps, BigInt(fill.ops), `${label} fill ${i} ops`);
      eq(s.creatorBucket, BigInt(fill.creatorBucket), `${label} fill ${i} creatorBucket`);
      st = applyBuy(st, f);
    } else {
      const amount = BigInt(fill.amountIn);
      const f = sellQuote(st, fill.feeBps, amount);
      if (!f) {
        failures.push(`${label} fill ${i}: sellQuote returned null`);
        break;
      }
      eq(f.grossBase, BigInt(fill.grossBase), `${label} fill ${i} grossBase`);
      eq(f.fee, BigInt(fill.fee), `${label} fill ${i} fee`);
      eq(f.netBase, BigInt(fill.netBase), `${label} fill ${i} netBase`);
      const s = splitFee(f.fee);
      eq(s.protocol, BigInt(fill.protocol), `${label} fill ${i} protocol`);
      eq(s.stonkzOps, BigInt(fill.ops), `${label} fill ${i} ops`);
      eq(s.creatorBucket, BigInt(fill.creatorBucket), `${label} fill ${i} creatorBucket`);
      st = applySell(st, f, amount);
    }
  }

  eq(st.virtualBase, BigInt(c.final.virtualBase), `${label} final virtualBase`);
  eq(st.virtualToken, BigInt(c.final.virtualToken), `${label} final virtualToken`);
  eq(st.realBase, BigInt(c.final.realBase), `${label} final realBase`);
  eq(st.realToken, BigInt(c.final.realToken), `${label} final realToken`);
  eq(mcapBase(st, BigInt(c.supplyAtoms)), BigInt(c.final.mcapBase), `${label} final mcapBase`);
  eq(
    mcapUsd1e6(mcapBase(st, BigInt(c.supplyAtoms)), BigInt(c.price1e6), c.baseDecimals),
    BigInt(c.final.mcapUsd1e6),
    `${label} final mcapUsd`,
  );
}

/* --------------------------------------------------------------------- report */

if (failures.length) {
  console.error(`parity FAILED: ${failures.length} of ${checks} checks diverged\n`);
  for (const f of failures.slice(0, 40)) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`parity OK: curve-sim.ts matches the program on all ${checks} checks`);
