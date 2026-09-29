import { afterEach, describe, expect, it } from 'vitest';
import { CRATES, SP_LEVELS, type Crate } from '@stonkz/shared';
import {
  InvalidProgressionTableError,
  clearProgressionOverrides,
  getCrateTables,
  getLevelTable,
  progressionOverrideStatus,
  setProgressionOverrides,
} from './tables.js';

afterEach(() => clearProgressionOverrides());

describe('progression table accessors', () => {
  it('serve the shipped tables by default', () => {
    expect(getCrateTables()).toBe(CRATES);
    expect(getLevelTable()).toBe(SP_LEVELS);
    expect(progressionOverrideStatus()).toEqual({ crates: false, levels: false });
  });

  it('accept a valid operator override and restore on null', () => {
    const crates: Crate[] = CRATES.map((c) => ({
      ...c,
      drops: [...c.drops] as unknown as Crate['drops'],
      cd: 1,
    }));
    setProgressionOverrides({ crates });
    expect(getCrateTables()).toBe(crates);
    expect(getCrateTables().every((c) => c.cd === 1)).toBe(true);
    expect(progressionOverrideStatus()).toEqual({ crates: true, levels: false });

    setProgressionOverrides({ crates: null });
    expect(getCrateTables()).toBe(CRATES);
  });

  it('refuse a crate table whose odds do not sum to 100 and keep the old one', () => {
    const bad: Crate[] = CRATES.map((c, i) =>
      i === 0
        ? {
            ...c,
            drops: [
              [50, 'S', 50, 150],
              [26, 'S', 150, 400],
              [11, 'S', 400, 900],
              [4, 'S', 1000, 2500],
              [1, 'I', 'FEE REBATE 24H'],
            ] as unknown as Crate['drops'],
          }
        : c,
    );
    expect(() => setProgressionOverrides({ crates: bad })).toThrow(InvalidProgressionTableError);
    expect(getCrateTables()).toBe(CRATES);
    try {
      setProgressionOverrides({ crates: bad });
    } catch (err) {
      expect((err as InvalidProgressionTableError).problems.join()).toMatch(
        /BRONZE odds sum to 92/,
      );
    }
  });

  it('refuse a level table that grants a tier the crate table does not have', () => {
    expect(() =>
      setProgressionOverrides({
        levels: [
          { level: 1, sp: 0, grants: { BRONZE: 1 } },
          { level: 2, sp: 10, grants: { UNOBTAINIUM: 1 } as never },
        ],
      }),
    ).toThrow(/unknown tier UNOBTAINIUM/);
    expect(getLevelTable()).toBe(SP_LEVELS);
  });

  it('refuse a non-monotonic level table', () => {
    expect(() =>
      setProgressionOverrides({
        levels: [
          { level: 1, sp: 0, grants: { BRONZE: 1 } },
          { level: 2, sp: 500, grants: { BRONZE: 1 } },
          { level: 3, sp: 400, grants: { BRONZE: 1 } },
        ],
      }),
    ).toThrow(/level 3 threshold 400 is not above level 2/);
  });
});
