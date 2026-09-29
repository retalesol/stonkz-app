import { describe, expect, it } from 'vitest';
import {
  ACH,
  CRATES,
  RANKS,
  RAR,
  RWA_ASSETS,
  SP_LEVELS,
  crateBy,
  crateRollFromDigest,
  crateRollMessage,
  crateTableWarnings,
  isValidClientSeed,
  levelGrantTotals,
  rankOf,
  spLevelOf,
  validateCrateTables,
  validateLevelTable,
  type Crate,
  type SpLevelDef,
} from '../src/index.js';

/** Invariants the server, the sim and the rewards page all lean on. */
describe('shipped progression tables', () => {
  it('crate tables pass the validator the API applies to operator overrides', () => {
    expect(validateCrateTables(CRATES)).toEqual([]);
  });

  it('level table passes the validator, and every grant names a shipped tier', () => {
    expect(validateLevelTable(SP_LEVELS)).toEqual([]);
    const tiers = new Set<string>(CRATES.map((c) => c.k));
    for (const l of SP_LEVELS) {
      for (const tier of Object.keys(l.grants)) expect(tiers.has(tier)).toBe(true);
    }
  });

  it('rank ladder is strictly ascending and rankOf is monotone', () => {
    for (let i = 1; i < RANKS.length; i++) {
      expect(RANKS[i]![1]).toBeGreaterThan(RANKS[i - 1]![1]);
    }
    let last = -1;
    for (let xp = 0; xp <= 60_000; xp += 250) {
      const r = rankOf(xp);
      expect(r.i).toBeGreaterThanOrEqual(last);
      expect(r.pct).toBeGreaterThanOrEqual(0);
      expect(r.pct).toBeLessThanOrEqual(100);
      if (r.next !== null) expect(r.toNext).toBe(r.next - xp);
      last = r.i;
    }
    // Rank saturates at 55k XP while SP levels run to 250k: by design, flagged for the owner.
    expect(RANKS.at(-1)![1]).toBeLessThan(SP_LEVELS.at(-1)!.sp);
  });

  it('spLevelOf is monotone and its progress maths is consistent', () => {
    let last = 0;
    for (let sp = 0; sp <= 260_000; sp += 1_000) {
      const l = spLevelOf(sp);
      expect(l.level).toBeGreaterThanOrEqual(last);
      expect(l.cur).toBeLessThanOrEqual(sp);
      if (l.next !== null) {
        expect(l.next).toBeGreaterThan(sp);
        expect(l.toNext).toBe(l.next - sp);
        expect(l.pct).toBeCloseTo(((sp - l.cur) / (l.next - l.cur)) * 100, 6);
      } else {
        expect(l.pct).toBe(100);
        expect(l.toNext).toBe(0);
      }
      last = l.level;
    }
  });

  it('the ladder hands out at least one crate of every tier', () => {
    const totals = levelGrantTotals();
    for (const c of CRATES) expect(totals[c.k] ?? 0).toBeGreaterThan(0);
  });

  it('every RWA row names a catalog asset', () => {
    const catalog = new Set<string>(RWA_ASSETS.map((a) => a[0]));
    for (const c of CRATES) {
      for (const d of c.drops) if (d[1] === 'R') expect(catalog.has(d[2])).toBe(true);
    }
  });

  it('every drop row maps onto the rarity ladder', () => {
    for (const c of CRATES) expect(c.drops).toHaveLength(RAR.length);
  });

  it('achievement keys are unique and every ACH entry pays positive XP', () => {
    expect(new Set(ACH.map((a) => a.k)).size).toBe(ACH.length);
    for (const a of ACH) expect(a.xp).toBeGreaterThan(0);
  });

  it('flags (does not fail on) the tiers whose rarity odds are not descending', () => {
    // Owner tuning note: PALLADIUM and RHODIUM pay UNCOMMON more often than COMMON.
    const warnings = crateTableWarnings();
    expect(warnings.some((w) => w.startsWith('tier PALLADIUM'))).toBe(true);
    expect(warnings.some((w) => w.startsWith('tier RHODIUM'))).toBe(true);
    expect(warnings.some((w) => w.startsWith('tier BRONZE'))).toBe(false);
  });
});

describe('validators', () => {
  it('catch a bad crate table', () => {
    const bad = CRATES.map((c) => ({ ...c })) as Crate[];
    (bad[0] as { cd: number }).cd = 0;
    (bad[1] as { drops: unknown }).drops = [
      [60, 'S', 10, 20],
      [30, 'S', 30, 20],
      [5, 'R', 'DOGE', 1, 2],
      [4, 'I', ''],
      [1, 'I', 'X'],
    ];
    const problems = validateCrateTables(bad);
    expect(problems).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/BRONZE cooldown/),
        expect.stringMatching(/IRON row 1 \$STONKZ band/),
        expect.stringMatching(/IRON row 2 RWA asset DOGE/),
        expect.stringMatching(/IRON row 3 item label is empty/),
      ]),
    );
    expect(validateCrateTables([])).toEqual(['crate table is empty']);
  });

  it('catch a bad level table', () => {
    const bad: SpLevelDef[] = [
      { level: 1, sp: 100, grants: { BRONZE: 1 } },
      { level: 3, sp: 50, grants: {} },
      { level: 4, sp: 60, grants: { BRONZE: -1 } },
    ];
    const problems = validateLevelTable(bad);
    expect(problems).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/level 1 must start at 0 SP/),
        expect.stringMatching(/level 3 does not follow 1/),
        expect.stringMatching(/level 3 threshold 50 is not above/),
        expect.stringMatching(/level 3 grants nothing/),
        expect.stringMatching(/level 4 grant for BRONZE/),
      ]),
    );
    expect(validateLevelTable([])).toEqual(['level table is empty']);
  });
});

describe('table-parameterised helpers', () => {
  it('crateBy and spLevelOf follow an injected table', () => {
    const crates: Crate[] = [CRATES[3] as Crate];
    expect(crateBy('GOLD', crates)?.k).toBe('GOLD');
    expect(crateBy('BRONZE', crates)).toBeNull();
    const levels: SpLevelDef[] = [
      { level: 1, sp: 0, grants: { GOLD: 1 } },
      { level: 2, sp: 10, grants: { GOLD: 2 } },
    ];
    expect(spLevelOf(5, levels)).toMatchObject({ level: 1, next: 10, toNext: 5, pct: 50 });
    expect(spLevelOf(10, levels)).toMatchObject({ level: 2, next: null, pct: 100 });
  });
});

describe('commit–reveal roll mapping', () => {
  it('maps digest bytes big-endian onto [0,100) and [0,1)', () => {
    const zero = new Uint8Array(32);
    expect(crateRollFromDigest(zero)).toEqual({ rollValue: 0, amountRoll: 0 });
    const max = new Uint8Array(32).fill(0xff);
    const top = crateRollFromDigest(max);
    expect(top.rollValue).toBeLessThan(100);
    expect(top.rollValue).toBeGreaterThan(99.99);
    expect(top.amountRoll).toBeLessThan(1);
    // First byte 0x80 = exactly half of the range.
    const half = new Uint8Array(32);
    half[0] = 0x80;
    half[8] = 0x80;
    expect(crateRollFromDigest(half)).toEqual({ rollValue: 50, amountRoll: 0.5 });
    expect(() => crateRollFromDigest(new Uint8Array(8))).toThrow(/16 bytes/);
  });

  it('formats the HMAC message and validates client seeds', () => {
    expect(crateRollMessage('SOL', 'W', 'GOLD', 'abc')).toBe('SOL|W|GOLD|abc');
    expect(isValidClientSeed('abc-DEF_09')).toBe(true);
    expect(isValidClientSeed('')).toBe(false);
    expect(isValidClientSeed('has space')).toBe(false);
    expect(isValidClientSeed('x'.repeat(65))).toBe(false);
    expect(isValidClientSeed(42)).toBe(false);
  });
});
